# Architecture Decisions

Durable decisions and constraints behind the current design, collected from past planning notes. The README covers setup and the high-level layout; this file explains why things are the way they are. Agent access (MCP) has its own design doc: [agent-access.md](agent-access.md). Kakao Maps endpoints: [kakao-maps-private-api.md](kakao-maps-private-api.md).

## Data and sync

- **One snapshot per Kakao user.** The server stores the latest snapshot as one JSONB document per Kakao user id (`latest_snapshots`) plus history rows (`snapshot_history`). Lists are not normalized into their own tables.
- **Whole-snapshot, last-write-wins sync.** Simple to reason about and verify. Versioned merge logic is only worth adding if concurrent multi-device edits become important.
- **Chunked uploads.** `PUT /api/snapshot/list` uploads one list at a time; the server merges it into the stored snapshot. The final chunk carries `expectedListIds` so the server can prune lists that were deleted on Kakao without the client sending the whole snapshot.
- **Body limit.** Imported snapshots outgrew the original `1mb` Express limit; it is now `JSON_BODY_LIMIT` (default `10mb`).
- **Local first on import.** The extension saves an imported snapshot to its own storage before uploading. If the upload fails, the import is kept and the UI reports a partial success with the server error.
- **Two kinds of notes.** Kakao notes (`memo`) are imported data and are edited on Kakao itself; local notes are the user's own and are stored on the sync server (`PATCH /api/snapshot/item-note`).
- **Schema on startup.** The server creates its Postgres tables with `CREATE TABLE IF NOT EXISTS` on startup or cold start, behind a one-time readiness guard. There is no separate migration tool, so `DATABASE_URL` must point to a writable database before the first request.
- **No shared browser database.** The extension and the PWA run in different origins and storage sandboxes, so each keeps its own local copy behind shared repository contracts. The server is what moves data between devices.

## Roles of each client

- **The extension is the only importer.** Kakao Maps list data is only reachable with the browser's Kakao Maps session, which the extension can use and the PWA and server cannot. It imports only when the user asks.
- **The PWA is a read-only viewer** of the latest server snapshot. It does not create snapshots, so it never competes with the extension as an importer.
- **The popup stays import-focused.** Account and data management (pull server data, sign out, clear local data) live on the options page.

## Authentication

- **The server derives identity.** The browser obtains a Kakao authorization code; the server exchanges it, calls Kakao user-info (`/v2/user/me`), and uses the Kakao user id as the only storage scope. Clients never send an account id.
- **Kakao-backed sessions.** Clients hold a server-signed session token. On protected routes the server also re-validates the stored Kakao access token with Kakao, refreshes it with the refresh token when needed, and rejects the request if the Kakao identity can't be re-proven. Clients never handle raw Kakao tokens.
- **Extension sign-in runs in the background worker.** Chrome can close the popup during the external OAuth consent, so `chrome.identity.launchWebAuthFlow` is driven from the background worker and the session is stored in `chrome.storage.local`, which the popup, options page and worker all share.
- **Stable extension redirect URI.** The OAuth callback is `https://<extension-id>.chromiumapp.org/kakao`, and the extension id comes from the manifest `key`. Setting `EXTENSION_PUBLIC_KEY` keeps the id, and therefore the URI registered in Kakao Developers, stable across reinstalls. See [extension-public-key.md](extension-public-key.md).

## PWA

- **Hash routing.** Views are `#settings` and `#list/<id>?item=<id>`, derived from `window.location.hash` without a routing library. Static hosting needs no SPA rewrites.
- **Deep links wait for data.** A `#list/<id>` link is only resolved after the local snapshot is hydrated; clearing it earlier broke valid links opened from the extension. An id that still doesn't exist afterwards falls back to the overview.
- **Overview and contents are separate screens**, because large snapshots are unreadable when every place renders on one page.
- **Signing out** clears the session and replaces the hash with the overview, so list or place pages don't linger.

## Build and deployment

- **Two Vercel projects:** `apps/pwa` (static build) and `apps/server` (Express app behind a single function via `apps/server/vercel.json`, with a separate local `app.listen` entry point). Both need "Include source files outside of the Root Directory", because they import workspace packages.
- **The server compiles with plain `tsc`.** Bundling the server with esbuild produced an unstable runtime.
- **Workspace packages ship raw TypeScript.** `@kakao-lists/domain` and the other packages point their entry at `src/index.ts`. The compiled server may only import *types* from them; runtime helpers must live in the server until those packages get a build step.
- **One variable drives the extension's API access.** The extension build adds the origin of `VITE_SYNC_SERVER_URL` to the manifest `host_permissions`, so the runtime base URL and the permitted origin can't drift apart.
- **`DEBUG_MODE`** is injected at build time through Vite `define`; debug cards are removed from normal builds.

## Tooling and dependencies

- **pnpm only**, with `workspace:*` for internal packages. Plain semver ranges made pnpm try to fetch internal packages from the registry.
- **Biome** for linting and formatting, configured once at the root.
- **14-day release age.** Dependencies must have been published at least 14 days ago. This is enforced by `minimumReleaseAge: 20160` in `pnpm-workspace.yaml`, which applies to every install and update, transitive packages included. GitHub Actions are pinned to the commit SHA of a release that is at least 14 days old.
  - If pnpm reports `ERR_PNPM_NO_MATCHING_VERSION`, a package's newest version is too young. Re-resolving the lockfile in a clean checkout (no `node_modules`) lets pnpm fall back to an older matching version; `node_modules/.pnpm/lock.yaml` can otherwise make it reuse the young one.
  - Only add a package to `minimumReleaseAgeExclude` deliberately, for example for an urgent security fix.
- **CI Node version.** Workflows use Node 22.23.3. Node 22.12.0's bundled Corepack (0.29.4) cannot verify current pnpm release signatures (`Cannot find matching keyid`).

## Known limitations and follow-ups

- Kakao Maps extraction relies on private endpoints and page markup; see [kakao-maps-private-api.md](kakao-maps-private-api.md).
- Sync is whole-snapshot last-write-wins; concurrent edits on two devices can overwrite each other.
- Cloud sessions are a single signed token with no renewal flow.
- UI follow-ups from the May 2026 audits:
  - automated tests for malformed local storage, expired sessions and duplicate clicks;
  - clearer offline and retry messaging for server and background-refresh failures;
  - a shared locale-aware formatting helper for dates and counts, and broader i18n (strings are English-only);
  - virtualization or pagination if imported lists become very large;
  - the PWA's compact note copy button is under the 44×44 px touch target, kept small to match the layout.
