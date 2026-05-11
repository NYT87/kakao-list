import type { FavoriteList, SyncSnapshot } from "@kakao-lists/domain";

export interface FavoriteListsRepository {
  loadLists(): Promise<FavoriteList[]>;
  saveSnapshot(snapshot: SyncSnapshot): Promise<void>;
  getLastSyncedAt(): Promise<string | null>;
}

export interface SqliteEngine {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export class LocalStorageFavoriteListsRepository implements FavoriteListsRepository {
  constructor(
    private readonly storageKey: string,
    private readonly storage: Pick<Storage, "getItem" | "setItem"> = window.localStorage
  ) {}

  async loadLists(): Promise<FavoriteList[]> {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as SyncSnapshot;
    return parsed.lists;
  }

  async saveSnapshot(snapshot: SyncSnapshot): Promise<void> {
    this.storage.setItem(this.storageKey, JSON.stringify(snapshot));
  }

  async getLastSyncedAt(): Promise<string | null> {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as SyncSnapshot;
    return parsed.syncedAt;
  }
}

export class SqliteFavoriteListsRepository implements FavoriteListsRepository {
  constructor(private readonly engine: SqliteEngine) {}

  async initialize(): Promise<void> {
    await this.engine.run(
      "CREATE TABLE IF NOT EXISTS favorite_lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, item_count INTEGER NOT NULL, items_json TEXT NOT NULL)"
    );
    await this.engine.run(
      "CREATE TABLE IF NOT EXISTS sync_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), synced_at TEXT NOT NULL, source TEXT NOT NULL)"
    );
  }

  async loadLists(): Promise<FavoriteList[]> {
    const rows = await this.engine.all<{
      id: string;
      name: string;
      updated_at: string;
      item_count: number;
      items_json: string;
    }>(
      "SELECT id, name, updated_at, item_count, items_json FROM favorite_lists ORDER BY updated_at DESC"
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      itemCount: row.item_count,
      items: JSON.parse(row.items_json) as FavoriteList["items"]
    }));
  }

  async saveSnapshot(snapshot: SyncSnapshot): Promise<void> {
    await this.engine.run("DELETE FROM favorite_lists");

    for (const list of snapshot.lists) {
      await this.engine.run(
        "INSERT INTO favorite_lists (id, name, updated_at, item_count, items_json) VALUES (?, ?, ?, ?, ?)",
        [list.id, list.name, list.updatedAt, list.itemCount, JSON.stringify(list.items)]
      );
    }

    await this.engine.run("DELETE FROM sync_metadata WHERE id = 1");
    await this.engine.run(
      "INSERT INTO sync_metadata (id, synced_at, source) VALUES (1, ?, ?)",
      [snapshot.syncedAt, snapshot.source]
    );
  }

  async getLastSyncedAt(): Promise<string | null> {
    const rows = await this.engine.all<{ synced_at: string }>(
      "SELECT synced_at FROM sync_metadata WHERE id = 1"
    );
    return rows[0]?.synced_at ?? null;
  }
}

