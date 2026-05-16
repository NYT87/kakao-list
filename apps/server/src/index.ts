import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { Pool, type PoolClient } from "pg";
import type {
  CloudSession,
  ExchangeKakaoCodeInput,
  FavoriteList,
  KakaoUserProfile,
  MockAuthInput,
  PullSnapshotResult,
  PushSnapshotListInput,
  PushSnapshotInput,
  PushSnapshotResult,
  SyncSnapshot,
  UpdateLocalNoteInput,
} from "@kakao-lists/domain";

loadRootEnvFiles();

const port = Number(process.env.PORT ?? process.env.SYNC_SERVER_PORT ?? 8787);
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/kakao_lists";
const kakaoClientId = process.env.KAKAO_REST_API_KEY ?? "";
const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET ?? "";
const sessionSigningSecret =
  process.env.SYNC_SERVER_SIGNING_SECRET ?? "change-me-in-production";
const allowMockAuth = process.env.ALLOW_MOCK_AUTH === "true";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 7;
const jsonBodyLimit = process.env.JSON_BODY_LIMIT ?? "10mb";

const pool = new Pool({
  connectionString: databaseUrl,
});

const app: express.Express = express();
app.use(cors());
app.use(express.json({ limit: jsonBodyLimit }));
app.use((request, response, next) => {
  if (!shouldLogRequest(request.originalUrl)) {
    next();
    return;
  }

  const startedAt = performance.now();

  response.on("finish", () => {
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    console.info(
      `[api] ${request.method} ${request.originalUrl} -> ${response.statusCode} (${durationMs}ms)`,
    );
  });

  next();
});
app.use("/api", async (_request, response, next) => {
  try {
    await ensureServerReady();
    next();
  } catch (error) {
    response
      .status(503)
      .send(
        error instanceof Error
          ? `Database is unavailable: ${error.message}`
          : "Database is unavailable.",
      );
  }
});

let initializationPromise: Promise<void> | null = null;

interface KakaoTokenRecord {
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  updatedAt: string;
}

function shouldLogRequest(url: string) {
  return url === "/health" || url.startsWith("/api");
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
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      service: "kakao-lists-sync-server",
      database: "postgres",
      error:
        error instanceof Error
          ? error.message
          : "Database health check failed.",
    });
  }
});

app.post("/api/auth/kakao/exchange", async (request, response) => {
  const body = request.body as Partial<ExchangeKakaoCodeInput>;
  if (!body?.code || !body.redirectUri) {
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
    );
    const kakaoUser = await fetchKakaoUserProfile(kakaoToken.access_token);
    await saveKakaoTokens(kakaoUser.id, kakaoToken);
    const session = createCloudSession(kakaoUser);
    response.json(session);
  } catch (error) {
    response
      .status(502)
      .send(
        error instanceof Error ? error.message : "Kakao auth exchange failed.",
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
    id: body.userId?.trim() || "mock-user-1",
    nickname: body.nickname?.trim() || "Mock User",
  };

  await saveKakaoTokens(user.id, {
    access_token: "mock-access-token",
    refresh_token: "mock-refresh-token",
    scope: "profile_nickname",
  });

  response.json(createCloudSession(user));
});

