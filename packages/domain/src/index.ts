export type SyncStatus = "idle" | "syncing" | "ready" | "error";

export interface FavoriteListItem {
  id: string;
  title: string;
  href?: string;
  note?: string;
}

export interface FavoriteList {
  id: string;
  name: string;
  updatedAt: string;
  itemCount: number;
  items: FavoriteListItem[];
}

export interface SyncSnapshot {
  syncedAt: string;
  source: string;
  lists: FavoriteList[];
}

export interface KakaoUserProfile {
  id: string;
  nickname?: string;
  profileImageUrl?: string;
}

export interface CloudSession {
  token: string;
  expiresAt: string;
  user: KakaoUserProfile;
}

export interface ExchangeKakaoCodeInput {
  code: string;
  redirectUri: string;
}

export interface PushSnapshotInput {
  deviceId: string;
  snapshot: SyncSnapshot;
}

export interface PushSnapshotResult {
  userId: string;
  deviceId: string;
  serverVersion: number;
  receivedAt: string;
  snapshot: SyncSnapshot;
}

export interface PullSnapshotResult {
  userId: string;
  deviceId: string | null;
  serverVersion: number | null;
  receivedAt: string | null;
  snapshot: SyncSnapshot | null;
}

export interface SyncAdapter {
  syncFavoriteLists(input: { authCode: string }): Promise<SyncSnapshot>;
}

export interface CloudSyncClient {
  exchangeKakaoCode(input: ExchangeKakaoCodeInput): Promise<CloudSession>;
  syncFromKakao(): Promise<PushSnapshotResult>;
  pushSnapshot(input: PushSnapshotInput): Promise<PushSnapshotResult>;
  pullLatestSnapshot(): Promise<PullSnapshotResult>;
}

export function createMockSyncAdapter(): SyncAdapter {
  return {
    async syncFavoriteLists({ authCode }) {
      await delay(600);

      const now = new Date().toISOString();
      const suffix = authCode.slice(0, 6) || "manual";

      const lists: FavoriteList[] = [
        {
          id: `fav-${suffix}-01`,
          name: "Pinned Reads",
          updatedAt: now,
          itemCount: 3,
          items: [
            { id: "item-1", title: "Kakao onboarding notes", note: "Imported from mock adapter" },
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
      ];

      return {
        syncedAt: now,
        source: "mock-kakao-sync-adapter",
        lists
      };
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}
