# Architecture Decisions

Durable decisions and constraints behind the current design, collected from past planning notes. The README covers setup and the high-level layout; this file explains why things are the way they are. Agent access (MCP) has its own design doc: [agent-access.md](agent-access.md). Kakao Maps endpoints: [kakao-maps-private-api.md](kakao-maps-private-api.md).

## Data and sync

- **One snapshot per Kakao user.** The server stores the latest snapshot as one JSONB document per Kakao user id (`latest_snapshots`) plus history rows (`snapshot_history`). Lists are not normalized into their own tables.
- **Serialized partial updates.** A per-user advisory transaction lock covers the read, merge, and write, including first inserts. Whole imports still use last-writer-wins semantics when replacing the same imported field. Local notes are server-owned and are preserved across both whole-snapshot and per-list imports.
- **Chunked uploads.** `PUT /api/snapshot/list` uploads one list at a time. Intermediate extension requests use `?summary=true` to avoid returning the full snapshot. The final chunk carries `expectedListIds` for pruning and history recording. Incomplete imports remain visible and recoverable; staging/finalization is a possible future improvement.
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
- **Kakao-backed sessions.** Clients hold an opaque random token; only its SHA-256 hash is stored in the expiring browser_sessions table. Logout revokes the current session; logout-all revokes browser sessions independently of assistant grants. Legacy signed tokens are invalid. On protected routes the server also re-validates the stored Kakao access token with Kakao, refreshes it with the refresh token when needed, and rejects the request if the Kakao identity can't be re-proven. Clients never handle raw Kakao tokens.
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
- **Shared domain runtime.** The domain package builds JavaScript for Node, exports source types and browser source through conditional exports, and is built before tests, application builds, and dev commands. Other browser packages still ship TypeScript source.
- **One variable drives the extension's API access.** The extension build adds the origin of `VITE_SYNC_SERVER_URL` to the manifest `host_permissions`, so the runtime base URL and the permitted origin can't drift apart.
- **`DEBUG_MODE`** is injected at build time through Vite `define`; debug cards are removed from normal builds.

## Tooling and dependencies

- **pnpm only**, with `workspace:*` for internal packages. Plain semver ranges made pnpm try to fetch internal packages from the registry.
- **Biome** for linting and formatting, configured once at the root.
- **14-day release age.** Dependencies must have been published at least 14 days ago. This is enforced by `minimumReleaseAge: 20160` in `pnpm-workspace.yaml`, which applies to every install and update, transitive packages included. GitHub Actions are pinned to the commit SHA of a release that is at least 14 days old.
  - If pnpm reports `ERR_PNPM_NO_MATCHING_VERSION`, a package's newest version is too young. Re-resolving the lockfile in a clean checkout (no `node_modules`) lets pnpm fall back to an older matching version; `node_modules/.pnpm/lock.yaml` can otherwise make it reuse the young one.
  - Only add a package to `minimumReleaseAgeExclude` deliberately, for example for an urgent security fix.
- **CI Node version.** Workflows use Node 22.23.3. Node 22.12.0's bundled Corepack (0.29.4) cannot verify current pnpm release signatures (`Cannot find matching keyid`).
- **Package-specific releases.** Release Please tracks the extension, PWA, server, and four shared packages independently from an initial `0.1.0` manifest. A push to `main` opens or updates a version PR based on conventional commits and changed package paths. The Node workspace plugin patch-bumps clients when their shared dependencies release. Merging the PR creates component tags such as `extension-v0.1.1`; the extension bundle job is gated on Release Please's `apps/extension--release_created` output and checks out its release SHA. A server-only release skips extension packaging. The extension's release PR updates both its package version and Chrome manifest version; the bundle script checks that they match. Bundles carry the manifest version and short release commit. `GITHUB_TOKEN`-created releases do not start a separate `release: published` workflow, so release creation and bundling share one workflow. GitHub's repository-wide latest release may be for another package; extension downloads use the newest `extension-v*` release.

## Known limitations and follow-ups

- Kakao Maps extraction relies on private endpoints and page markup; see [kakao-maps-private-api.md](kakao-maps-private-api.md).
- Imports are not staged as one atomic multi-list operation; overlapping imports can still replace the same imported fields. Partial updates are serialized and local notes are protected.
- Browser sessions are revocable opaque tokens, expire after seven days, and have no renewal flow.
- UI follow-ups from the May 2026 audits:
  - automated tests for malformed local storage, expired sessions and duplicate clicks;
  - clearer offline and retry messaging for server and background-refresh failures;
  - a shared locale-aware formatting helper for dates and counts, and broader i18n (strings are English-only);
  - virtualization or pagination if imported lists become very large;
  - the PWA's compact note copy button is under the 44×44 px touch target, kept small to match the layout.

## Review remediation, October 2026

- Complete nested snapshots are validated at server and cache boundaries, with bounded list/item/note counts and HTTPS place URLs.
- Every account has a separate browser cache; legacy unowned caches are not migrated to a new user. Logout/identity changes clear displayed private data and stale responses are ignored.
- Kakao credentials use AES-256-GCM with a domain-separated HKDF key derived from the required server secret. Legacy plaintext credentials are removed at migration startup and require re-authentication. Rotating the secret requires a planned credential invalidation/re-authentication rollout.
- Account deletion removes snapshots/history, credentials, browser sessions, agent keys, and OAuth codes/grants. A minimal one-day deletion guard prevents an already-running authorization from recreating credentials; pending authorizations without a known identity expire after ten minutes. Shared OAuth client registrations are retained and follow normal cleanup.
- History is bounded to 20 records per account and 30 days. Kakao credentials unused for 60 days are removed by maintenance. The cron secret must be configured in serverless deployments.
- JSON decompression is disabled. Main API traffic has process-local early limits and Postgres-backed per-IP/per-user budgets. Forwarded IP strings and collection sizes are bounded before susceptible downstream parsers.
- Offline caching includes public shell assets only. The service worker contains a hash of built shell assets, so frontend releases trigger update discovery. OAuth callbacks, query-bearing requests, external origins, and APIs bypass shell caching.
- Maps profile ids and Kakao Login service ids remain incomparable. [Kakao's Login documentation](https://developers.kakao.com/docs/en/kakaologin/utilize) defines the latter as unique within each service app; [Kakao's account FAQ](https://developers.kakao.com/docs/en/getting-started/faq) states that the same person receives different ids in different apps. The private Maps folder payload supplies `kakao_map_user_id` or `map_user_id`, but no documented bridge to this app's Login id. Imports/note edits require explicit per-operation manual account confirmation; this is not a verified automatic identity mapping. The extension checks that its own session remains unchanged before subsequent writes, but this cannot prove the Maps account.
- Details, evidence, eligible dependency-upgrade dates, and remaining manual checks are in [remediation-status.md](remediation-status.md).
