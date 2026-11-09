# Place Links

A **Links** section on every saved place, next to the Kakao note and the local note: a short list of web links the user adds to a place (a blog review, the menu, a reservation page, an Instagram post) without editing either note.

Status: **planned**, not started. **Depends on `docs/place-storage.md`**, which stores places as their own records; links are a column of a place there.

## What the user sees

Everywhere a place's notes are shown (the web app's list page, the extension popup, and later the map app's place card):

- A **Links** section under the notes, listing each link's title, or its site (for example `blog.naver.com`) when it has no title. Tapping a link opens it in a new tab.
- **Add link**: a URL field plus an optional title. A link without a title shows its site; the server never fetches the page to look one up. Up to **10 links per place**; at 10, the add form is replaced by "10 of 10 links".
- **Remove** on each link, with a short undo instead of a confirmation dialog, because a link is cheap to re-add.
- Links are shown **in the order they were added**; there is no reordering.
- Links belong to the **place, one list per user**, like the local note. A place in several lists shows the same links in each.
- They can be edited when the place is in at least one of the user's own lists, and are read-only for places that are only in shared lists (the rule from `docs/map-view.md`). Places removed from Kakao keep their links, which stay editable.

## Data

Links are the user's own data, like the local note: stored on the sync server, on the place record from `docs/place-storage.md`, never on Kakao.

```ts
interface PlaceLink {
  id: string;        // random id, so edits and removals target one link
  url: string;       // http or https only
  title?: string;    // optional label
  addedAt: string;   // ISO time
}

interface Place {
  // ...fields from docs/place-storage.md
  links: PlaceLink[];
}
```

Validation, in `@kakao-lists/domain` and again on the server:

- At most **10 links per place**.
- `url`: absolute `http:` or `https:` only, at most 1,024 characters, no credentials (`user:pass@`). Anything else (`javascript:`, `data:`, relative paths) is rejected.
- `title`: optional, trimmed, at most 100 characters, no control characters.
- Duplicate URLs on the same place are rejected.

With places stored as their own rows, there is no account-wide cap: the earlier 2,000-link limit only existed because everything shared one snapshot document.

## Saving

- `PUT /api/places/:id/links` with `{ links }`, from `docs/place-storage.md`. It replaces the whole list for one place.
  - Same session auth, rate limit and ownership rule as the local note; rejected for places that are only in shared lists.
  - Replacing the whole list keeps it simple: one request per change, safe to retry, and the server validates the final state in one place.
  - It writes one row, so it doesn't conflict with an import running at the same time. Two devices editing the same place's links at once is last-write-wins.
- `@kakao-lists/sync` gets `updatePlaceLinks(placeId, links)`. The web app, the extension and the map app all use it.
- The server checks the limits and returns `400` with a readable message.

## Imports

Imports never touch links. A sync run updates lists, places and memberships from Kakao, but the local note and links are ours and are left as they are. A place that is moved between lists, or removed from Kakao, keeps its links. No carry-over code is needed.

## AI assistants

The read-only MCP tools (`get_list`, `search_places`, `get_place`) return each place's links (title and URL), so an assistant can point to the user's saved review or menu. `search_places` also matches link titles. Assistants cannot add or change links.

## Work breakdown

Starts after `docs/place-storage.md` is done.

1. **Domain and server**:
   - the `PlaceLink` type and validation;
   - the `links` column on places and `PUT /api/places/:id/links`, with the limits, ownership rule and rate limit;
   - tests: limits, bad URLs, shared-only places, removed places, and an import leaving links untouched.
2. **Sync client**: `updatePlaceLinks`.
3. **Extension**: a Links section in the popup's place view.
4. **Web app**: the Links section on the place view, with the same patterns as the notes (saving state, errors that keep the typed text, light and dark, phone width).
5. **MCP tools**: include links in place results and search.
6. **Map app**: the Links section on the place card (`docs/map-view.md`, place card).
7. **Docs**: README and this doc updated.

## Decided

- **No reordering.** Links keep the order they were added in; new links go at the end.
- **No automatic titles.** The server never fetches a linked page; a link without a title shows its site. Fetching arbitrary URLs from the server would need SSRF protection for little gain.
