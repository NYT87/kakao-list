# Findings & Decisions

## Extension Place-Modal Detection: 2026-05-15

### Key Findings
- The extension popup already has a complete place-specific UI path in `apps/extension/src/PopupApp.tsx` that renders matching saved-list memberships and local-note editing whenever `activeTab.kind === "place"` and a `placeKey` is present.
- Current place detection is URL-only: `resolveActiveTabContext(...)` extracts the place id exclusively from `place.map.kakao.com/<id>` URLs.
- The extension already has the permissions needed to inspect the active Kakao Maps page at popup-open time:
  - `scripting` permission
  - `https://map.kakao.com/*` host permission
- The modal markup provided by the user includes an anchor to `https://place.map.kakao.com/1246170309`, which means the modal case can reuse the existing `placeKey` matching logic with no domain-model changes.

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Add a one-shot DOM probe for the active `map.kakao.com` tab from the popup | The popup already does on-demand page scripting for imports; a persistent content script is unnecessary for this behavior |
| Normalize modal-derived context into the same `ActiveTabContext` shape as direct place pages | This avoids duplicating render logic and keeps note-save/open-in-PWA behavior unchanged |
| Prefer explicit stable selectors plus a fallback anchor search for `place.map.kakao.com` links | Kakao Maps DOM can shift, so a narrow primary selector should be paired with a resilient fallback |

### Verified Implementation Notes
- `apps/extension/src/PopupApp.tsx` now resolves active-tab place context asynchronously instead of relying only on the tab URL.
- If the active tab URL is already `place.map.kakao.com/<id>`, the popup keeps using the original direct URL path.
- If the active tab is `map.kakao.com`, the popup now runs a one-shot DOM probe with `chrome.scripting.executeScript(...)` and searches the map container for a visible place anchor that points to `place.map.kakao.com/<id>`.
- When such an anchor is found, the popup marks the tab as a place context with `source: "modal"`, which reuses the existing saved-in-lists UI, server refresh, and local-note save flow.
- The popup debug card now records whether the detected place source was `url` or `modal`.

### Residual Limitation
- The modal detection depends on Kakao Maps DOM structure and visible place-link anchors. If Kakao changes the modal markup substantially, the selector fallback may need another adjustment.

## Requirements
- Build a project with both a Chrome/Brave browser extension and a PWA.
- Support Kakao authentication.
- Show synced “favorite lists”.
- Persist synced data locally in SQLite.
- Share as much code as practical across both clients.
- Add a server so list data can sync between devices.

