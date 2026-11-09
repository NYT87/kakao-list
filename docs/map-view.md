# Map View (milestone)

A separate PWA that shows the user's saved places on a map, like Kakao Map or Google Maps, with a list picker to show or hide each saved list.

Status: **planned**, not started.

## Goals

- See every saved place on a map, coloured like in Kakao Map, for the user's own lists and for lists shared with them.
- Select or deselect lists; the map shows only the selected ones.
- Tap a place to see its name and address, open it in the Kakao Map app or on the web, and edit its Kakao note and local note in place (own lists only).
- Feel familiar to Kakao Map users, light and calm, usable on a phone first (see the design context in `AGENTS.md`).

## Decisions

| Topic | Decision |
|---|---|
| Map provider | **Both.** The Kakao Maps SDK is the default; Leaflet + OpenStreetMap is a built-in fallback (see "Map provider"). |
| Shared lists | **Shown**, next to the user's own lists. |
| Editing | **Own lists only**, for both the Kakao note and the local note, as on Kakao itself. Shared lists are read-only. |

## Data needed first

The importer drops two things the map needs. Both come from Kakao responses it already reads, so step 1 adds them, and users re-import once from the extension:

- **Coordinates.** `GET /favorite/mine/list` returns `x` and `y` for every favourite (see `docs/kakao-maps-private-api.md`), but `FavoriteListItem` has no location.
  - They look like Kakao's web-map coordinates (WCONGNAMUL), not latitude/longitude. **To confirm with a real import.**
  - The raw values are stored as `kakaoX`/`kakaoY`, so the snapshot stays faithful to Kakao.
  - A shared helper in `@kakao-lists/domain` converts them to latitude/longitude, so both map providers use the same positions. It is checked against the Kakao SDK's own conversion (`new kakao.maps.Coords(x, y).toLatLng()`) on real places.
- **Whether a list is shared.** `GET /folder/list` marks lists the user subscribes to with a `subscribe` field. The importer keeps it as `shared: true` on `FavoriteList`. The existing `ownerId` cannot tell this on its own, because Kakao's Maps profile id cannot be compared with the Kakao Login id.

Until the user re-imports: places without coordinates are counted, with a "re-import from the extension" hint, and lists without the `shared` flag are shown but not editable, with the same hint. This is the safe default.

## Map provider

**Both, with Kakao as the default.**

