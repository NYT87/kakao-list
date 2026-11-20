// Read-only endpoints magomap's server calls to import one account's saved lists, list by list
// and page by page (magomap's import contract v1). Authorised by a shared secret.
import crypto from "node:crypto";
import {
  type FavoriteList,
  type FavoriteListItem,
  type PushSnapshotResult,
  wcongnamulToLatLng,
} from "@kakao-lists/domain";
import express from "express";
import type { Pool } from "pg";
import { loadSnapshot } from "./snapshots.js";

/** Shorter secrets leave the endpoints off. */
export const MAGOMAP_SECRET_MIN_LENGTH = 32;
/**
 * Kakao favourite types magomap shows as places, with their `key` (seen on a real import,
 * 2026-11-19: PLACE, ADDRESS, POINT and ROUTE_BICYCLE). A PLACE key is a Kakao place id; an
 * ADDRESS key (`N…`/`J…`) is Kakao's address id, which magomap keeps as the place's id but
 * doesn't link to as a place page. POINT and ROUTE_BICYCLE favourites reach magomap without a
 * key, as pins at their own coordinates.
 */
export const MAGOMAP_PLACE_TYPES: ReadonlySet<string> = new Set([
  "PLACE",
  "ADDRESS",
]);
/** Largest page magomap asks for. */
export const MAGOMAP_PAGE_LIMIT = 500;

export interface MagomapListSummary {
  kakaoFolderId: number;
  name: string;
  description?: string;
  subscribed: boolean;
  ownerName?: string;
  itemCount: number;
}

export interface MagomapLists {
  contractVersion: 1;
  kakaoUserId: string;
  importedAt: string;
  complete: boolean;
  subscriptionKnown: boolean;
  lists: MagomapListSummary[];
}

export interface MagomapItem {
  favoriteSeq: string;
  favoriteType?: string;
  placeKey?: string;
  title: string;
  address?: string;
  lat?: number;
  lng?: number;
  kakaoNote?: string;
  kakaoColor?: string;
  localNote?: string;
  position: number;
}

export interface MagomapItems {
  contractVersion: 1;
  kakaoFolderId: number;
  importedAt: string;
  total: number;
  offset: number;
  items: MagomapItem[];
}

/** Drops absent fields, so the JSON carries only what is known. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;

/** Kakao's folder id from a stored list id (`kakao-folder-123`); other lists aren't Kakao's. */
function folderIdOf(list: FavoriteList): number | undefined {
  const match = /^kakao-folder-(\d{1,15})$/.exec(list.id);
  const id = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(id) ? id : undefined;
}

const kakaoLists = (stored: PushSnapshotResult) =>
  stored.snapshot.lists.flatMap((list) => {
    const kakaoFolderId = folderIdOf(list);
    return kakaoFolderId === undefined ? [] : [{ list, kakaoFolderId }];
  });

/** The account's lists, as magomap's import starts them. */
export function toMagomapLists(
  kakaoUserId: string,
  stored: PushSnapshotResult,
): MagomapLists {
  const lists = kakaoLists(stored);
  return {
    contractVersion: 1,
    kakaoUserId,
    importedAt: stored.receivedAt,
    complete: stored.snapshot.complete === true,
    // Older snapshots don't say which lists are followed: magomap then claims no ownership.
    subscriptionKnown:
      stored.snapshot.lists.length > 0 &&
      stored.snapshot.lists.every(
        (list) => typeof list.subscribed === "boolean",
      ),
    lists: lists.map(({ list, kakaoFolderId }) =>
      defined({
        kakaoFolderId,
        name: list.name,
        description: list.description,
        subscribed: list.subscribed === true,
        // The owner's name only means something on a list someone else made.
        ownerName: list.subscribed === true ? list.creatorName : undefined,
        itemCount: list.items.length,
      }),
    ),
  };
}

function toMagomapItem(
  item: FavoriteListItem,
  position: number,
  placeTypes: ReadonlySet<string> | undefined,
): MagomapItem {
  // A favourite is a place when its type says so; untyped (older) favourites keep their key.
  const isPlace =
    placeTypes === undefined ||
    item.kakaoType === undefined ||
    placeTypes.has(item.kakaoType);
  const point = wcongnamulToLatLng(item.kakaoX, item.kakaoY);
  return defined({
    favoriteSeq: item.id,
    favoriteType: item.kakaoType,
    placeKey: isPlace ? item.placeKey : undefined,
    title: item.title,
    address: item.subtitle,
    lat: point?.lat,
    lng: point?.lng,
    kakaoNote: item.kakaoNote,
    kakaoColor: item.color,
    localNote: item.localNote,
    position,
  });
}

