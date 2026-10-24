# Kakao Maps Private Web Endpoints

Notes on the undocumented `map.kakao.com` endpoints the extension uses to read saved-place lists and edit Kakao notes. Kakao does not publish a public "favorite lists" API, so these were observed from the Kakao Maps web app in a signed-in browser.

> [!WARNING]
> These endpoints are unsupported. They are authorized by the signed-in Kakao Maps browser session (cookies), not by the Kakao Login REST token the sync server uses, and they can change or break whenever Kakao updates the site. They may also be subject to Kakao's terms of service.

Implementation: `apps/extension/src/kakaoMapsExtractor.ts`.

## How requests are made

- Every request runs **inside a live `map.kakao.com` tab** via `chrome.scripting.executeScript(...)`, with `credentials: "include"`, so it rides the user's Kakao Maps session. The extension needs the `scripting` permission and the `https://map.kakao.com/*` host permission.
- Imports only run when the user clicks **Import from Kakao Maps** in the popup; nothing runs automatically.

## Reading lists

### `GET /folder/list`

Returns a JSON array of folder (list) records. Observed fields:

`folderid`, `title`, `status`, `icon`, `favorite_cnt`, `created_at`, `folder_updated_at`, `kakao_map_user_id`, `map_user_id`, and for subscribed or public folders also `subscribe`, `nickname`, `profile_image`, `timeline_level`.

- Folders with `status: "D"` are deleted placeholders and are skipped on import.
- Older snapshots can still contain placeholder rows such as `Folder 2052505`, so the clients also hide them when reading.

### `GET /favorite/mine/list?folderid=<folderid>`

Returns `{ favorites: [...] }` for one folder. Observed item fields:

`seq`, `type`, `display1`, `display2`, `memo`, `key`, `x`, `y`, `home`, `color`, `folderid`, `created_at`, `item_updated_at`.

- `seq` identifies the saved favorite and becomes the imported item's `id`.
- `folderid` is stored on the item as `kakaoFolderId`. Note edits must use it rather than a folder id derived from the list id, otherwise the extension can resolve and verify against the wrong favorite even when the place `key` matches.
- `memo` is the Kakao note. It is kept separate from the user's own local note, which lives on the sync server.

Also seen on page load but not used: `GET /favorite/timestamp`, `GET /favorite/myplace/list.json`.

## Editing a Kakao note

The extension mirrors what the Kakao Maps web app sends:

1. `POST /favorite/update` with `Content-Type: application/json` and `X-Requested-With: XMLHttpRequest`:

   ```json
   { "datas": [{ "seq": 123, "display1": "…", "display2": "…", "color": "…", "memo": "…" }] }
   ```

2. The response has a request-level `status` and one entry per edited favorite in `data[]`, each with its own `status`, `last_updated_at`, and the echoed `req`. A save only counts as successful when both statuses have `code: "SUCCESS"`.
3. A best-effort `GET /favorite/home.json` follows to refresh Kakao's cache. Its failure is ignored, because the write was already accepted.
4. The extension then re-reads `GET /favorite/mine/list?folderid=<kakaoFolderId>` (up to 4 attempts, 350 ms apart) to verify that the memo was stored.

After a verified save, the extension updates its local snapshot and syncs only the changed list to the server, without a full re-import.

## Place detection in the popup

The popup switches to a place-centred view when the active tab shows a place:

- **Direct URL:** `place.map.kakao.com/<id>`.
- **Place modal on `map.kakao.com`:** a one-shot DOM probe looks for a visible anchor pointing at `place.map.kakao.com/<id>` inside the map container. The debug card reports the source as `url` or `modal`.

The modal detection depends on Kakao Maps markup. If Kakao changes the modal substantially, the selectors will need adjusting.