- **Kakao Maps SDK (default).** It looks familiar, has the best Korean map data, and includes marker clustering. It is free up to **300,000 map loads per day**, but only for the **first app on the developer account that turned Kakao Maps on**. Above that, or for any other app, requests fail with HTTP 429 unless paid billing is set up (0.1 KRW per load, through Kakao's Bizwallet). Kakao changed these rules on 2026-07-21. Before relying on this, check in the console that this app is the account's first Kakao Maps app and is within quota (Statistics → Quota).
  - Setup: in Kakao Developers, set Kakao Maps (카카오맵) → Use setting to **ON**. Use the **JavaScript key** (`VITE_KAKAO_JAVASCRIPT_KEY`), never the REST key, and register the map app's domain, plus `http://localhost:<port>` for development, as a JavaScript SDK domain for that key.
- **Leaflet + OpenStreetMap (fallback).** No key or registration, and dark tiles are possible. The map app switches to it automatically when no JavaScript key is configured, when the Kakao SDK fails to load, or when Kakao answers 429 (over quota), so the app keeps working **without ever paying**. A small note says which map is shown.
- Both providers sit behind one small map interface (show markers, cluster, fit to bounds, open a place). The rest of the app does not know which one is active.

## App shape

- **New app `apps/map`**: Vite + React PWA, like `apps/pwa`, deployed as its own Vercel project.
- It signs in with Kakao the same way as the web app, pulls the latest snapshot from the sync server (`GET /api/snapshot`), and keeps a local copy for offline viewing.
- It never imports lists; importing stays in the extension. It edits notes on the user's own lists (see "Editing notes").
- Reuses `@kakao-lists/domain`, `@kakao-lists/kakao` and `@kakao-lists/sync`.

## Screens and behaviour

- **Full-screen map**, fitted to the selected places on first load.
- **List picker**: a sheet on phones, a side panel on desktop.
  - Two sections, **My lists** and **Shared with me**. Each list has a toggle, its colour and its place count, and shared lists show the owner's name.
  - "Show all" and "Hide all", per section and overall. The selection is remembered on the device.
- **Markers** coloured by the Kakao colour of each place, as in the web app. Nearby markers cluster when zoomed out, so large lists stay readable.
- **Place card** on tap: name, address (`subtitle`), the list it belongs to (marked "Shared" when it is), links to Kakao, and both notes. The notes are editable on own lists and read-only on shared ones.
- **"Fit to selection"** and an optional **"My location"** button (asks for permission only when tapped).
- **Empty and partial states**: no snapshot yet (import with the extension), no list selected, places without a location (re-import), lists without ownership info (re-import to edit).
- **Accessibility**: the list picker and place card are fully keyboard- and screen-reader-usable. A plain list of the visible places is available alongside the map, because markers alone are not accessible.

## Place card: Kakao links

Built from the place's Kakao id (`placeKey`):

- **Open in Kakao Map app**: `kakaomap://place?id=<placeKey>`. Shown on phones; if the app is not installed, the page falls back to the web link after a short delay.
- **Open on the web**: `https://place.map.kakao.com/<placeKey>`, shown everywhere, opened in a new tab.
- Places without a `placeKey` show neither link and say why.

## Editing notes

**Only on the user's own lists** (`shared` is `false`). On shared lists, both notes are read-only. The rule is enforced in the map app, in the extension, and on the server for local notes, so it can't be bypassed by calling the API directly.

Each place has two notes, and they are saved in different places:

| Note | Saved to | How the map app saves it |
|---|---|---|
| **Local note** (the user's own) | the sync server | Directly, with the existing `PATCH /api/snapshot/item-note` (`updateLocalNote` in `@kakao-lists/sync`), the same call the web app uses. Works everywhere. The server rejects notes on shared lists. |
| **Kakao note** (`memo`, shown in Kakao Map too) | Kakao | Only through the extension. Kakao accepts note edits only from a signed-in Kakao Maps browser session, which neither the map app nor the server has (see `docs/kakao-maps-private-api.md`). |

Kakao note editing, by situation:

- **Desktop browser with the extension installed:** the map app sends the edit to the extension with `chrome.runtime.sendMessage(<extension id>, …)`. The extension saves it with its existing verified flow (`updateKakaoFavoriteNote`: write in a `map.kakao.com` tab, re-read to confirm), syncs the changed list to the server, and replies with the result. The map app then updates the card and its local copy.
  - The extension must list the map app's origin under `externally_connectable` in its manifest, and accept only that origin.
  - It must also check that the message is well-formed, that the place exists in one of the user's own lists in its snapshot, and that its signed-in Kakao user is the same as the map app's. That way a web page can never make it edit shared lists or someone else's notes.
  - If Kakao Maps isn't signed in in that browser, the reply says so and the card tells the user to sign in to Kakao Maps.
- **Phones, or without the extension:** the Kakao note is shown read-only, with "Edit in Kakao Map" (the app or web link above). The next import brings the change back.
- The map app detects the extension by sending it a version ping; no reply means the read-only path.

Saving shows progress and an error the user can act on, and never loses the typed text if the save fails.

## Work breakdown

1. **Data** (`packages/domain`, `apps/extension`, `apps/server`):
   - add `kakaoX`/`kakaoY` to `FavoriteListItem` and `shared` to `FavoriteList`, and keep `x`/`y` and `subscribe` on import;
   - add the coordinate conversion helper and confirm the coordinate system with a real import;
   - have the server reject local-note edits on shared lists;
   - test that the new fields survive sync. Snapshots are stored as JSON, so storage needs no change.
2. **App scaffold** (`apps/map`): Vite PWA, manifest and icons, Kakao sign-in and session, snapshot loading and local cache, workspace and CI wiring.
3. **Map and list picker**:
   - the map interface with Kakao and Leaflet implementations, plus the automatic fallback;
   - markers from the selected lists;
   - the picker with "My lists" and "Shared with me", the remembered selection, and fitting to the selection.
4. **Place card**:
   - Kakao app and web links;
   - local note editing through the sync server;
   - Kakao note editing through the extension (`externally_connectable`, message validation, the own-list and same-user checks, a ping to detect the extension, and the read-only fallback);
   - read-only notes on shared lists.
5. **Polish**: clustering, empty and partial states, the accessible place list, light and dark UI chrome, phone and desktop layouts.
6. **Ship**: Vercel project; the domain registered for Kakao Login (redirect URI) and for the JavaScript key (JavaScript SDK domain); Kakao Maps turned on; README and this doc updated.

## Open questions

- Domain for the map app (e.g. a new `*.vercel.app` project), so it can be registered in Kakao Developers.
- Is this Kakao app the first one on the developer account with Kakao Maps turned on, so it gets the free quota? If not, the app still works on the Leaflet fallback.
- Later: queue Kakao note edits made on a phone and have the extension apply them the next time it runs? That would reuse the request-queue idea from agent-access phase 3.