## Research Findings
- Kakao’s official browser entry point is the JavaScript SDK and current docs cover web login flows and JS SDK initialization.
- Kakao’s published docs clearly expose login/profile/social/share capabilities, but an official public “favorite lists” API was not identified from the initial documentation pass.
- A browser extension and a PWA can each use browser-local persistence, but they do not naturally share one local SQLite file because they run under different origins and storage sandboxes.
- The first safe scaffold is to let the PWA own Kakao OAuth callback capture and let the extension stay thin until the real sync path is verified.
- A first server sync can operate on whole-snapshot upload/download semantics before introducing conflict resolution or per-item merge logic.
- A dedicated sync server removes the biggest limitation of the original design: device-to-device transfer no longer depends on shared browser-local storage.
- The secure boundary is to let the server exchange the Kakao authorization code and derive the Kakao user id itself, instead of trusting a client-provided account id.
- The intended UX is simpler than the earlier scaffold: both clients should land on sign-in first, then open directly to saved lists once a session exists.
- The repository had drifted into a mixed package-manager state: npm workspace syntax plus both npm and pnpm lockfiles.
- pnpm requires explicit workspace linking for internal packages; plain semver versions caused registry fetch attempts.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Use React + TypeScript style scaffolding for both app surfaces | This is the most maintainable baseline for a shared browser codebase |
| Put domain types, sync contracts, and storage contracts in shared packages | Prevents duplication and makes the future sync implementation testable |
| Use a repository contract with an in-memory starter implementation and SQLite adapter interface | Lets the scaffold run conceptually before locking into a WASM SQLite library |
| Treat Kakao sync as a two-layer concern: auth is real, list fetch is adapter-driven | Reduces risk from undocumented or private endpoints |
| Keep extension auth indirect for now | Avoids implementing a brittle OAuth flow twice before the data-sync contract is settled |
| Use a separate server app with SQLite and REST endpoints | This is the cleanest path to cross-device sync without changing the browser storage model |
| Use whole-snapshot last-write-wins sync for v1 | It is simple to reason about and easy to verify before introducing merges |
| Require authenticated bearer tokens on snapshot APIs | User scope must come from the server-issued session, not a request parameter |
| Trigger Kakao sync automatically on each authenticated load | This makes local cache refresh and cloud persistence part of the normal app lifecycle |
| Make pnpm the only package manager for the repo | Avoids lockfile drift and ambiguous install/build instructions |
| Keep pnpm’s `pnpm-workspace.yaml` and `workspace:*` references aligned | This is the correct workspace setup for internal package resolution |
| Put private Kakao Maps extraction in the extension | The private list endpoints ride the logged-in `map.kakao.com` browser session, which the extension can access more naturally than the PWA or server |
| Show list overviews separately from place contents in the PWA | Large imported Kakao Maps snapshots become unreadable when every place is rendered on the main page |
| Make the PWA read-only for snapshots and keep snapshot creation in the extension | This prevents the web app from competing with the extension as an importer and keeps Kakao Maps extraction explicitly user-triggered |
| Separate imported Kakao notes from user-authored local notes | Kakao Maps memo fields should remain visible as imported data, while user edits should be stored independently on the sync server |
| Switch the extension popup into a place-centric view on `place.map.kakao.com/<id>` pages | The active place page provides strong context for showing which saved lists contain that place and which notes apply to it |
| Let the extension place-centric popup edit local notes in place | The place view already has enough context to edit a single saved-place note and persist the returned server snapshot back into extension-local storage |
| Keep the default popup import-focused and move account/data management into the options page | Import is the primary popup task; destructive or maintenance actions fit better in a dedicated management view |
| Filter stale deleted-folder placeholders on read as well as on import | The importer already skips Kakao folders with `status: "D"`, but older server/local snapshots can still contain placeholder rows like `Folder 2052505`, so the clients should defensively hide them |
| Move the sync server from SQLite to Postgres using `DATABASE_URL` | The API is multi-user and benefits from a real server database with standard deployment ergonomics instead of a local file path |
| Initialize Postgres tables at server startup instead of adding a separate migration tool right now | This keeps the migration small while preserving the existing whole-snapshot sync model |
| Add Docker Compose only for the Postgres service | The server already runs locally through `pnpm dev:server`, so the database is the only extra local infrastructure needed |

## Verified Implementation Notes
- The extension place-page popup already renders editable local-note inputs for each matching saved-list item.
- Saving a note from the extension place view calls the existing `PATCH /api/snapshot/item-note` path through `cloudSync.updateLocalNote(...)`.
- The returned snapshot is already written back into extension-local storage with `repository.saveSnapshot(...)`, then applied to popup state so the UI refreshes immediately.
- The extension still treats imported Kakao notes as read-only and keeps them separate from user-authored local notes.
- The extension default popup now only exposes import plus navigation to options; the options page owns `Pull Server Data`, `Sign Out`, and `Clear All Local Data`.
- The extension stored-lists panel now includes a per-row action that opens the PWA directly on that list route.
- The PWA list-route bootstrap must not clear `#list/<folderId>` before local snapshot hydration finishes; otherwise valid extension deep links fall back to the overview page.
- When a requested `#list/<folderId>` still does not exist after hydration, the PWA should render an explicit 404-style state instead of redirecting to the overview.
- The PWA currently keeps all navigation in `App.tsx` and derives list/place detail state from `window.location.hash`.
- The current PWA main screen still mixes three concerns in one view: overview browsing, session metadata, and cloud sync controls.
- A settings page can be introduced without a routing library by extending the existing hash parsing to support a dedicated `settings` view alongside the existing `list`/`place` deep links.
- The fixed header should be the primary home for settings/logout/back actions so those controls remain available from overview, settings, list, and place screens.
- The new PWA route model now treats `#settings` as a first-class authenticated view and keeps `#list/<id>?item=<id>` for list/place deep links.
- Logout should clear the cloud session and replace the hash with the overview URL so deep-linked list/place pages do not linger after sign-out.
- The server persistence layer was previously entirely SQLite-specific: file-path config, `better-sqlite3`, PRAGMA setup, schema bootstrap, and in-process transaction helpers.
- The Postgres migration now uses a shared `pg` pool, `DATABASE_URL`, startup `CREATE TABLE IF NOT EXISTS` initialization, JSONB snapshot storage, and explicit SQL transactions for snapshot version increments.
- `docker compose config` validates the new Postgres Compose file, but a live container boot and end-to-end runtime test against Postgres were not executed in this session.

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| Empty repo provided no baseline project | Created a new monorepo scaffold from scratch |
| Shared SQLite across extension and PWA is not a straightforward browser capability | Documented this as an architectural constraint and kept storage per-surface behind shared contracts |
| Root workspace build script would have failed against shared packages | Scoped root build to the two app workspaces |
| Esbuild output was not a stable runtime target for the Express server | Switched the server build to plain `tsc` output |
| Existing dev database schema mismatched the new auth-scoped code | Added an in-place migration from `account_id` to `kakao_user_id` |