app.post("/api/sync/kakao", async (request, response) => {
  const auth = await requireAuthenticatedSession(request, response);
  if (!auth) {
    return;
  }

  try {
    const { session, tokenRecord } = auth;
    const snapshot = buildMockKakaoSnapshot(session.user.id);
    const result = await saveLatestSnapshot({
      userId: session.user.id,
      deviceId: "server-kakao-sync",
      snapshot: {
        ...snapshot,
        source: `kakao-server-sync:${tokenRecord.updatedAt}`,
      },
    });

    response.json(result);
  } catch (error) {
    response
      .status(500)
      .send(error instanceof Error ? error.message : "Kakao sync failed.");
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
          userId: row.kakaoUserId,
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

  const body = request.body as Partial<PushSnapshotInput>;
  if (!body.deviceId || !body.snapshot) {
    response.status(400).send("Body must include deviceId and snapshot.");
    return;
  }

  try {
    const { session } = auth;
    const validatedSnapshot = validateSnapshot(body.snapshot);
    const result = await saveLatestSnapshot({
      userId: session.user.id,
      deviceId: body.deviceId,
      snapshot: validatedSnapshot,
    });

    response.json(result);
  } catch (error) {
    response
      .status(400)
      .send(error instanceof Error ? error.message : "Snapshot write failed.");
  }
});

app.put("/api/snapshot/list", async (request, response) => {
  const auth = await requireAuthenticatedSession(request, response);
  if (!auth) {
    return;
  }

  const body = request.body as Partial<PushSnapshotListInput>;
  if (!body.deviceId || !body.list || !body.syncedAt || !body.source) {
    response
      .status(400)
      .send("Body must include deviceId, list, syncedAt, and source.");
    return;
  }

  try {
    const { session } = auth;
    const current = await getLatestSnapshotRow(session.user.id);
    const mergedSnapshot = mergeSnapshotList({
      currentSnapshot: current?.snapshot ?? null,
      list: body.list,
      syncedAt: body.syncedAt,
      source: body.source,
      expectedListIds: body.expectedListIds,
    });
    const validatedSnapshot = validateSnapshot(mergedSnapshot);
    const result = await saveLatestSnapshot({
      userId: session.user.id,
      deviceId: body.deviceId,
      snapshot: validatedSnapshot,
    });

    response.json(result);
  } catch (error) {
    response
      .status(400)
      .send(
        error instanceof Error ? error.message : "Snapshot list write failed.",
      );
  }
});

app.patch("/api/snapshot/item-note", async (request, response) => {
  const auth = await requireAuthenticatedSession(request, response);
  if (!auth) {
    return;
  }

  const body = request.body as Partial<UpdateLocalNoteInput>;
  if (!body.listId || !body.itemId || typeof body.localNote !== "string") {
    response
      .status(400)
      .send("Body must include listId, itemId, and localNote.");
    return;
  }

  try {
    const { session } = auth;
    const current = await getLatestSnapshotRow(session.user.id);
    if (!current) {
      response.status(404).send("No snapshot exists for this user yet.");
      return;
    }

    const localNote = body.localNote;
    let found = false;
    const nextLists = current.snapshot.lists.map((list) => {
      if (list.id !== body.listId) {
        return list;
      }

      return {
        ...list,
        items: list.items.map((item) => {
          if (item.id !== body.itemId) {
            return item;
          }

          found = true;
          return {
            ...item,
            localNote: localNote.trim() || undefined,
          };
        }),
      };
    });

    if (!found) {
      response.status(404).send("List item not found in the current snapshot.");
      return;
    }

    const result = await saveLatestSnapshot({
      userId: session.user.id,
      deviceId: "server-local-note",
      snapshot: {
        ...current.snapshot,
        syncedAt: new Date().toISOString(),
        source: `${current.snapshot.source}:local-note`,
        lists: nextLists,
      },
    });

    response.json(result);
  } catch (error) {
    response
      .status(500)
      .send(
        error instanceof Error ? error.message : "Local note update failed.",
      );
  }
});

export default app;
export { ensureServerReady };

const isDirectRun =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  void startServer();
}

