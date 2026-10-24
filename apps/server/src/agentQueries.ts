import type {
  FavoriteList,
  FavoriteListItem,
  SyncSnapshot,
} from "@kakao-lists/domain";

// Read-only views over a user's snapshot, shaped for AI agents (MCP tools).
// Results are filtered and paginated here so agents never receive the whole
// snapshot, and internal Kakao fields (color, folder ids) are left out.

export const LIST_PAGE_DEFAULT_LIMIT = 50;
export const LIST_PAGE_MAX_LIMIT = 100;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

export interface ListSummary {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;
  placeCount: number;
}

export interface PlaceView {
  listId: string;
  listName: string;
  id: string;
  title: string;
  subtitle?: string;
  kakaoNote?: string;
  localNote?: string;
  url?: string;
}

export interface ListsOverview {
  syncedAt: string | null;
  lists: ListSummary[];
}

export interface ListPage {
  syncedAt: string;
  list: ListSummary;
  total: number;
  offset: number;
  limit: number;
  nextOffset: number | null;
  places: PlaceView[];
}

export interface SearchResult {
  syncedAt: string | null;
  total: number;
  limit: number;
  places: PlaceView[];
}

export function summarizeLists(snapshot: SyncSnapshot | null): ListsOverview {
  if (!snapshot) {
    return { syncedAt: null, lists: [] };
  }

  return {
    syncedAt: snapshot.syncedAt,
    lists: snapshot.lists.map(toListSummary),
  };
}

export function getListPage(
  snapshot: SyncSnapshot | null,
  listId: string,
  options: { limit?: number; offset?: number },
): ListPage | null {
  const list = snapshot?.lists.find((candidate) => candidate.id === listId);
  if (!snapshot || !list) {
    return null;
  }

  const limit = clampInteger(
    options.limit,
    1,
    LIST_PAGE_MAX_LIMIT,
    LIST_PAGE_DEFAULT_LIMIT,
  );
  const offset = clampInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const total = list.items.length;
  const end = offset + limit;

  return {
    syncedAt: snapshot.syncedAt,
    list: toListSummary(list),
    total,
    offset,
    limit,
    nextOffset: end < total ? end : null,
    places: list.items
      .slice(offset, end)
      .map((item) => toPlaceView(list, item)),
  };
}

export function searchPlaces(
  snapshot: SyncSnapshot | null,
  options: { query: string; listId?: string; limit?: number },
): SearchResult {
  const limit = clampInteger(
    options.limit,
    1,
    SEARCH_MAX_LIMIT,
    SEARCH_DEFAULT_LIMIT,
  );
  const terms = normalizeText(options.query).split(/\s+/).filter(Boolean);
  if (!snapshot || terms.length === 0) {
    return {
      syncedAt: snapshot?.syncedAt ?? null,
      total: 0,
      limit,
      places: [],
    };
  }

  const matches: PlaceView[] = [];
  for (const list of snapshot.lists) {
    if (options.listId && list.id !== options.listId) {
      continue;
    }

    for (const item of list.items) {
      const haystack = normalizeText(
        [item.title, item.subtitle, item.kakaoNote, item.localNote]
          .filter(Boolean)
          .join(" "),
      );
      if (terms.every((term) => haystack.includes(term))) {
        matches.push(toPlaceView(list, item));
      }
    }
  }

  return {
    syncedAt: snapshot.syncedAt,
    total: matches.length,
    limit,
    places: matches.slice(0, limit),
  };
}

export function findPlace(
  snapshot: SyncSnapshot | null,
  listId: string,
  itemId: string,
): PlaceView | null {
  const list = snapshot?.lists.find((candidate) => candidate.id === listId);
  const item = list?.items.find((candidate) => candidate.id === itemId);
  return list && item ? toPlaceView(list, item) : null;
}

function toListSummary(list: FavoriteList): ListSummary {
  return withoutUndefined({
    id: list.id,
    name: list.name,
    description: list.description,
    updatedAt: list.updatedAt,
    placeCount: list.items.length,
  });
}

function toPlaceView(list: FavoriteList, item: FavoriteListItem): PlaceView {
  return withoutUndefined({
    listId: list.id,
    listName: list.name,
    id: item.id,
    title: item.title,
    subtitle: item.subtitle,
    kakaoNote: item.kakaoNote,
    localNote: item.localNote,
    url: item.href,
  });
}

// Case- and accent-insensitive. NFKD also splits Hangul syllables into jamo,
// which is harmless because both sides are normalized the same way.
function normalizeText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
) {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}