## Resources
- Kakao JS SDK getting started: https://developers.kakao.com/docs/en/javascript/getting-started
- Kakao JS SDK latest download/version page: https://developers.kakao.com/docs/latest/en/javascript/download
- Kakao Login for JavaScript SDK: https://developers.kakao.com/docs/latest/en/kakaologin/js

## Visual/Browser Findings
- Live Kakao Maps browser inspection exposed private XHR endpoints for saved place lists that are not documented in the official public Kakao APIs.
- The favorites/folders overview is loaded from `GET https://map.kakao.com/folder/list`.
- The folder list response is a JSON array of folder records. Observed fields include `folderid`, `title`, `status`, `icon`, `favorite_cnt`, `created_at`, `folder_updated_at`, `kakao_map_user_id`, `map_user_id`, and for subscribed/public folders also `subscribe`, `nickname`, `profile_image`, and `timeline_level`.
- The places inside a folder are loaded from `GET https://map.kakao.com/favorite/mine/list?folderid=<folderid>`.
- The per-folder places response is a JSON object with a `favorites` array. Observed item fields include `seq`, `type`, `display1`, `display2`, `memo`, `key`, `x`, `y`, `home`, `color`, `folderid`, `created_at`, and `item_updated_at`.
- Additional favorites-related requests observed during page load included `GET https://map.kakao.com/favorite/timestamp` and `GET https://map.kakao.com/favorite/myplace/list.json`.
- The private Kakao Maps web app appears to authorize these requests via the logged-in browser session rather than the Kakao Login REST bearer token used by this project.
- This route is technically usable for reverse-engineering, but it is unsupported, cookie/session-bound, and likely brittle against frontend changes or ToS constraints.

## Extension Auth Findings
- The extension is correctly using `chrome.identity.getRedirectURL("kakao")` to build the Kakao OAuth redirect URI.
- The UI error indicates Kakao is rejecting the generated `https://<extension-id>.chromiumapp.org/kakao` callback because that exact URI is not registered in Kakao Developers.
- In local unpacked-extension development, that callback URI can drift if the extension id changes between installs.
- Chrome derives the extension id from the manifest `key`, so adding a stable `key` is the cleanest way to keep the Kakao redirect URI fixed across reinstalls.
- Product-side mitigation is still worthwhile even though the failure is primarily setup-related: the popup and options page should show the exact redirect URI instead of leaving users to discover it from a failed auth attempt.

## UI Audit: 2026-05-14 (PWA + Extension)

### Anti-Patterns Verdict
- Pass with minor caveats. The current UI no longer reads as generic AI card-grid output, and the Kakao-like utility direction is consistent.
- Remaining rough edges were implementation-quality issues rather than aesthetic slop: placeholder-only form fields, missing consistent keyboard focus treatment, reduced-motion gaps, and a few theme-token leaks.

### Prioritized Findings
| Severity | Category | Location | Finding | Impact | Recommendation |
|----------|----------|----------|---------|--------|----------------|
| High | Accessibility | `apps/pwa/src/App.tsx` list and place search fields | Search inputs relied on placeholders without explicit labels | Screen-reader and voice-control users get weaker field identification | Add persistent accessible labels, visually hidden if necessary |
| High | Accessibility | `apps/pwa/src/styles.css`, `apps/extension/src/styles.css` interactive controls | No consistent `:focus-visible` treatment across custom buttons/links/inputs | Keyboard navigation quality was inconsistent and could fail WCAG 2.4.7 expectations | Add tokenized focus rings across interactive primitives |
| Medium | Motion | `apps/pwa/src/App.tsx` route scrolling and global styles | Route-change scrolling always used smooth motion | Users with reduced-motion preference still received animated movement | Respect `prefers-reduced-motion` in JS scroll behavior and CSS transitions |
| Medium | Theming | `apps/pwa/src/styles.css`, `apps/extension/src/styles.css` | A few semantic colors remained hard-coded outside the theme token set | Theme maintenance drifts over time and dark/light tuning becomes inconsistent | Move status and danger colors behind tokens |
| Low | Responsive/A11y | PWA note copy affordance | The compact copy button remains visually aligned but is under the ideal 44x44 touch target | Slightly weaker tap ergonomics on touch devices | Revisit if touch feedback becomes a problem; current size was preserved to match the requested layout |

