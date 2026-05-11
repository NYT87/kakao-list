import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import cors from "cors";
import Database from "better-sqlite3";
import express from "express";
import type {
  CloudSession,
  ExchangeKakaoCodeInput,
  KakaoUserProfile,
  PullSnapshotResult,
  PushSnapshotInput,
  PushSnapshotResult,
  SyncSnapshot
} from "@kakao-lists/domain";

const port = Number(process.env.SYNC_SERVER_PORT ?? 8787);
const dbPath = path.resolve(process.cwd(), process.env.SYNC_SERVER_DB_PATH ?? "./apps/server/data/sync.sqlite");
const kakaoClientId = process.env.KAKAO_REST_API_KEY ?? "";
const kakaoClientSecret = process.env.KAKAO_CLIENT_SECRET ?? "";
const sessionSigningSecret = process.env.SYNC_SERVER_SIGNING_SECRET ?? "change-me-in-production";
const sessionTtlMs = 1000 * 60 * 60 * 24 * 7;

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const database = new Database(dbPath);
database.pragma("journal_mode = WAL");
initializeDatabase();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    service: "kakao-lists-sync-server",
    dbPath
  });
});

app.post("/api/auth/kakao/exchange", async (request, response) => {
  const body = request.body as Partial<ExchangeKakaoCodeInput>;
  if (!body?.code || !body.redirectUri) {
    response.status(400).send("Body must include code and redirectUri.");
    return;
  }

  if (!kakaoClientId) {
    response.status(500).send("KAKAO_REST_API_KEY is not configured on the server.");
    return;
  }

  try {
    const kakaoToken = await exchangeAuthorizationCode(body.code, body.redirectUri);
    const kakaoUser = await fetchKakaoUserProfile(kakaoToken.access_token);
    saveKakaoTokens(kakaoUser.id, kakaoToken);
    const session = createCloudSession(kakaoUser);
    response.json(session);
  } catch (error) {
    response.status(502).send(error instanceof Error ? error.message : "Kakao auth exchange failed.");
  }
});

app.post("/api/sync/kakao", (request, response) => {
  const session = requireSession(request, response);
  if (!session) {
    return;
  }

  const tokenRecord = database
    .prepare(
      "SELECT access_token, refresh_token, scope, updated_at FROM kakao_tokens WHERE kakao_user_id = ?"
    )
    .get(session.user.id) as
    | {
        access_token: string;
        refresh_token: string | null;
        scope: string | null;
        updated_at: string;
      }
    | undefined;

  if (!tokenRecord) {
    response.status(404).send("No Kakao token record exists for this user.");
    return;
  }

  const snapshot = buildMockKakaoSnapshot(session.user.id);
  const result = saveLatestSnapshot({
    userId: session.user.id,
    deviceId: "server-kakao-sync",
    snapshot: {
      ...snapshot,
      source: `kakao-server-sync:${tokenRecord.updated_at}`
    }
  });

  response.json(result);
});

app.get("/api/snapshot", (request, response) => {
  const session = requireSession(request, response);
  if (!session) {
    return;
  }

  const userId = session.user.id;
  const row = database
    .prepare(
      "SELECT kakao_user_id, device_id, server_version, received_at, snapshot_json FROM latest_snapshots WHERE kakao_user_id = ?"
    )
    .get(userId) as
    | {
        kakao_user_id: string;
        device_id: string;
        server_version: number;
        received_at: string;
        snapshot_json: string;
      }
    | undefined;

  const result: PullSnapshotResult = row
    ? {
        userId: row.kakao_user_id,
        deviceId: row.device_id,
        serverVersion: row.server_version,
        receivedAt: row.received_at,
        snapshot: JSON.parse(row.snapshot_json) as SyncSnapshot
      }
    : {
        userId,
        deviceId: null,
        serverVersion: null,
        receivedAt: null,
        snapshot: null
      };

  response.json(result);
});

app.put("/api/snapshot", (request, response) => {
  const session = requireSession(request, response);
  if (!session) {
    return;
  }

  const body = request.body as Partial<PushSnapshotInput>;

  if (!body.deviceId || !body.snapshot) {
    response.status(400).send("Body must include deviceId and snapshot.");
    return;
  }

  const validatedSnapshot = validateSnapshot(body.snapshot);
  const result = saveLatestSnapshot({
    userId: session.user.id,
    deviceId: body.deviceId,
    snapshot: validatedSnapshot
  });

  response.json(result);
});

app.listen(port, () => {
  console.info(`Kakao Lists sync server listening on http://localhost:${port}`);
});

function initializeDatabase() {
  migrateLegacySchemaIfNeeded();

  database.exec(`
    CREATE TABLE IF NOT EXISTS snapshot_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kakao_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      server_version INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS latest_snapshots (
      kakao_user_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      server_version INTEGER NOT NULL,
      received_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kakao_tokens (
      kakao_user_id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      scope TEXT,
      updated_at TEXT NOT NULL
    );
  `);
}

