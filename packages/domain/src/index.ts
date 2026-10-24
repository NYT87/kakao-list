export type SyncStatus = "idle" | "syncing" | "ready" | "error";

export interface FavoriteListItem {
  id: string;
  title: string;
  placeKey?: string;
  kakaoFolderId?: number;
  href?: string;
  color?: string;
  subtitle?: string;
  kakaoNote?: string;
  localNote?: string;
}

export interface FavoriteList {
  id: string;
  name: string;
  description?: string;
  creatorName?: string;
  /** Kakao Maps user id that owns the source folder, when the import exposed one. */
  ownerId?: string;
  /** Kakao account id of the user whose signed-in session imported this list. */
  importedByUserId?: string;
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

export interface MockAuthInput {
  userId?: string;
  nickname?: string;
}

export interface PushSnapshotInput {
  deviceId: string;
  snapshot: SyncSnapshot;
}

export interface PushSnapshotListInput {
  deviceId: string;
  list: FavoriteList;
  syncedAt: string;
  source: string;
  expectedListIds?: string[];
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

export interface UpdateLocalNoteInput {
  listId: string;
  itemId: string;
  localNote: string;
}

/** An AI agent access token as listed in the PWA. The secret is never included. */
export interface AgentToken {
  id: string;
  name: string;
  tokenHint: string;
  scopes: string[];
  status: "active" | "expired";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

/** An assistant connected by signing in with Kakao (OAuth). */
export interface AgentConnection {
  id: string;
  clientName: string;
  scopes: string[];
  status: "active" | "expired";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface CreateAgentTokenInput {
  name: string;
  expiresInDays?: 30 | 90 | 365;
}

export interface CreatedAgentToken {
  /** Shown to the user once; only its hash is stored on the server. */
  token: string;
  agentToken: AgentToken;
}

export interface SyncAdapter {
  syncFavoriteLists(input: { authCode: string }): Promise<SyncSnapshot>;
}

export interface CloudSyncClient {
  exchangeKakaoCode(input: ExchangeKakaoCodeInput): Promise<CloudSession>;
  createMockSession(input?: MockAuthInput): Promise<CloudSession>;
  syncFromKakao(): Promise<PushSnapshotResult>;
  pushSnapshot(input: PushSnapshotInput): Promise<PushSnapshotResult>;
  pushSnapshotList(input: PushSnapshotListInput): Promise<PushSnapshotResult>;
  pullLatestSnapshot(): Promise<PullSnapshotResult>;
  updateLocalNote(input: UpdateLocalNoteInput): Promise<PushSnapshotResult>;
  listAgentTokens(): Promise<AgentToken[]>;
  createAgentToken(input: CreateAgentTokenInput): Promise<CreatedAgentToken>;
  revokeAgentToken(id: string): Promise<void>;
  /** Whether the server offers "sign in with Kakao" to AI assistants. */
  isAgentSignInAvailable(): Promise<boolean>;
  listAgentConnections(): Promise<AgentConnection[]>;
  revokeAgentConnection(id: string): Promise<void>;
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
          description:
            "Imported from the mock adapter as a sample overview list.",
          creatorName: "Mock User",
          updatedAt: now,
          itemCount: 3,
          items: [
            {
              id: "item-1",
              title: "Kakao onboarding notes",
              placeKey: "mock-1",
              color: "01",
              subtitle: "Mock detail line",
              kakaoNote: "Imported from mock adapter",
            },
            {
              id: "item-2",
              title: "Shared grocery ideas",
              placeKey: "mock-2",
              color: "02",
              subtitle: "Mock detail line",
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
          description: "Shortlist of places saved during local testing.",
          creatorName: "Mock User",
          updatedAt: now,
          itemCount: 2,
          items: [
            {
              id: "item-4",
              title: "Busan cafe shortlist",
              placeKey: "mock-4",
              color: "03",
              subtitle: "Mock detail line",
            },
            {
              id: "item-5",
              title: "Jeju trip draft",
              placeKey: "mock-5",
              color: "04",
              subtitle: "Mock detail line",
            },
          ],
        },
      ];

      return {
        syncedAt: now,
        source: "mock-kakao-sync-adapter",
        lists,
      };
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}
