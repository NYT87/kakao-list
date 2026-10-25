import crypto from "node:crypto";
import { isIP } from "node:net";
import type {
  CloudSession,
  ExchangeKakaoCodeInput,
  KakaoUserProfile,
  MockAuthInput,
  PullSnapshotResult,
  PushSnapshotInput,
  PushSnapshotListInput,
  UpdateLocalNoteInput,
} from "@kakao-lists/domain";
import { parseSnapshot } from "@kakao-lists/domain";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { Pool } from "pg";
import { createAgentConnectionRouter } from "./agentConnectionRoutes.js";
import { createAgentTokenRouter } from "./agentTokenRoutes.js";
import {
  AGENT_TOKENS_SCHEMA_SQL,
  createAgentTokenVerifier,
  createPostgresAgentTokenStore,
} from "./agentTokens.js";
import { createAgentVerifier } from "./agentVerifier.js";
import { getBuildInfo } from "./buildInfo.js";
import { createKakaoOAuth } from "./kakaoOAuth.js";
import { createMaintenanceRouter, runMaintenance } from "./maintenance.js";
import { createMcpRouter } from "./mcpServer.js";
import { createPostgresOAuthStore, OAUTH_SCHEMA_SQL } from "./oauthStore.js";
import {
  PostgresRateLimitStore,
  RATE_LIMIT_SCHEMA_SQL,
} from "./rateLimitStore.js";
import { createApiRateLimit, createMcpRateLimits } from "./rateLimits.js";
import {
  credentialVault,
  SESSION_SCHEMA_SQL,
  sessionStore,
  validateSecurityConfiguration,
} from "./security.js";
import {
  loadSnapshot,
  mergeSnapshotList,
  mutateSnapshot,
  preserveLocalNotes,
  SNAPSHOT_SCHEMA_SQL,
} from "./snapshots.js";