/**
 * One page of a list's favourites, or undefined when the account has no such list. Positions
 * count across the whole list. `placeTypes` undefined (the types aren't confirmed yet) keeps
 * every favourite's place key.
 */
export function toMagomapItems(
  stored: PushSnapshotResult,
  kakaoFolderId: number,
  offset: number,
  limit: number,
  placeTypes?: ReadonlySet<string>,
): MagomapItems | undefined {
  const found = kakaoLists(stored).find(
    (l) => l.kakaoFolderId === kakaoFolderId,
  );
  if (!found) return undefined;
  const { items } = found.list;
  return {
    contractVersion: 1,
    kakaoFolderId,
    importedAt: stored.receivedAt,
    total: items.length,
    offset,
    items: items
      .slice(offset, offset + limit)
      .map((item, i) => toMagomapItem(item, offset + i, placeTypes)),
  };
}

const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest();

/** A non-negative integer query value, its default when absent, or undefined when invalid. */
function count(value: unknown, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value);
}

export function createMagomapIntegrationRouter(opts: {
  pool: Pool;
  secret: string;
  placeTypes?: ReadonlySet<string>;
}): express.Router {
  const expected = digest(`Bearer ${opts.secret}`);
  const router = express.Router();

  router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    const actual = digest(request.header("authorization") ?? "");
    if (!crypto.timingSafeEqual(actual, expected)) {
      console.warn("[magomap] refused a request without the import secret");
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  });

  /** The stored snapshot for the asked account, or an answer already sent. */
  async function snapshotFor(
    request: express.Request,
    response: express.Response,
  ) {
    const kakaoUserId = request.query.kakaoUserId;
    if (
      typeof kakaoUserId !== "string" ||
      !kakaoUserId ||
      kakaoUserId.length > 200
    ) {
      response.status(400).json({ error: "invalid" });
      return null;
    }
    const stored = await loadSnapshot(opts.pool, kakaoUserId);
    if (!stored) {
      console.info(`[magomap] ${kakaoUserId}: no_snapshot`);
      response.status(404).json({ error: "no_snapshot" });
      return null;
    }
    return { kakaoUserId, stored };
  }

  router.get("/lists", async (request, response) => {
    try {
      const found = await snapshotFor(request, response);
      if (!found) return;
      console.info(`[magomap] ${found.kakaoUserId}: lists`);
      response.json(toMagomapLists(found.kakaoUserId, found.stored));
    } catch (error) {
      console.error(
        `[magomap] lists failed: ${error instanceof Error ? error.message : error}`,
      );
      response.status(500).json({ error: "unavailable" });
    }
  });

  router.get("/lists/:kakaoFolderId/items", async (request, response) => {
    try {
      const folderId = count(request.params.kakaoFolderId, -1);
      const offset = count(request.query.offset, 0);
      const limit = count(request.query.limit, MAGOMAP_PAGE_LIMIT);
      if (
        folderId === undefined ||
        folderId < 0 ||
        offset === undefined ||
        limit === undefined ||
        limit < 1 ||
        limit > MAGOMAP_PAGE_LIMIT
      ) {
        response.status(400).json({ error: "invalid" });
        return;
      }
      const found = await snapshotFor(request, response);
      if (!found) return;
      const page = toMagomapItems(
        found.stored,
        folderId,
        offset,
        limit,
        opts.placeTypes,
      );
      if (!page) {
        console.info(`[magomap] ${found.kakaoUserId}: no list ${folderId}`);
        response.status(404).json({ error: "no_snapshot" });
        return;
      }
      console.info(
        `[magomap] ${found.kakaoUserId}: list ${folderId} from ${offset}`,
      );
      response.json(page);
    } catch (error) {
      console.error(
        `[magomap] items failed: ${error instanceof Error ? error.message : error}`,
      );
      response.status(500).json({ error: "unavailable" });
    }
  });

  return router;
}
