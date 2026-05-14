import type { FavoriteList, FavoriteListItem, SyncSnapshot } from "@kakao-lists/domain";

const KAKAO_MAPS_URL_PATTERNS = ["https://map.kakao.com/*"];

interface KakaoMapsFolderRecord {
  folderid?: number;
  title?: string;
  memo?: string;
  status?: string;
  icon?: string;
  favorite_cnt?: number;
  created_at?: string;
  folder_updated_at?: string;
  nickname?: string;
  kakao_map_user_id?: string;
  map_user_id?: string;
}

interface KakaoMapsFavoriteRecord {
  seq?: number;
  type?: string;
  display1?: string;
  display2?: string;
  memo?: string;
  key?: string;
  x?: number;
  y?: number;
  color?: string;
  folderid?: number;
  created_at?: string;
  item_updated_at?: string;
}

interface KakaoMapsFolderFavoritesResponse {
  favorites?: KakaoMapsFavoriteRecord[];
}

interface TabSnapshotExtractionResult {
  snapshot: SyncSnapshot;
  folderCount: number;
  placeCount: number;
  folderIds: number[];
}

interface PageExtractionEnvelope {
  ok: boolean;
  result?: TabSnapshotExtractionResult;
  error?: string;
  pageHref?: string;
  responsePreview?: string;
}

export interface ExtractedKakaoMapsSnapshot {
  snapshot: SyncSnapshot;
  folderCount: number;
  placeCount: number;
  folderIds: number[];
  tabId: number;
  tabTitle?: string;
  tabUrl?: string;
  debug: string[];
}

export async function extractSnapshotFromKakaoMapsTab(): Promise<ExtractedKakaoMapsSnapshot | null> {
  const tab = await findKakaoMapsTab();
  if (!tab?.id) {
    return null;
  }

  const debug = [`found-tab:${tab.id}`, `title:${tab.title ?? "unknown"}`, `url:${tab.url ?? "unknown"}`];

  const [{ result }] = await chrome.scripting.executeScript({
    target: {
      tabId: tab.id
    },
    world: "MAIN",
    func: extractSnapshotInPageEnvelope
  });

  if (!result) {
    throw new Error("Kakao Maps extraction returned no data. Reload the Kakao Maps tab and try again.");
  }

  const envelope = result as PageExtractionEnvelope;
  if (!envelope.ok || !envelope.result) {
    throw new Error(
      envelope.error
        ? `Kakao Maps page error: ${envelope.error}${envelope.pageHref ? ` @ ${envelope.pageHref}` : ""}${
            envelope.responsePreview ? ` | preview: ${envelope.responsePreview}` : ""
          }`
        : "Kakao Maps extraction returned no structured result."
    );
  }

  return {
    ...envelope.result,
    tabId: tab.id,
    tabTitle: tab.title ?? undefined,
    tabUrl: tab.url ?? undefined,
    debug: [
      ...debug,
      `page-href:${envelope.pageHref ?? tab.url ?? "unknown"}`,
      `folder-count:${envelope.result.folderCount}`,
      `place-count:${envelope.result.placeCount}`,
      `folder-ids:${envelope.result.folderIds.slice(0, 12).join(",") || "none"}`
    ]
  };
}

async function findKakaoMapsTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({
    url: KAKAO_MAPS_URL_PATTERNS
  });

  if (tabs.length === 0) {
    return null;
  }

  const activeInCurrentWindow = tabs.find((tab) => tab.active && tab.lastAccessed !== undefined);
  if (activeInCurrentWindow) {
    return activeInCurrentWindow;
  }

  return (
    tabs
      .slice()
      .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null
  );
}

