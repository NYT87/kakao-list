# Place Storage (refactor)

Store lists and places as their own records on the sync server, instead of one JSON snapshot per user. A Kakao import becomes a **sync run** that updates those records, so the server manages the places: a place removed from Kakao is kept with its notes (marked "removed from Kakao") instead of disappearing.

Status: **planned**, not started.

## Why

Today the server keeps one JSON document per user (`latest_snapshots`, `apps/server/src/snapshots.ts`), and every import replaces it list by list. That causes:

- **Lost notes.** Local notes are carried over by list id and favourite id (`preserveLocalNotes`). When a place is removed from a list on Kakao, or moved to another list, the import drops it and its local note with it.
- **No history of the places themselves.** The server can't say when a place was added, or that it was removed.
- **Whole-document writes.** Every note edit rewrites the whole snapshot, and every client downloads all of it. Planned features make this worse: links (`docs/place-links.md`) needed an account-wide cap because of the document size, and the map app (`docs/map-view.md`) needs per-place data.
- **Coarse concurrency.** Writes are last-write-wins on the whole document.

## Data model

All tables are scoped by `kakao_user_id`, like today.

| Table | One row per | Main columns |
|---|---|---|
| `lists` | Kakao folder | Kakao folder id, name, description, owner and owner name, `shared`, colour/icon, `first_seen_run_id`, `last_seen_run_id`, `removed_at` |
| `places` | Kakao place (`placeKey`), per user | title, address (`subtitle`), category, coordinates (`kakaoX`/`kakaoY`), Kakao link, **local note**, **links**, `first_seen_at` |
| `list_items` | place in a list (a Kakao favourite) | list, place, Kakao favourite id (`seq`), Kakao note (`memo`), colour, `first_seen_run_id`, `last_seen_run_id`, `removed_at` |
| `sync_runs` | import | started and finished time, device, status (`running`, `completed`, `failed`), counts (lists and places added, updated, removed, restored) |

- **A place is separate from its list membership.** The same Kakao place saved in two lists is one `places` row with two `list_items`.
- **Kakao notes are per list**, as in Kakao: each membership keeps its own Kakao note. A place in several lists shows each list's Kakao note, labelled with the list, and each can be edited on the user's own lists.
- **The local note and links are one per place and user**: they follow the place across lists, and survive it being moved or removed.
- Kakao favourites without a place id (custom pins) get a place keyed by their favourite id, so they behave the same.
- `snapshot_history` is no longer needed once the run counts exist; it is dropped at the end of the migration.

## Sync runs

The extension still does the import (only it can read Kakao Maps). The server turns uploads into record changes:

1. **Start** a run: `POST /api/sync-runs` returns a run id. Only one run per user at a time; a new one supersedes a stale one.
2. **Upload each list**: `PUT /api/sync-runs/:id/lists/:kakaoFolderId`, same chunking as today. For that list, in one transaction:
   - upsert the list and its places;
   - add memberships that are new; update the Kakao note, colour and position of existing ones; stamp all of them `last_seen_run_id`;
   - memberships of that list **not** in the upload get `removed_at`. They are **not deleted**: the place, its local note and links stay.
   - a membership that was removed and appears again is **restored** (`removed_at` cleared), and counted as such.
3. **Complete** the run: `POST /api/sync-runs/:id/complete` with the full list of Kakao folder ids. Lists not in it get `removed_at`, again without deleting anything. A run that never completes (the browser closed, an error) marks nothing as removed from the lists it didn't reach, so a half-finished import can never remove places by mistake.

This keeps today's safety rule (`expectedListIds` on the final chunk) and adds the record of what changed.

### What "version" means

Each run is a version. Every list and membership records the run that last saw it, so the server can answer:

- what changed in the last import (added, removed, restored), shown as a short summary after an import;
- which places were removed from Kakao, and since which import.

## Removed places

- They **keep showing in the lists they were originally added to**, at the end and **marked "Removed from Kakao"**, with their Kakao note for that list, their local note and their links.
- **They are kept until the user forgets them**; nothing is deleted automatically.
- **Forget**: the user can delete a removed place for good, with its notes and links. That's the only way places are ever deleted, apart from deleting the account.
- If the place comes back in Kakao, it is restored automatically.
- A removed membership's Kakao note is kept read-only (Kakao no longer has it). The local note and links stay editable.
- Lists removed from Kakao work the same way: kept, marked, and can be forgotten.

## API

| Now | After |
|---|---|
| `GET /api/snapshot` (everything) | `GET /api/lists` (lists with counts), `GET /api/lists/:id/places` (paginated), `GET /api/places/:id`, `GET /api/sync-runs/latest` |
| `PUT /api/snapshot`, `PUT /api/snapshot/list` | the sync-run endpoints above |
| `PATCH /api/snapshot/item-note` | `PATCH /api/places/:id` (local note), `PUT /api/places/:id/links`; Kakao note edits from the extension update the membership |
| — | `DELETE /api/places/:id` (forget a removed place), `DELETE /api/lists/:id` (forget a removed list) |

- Writes touch one row each, so a note edit no longer conflicts with an import running at the same time.
- The MCP tools (`apps/server/src/agentQueries.ts`) query the tables directly. Search becomes a SQL query instead of scanning the snapshot. The tools also report removed places, marked as such.
- Same session auth, rate limits and own-list rules as today.

## Clients

- **Extension:** the import uses sync runs. Kakao note edits update one membership. Its local copy becomes a cache of the new read endpoints.
- **Web app:** reads lists and places from the new endpoints and caches them for offline use. Removed places are shown marked in their original lists, with Forget, and a short "what changed" summary appears after an import. A place's view shows one Kakao note per list it is in.
- **Map app** (`docs/map-view.md`): uses the new endpoints. Removed places stay on the map with their lists, drawn as removed. The place card shows one Kakao note per list.
- **Place links** (`docs/place-links.md`): stored on `places`. The 2,000-per-account cap, which existed only because of the snapshot size, can go up; 10 per place stays.

## Migration and rollout

The extension auto-updates, but not instantly, and the web app may be cached. So both models run side by side for one release:

1. **Tables and backfill.** Create the tables. A one-off backfill turns each user's latest snapshot into a completed "migrated" sync run: lists, places, memberships, local notes. Places with the same Kakao place id in several lists become one place. If their local notes differ, they are joined into one note, with each list name as a heading. Nothing is lost.
2. **New endpoints, dual write.** Add the sync-run, read and note endpoints. While old clients exist, `GET /api/snapshot` is built from the tables and the old write endpoints are translated into sync runs, so old extensions keep working.
3. **Clients switch.** The extension, web app and MCP tools move to the new endpoints, released together.
4. **Remove the old model.** After a release with no old-endpoint traffic (the logs show it), remove the snapshot endpoints and drop `latest_snapshots` and `snapshot_history`.

The backfill and every step are tested against Postgres: the backfill is idempotent and keeps every local note; a run that never completes removes nothing; removed places keep their notes and come back when restored; concurrent runs and edits behave as described.

## Order with the other plans

This comes **first**. `docs/place-links.md` and `docs/map-view.md` both build on it, so they don't have to be written for the snapshot and moved later. The import captures what they need here: coordinates (`kakaoX`/`kakaoY` on places) and the shared flag (on lists), and the local note and links live on places.

## Decided

- **Kakao notes per list, our local note and links per place and user.** Kakao keeps a note per favourite, so a place shows each list's Kakao note; the local note and links are one per place, following it across lists. Migration joins differing local notes as described above.
- **Removed places are kept** until the user forgets them; nothing expires.
- **Removed places keep showing in the lists they were originally added to**, marked "Removed from Kakao".