function migrateLegacySchemaIfNeeded() {
  const latestColumns = getTableColumns("latest_snapshots");
  if (latestColumns.includes("account_id") && !latestColumns.includes("kakao_user_id")) {
    database.exec(`
      ALTER TABLE latest_snapshots RENAME TO latest_snapshots_legacy;

      CREATE TABLE latest_snapshots (
        kakao_user_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        server_version INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      INSERT INTO latest_snapshots (kakao_user_id, device_id, server_version, received_at, snapshot_json)
      SELECT account_id, device_id, server_version, received_at, snapshot_json
      FROM latest_snapshots_legacy;

      DROP TABLE latest_snapshots_legacy;
    `);
  }

  const historyColumns = getTableColumns("snapshot_history");
  if (historyColumns.includes("account_id") && !historyColumns.includes("kakao_user_id")) {
    database.exec(`
      ALTER TABLE snapshot_history RENAME TO snapshot_history_legacy;

      CREATE TABLE snapshot_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kakao_user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        server_version INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        snapshot_json TEXT NOT NULL
      );

      INSERT INTO snapshot_history (id, kakao_user_id, device_id, server_version, received_at, snapshot_json)
      SELECT id, account_id, device_id, server_version, received_at, snapshot_json
      FROM snapshot_history_legacy;

      DROP TABLE snapshot_history_legacy;
    `);
  }
}

function getTableColumns(tableName: string): string[] {
  const rows = database
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

function saveKakaoTokens(
  userId: string,
  token: {
    access_token: string;
    refresh_token?: string;
    scope?: string;
  }
) {
  const updatedAt = new Date().toISOString();
  database
    .prepare(
      `
      INSERT INTO kakao_tokens (kakao_user_id, access_token, refresh_token, scope, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kakao_user_id) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        scope = excluded.scope,
        updated_at = excluded.updated_at
    `
    )
    .run(userId, token.access_token, token.refresh_token ?? null, token.scope ?? null, updatedAt);
}

function validateSnapshot(snapshot: Partial<SyncSnapshot>): SyncSnapshot {
  if (!snapshot.syncedAt || !snapshot.source || !Array.isArray(snapshot.lists)) {
    throw new Error("Snapshot must include syncedAt, source, and lists.");
  }

  return {
    syncedAt: snapshot.syncedAt,
    source: snapshot.source,
    lists: snapshot.lists
  };
}

const saveLatestSnapshot = database.transaction(
  (input: PushSnapshotInput & { userId: string }): PushSnapshotResult => {
    const current = database
      .prepare("SELECT server_version FROM latest_snapshots WHERE kakao_user_id = ?")
      .get(input.userId) as { server_version: number } | undefined;

    const nextVersion = (current?.server_version ?? 0) + 1;
    const receivedAt = new Date().toISOString();
    const serialized = JSON.stringify(input.snapshot);

    database
      .prepare(
        "INSERT INTO snapshot_history (kakao_user_id, device_id, server_version, received_at, snapshot_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run(input.userId, input.deviceId, nextVersion, receivedAt, serialized);

    database
      .prepare(
        `
        INSERT INTO latest_snapshots (kakao_user_id, device_id, server_version, received_at, snapshot_json)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kakao_user_id) DO UPDATE SET
          device_id = excluded.device_id,
          server_version = excluded.server_version,
          received_at = excluded.received_at,
          snapshot_json = excluded.snapshot_json
      `
      )
      .run(input.userId, input.deviceId, nextVersion, receivedAt, serialized);

    return {
      userId: input.userId,
      deviceId: input.deviceId,
      serverVersion: nextVersion,
      receivedAt,
      snapshot: input.snapshot
    };
  }
);

function requireSession(
  request: express.Request,
  response: express.Response
): CloudSession | null {
  const authHeader = request.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    response.status(401).send("Missing bearer token.");
    return null;
  }

  const session = verifySessionToken(token);
  if (!session) {
    response.status(401).send("Invalid or expired session token.");
    return null;
  }

  return session;
}

async function exchangeAuthorizationCode(code: string, redirectUri: string) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: kakaoClientId,
    redirect_uri: redirectUri,
    code
  });

  if (kakaoClientSecret) {
    body.set("client_secret", kakaoClientSecret);
  }

  const response = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
    },
    body
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

async function fetchKakaoUserProfile(accessToken: string): Promise<KakaoUserProfile> {
  const response = await fetch("https://kapi.kakao.com/v2/user/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(await response.text());
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
    nickname: payload.kakao_account?.profile?.nickname ?? payload.properties?.nickname,
    profileImageUrl:
      payload.kakao_account?.profile?.profile_image_url ?? payload.properties?.profile_image
  };
}

function createCloudSession(user: KakaoUserProfile): CloudSession {
  const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();
  const payload = {
    user,
    expiresAt
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);

  return {
    token: `${encodedPayload}.${signature}`,
    expiresAt,
    user
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

  if (!parsed.user?.id || !parsed.expiresAt || Number.isNaN(Date.parse(parsed.expiresAt))) {
    return null;
  }

  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    return null;
  }

  return {
    token,
    expiresAt: parsed.expiresAt,
    user: parsed.user
  };
}

function signPayload(encodedPayload: string) {
  return crypto.createHmac("sha256", sessionSigningSecret).update(encodedPayload).digest("base64url");
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
          { id: "item-1", title: "Kakao onboarding notes", note: "Imported by server sync" },
          { id: "item-2", title: "Shared grocery ideas" },
          { id: "item-3", title: "Weekend plans", href: "https://example.com/weekend" }
        ]
      },
      {
        id: `fav-${suffix}-02`,
        name: "Saved Places",
        updatedAt: now,
        itemCount: 2,
        items: [
          { id: "item-4", title: "Busan cafe shortlist" },
          { id: "item-5", title: "Jeju trip draft" }
        ]
      }
    ]
  };
}