### Positive Findings
- Typography, spacing, and information hierarchy are much closer to the intended simple/accessibile/clean Kakao-like direction than earlier iterations.
- Theme preference is now system-aware across both surfaces and already tokenized enough to support normalization work safely.
- The PWA and extension share consistent mono metadata, monochrome surfaces, and compact action language without over-decorating the UI.

## UI Audit + Hardening: 2026-05-14 (PWA + Extension)

### Anti-Patterns Verdict
- Pass. The interface does not read as generic AI-generated dashboard UI.
- It stays within the intended Kakao-like direction: light-first, restrained, list-focused, and not overloaded with decorative card nesting or synthetic gradients.
- The main quality gaps were resilience issues rather than visual anti-patterns.

### Executive Summary
- Total prioritized issues found: 6
- By severity: 0 critical, 3 high, 2 medium, 1 low
- Most important issues:
  - Corrupted local storage session payloads could crash bootstrap logic in both surfaces.
  - Network actions allowed repeated clicks, which risked duplicate imports, pulls, and note saves.
  - Filtered empty states were silent, leaving users with blank content and no explanation.
  - Long text in list/place metadata could force awkward wrapping or overflow in compact rows.
- Quality score after hardening pass: 8/10
- Recommended next steps:
  1. Keep the current hardening fixes.
  2. Add a dedicated invalid-list 404 state back into the PWA route model.
  3. Add automated edge-case tests for corrupted storage, expired sessions, and duplicate-click prevention.

### Detailed Findings By Severity

#### Critical Issues
- None verified in this pass.

#### High-Severity Issues
- **Location:** `apps/pwa/src/App.tsx`, `apps/extension/src/PopupApp.tsx`, `apps/extension/src/OptionsApp.tsx`
  - **Category:** Edge Case / Error Handling
  - **Description:** Session bootstrap trusted `JSON.parse(localStorageValue)` without guarding for malformed data.
  - **Impact:** A corrupted or manually edited storage value could break app startup instead of degrading gracefully.
  - **Recommendation:** Parse defensively, validate required session fields, and clear invalid storage.
  - **Suggested command:** `/i-harden`
- **Location:** PWA and extension async controls for pull/import/sign-in/note save
  - **Category:** Interaction / Concurrent Operations
  - **Description:** Async actions were re-triggerable while the previous request was still in flight.
  - **Impact:** Repeated taps could cause duplicate network work, confusing status messages, and inconsistent snapshots.
  - **Recommendation:** Add in-flight guards and disabled states for busy controls.
  - **Suggested command:** `/i-harden`
- **Location:** Filtered PWA overview/detail views
  - **Category:** Accessibility / Empty States
  - **Description:** A search with zero results produced a blank content area with no explanation.
  - **Impact:** Users lose context and cannot distinguish “no data” from “broken UI” or “loading glitch”.
  - **Recommendation:** Render explicit no-results messaging with recovery guidance.
  - **Suggested command:** `/i-harden`

#### Medium-Severity Issues
- **Location:** Compact metadata rows and popup match/list headers across PWA and extension
  - **Category:** Responsive / Internationalization
  - **Description:** Long titles, creator names, device ids, and notes had limited overflow hardening in flex/grid containers.
  - **Impact:** Real-world long text, CJK strings, and pasted notes can degrade layout readability on narrow screens.
  - **Recommendation:** Add `min-width: 0` and `overflow-wrap: anywhere` to shrinking text containers.
  - **Suggested command:** `/i-harden`
- **Location:** Date/count formatting in PWA and extension metadata
  - **Category:** Internationalization
  - **Description:** Raw `toLocaleString()` or unformatted plain counts were inconsistent and lacked invalid-date fallback behavior.
  - **Impact:** Locale output was inconsistent and malformed timestamps could surface as confusing raw values.
  - **Recommendation:** Centralize locale-aware date/count formatting with invalid-value fallbacks.
  - **Suggested command:** `/i-harden`

#### Low-Severity Issues
- **Location:** PWA compact copy icon
  - **Category:** Responsive / Touch Targets
  - **Description:** The compact copy affordance remains smaller than ideal touch target guidance.
  - **Impact:** Slightly weaker tap ergonomics on touch devices.
  - **Recommendation:** Revisit only if the interaction proves error-prone; current size preserves the requested layout.
  - **Suggested command:** `/i-polish`

### Patterns & Systemic Issues
- Async network actions were originally designed as single-user happy-path flows and needed explicit duplicate-click protection.
- Storage/session reads assumed valid browser state and were not hardened against manual edits or stale/corrupted payloads.
- Compact metadata layouts needed more defensive overflow treatment for long names, ids, and notes.

