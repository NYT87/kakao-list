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
  logout(allDevices?: boolean): Promise<void>;
  deleteAccount(): Promise<void>;
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

export const SNAPSHOT_LIMITS = {
  lists: 500,
  itemsPerList: 5000,
  totalItems: 20000,
  note: 500,
} as const;

export function parseSnapshot(value: unknown): SyncSnapshot {
  const record = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Expected an object.");
    return input as Record<string, unknown>;
  };
  const text = (
    input: unknown,
    max: number,
    optional = false,
  ): string | undefined => {
    if (optional && input === undefined) return undefined;
    if (
      typeof input !== "string" ||
      input.length > max ||
      (!optional && !input.trim()) ||
      Array.from(input).some(
        (char) =>
          char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)),
      )
    )
      throw new Error("Invalid text field.");
    return input;
  };
  const date = (input: unknown): string => {
    const result = text(input, 40) as string;
    if (!Number.isFinite(Date.parse(result))) throw new Error("Invalid date.");
    return result;
  };
  const root = record(value);
  if (!Array.isArray(root.lists) || root.lists.length > SNAPSHOT_LIMITS.lists)
    throw new Error("Invalid lists collection.");
  const ids = new Set<string>();
  let total = 0;
  const lists = root.lists.map((input) => {
    const list = record(input);
    const id = text(list.id, 200) as string;
    if (ids.has(id)) throw new Error("Duplicate list id.");
    ids.add(id);
    if (
      !Array.isArray(list.items) ||
      list.items.length > SNAPSHOT_LIMITS.itemsPerList
    )
      throw new Error("Invalid places collection.");
    total += list.items.length;
    if (total > SNAPSHOT_LIMITS.totalItems)
      throw new Error("Too many saved places.");
    const itemIds = new Set<string>();
    const items = list.items.map((input) => {
      const item = record(input);
      const itemId = text(item.id, 200) as string;
      if (itemIds.has(itemId)) throw new Error("Duplicate place id.");
      itemIds.add(itemId);
      const href = text(item.href, 2048, true);
      if (href) {
        let url: URL;
        try {
          url = new URL(href);
        } catch {
          throw new Error("Invalid place link.");
        }
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error("Place links must use HTTPS without credentials.");
      }
      if (
        item.kakaoFolderId !== undefined &&
        (!Number.isSafeInteger(item.kakaoFolderId) ||
          Number(item.kakaoFolderId) < 0)
      )
        throw new Error("Invalid folder id.");
      return {
        id: itemId,
        title: text(item.title, 1000) as string,
        placeKey: text(item.placeKey, 200, true),
        kakaoFolderId: item.kakaoFolderId as number | undefined,
        href,
        color: text(item.color, 40, true),
        subtitle: text(item.subtitle, 5000, true),
        kakaoNote: text(item.kakaoNote, 5000, true),
        localNote: text(item.localNote, SNAPSHOT_LIMITS.note, true),
      };
    });
    if (!Number.isInteger(list.itemCount) || list.itemCount !== items.length)
      throw new Error("Place count does not match the list.");
    return {
      id,
      name: text(list.name, 1000) as string,
      description: text(list.description, 5000, true),
      creatorName: text(list.creatorName, 1000, true),
      ownerId: text(list.ownerId, 200, true),
      importedByUserId: text(list.importedByUserId, 200, true),
      updatedAt: date(list.updatedAt),
      itemCount: items.length,
      items,
    };
  });
  return {
    syncedAt: date(root.syncedAt),
    source: text(root.source, 200) as string,
    lists,
  };
}

export function isCloudSession(value: unknown): value is CloudSession {
  if (!value || typeof value !== "object") return false;
  const s = value as CloudSession;
  return (
    typeof s.token === "string" &&
    s.token.length > 0 &&
    typeof s.user?.id === "string" &&
    s.user.id.length > 0 &&
    typeof s.expiresAt === "string" &&
    Number.isFinite(Date.parse(s.expiresAt)) &&
    Date.parse(s.expiresAt) > Date.now()
  );
}

export function noteKey(listId: string, itemId: string): string {
  return JSON.stringify([listId, itemId]);
}

/** Refresh clean fields, retaining edits made since their last server value. */
export function reconcileDrafts(
  drafts: Record<string, string>,
  previous: Record<string, string>,
  next: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [
      key,
      key in drafts && drafts[key] !== (previous[key] ?? "")
        ? drafts[key]
        : value,
    ]),
  );
}