async function startServer() {
  try {
    await ensureServerReady();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `Postgres initialization failed at startup: ${error.message}`
        : "Postgres initialization failed at startup.",
    );
  }

  app.listen(port, () => {
    console.info(
      `Kakao Lists sync server listening on http://localhost:${port}`,
    );
  });
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
    CREATE TABLE IF NOT EXISTS snapshot_history (
      id BIGSERIAL PRIMARY KEY,
      kakao_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      server_version INTEGER NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      snapshot_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS latest_snapshots (
      kakao_user_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      server_version INTEGER NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      snapshot_json JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kakao_tokens (
      kakao_user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      updated_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS snapshot_history_user_version_idx
      ON snapshot_history (kakao_user_id, server_version DESC);
  `);
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
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    scope: row.scope,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function getLatestSnapshotRow(userId: string) {
  const result = await pool.query<{
    kakao_user_id: string;
    device_id: string;
    server_version: number;
    received_at: Date | string;
    snapshot_json: SyncSnapshot | string;
  }>(
    `
      SELECT kakao_user_id, device_id, server_version, received_at, snapshot_json
      FROM latest_snapshots
      WHERE kakao_user_id = $1
    `,
    [userId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    kakaoUserId: row.kakao_user_id,
    deviceId: row.device_id,
    serverVersion: row.server_version,
    receivedAt: new Date(row.received_at).toISOString(),
    snapshot: normalizeSnapshotValue(row.snapshot_json),
  };
}

async function saveKakaoTokens(
  userId: string,
  token: {
    access_token: string;
    refresh_token?: string;
    scope?: string;
  },
) {
  const updatedAt = new Date().toISOString();
  await pool.query(
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
      token.access_token,
      token.refresh_token ?? null,
      token.scope ?? null,
      updatedAt,
    ],
  );
}

function validateSnapshot(snapshot: Partial<SyncSnapshot>): SyncSnapshot {
  if (
    !snapshot.syncedAt ||
    !snapshot.source ||
    !Array.isArray(snapshot.lists)
  ) {
    throw new Error("Snapshot must include syncedAt, source, and lists.");
  }

  return {
    syncedAt: snapshot.syncedAt,
    source: snapshot.source,
    lists: snapshot.lists,
  };
}

function mergeSnapshotList(input: {
  currentSnapshot: SyncSnapshot | null;
  list: FavoriteList;
  syncedAt: string;
  source: string;
  expectedListIds?: string[];
}): SyncSnapshot {
  const currentLists = input.currentSnapshot?.lists ?? [];
  const nextLists = [
    ...currentLists.filter((existing) => existing.id !== input.list.id),
    input.list,
  ];

  const expectedListIds = input.expectedListIds?.filter(Boolean);
  const normalizedLists =
    expectedListIds && expectedListIds.length > 0
      ? nextLists.filter((list) => expectedListIds.includes(list.id))
      : nextLists;

  return {
    syncedAt: input.syncedAt,
    source: input.source,
    lists: normalizedLists,
  };
}

async function saveLatestSnapshot(
  input: PushSnapshotInput & { userId: string },
): Promise<PushSnapshotResult> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const current = await client.query<{ server_version: number }>(
      `
        SELECT server_version
        FROM latest_snapshots
        WHERE kakao_user_id = $1
        FOR UPDATE
      `,
      [input.userId],
    );

    const nextVersion = (current.rows[0]?.server_version ?? 0) + 1;
    const receivedAt = new Date().toISOString();
    const serialized = JSON.stringify(input.snapshot);

    await client.query(
      `
        INSERT INTO snapshot_history (kakao_user_id, device_id, server_version, received_at, snapshot_json)
        VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
      `,
      [input.userId, input.deviceId, nextVersion, receivedAt, serialized],
    );

    await client.query(
      `
        INSERT INTO latest_snapshots (kakao_user_id, device_id, server_version, received_at, snapshot_json)
        VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
        ON CONFLICT(kakao_user_id) DO UPDATE SET
          device_id = excluded.device_id,
          server_version = excluded.server_version,
          received_at = excluded.received_at,
          snapshot_json = excluded.snapshot_json
      `,
      [input.userId, input.deviceId, nextVersion, receivedAt, serialized],
    );

    await client.query("COMMIT");

    return {
      userId: input.userId,
      deviceId: input.deviceId,
      serverVersion: nextVersion,
      receivedAt,
      snapshot: input.snapshot,
    };
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }
}

async function rollbackQuietly(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Ignore rollback failures after the original transaction error.
  }
}

function normalizeSnapshotValue(value: SyncSnapshot | string): SyncSnapshot {
  return typeof value === "string"
    ? (JSON.parse(value) as SyncSnapshot)
    : value;
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

  const session = verifySessionToken(token);
  if (!session) {
    response.status(401).send("Invalid or expired session token.");
    return null;
  }

  try {
    const tokenRecord = await ensureKakaoBackedSession(session);
    return {
      session,
      tokenRecord,
    };
  } catch (error) {
    const status = error instanceof HttpStatusError ? error.status : 502;
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

  return await validateOrRefreshKakaoTokenRecord(session, tokenRecord);
}

async function validateOrRefreshKakaoTokenRecord(
  session: CloudSession,
  tokenRecord: KakaoTokenRecord,
): Promise<KakaoTokenRecord> {
  try {
    const profile = await fetchKakaoUserProfile(tokenRecord.accessToken);
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
      );
      await saveKakaoTokens(session.user.id, refreshedToken);
      const nextTokenRecord = await getKakaoTokenRecord(session.user.id);
      if (!nextTokenRecord) {
        throw new HttpStatusError(
          401,
          "Kakao token refresh completed, but no token record remains.",
        );
      }

      const profile = await fetchKakaoUserProfile(nextTokenRecord.accessToken);
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

async function exchangeAuthorizationCode(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: kakaoClientId,
    redirect_uri: redirectUri,
    code,
  });

  if (kakaoClientSecret) {
    body.set("client_secret", kakaoClientSecret);
  }

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    scope?: string;
  };
}

async function refreshKakaoAccessToken(refreshToken: string) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: kakaoClientId,
    refresh_token: refreshToken,
  });

  if (kakaoClientSecret) {
    body.set("client_secret", kakaoClientSecret);
  }

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
  });

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
): Promise<KakaoUserProfile> {
  const response = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

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

  return {
    id: String(payload.id),
    nickname:
      payload.kakao_account?.profile?.nickname ?? payload.properties?.nickname,
    profileImageUrl:
      payload.kakao_account?.profile?.profile_image_url ??
      payload.properties?.profile_image,
  };
}

function createCloudSession(user: KakaoUserProfile): CloudSession {
  const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
  const payload = {
    user,
    expiresAt,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt,
    user,
  };
}

function verifySessionToken(token: string): CloudSession | null {
  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const parsed = JSON.parse(base64UrlDecode(encodedPayload)) as {
    user: KakaoUserProfile;
    expiresAt: string;
  };

  if (
    !parsed.user?.id ||
    !parsed.expiresAt ||
    Number.isNaN(Date.parse(parsed.expiresAt))
  ) {
    return null;
  }

  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    return null;
  }

  return {
    token,
    expiresAt: parsed.expiresAt,
    user: parsed.user,
  };
}

function signPayload(encodedPayload: string) {
  return crypto
    .createHmac("sha256", sessionSigningSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function buildMockKakaoSnapshot(userId: string): SyncSnapshot {
  const now = new Date().toISOString();
  const suffix = userId.slice(0, 6) || "kakao";

  return {
    syncedAt: now,
    source: "mock-kakao-server-sync",
    lists: [
      {
        id: `fav-${suffix}-01`,
        name: "Pinned Reads",
        updatedAt: now,
        itemCount: 3,
        items: [
          {
            id: "item-1",
            title: "Kakao onboarding notes",
            placeKey: "mock-1",
            color: "01",
            subtitle: "Imported by server sync",
            kakaoNote: "Imported by server sync",
          },
          {
            id: "item-2",
            title: "Shared grocery ideas",
            placeKey: "mock-2",
            color: "02",
            subtitle: "Imported by server sync",
          },
          {
            id: "item-3",
            title: "Weekend plans",
            href: "https://example.com/weekend",
          },
        ],
      },
      {
        id: `fav-${suffix}-02`,
        name: "Saved Places",
        updatedAt: now,
        itemCount: 2,
        items: [
          {
            id: "item-4",
            title: "Busan cafe shortlist",
            placeKey: "mock-4",
            color: "03",
            subtitle: "Imported by server sync",
          },
          {
            id: "item-5",
            title: "Jeju trip draft",
            placeKey: "mock-5",
            color: "04",
            subtitle: "Imported by server sync",
          },
        ],
      },
    ],
  };
}

function loadRootEnvFiles() {
  const currentFile = fileURLToPath(import.meta.url);
  const rootDir = path.resolve(path.dirname(currentFile), "../../..");

  for (const name of [".env", ".env.local"]) {
    loadEnvFile(path.join(rootDir, name));
  }
}

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || key in process.env) {
      continue;
    }

    const value = line
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] = value;
  }
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