### Positive Findings
- Theme tokens and reduced-motion handling introduced in the previous pass made this hardening work straightforward.
- The PWA and extension already share a consistent interaction vocabulary, which made busy-state hardening easy to apply without redesign.
- Existing empty states for zero stored lists were already reasonably clear and only needed filtered-state equivalents.

### Recommendations By Priority
1. **Immediate**
   - Keep the new defensive storage parsing and duplicate-click guards.
   - Preserve explicit no-results messaging for filtered views.
2. **Short-term**
   - Restore a dedicated invalid-list/not-found state in the PWA instead of falling back toward overview behavior.
   - Add automated tests for malformed local storage and repeated async clicks.
3. **Medium-term**
   - Add richer offline/retry messaging for server failures and background refresh failures.
   - Consider a shared formatting helper for locale-aware labels across all surfaces.
4. **Long-term**
   - Add broader i18n support instead of English-only plural strings.
   - Evaluate virtualization or pagination if imported list sizes become very large.

### Suggested Commands For Fixes
- Use `/i-harden` for corrupted-storage handling, duplicate-action prevention, overflow resilience, and i18n-safe formatting.
- Use `/i-audit` again after the next UI iteration to verify that invalid-route and offline states are fully covered.
- Use `/i-polish` later if you want to revisit compact touch-target compromises without expanding the current layouts.

## Vercel Deployment Readiness: 2026-05-14

### Key Findings
- The repo should deploy to Vercel as two projects, not one:
  - `apps/pwa` for the Vite-built web app
  - `apps/server` for the sync API
- The PWA is already structurally close to Vercel-ready because it builds to static assets and uses hash-based navigation, so it does not need SPA rewrites for deep links.
- The server is not yet ideally Vercel-shaped in its current form because the only public entrypoint is a long-running `app.listen(...)` bootstrap in `apps/server/src/index.ts`.
- The server no longer depends on local SQLite files, which removes the major persistence blocker for Vercel deployment.
- Both projects depend on workspace packages outside their app directories, so Vercel imports must enable source access outside the selected root directory.

### Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Split the server into a reusable Express app module and separate local/Vercel entrypoints | Local development still needs a listener, while Vercel needs a request handler shape |
| Initialize the Postgres schema through a shared one-time readiness guard | Both local startup and serverless cold starts need the same database bootstrap behavior |
| Add a server `vercel.json` that routes all requests to a single API handler | The current API is a small Express app with one unified route surface |
| Keep PWA Vercel configuration minimal and rely mostly on documented dashboard settings | The app already uses static assets and hash routing, so extra rewrites are unnecessary |

### Remaining Manual Deployment Steps
1. Create one Vercel project rooted at `apps/pwa` and one rooted at `apps/server`.
2. Enable “Include source files outside of the Root Directory” on both projects.
3. Configure the documented environment variables separately for each project.
4. Point the PWA `VITE_SYNC_SERVER_URL` at the deployed API domain and redeploy the PWA.
5. Build the extension with that same `VITE_SYNC_SERVER_URL` so its generated manifest includes the deployed API origin in `host_permissions`.

### Extension-Specific Deployment Finding
- The extension already used `VITE_SYNC_SERVER_URL` at runtime, but its checked-in manifest only granted host permissions for localhost.
- Without adding the deployed API origin to `host_permissions`, the extension could fail to sync against a Vercel-hosted API even though the runtime base URL was configured correctly.
- The extension build now derives an additional manifest host permission from `VITE_SYNC_SERVER_URL`, so one env value drives both the runtime client base URL and the permitted API origin.

## Kakao-Backed Backend Auth Hardening: 2026-05-14

### Key Findings
- Protected API routes currently validate only the server-issued signed session token, not the continued validity of the Kakao token stored for that user.
- The server already stores both Kakao `access_token` and optional `refresh_token`, so it has enough data to enforce Kakao-backed authorization server-side.
- The cleanest hardening path is:
  - verify the signed backend session
  - require a Kakao token record for that Kakao user id
  - validate the Kakao access token by calling Kakao user-info
  - if validation fails, try refresh-token exchange and retry validation
  - reject the request if the Kakao identity cannot be re-proven

### Technical Decision
| Decision | Rationale |
|----------|-----------|
| Enforce Kakao-backed authorization on every protected sync route | This is the most direct interpretation of “backend auth using the Kakao token” and closes the current trust gap |
| Keep the client-facing bearer token as the server-issued session token | This avoids forcing the PWA and extension to manage raw Kakao tokens directly while still letting the server prove Kakao identity |