async function extractSnapshotInPageEnvelope(): Promise<PageExtractionEnvelope> {
  try {
    const fetchJson = async <T>(path: string): Promise<T> => {
      const response = await fetch(new URL(path, window.location.origin).toString(), {
        credentials: "include",
        headers: {
          Accept: "application/json"
        }
      });

      const raw = await response.text();
      if (!response.ok) {
        throw new Error(
          `Kakao Maps request failed for ${path} with status ${response.status}. Response preview: ${raw.slice(0, 180)}`
        );
      }

      try {
        return JSON.parse(raw) as T;
      } catch {
        throw new Error(`Kakao Maps returned non-JSON for ${path}. Response preview: ${raw.slice(0, 180)}`);
      }
    };

    const metadataScore = (record: KakaoMapsFolderRecord): number => {
      let score = 0;
      if (record.title) score += 3;
      if (record.favorite_cnt !== undefined) score += 2;
      if (record.folder_updated_at) score += 1;
      return score;
    };

    const dedupeFolders = (
      records: KakaoMapsFolderRecord[]
    ): Array<Required<Pick<KakaoMapsFolderRecord, "folderid">> & KakaoMapsFolderRecord> => {
      const byId = new Map<number, KakaoMapsFolderRecord>();

      for (const record of records) {
        if (typeof record.folderid !== "number") {
          continue;
        }
        if (record.status === "D") {
          continue;
        }

        const current = byId.get(record.folderid);
        if (!current) {
          byId.set(record.folderid, record);
          continue;
        }

        byId.set(record.folderid, metadataScore(record) >= metadataScore(current) ? record : current);
      }

      return Array.from(byId.entries()).map(([folderid, record]) => ({
        folderid,
        ...record
      }));
    };

    const normalizeFavoriteItem = (
      folderId: number,
      favorite: KakaoMapsFavoriteRecord,
      index: number
    ): FavoriteListItem => {
      return {
        id: String(favorite.seq ?? favorite.key ?? `${folderId}-${index}`),
        title: favorite.display1?.trim() || `Saved place ${index + 1}`,
        placeKey: favorite.key?.trim() || undefined,
        href: favorite.key ? `https://place.map.kakao.com/${favorite.key}` : undefined,
        color: favorite.color?.trim() || undefined,
        subtitle: favorite.display2?.trim() || undefined,
        kakaoNote: favorite.memo?.trim() || undefined,
        localNote: undefined
      };
    };

    const resolveListUpdatedAt = (
      folder: KakaoMapsFolderRecord,
      favorites: KakaoMapsFavoriteRecord[],
      fallback: string
    ): string => {
      const timestamps = [
        folder.folder_updated_at,
        ...favorites.map((favorite) => favorite.item_updated_at),
        folder.created_at,
        ...favorites.map((favorite) => favorite.created_at)
      ].filter((value): value is string => Boolean(value));

      const latest = timestamps
        .map((value) => Date.parse(value))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => right - left)[0];

      return latest ? new Date(latest).toISOString() : fallback;
    };

    const now = new Date().toISOString();
    const folderPayload = await fetchJson<unknown>("/folder/list");
    const folderRecords = Array.isArray(folderPayload)
      ? (folderPayload as KakaoMapsFolderRecord[])
      : Array.isArray((folderPayload as { folders?: unknown }).folders)
        ? ((folderPayload as { folders: KakaoMapsFolderRecord[] }).folders)
        : null;

    if (!folderRecords) {
      throw new Error(
        `Unexpected /folder/list payload shape: ${JSON.stringify(folderPayload).slice(0, 180)}`
      );
    }

    const folders = dedupeFolders(folderRecords);

    const folderFavorites = await Promise.all(
      folders.map(async (folder) => {
        const payload = await fetchJson<unknown>(
          `/favorite/mine/list?folderid=${folder.folderid}`
        );

        const favorites = Array.isArray((payload as { favorites?: unknown }).favorites)
          ? ((payload as { favorites: KakaoMapsFavoriteRecord[] }).favorites)
          : Array.isArray(payload)
            ? (payload as KakaoMapsFavoriteRecord[])
            : null;

        if (!favorites) {
          throw new Error(
            `Unexpected /favorite/mine/list payload for folder ${folder.folderid}: ${JSON.stringify(payload).slice(0, 180)}`
          );
        }

        return {
          folder,
          favorites
        };
      })
    );

    const lists: FavoriteList[] = folderFavorites.map(({ folder, favorites }) => {
      const items = favorites.map((favorite, index) =>
        normalizeFavoriteItem(folder.folderid, favorite, index)
      );

      return {
        id: `kakao-folder-${folder.folderid}`,
        name: folder.title?.trim() || `Folder ${folder.folderid}`,
        description: folder.memo?.trim() || favorites[0]?.display2?.trim() || undefined,
        creatorName:
          folder.nickname?.trim() ||
          folder.kakao_map_user_id?.trim() ||
          (folder.map_user_id ? `map:${folder.map_user_id}` : undefined),
        updatedAt: resolveListUpdatedAt(folder, favorites, now),
        itemCount: items.length,
        items
      };
    });

    return {
      ok: true,
      result: {
        snapshot: {
          syncedAt: now,
          source: "kakao-maps-private-web",
          lists
        },
        folderCount: lists.length,
        placeCount: lists.reduce((total, list) => total + list.itemCount, 0),
        folderIds: lists
          .map((list) => Number(list.id.replace("kakao-folder-", "")))
          .filter(Number.isFinite)
      },
      pageHref: window.location.href
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      pageHref: window.location.href,
      responsePreview: error instanceof Error ? undefined : String(error)
    };
  }
}