export function createApplication(options: {
  env: NodeJS.ProcessEnv;
  pool?: Pool;
  kakaoAuthUrl?: string;
  kakaoApiUrl?: string;
}) {
  const env = options.env;
  const buildInfo = getBuildInfo(env);
  const sessionSigningSecret = validateSecurityConfiguration(env);
  const vault = credentialVault(sessionSigningSecret);

  const databaseUrl =
    env.DATABASE_URL ??
    "postgres://postgres:postgres@localhost:5432/kakao_lists";
  const kakaoClientId = env.KAKAO_REST_API_KEY ?? "";
  const kakaoClientSecret = env.KAKAO_CLIENT_SECRET ?? "";
  const allowMockAuth = env.ALLOW_MOCK_AUTH === "true";
  const jsonBodyLimit = env.JSON_BODY_LIMIT ?? "10mb";
  // Public origin of this server. Required for "sign in with Kakao" from AI
  // assistants (OAuth issuer and Kakao redirect URI); without it, /mcp only
  // accepts personal agent tokens.
  const publicServerUrl = parsePublicServerUrl(env.PUBLIC_SERVER_URL);
  const kakaoRequestTimeoutMs = 5_000;
  // Bearer secret for the maintenance cron endpoint (Vercel Cron sends it).
  const cronSecret = env.CRON_SECRET ?? "";

  const pool =
    options.pool ??
    new Pool({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
  const sessions = sessionStore(pool);
  const agentTokenStore = createPostgresAgentTokenStore(pool);
  const oauthStore = createPostgresOAuthStore(pool);
  // Rate limits are counted in Postgres so they hold across serverless instances.
  const createRateLimitStore = (prefix: string) =>
    new PostgresRateLimitStore(pool, prefix);
  const kakaoOAuth =
    publicServerUrl && kakaoClientId
      ? createKakaoOAuth({
          store: oauthStore,
          publicUrl: publicServerUrl,
          kakaoClientId,
          identifyKakaoUser: async (code, redirectUri) => {
            // Only the user id is needed. The Kakao tokens from this login are
            // not stored, so the web app's own Kakao session is left untouched.
            const kakaoToken = await exchangeAuthorizationCode(
              code,
              redirectUri,
            );
            return (await fetchKakaoUserProfile(kakaoToken.access_token)).id;
          },
          rateLimit: { createStore: createRateLimitStore },
        })
      : null;

  const app: express.Express = express();
  app.use((request, response, next) => {
    const send = response.send.bind(response);
    response.send = ((body: unknown) => {
      if (response.headersSent || response.writableEnded) return response;
      if (
        (request.path.startsWith("/api") || request.path === "/health") &&
        response.statusCode >= 400 &&
        typeof body === "string"
      ) {
        const messages: Record<number, string> = {
          400: "The request is invalid. Check your input and try again.",
          401: "Your session has ended. Sign in again.",
          403: "This action is unavailable.",
          404: "The requested item was not found.",
          410: "Import saved lists using the browser extension.",
          413: "This request is too large.",
          415: "Compressed request bodies are not accepted.",
          429: "Too many requests. Wait a moment and try again.",
          500: "Something went wrong. Please try again.",
          502: "Could not connect to Kakao. Please try again.",
          503: "Saved lists are temporarily unavailable.",
          504: "This request took too long. Please try again.",
        };
        // Normalize all main-API failures; upstream JSON text is untrusted too.

        response.type("application/json");
        return send(
          JSON.stringify({
            ...(request.path === "/health" ? buildInfo : {}),
            error: {
              code: `HTTP_${response.statusCode}`,
              message: messages[response.statusCode] ?? "Request failed.",
            },
          }),
        );
      }
      return send(body);
    }) as typeof response.send;
    next();
  });
  // One proxy hop on Vercel; lets the OAuth endpoints' rate limits see client IPs.
  app.set("trust proxy", 1);
  // MCP clients running in a browser need to read the auth challenge.
  app.use(
    cors({
      exposedHeaders: [
        "WWW-Authenticate",
        "Retry-After",
        "RateLimit",
        "RateLimit-Policy",
      ],
    }),
  );
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response
      .set("Cache-Control", "no-store")
      .set("X-Content-Type-Options", "nosniff");
    next();
  });
  // Cheap process-local ceiling before parsing or DB work; shared budgets follow readiness.
  app.use((request, response, next) => {
    const forwarded = request.header("x-forwarded-for");
    if (
      forwarded &&
      (forwarded.length > 512 ||
        forwarded.split(",").some((part) => !isIP(part.trim())))
    ) {
      response.status(400).send("Invalid forwarded address.");
      return;
    }
    next();
  });
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 600,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: jsonBodyLimit, inflate: false }));
  app.use((request, response, next) => {
    const stack = [request.body];
    let nodes = 0;
    while (stack.length) {
      const value = stack.pop();
      if (++nodes > 50000) {
        response.status(400).send("Too many input fields.");
        return;
      }
      if (Array.isArray(value)) {
        if (value.length > 5000) {
          response.status(400).send("Too many collection entries.");
          return;
        }
        stack.push(...value);
      } else if (value && typeof value === "object") {
        const values = Object.values(value);
        if (values.length > 100) {
          response.status(400).send("Too many fields.");
          return;
        }
        stack.push(...values);
      }
    }
    next();
  });
  app.use((_request, response, next) => {
    response.locals.deadline = AbortSignal.timeout(20_000);
    const timer = setTimeout(() => {
      if (!response.headersSent)
        response.status(504).json({
          error: {
            code: "REQUEST_TIMEOUT",
            message: "This request took too long. Please try again.",
          },
        });
    }, 22000);
    response.on("finish", () => clearTimeout(timer));
    response.on("close", () => clearTimeout(timer));
    next();
  });
  app.use((request, response, next) => {
    // Path only: OAuth query strings carry codes and state.
    const path = request.originalUrl.split("?")[0] ?? "";
    if (!shouldLogRequest(path)) {
      next();
      return;
    }

    const startedAt = performance.now();

    response.on("finish", () => {
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      console.info(
        `[api] ${request.method} ${path} -> ${response.statusCode} (${durationMs}ms)`,
      );
    });

    next();
  });
  app.use(
    ["/api", "/mcp", "/authorize", "/token", "/register", "/revoke", "/oauth"],
    async (_request, response, next) => {
      try {
        await ensureServerReady();
        next();
      } catch (_error) {
        console.error("[database] initialization failed");
        response.status(503).json({
          error: {
            code: "DATABASE_UNAVAILABLE",
            message:
              "Saved lists are temporarily unavailable. Try again shortly.",
          },
        });
      }
    },
  );

  app.use(
    "/api/auth",
    createApiRateLimit({
      createStore: createRateLimitStore,
      prefix: "auth-main:",
      perIpPerMinute: 30,
    }),
  );
  app.use(
    "/api/snapshot",
    createApiRateLimit({
      createStore: createRateLimitStore,
      prefix: "snapshot-main:",
      perIpPerMinute: 180,
    }),
  );
  const userLimit = rateLimit({
    store: createRateLimitStore("api-user:"),
    windowMs: 60000,
    limit: 120,
    keyGenerator: (_req, res) => res.locals.userId,
    standardHeaders: "draft-7",
    legacyHeaders: false,
  });
  let initializationPromise: Promise<void> | null = null;

  interface KakaoTokenRecord {
    accessToken: string;
    refreshToken: string | null;
    scope: string | null;
    updatedAt: string;
  }

  function shouldLogRequest(path: string) {
    return (
      path === "/health" ||
      [
        "/api",
        "/mcp",
        "/authorize",
        "/token",
        "/register",
        "/revoke",
        "/oauth",
      ].some((prefix) => path.startsWith(prefix))
    );
  }

  interface AuthenticatedSession {
    session: CloudSession;
    tokenRecord: KakaoTokenRecord;
  }

  class HttpStatusError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  class KakaoApiError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }

  app.get("/health", async (_request, response) => {
    try {
      await pool.query("SELECT 1");
      response.json({
        ok: true,
        service: "kakao-lists-sync-server",
        database: "postgres",
        ...buildInfo,
      });
    } catch (_error) {
      response.status(500).json({
        ok: false,
        service: "kakao-lists-sync-server",
        database: "postgres",
        error: "Database health check failed.",
      });
    }
  });

  app.post("/api/auth/kakao/exchange", async (request, response) => {
    const startedAt = new Date();
    const body = request.body as Partial<ExchangeKakaoCodeInput>;
    if (
      typeof body?.code !== "string" ||
      !body.code ||
      body.code.length > 2048 ||
      typeof body.redirectUri !== "string" ||
      body.redirectUri.length > 2048 ||
      !URL.canParse(body.redirectUri)
    ) {
      response.status(400).send("Body must include code and redirectUri.");
      return;
    }

    if (!kakaoClientId) {
      response
        .status(500)
        .send("KAKAO_REST_API_KEY is not configured on the server.");
      return;
    }

    try {
      const kakaoToken = await exchangeAuthorizationCode(
        body.code,
        body.redirectUri,
        response.locals.deadline,
      );
      const kakaoUser = await fetchKakaoUserProfile(
        kakaoToken.access_token,
        response.locals.deadline,
      );
      await saveKakaoTokens(kakaoUser.id, kakaoToken, undefined, startedAt);
      const session = await sessions.issue(kakaoUser, startedAt);
      response.json(session);
    } catch (error) {
      response
        .status(
          error instanceof Error &&
            ["TimeoutError", "AbortError"].includes(error.name)
            ? 504
            : 502,
        )
        .send(
          error instanceof Error
            ? error.message
            : "Kakao auth exchange failed.",
        );
    }
  });

  app.post("/api/auth/mock", async (request, response) => {
    if (!allowMockAuth) {
      response
        .status(403)
        .send("Mock auth is disabled. Set ALLOW_MOCK_AUTH=true to enable it.");
      return;
    }

    const body = (request.body ?? {}) as MockAuthInput;
    const user = {
      id: `mock:${typeof body.userId === "string" ? body.userId.trim().slice(0, 100) || "user-1" : "user-1"}`,
      nickname:
        typeof body.nickname === "string"
          ? body.nickname.trim().slice(0, 100)
          : "Mock User",
    };

    await saveKakaoTokens(user.id, {
      access_token: "mock-access-token",
      refresh_token: "mock-refresh-token",
      scope: "profile_nickname",
    });

    response.json(await sessions.issue(user));
  });

  app.post("/api/sync/kakao", (_request, response) => {
    response.status(410).send("Use extension import.");
  });

  app.post("/api/auth/logout", async (request, response) => {
    const token = request.header("authorization")?.replace(/^Bearer /, "");
    if (token) await sessions.revoke(token);
    response.status(204).end();
  });
  app.post("/api/auth/logout-all", async (request, response) => {
    const auth = await requireAuthenticatedSession(request, response);
    if (!auth) return;
    await sessions.revokeAll(auth.session.user.id);
    response.status(204).end();
  });
  app.delete("/api/account", async (request, response) => {
    const auth = await requireAuthenticatedSession(request, response);
    if (!auth) return;
    const userId = auth.session.user.id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const key of [
        `account:${userId}`,
        `agent_tokens:${userId}`,
        `oauth_grants:${userId}`,
      ])
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      await client.query(
        "INSERT INTO account_deletion_guards(kakao_user_id,deleted_at) VALUES($1,now()) ON CONFLICT(kakao_user_id) DO UPDATE SET deleted_at=excluded.deleted_at",
        [userId],
      );
      for (const table of [
        "snapshot_history",
        "latest_snapshots",
        "browser_sessions",
        "agent_tokens",
        "oauth_authorization_codes",
        "oauth_grants",
        "kakao_tokens",
      ])
        await client.query(`DELETE FROM ${table} WHERE kakao_user_id=$1`, [
          userId,
        ]);
      await client.query("COMMIT");
      response.status(204).end();
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/api/snapshot", async (request, response) => {
    const auth = await requireAuthenticatedSession(request, response);
    if (!auth) {
      return;
    }

    try {
      const { session } = auth;
      const row = await getLatestSnapshotRow(session.user.id);
      const result: PullSnapshotResult = row
        ? {
            userId: row.userId,
            deviceId: row.deviceId,
            serverVersion: row.serverVersion,
            receivedAt: row.receivedAt,
            snapshot: row.snapshot,
          }
        : {
            userId: session.user.id,
            deviceId: null,
            serverVersion: null,
            receivedAt: null,
            snapshot: null,
          };

      response.json(result);
    } catch (error) {
      response
        .status(500)
        .send(error instanceof Error ? error.message : "Snapshot read failed.");
    }
  });

  app.put("/api/snapshot", async (request, response) => {
    const auth = await requireAuthenticatedSession(request, response);
    if (!auth) {
      return;
    }

    const body = (request.body ?? {}) as Partial<PushSnapshotInput>;
    if (!body.deviceId || !body.snapshot) {
      response.status(400).send("Body must include deviceId and snapshot.");
      return;
    }

    try {
      const { session } = auth;
      const validatedSnapshot = parseSnapshot(body.snapshot);
      const result = await mutateSnapshot(
        pool,
        session.user.id,
        body.deviceId,
        (current) => preserveLocalNotes(current, validatedSnapshot),
        { sessionTokenHash: tokenHash(session.token) },
      );

      response.json(result);
    } catch (error) {
      response
        .status(400)
        .send(
          error instanceof Error ? error.message : "Snapshot write failed.",
        );
    }
  });

  app.put("/api/snapshot/list", async (request, response) => {
    const auth = await requireAuthenticatedSession(request, response);
    if (!auth) {
      return;
    }

    const body = (request.body ?? {}) as Partial<PushSnapshotListInput>;
    if (!body.deviceId || !body.list || !body.syncedAt || !body.source) {
      response
        .status(400)
        .send("Body must include deviceId, list, syncedAt, and source.");
      return;
    }

    try {
      const { session } = auth;
      const { list, syncedAt, source } = body;
      const result = await mutateSnapshot(
        pool,
        session.user.id,
        body.deviceId,
        (current) =>
          preserveLocalNotes(
            current,
            mergeSnapshotList({
              currentSnapshot: current,
              list,
              syncedAt,
              source,
              expectedListIds: body.expectedListIds,
            }),
          ),
        {
          recordHistory: body.expectedListIds !== undefined,
          sessionTokenHash: tokenHash(session.token),
        },
      );

      if (request.query.summary === "true") {
        const { snapshot: _snapshot, ...receipt } = result;
        response.json(receipt);
      } else response.json(result);
    } catch (error) {
      response
        .status(400)
        .send(
          error instanceof Error
            ? error.message
            : "Snapshot list write failed.",
        );
    }
  });

  app.patch("/api/snapshot/item-note", async (request, response) => {
    const auth = await requireAuthenticatedSession(request, response);
    if (!auth) {
      return;
    }

    const body = (request.body ?? {}) as Partial<UpdateLocalNoteInput>;
    if (!body.listId || !body.itemId || typeof body.localNote !== "string") {
      response
        .status(400)
        .send("Body must include listId, itemId, and localNote.");
      return;
    }

    try {
      const { session } = auth;
      if (
        body.localNote.length > 500 ||
        typeof body.listId !== "string" ||
        typeof body.itemId !== "string"
      ) {
        response.status(400).send("Invalid note.");
        return;
      }
      const result = await mutateSnapshot(
        pool,
        session.user.id,
        "local-note",
        (current) => {
          if (!current) throw new HttpStatusError(404, "No saved lists yet.");
          let found = false;
          const lists = current.lists.map((list) =>
            list.id !== body.listId
              ? list
              : {
                  ...list,
                  items: list.items.map((item) => {
                    if (item.id !== body.itemId) return item;
                    found = true;
                    return {
                      ...item,
                      localNote: body.localNote?.trim() || undefined,
                    };
                  }),
                },
          );
          if (!found) throw new HttpStatusError(404, "Place not found.");
          return { ...current, source: "local-note", lists };
        },
        { sessionTokenHash: tokenHash(session.token) },
      );

      response.json(result);
    } catch (error) {
      response
        .status(error instanceof HttpStatusError ? error.status : 500)
        .send(
          error instanceof Error ? error.message : "Local note update failed.",
        );
    }
  });

  app.use(
    "/api/agent-tokens",
    createApiRateLimit({
      createStore: createRateLimitStore,
      prefix: "api-agent-tokens:",
    }),
    createAgentTokenRouter({
      store: agentTokenStore,
      authenticate: async (request, response) =>
        (await requireAuthenticatedSession(request, response))?.session.user
          .id ?? null,
    }),
  );

  // Read-only MCP endpoint for AI agents, authenticated with agent tokens.
  // See docs/agent-access.md.
  app.use(
    "/api/agent-connections",
    createApiRateLimit({
      createStore: createRateLimitStore,
      prefix: "api-agent-connections:",
    }),
    createAgentConnectionRouter({
      store: oauthStore,
      authenticate: async (request, response) =>
        (await requireAuthenticatedSession(request, response))?.session.user
          .id ?? null,
    }),
  );

  // OAuth sign-in with Kakao for AI assistants: /authorize, /token, /register,
  // /revoke, /oauth/kakao/callback and the .well-known metadata. See
  // docs/agent-access.md (phase 2).
  if (kakaoOAuth) {
    app.use(kakaoOAuth.router);
  }

  // Read-only MCP endpoint for AI agents. Accepts personal agent tokens and,
  // when PUBLIC_SERVER_URL is set, OAuth access tokens.
  app.use(
    "/mcp",
    createMcpRouter({
      verifier: createAgentVerifier({
        agentTokens: createAgentTokenVerifier(agentTokenStore),
        oauth: kakaoOAuth?.verifier,
        resource: kakaoOAuth?.mcpResourceUrl,
      }),
      loadSnapshot: async (userId) =>
        (await getLatestSnapshotRow(userId))?.snapshot ?? null,
      resourceMetadataUrl: kakaoOAuth?.resourceMetadataUrl,
      expectedResource: kakaoOAuth?.mcpResourceUrl,
      rateLimits: createMcpRateLimits({ createStore: createRateLimitStore }),
    }),
  );

  // Daily cleanup from Vercel Cron (see vercel.json). Disabled without a secret.
  if (cronSecret) {
    app.use(
      "/api/cron/maintenance",
      createMaintenanceRouter({
        secret: cronSecret,
        run: async () => {
          const result = await runMaintenance(pool);
          await cleanupAppData();
          return result;
        },
      }),
    );
  }

  function ensureServerReady() {
    if (!initializationPromise) {
      initializationPromise = initializeDatabase()
        .then(() => {
          console.info(
            `Connected to Postgres at ${formatDatabaseTarget(databaseUrl)}`,
          );
        })
        .catch((error) => {
          initializationPromise = null;
          throw error;
        });
    }

    return initializationPromise;
  }

  async function initializeDatabase() {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS kakao_tokens (
      kakao_user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      updated_at TIMESTAMPTZ NOT NULL
    );

  `);
    await pool.query(SNAPSHOT_SCHEMA_SQL);
    await pool.query(SESSION_SCHEMA_SQL);
    // Legacy plaintext credentials cannot be silently retained after hardening.
    await pool.query(
      "DELETE FROM kakao_tokens WHERE access_token NOT LIKE 'enc:v1:%'",
    );
    await pool.query(AGENT_TOKENS_SCHEMA_SQL);
    await pool.query(OAUTH_SCHEMA_SQL);
    await pool.query(RATE_LIMIT_SCHEMA_SQL);
  }

  async function getKakaoTokenRecord(
    userId: string,
  ): Promise<KakaoTokenRecord | null> {
    const result = await pool.query<{
      access_token: string;
      refresh_token: string | null;
      scope: string | null;
      updated_at: Date | string;
    }>(
      `
      SELECT access_token, refresh_token, scope, updated_at
      FROM kakao_tokens
      WHERE kakao_user_id = $1
    `,
      [userId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      accessToken: vault.decrypt(row.access_token),
      refreshToken: row.refresh_token ? vault.decrypt(row.refresh_token) : null,
      scope: row.scope,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  async function getLatestSnapshotRow(userId: string) {
    return loadSnapshot(pool, userId);
  }

  async function saveKakaoTokens(
    userId: string,
    token: {
      access_token: string;
      refresh_token?: string;
      scope?: string;
    },
    sessionToken?: string,
    startedAt = new Date(),
  ) {
    const updatedAt = new Date().toISOString();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `account:${userId}`,
      ]);
      const deleted = await client.query(
        "SELECT 1 FROM account_deletion_guards WHERE kakao_user_id=$1 AND deleted_at>=$2",
        [userId, startedAt],
      );
      if (deleted.rowCount)
        throw new HttpStatusError(
          401,
          "Sign-in was cancelled by account deletion.",
        );
      if (sessionToken) {
        const session = await client.query(
          "SELECT 1 FROM browser_sessions WHERE token_hash=$1 AND expires_at>now()",
          [tokenHash(sessionToken)],
        );
        if (!session.rowCount) throw new HttpStatusError(401, "Session ended.");
      }
      await client.query(
        `
      INSERT INTO kakao_tokens (kakao_user_id, access_token, refresh_token, scope, updated_at)
      VALUES ($1, $2, $3, $4, $5::timestamptz)
      ON CONFLICT(kakao_user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = COALESCE(excluded.refresh_token, kakao_tokens.refresh_token),
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `,
        [
          userId,
          vault.encrypt(token.access_token),
          token.refresh_token ? vault.encrypt(token.refresh_token) : null,
          token.scope ?? null,
          updatedAt,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  function tokenHash(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  async function requireAuthenticatedSession(
    request: express.Request,
    response: express.Response,
  ): Promise<AuthenticatedSession | null> {
    const authHeader = request.header("authorization");
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

    if (!token) {
      response.status(401).send("Missing bearer token.");
      return null;
    }

    const session = await sessions.find(token);
    if (!session) {
      response.status(401).send("Invalid or expired session token.");
      return null;
    }

    try {
      response.locals.userId = session.user.id;
      response.locals.browserSessionHash = tokenHash(session.token);
      if (!response.locals.userLimited) {
        await new Promise<void>((resolve, reject) => {
          void userLimit(request, response, (error) =>
            error ? reject(error) : resolve(),
          );
          response.once("finish", resolve);
        });
        response.locals.userLimited = true;
        if (response.headersSent) return null;
      }
      const tokenRecord = await ensureKakaoBackedSession(
        session,
        response.locals.deadline,
      );
      if (response.headersSent) return null;
      return {
        session,
        tokenRecord,
      };
    } catch (error) {
      const status =
        error instanceof HttpStatusError
          ? error.status
          : error instanceof Error &&
              ["TimeoutError", "AbortError"].includes(error.name)
            ? 504
            : 502;
      const message =
        error instanceof Error
          ? error.message
          : "Kakao session validation failed.";
      response.status(status).send(message);
      return null;
    }
  }

  async function ensureKakaoBackedSession(
    session: CloudSession,
    signal?: AbortSignal,
  ): Promise<KakaoTokenRecord> {
    const tokenRecord = await getKakaoTokenRecord(session.user.id);
    if (!tokenRecord) {
      throw new HttpStatusError(
        401,
        "No Kakao token record exists for this session. Sign in again.",
      );
    }

    if (allowMockAuth && tokenRecord.accessToken === "mock-access-token") {
      return tokenRecord;
    }

    return await validateOrRefreshKakaoTokenRecord(
      session,
      tokenRecord,
      signal,
    );
  }

  async function validateOrRefreshKakaoTokenRecord(
    session: CloudSession,
    tokenRecord: KakaoTokenRecord,
    signal?: AbortSignal,
  ): Promise<KakaoTokenRecord> {
    try {
      const profile = await fetchKakaoUserProfile(
        tokenRecord.accessToken,
        signal,
      );
      assertMatchingKakaoIdentity(session, profile);
      return tokenRecord;
    } catch (error) {
      if (!isKakaoAuthorizationError(error)) {
        throw error;
      }

      if (!tokenRecord.refreshToken) {
        throw new HttpStatusError(
          401,
          "Kakao authentication expired. Sign in again.",
        );
      }

      try {
        const refreshedToken = await refreshKakaoAccessToken(
          tokenRecord.refreshToken,
          signal,
        );
        await saveKakaoTokens(session.user.id, refreshedToken, session.token);
        const nextTokenRecord = await getKakaoTokenRecord(session.user.id);
        if (!nextTokenRecord) {
          throw new HttpStatusError(
            401,
            "Kakao token refresh completed, but no token record remains.",
          );
        }

        const profile = await fetchKakaoUserProfile(
          nextTokenRecord.accessToken,
          signal,
        );
        assertMatchingKakaoIdentity(session, profile);
        return nextTokenRecord;
      } catch (refreshError) {
        if (
          isKakaoAuthorizationError(refreshError) ||
          isKakaoRefreshTokenError(refreshError)
        ) {
          throw new HttpStatusError(
            401,
            "Kakao authentication expired. Sign in again.",
          );
        }

        throw refreshError;
      }
    }
  }

  function assertMatchingKakaoIdentity(
    session: CloudSession,
    profile: KakaoUserProfile,
  ) {
    if (profile.id !== session.user.id) {
      throw new HttpStatusError(
        401,
        "Kakao identity no longer matches this session. Sign in again.",
      );
    }
  }

  async function exchangeAuthorizationCode(
    code: string,
    redirectUri: string,
    signal?: AbortSignal,
  ) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: kakaoClientId,
      redirect_uri: redirectUri,
      code,
    });

    if (kakaoClientSecret) {
      body.set("client_secret", kakaoClientSecret);
    }

    const response = await fetch(
      `${options.kakaoAuthUrl ?? "https://kauth.kakao.com"}/oauth/token`,
      {
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(kakaoRequestTimeoutMs),
            ])
          : AbortSignal.timeout(kakaoRequestTimeoutMs),
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body,
      },
    );

    if (!response.ok) {
      throw new Error(await response.text());
    }

    return (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
    };
  }

  async function refreshKakaoAccessToken(
    refreshToken: string,
    signal?: AbortSignal,
  ) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: kakaoClientId,
      refresh_token: refreshToken,
    });

    if (kakaoClientSecret) {
      body.set("client_secret", kakaoClientSecret);
    }

    const response = await fetch(
      `${options.kakaoAuthUrl ?? "https://kauth.kakao.com"}/oauth/token`,
      {
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(kakaoRequestTimeoutMs),
            ])
          : AbortSignal.timeout(kakaoRequestTimeoutMs),
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body,
      },
    );

    if (!response.ok) {
      throw new KakaoApiError(response.status, await response.text());
    }

    return (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      scope?: string;
    };
  }

  async function fetchKakaoUserProfile(
    accessToken: string,
    signal?: AbortSignal,
  ): Promise<KakaoUserProfile> {
    const response = await fetch(
      `${options.kakaoApiUrl ?? "https://kapi.kakao.com"}/v2/user/me`,
      {
        signal: signal
          ? AbortSignal.any([
              signal,
              AbortSignal.timeout(kakaoRequestTimeoutMs),
            ])
          : AbortSignal.timeout(kakaoRequestTimeoutMs),
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new KakaoApiError(response.status, await response.text());
    }

    const payload = (await response.json()) as {
      id: number | string;
      properties?: {
        nickname?: string;
        profile_image?: string;
      };
      kakao_account?: {
        profile?: {
          nickname?: string;
          profile_image_url?: string;
        };
      };
    };

    if (
      !["string", "number"].includes(typeof payload.id) ||
      !String(payload.id).trim() ||
      String(payload.id).length > 200
    )
      throw new KakaoApiError(502, "Invalid identity response.");
    const nickname =
      payload.kakao_account?.profile?.nickname ?? payload.properties?.nickname;
    const image =
      payload.kakao_account?.profile?.profile_image_url ??
      payload.properties?.profile_image;
    return {
      id: String(payload.id),
      nickname:
        typeof nickname === "string" ? nickname.slice(0, 1000) : undefined,
      profileImageUrl:
        typeof image === "string" && image.startsWith("https://")
          ? image
          : undefined,
    };
  }

  function parsePublicServerUrl(value: string | undefined) {
    if (!value) {
      return null;
    }
    if (!URL.canParse(value)) {
      throw new Error(`PUBLIC_SERVER_URL is not a valid URL: ${value}`);
    }
    return new URL(value);
  }

  function formatDatabaseTarget(value: string) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname || "localhost";
      const portPart = parsed.port ? `:${parsed.port}` : "";
      const database = parsed.pathname.replace(/^\//, "") || "postgres";
      return `${host}${portPart}/${database}`;
    } catch {
      return "configured DATABASE_URL";
    }
  }

  function isKakaoAuthorizationError(error: unknown) {
    return (
      error instanceof KakaoApiError &&
      (error.status === 401 || error.status === 403)
    );
  }

  function isKakaoRefreshTokenError(error: unknown) {
    return error instanceof KakaoApiError && error.status === 400;
  }

  app.use("/api", (_request, response) => {
    response.status(404).send("Not found.");
  });
  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      if (response.headersSent) return;
      const e = error as { status?: number; type?: string };
      const status =
        e.status && e.status >= 400 && e.status < 500 ? e.status : 500;
      console.error(`[api] request failed (${e.type ?? "internal"})`);
      response.status(status).send("Request failed.");
    },
  );
  async function cleanupAppData() {
    await pool.query(
      "DELETE FROM account_deletion_guards WHERE deleted_at<now()-interval '1 day'",
    );
    await pool.query("DELETE FROM browser_sessions WHERE expires_at<=now()");
    await pool.query(
      "DELETE FROM kakao_tokens WHERE updated_at<now()-interval '60 days'",
    );
    await pool.query(
      "DELETE FROM snapshot_history WHERE received_at<now()-interval '30 days'",
    );
  }
  return {
    app,
    ensureServerReady,
    maintain: async () => {
      await ensureServerReady();
      await runMaintenance(pool);
      await cleanupAppData();
    },
    close: () => pool.end(),
  };
}
