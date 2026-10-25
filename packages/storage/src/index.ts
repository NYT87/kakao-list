import {
  type FavoriteList,
  parseSnapshot,
  type SyncSnapshot,
} from "@kakao-lists/domain";

export interface FavoriteListsRepository {
  loadLists(): Promise<FavoriteList[]>;
  saveSnapshot(snapshot: SyncSnapshot): Promise<void>;
  getLastSyncedAt(): Promise<string | null>;
}

export interface SqliteEngine {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function browserStorage(): Storage {
  const read = <T>(fallback: T, action: (storage: Storage) => T): T => {
    try {
      return action(window.localStorage);
    } catch {
      return fallback;
    }
  };
  return {
    getItem: (key) => read(null, (s) => s.getItem(key)),
    setItem: (key, value) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        throw new Error(
          "Could not save on this device. Enable browser storage and try again.",
        );
      }
    },
    removeItem: (key) => {
      read(undefined, (s) => s.removeItem(key));
    },
    clear: () => {
      read(undefined, (s) => s.clear());
    },
    key: (index) => read(null, (s) => s.key(index)),
    get length() {
      return read(0, (s) => s.length);
    },
  };
}

export class LocalStorageFavoriteListsRepository
  implements FavoriteListsRepository
{
  constructor(
    private readonly storageKey: string,
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    > = browserStorage(),
  ) {}

  forAccount(
    userId: string | null | undefined,
  ): LocalStorageFavoriteListsRepository {
    // Old records have no trustworthy owner. Never migrate them to a new login.
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* Reading remains possible without persistent storage. */
    }
    return new LocalStorageFavoriteListsRepository(
      `${this.storageKey}:user:${encodeURIComponent(userId ?? "signed-out")}`,
      this.storage,
    );
  }

  clear(): void {
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* A blocked store cannot restore data. */
    }
  }

  private read(): SyncSnapshot | null {
    try {
      const raw = this.storage.getItem(this.storageKey);
      return raw ? parseSnapshot(JSON.parse(raw)) : null;
    } catch {
      this.clear();
      return null;
    }
  }

  async loadLists(): Promise<FavoriteList[]> {
    return this.read()?.lists ?? [];
  }
  async getLastSyncedAt(): Promise<string | null> {
    return this.read()?.syncedAt ?? null;
  }
  async saveSnapshot(snapshot: SyncSnapshot): Promise<void> {
    const validated = parseSnapshot(snapshot);
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(validated));
    } catch {
      throw new Error(
        "Could not save on this device. Free some browser storage and try again.",
      );
    }
  }
}

export class SqliteFavoriteListsRepository implements FavoriteListsRepository {
  constructor(private readonly engine: SqliteEngine) {}

  async initialize(): Promise<void> {
    await this.engine.run(
      "CREATE TABLE IF NOT EXISTS favorite_lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, item_count INTEGER NOT NULL, items_json TEXT NOT NULL)",
    );
    await this.engine.run(
      "CREATE TABLE IF NOT EXISTS sync_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), synced_at TEXT NOT NULL, source TEXT NOT NULL)",
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
      "SELECT id, name, updated_at, item_count, items_json FROM favorite_lists ORDER BY updated_at DESC",
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      updatedAt: row.updated_at,
      itemCount: row.item_count,
      items: JSON.parse(row.items_json) as FavoriteList["items"],
    }));
  }

  async saveSnapshot(snapshot: SyncSnapshot): Promise<void> {
    await this.engine.run("DELETE FROM favorite_lists");

    for (const list of snapshot.lists) {
      await this.engine.run(
        "INSERT INTO favorite_lists (id, name, updated_at, item_count, items_json) VALUES (?, ?, ?, ?, ?)",
        [
          list.id,
          list.name,
          list.updatedAt,
          list.itemCount,
          JSON.stringify(list.items),
        ],
      );
    }

    await this.engine.run("DELETE FROM sync_metadata WHERE id = 1");
    await this.engine.run(
      "INSERT INTO sync_metadata (id, synced_at, source) VALUES (1, ?, ?)",
      [snapshot.syncedAt, snapshot.source],
    );
  }

  async getLastSyncedAt(): Promise<string | null> {
    const rows = await this.engine.all<{ synced_at: string }>(
      "SELECT synced_at FROM sync_metadata WHERE id = 1",
    );
    return rows[0]?.synced_at ?? null;
  }
}
