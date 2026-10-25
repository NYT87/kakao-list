import {
  type FavoriteList,
  type PushSnapshotResult,
  parseSnapshot,
  type SyncSnapshot,
} from "@kakao-lists/domain";
import type { Pool, PoolClient } from "pg";

export const SNAPSHOT_SCHEMA_SQL = `
 CREATE TABLE IF NOT EXISTS snapshot_history(id BIGSERIAL PRIMARY KEY,kakao_user_id TEXT NOT NULL,device_id TEXT NOT NULL,server_version INTEGER NOT NULL,received_at TIMESTAMPTZ NOT NULL,snapshot_json JSONB NOT NULL);
 CREATE TABLE IF NOT EXISTS latest_snapshots(kakao_user_id TEXT PRIMARY KEY,device_id TEXT NOT NULL,server_version INTEGER NOT NULL,received_at TIMESTAMPTZ NOT NULL,snapshot_json JSONB NOT NULL);
 CREATE INDEX IF NOT EXISTS snapshot_history_user_version_idx ON snapshot_history(kakao_user_id,server_version DESC);
`;

export function preserveLocalNotes(
  current: SyncSnapshot | null,
  incoming: SyncSnapshot,
): SyncSnapshot {
  const oldLists = new Map(current?.lists.map((list) => [list.id, list]) ?? []);
  return {
    ...incoming,
    lists: incoming.lists.map((list) => {
      const previous = new Map(
        oldLists.get(list.id)?.items.map((item) => [item.id, item.localNote]) ??
          [],
      );
      // Notes are server-owned: imports may neither erase nor overwrite them.
      return {
        ...list,
        items: list.items.map((item) => ({
          ...item,
          localNote: previous.get(item.id),
        })),
      };
    }),
  };
}

export function mergeSnapshotList(input: {
  currentSnapshot: SyncSnapshot | null;
  list: FavoriteList;
  syncedAt: string;
  source: string;
  expectedListIds?: string[];
}): SyncSnapshot {
  const incoming = parseSnapshot({
    syncedAt: input.syncedAt,
    source: input.source,
    lists: [input.list],
  });
  const next = [
    ...(input.currentSnapshot?.lists ?? []).filter(
      (list) => list.id !== input.list.id,
    ),
    incoming.lists[0],
  ];
  if (
    input.expectedListIds !== undefined &&
    (!Array.isArray(input.expectedListIds) ||
      input.expectedListIds.length > 500 ||
      input.expectedListIds.some(
        (id) => typeof id !== "string" || !id || id.length > 200,
      ))
  )
    throw new Error("Invalid expected list ids.");
  return parseSnapshot({
    ...incoming,
    lists: input.expectedListIds
      ? next.filter((list) => input.expectedListIds?.includes(list.id))
      : next,
  });
}

export async function loadSnapshot(
  pool: Pick<Pool, "query"> | PoolClient,
  userId: string,
): Promise<PushSnapshotResult | null> {
  const result = await pool.query<{
    kakao_user_id: string;
    device_id: string;
    server_version: number;
    received_at: Date;
    snapshot_json: unknown;
  }>(
    "SELECT kakao_user_id,device_id,server_version,received_at,snapshot_json FROM latest_snapshots WHERE kakao_user_id=$1",
    [userId],
  );
  const row = result.rows[0];
  return row
    ? {
        userId: row.kakao_user_id,
        deviceId: row.device_id,
        serverVersion: row.server_version,
        receivedAt: new Date(row.received_at).toISOString(),
        snapshot: parseSnapshot(
          typeof row.snapshot_json === "string"
            ? JSON.parse(row.snapshot_json)
            : row.snapshot_json,
        ),
      }
    : null;
}

export async function mutateSnapshot(
  pool: Pool,
  userId: string,
  deviceId: string,
  mutate: (current: SyncSnapshot | null) => SyncSnapshot,
  {
    recordHistory = true,
    sessionTokenHash,
  }: { recordHistory?: boolean; sessionTokenHash?: string } = {},
): Promise<PushSnapshotResult> {
  if (typeof deviceId !== "string" || !deviceId.trim() || deviceId.length > 200)
    throw new Error("Invalid device id.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `account:${userId}`,
    ]);
    if (sessionTokenHash) {
      const session = await client.query(
        "SELECT 1 FROM browser_sessions WHERE token_hash=$1 AND expires_at>now()",
        [sessionTokenHash],
      );
      if (!session.rowCount) throw new Error("Session ended. Sign in again.");
    }
    const old = await loadSnapshot(client, userId);
    const snapshot = parseSnapshot(mutate(old?.snapshot ?? null));
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 10 * 1024 * 1024)
      throw new Error("Saved lists exceed the 10 MB account limit.");
    const version = (old?.serverVersion ?? 0) + 1;
    const at = new Date().toISOString();
    const args = [userId, deviceId, version, at, JSON.stringify(snapshot)];
    await client.query(
      "INSERT INTO latest_snapshots(kakao_user_id,device_id,server_version,received_at,snapshot_json) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(kakao_user_id) DO UPDATE SET device_id=excluded.device_id,server_version=excluded.server_version,received_at=excluded.received_at,snapshot_json=excluded.snapshot_json",
      args,
    );
    if (recordHistory)
      await client.query(
        "INSERT INTO snapshot_history(kakao_user_id,device_id,server_version,received_at,snapshot_json) VALUES($1,$2,$3,$4,$5::jsonb)",
        args,
      );
    await client.query(
      "DELETE FROM snapshot_history WHERE kakao_user_id=$1 AND (received_at < now()-interval '30 days' OR id NOT IN (SELECT id FROM snapshot_history WHERE kakao_user_id=$1 ORDER BY id DESC LIMIT 20))",
      [userId],
    );
    await client.query("COMMIT");
    return {
      userId,
      deviceId,
      serverVersion: version,
      receivedAt: at,
      snapshot,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
