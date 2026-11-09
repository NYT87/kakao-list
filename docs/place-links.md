# Place Links

A **Links** section on every saved place, next to the Kakao note and the local note: a short list of web links the user adds to a place (a blog review, the menu, a reservation page, an Instagram post) without editing either note.

Status: **planned**, not started.

## What the user sees

Everywhere a place's notes are shown (the web app's list page, the extension popup, and later the map app's place card):

- A **Links** section under the notes, listing each link's title, or its site (for example `blog.naver.com`) when it has no title. Tapping a link opens it in a new tab.
- **Add link**: a URL field plus an optional title. A link without a title shows its site; the server never fetches the page to look one up. Up to **10 links per place**; at 10, the add form is replaced by "10 of 10 links".
- **Remove** on each link, with a short undo instead of a confirmation dialog, because a link is cheap to re-add.
- Links are shown **in the order they were added**; there is no reordering.
- Links on shared lists are read-only, the same rule as notes (see `docs/map-view.md`). On the user's own lists they can always be edited, whatever happens with the notes.

## Data

Links are the user's own data, like the local note. They are stored on the sync server inside the snapshot, never on Kakao.

```ts
interface PlaceLink {
  id: string;        // random id, so edits and removals target one link
  url: string;       // http or https only
  title?: string;    // optional label
  addedAt: string;   // ISO time
}

interface FavoriteListItem {
  // ...existing fields
  links?: PlaceLink[];
}
```

Validation, both in `parseSnapshot` (`@kakao-lists/domain`) and on the server:

- At most **10 links per place**.
- `url`: absolute `http:` or `https:` only, at most 1,024 characters, no credentials (`user:pass@`). Anything else (`javascript:`, `data:`, relative paths) is rejected.
- `title`: optional, trimmed, at most 100 characters, no control characters.
- Duplicate URLs on the same place are rejected.
- **At most 2,000 links per account in total.** 10 links on each of up to 20,000 places would make snapshots far larger than the server's body limit, which also holds notes and places. 2,000 links of up to about 1 KB stay well within it. The limit is shown with a clear message when reached.

## Saving

- **New endpoint** `PUT /api/snapshot/item-links` with `{ listId, itemId, links }`. It replaces the whole list for one place.
  - Same session auth, rate limit and ownership rule as `PATCH /api/snapshot/item-note`; rejected on shared lists.
  - Replacing the whole list keeps it simple: one request per change, safe to retry, and the server validates the final state in one place.
  - Concurrent edits from two devices are last-write-wins, like notes today (see `docs/architecture-decisions.md`).
- `@kakao-lists/sync` gets `updatePlaceLinks(input)`. The web app, the extension and the map app all use it.
- The server checks the per-place and per-account limits and returns `400` with a readable message.

## Keeping links across re-imports

A re-import from Kakao rebuilds every list from Kakao's data, which knows nothing about links. The extension already carries local notes over from the previous snapshot, matched by list id and place id (`PopupApp.tsx`, import). **Links must be carried over the same way**, in the same step, or every re-import would delete them.

That carry-over covers both notes and links, and a test covers it. A place moved to another list on Kakao loses its local note and links, as notes do today; that limitation is documented, not fixed here.

## AI assistants

The read-only MCP tools (`get_list`, `search_places`, `get_place`) return each place's links (title and URL), so an assistant can point to the user's saved review or menu. `search_places` also matches link titles. Assistants cannot add or change links.

## Work breakdown

1. **Domain and server**:
   - the `PlaceLink` type and validation in `parseSnapshot`;
   - `PUT /api/snapshot/item-links` with the limits, ownership rule and rate limit;
   - tests, including limits, bad URLs, shared lists and concurrent edits.
2. **Sync client**: `updatePlaceLinks`.
3. **Extension**: carry links over on re-import (with a test), plus a Links section in the popup's place view.
4. **Web app**: the Links section on the list page, with the same patterns as the notes (saving state, errors that keep the typed text, light and dark, phone width).
5. **MCP tools**: include links in place results and search.
6. **Map app**: the Links section on the place card (`docs/map-view.md`, place card).
7. **Docs**: README and this doc updated.

## Decided

- **No reordering.** Links keep the order they were added in; new links go at the end.
- **No automatic titles.** The server never fetches a linked page; a link without a title shows its site. Fetching arbitrary URLs from the server would need SSRF protection for little gain.
