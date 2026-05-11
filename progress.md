# Progress Log

## Session: 2026-05-10

### Phase 1: Requirements & Discovery
- **Status:** complete
- **Started:** 2026-05-10 10:31 KST
- Actions taken:
  - Read the planning-with-files skill as required by the repo instructions.
  - Confirmed the workspace was empty.
  - Checked Kakao official docs for the current JavaScript SDK and login surface.
  - Identified the main constraint around shared local SQLite across extension and PWA origins.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

### Phase 2: Planning & Structure
- **Status:** complete
- Actions taken:
  - Defined the monorepo shape.
  - Chose shared packages for domain, auth, and storage abstractions.
  - Chose to isolate Kakao list sync behind an adapter.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

### Phase 3: Implementation
- **Status:** complete
- Actions taken:
  - Scaffolded the root npm workspace, shared TypeScript config, env example, and README.
  - Added shared domain, Kakao OAuth helper, and storage packages.
  - Implemented a PWA shell that captures Kakao OAuth callback parameters and syncs mock favorite lists into local storage.
  - Implemented an extension shell with popup, options page, and background alarm placeholder.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/tsconfig.base.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/README.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/.env.example`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/index.html`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/public/manifest.webmanifest`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/public/sw.js`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/App.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/main.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/styles.css`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/public/manifest.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/PopupApp.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/OptionsApp.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/background.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/styles.css`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/domain/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/kakao/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/storage/src/index.ts`

### Phase 4: Testing & Verification
- **Status:** complete
- Actions taken:
  - Reviewed workspace scripts and corrected the root build command to target app workspaces only.
  - Added Chrome typings to support extension TypeScript tooling once dependencies are installed.
  - Documented the implemented scope and remaining constraints in the README and planning files.
  - Installed dependencies successfully.
  - Ran full workspace typecheck successfully.
  - Ran production builds successfully for both the PWA and the extension.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

### Phase 5: Delivery
- **Status:** complete
- Actions taken:
  - Finalized the scaffold, verification state, and documentation.
  - Prepared the handoff with explicit constraints and next steps.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

## Session: 2026-05-10 (Server Sync Extension)

### Phase 2: Planning & Structure
- **Status:** complete
- Actions taken:
  - Re-opened the plan and findings files before changing the architecture.
  - Chose a separate server app with SQLite-backed latest-snapshot and history tables.
  - Chose whole-snapshot push/pull semantics keyed by account id and device id for the first sync version.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`

### Phase 3: Implementation
- **Status:** complete
- Actions taken:
  - Added the new `apps/server` workspace with Express and SQLite persistence.
  - Added shared cloud sync contracts to the domain package.
  - Added the `packages/sync` HTTP client.
  - Wired the PWA to push local snapshots to the server and pull the latest server snapshot back down.
  - Updated docs and env settings for the new server.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/tsconfig.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/tsconfig.build.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/domain/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/sync/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/App.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/styles.css`
  - `/Users/josemiguel/workspace-personal/kakao-lists/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/.env.example`
  - `/Users/josemiguel/workspace-personal/kakao-lists/README.md`

### Phase 4: Testing & Verification
- **Status:** complete
- Actions taken:
  - Installed the new dependencies, including the native SQLite package and typings.
  - Fixed server-inclusive typecheck issues caused by browser-only globals in the shared mock adapter.
  - Replaced the initial server bundle build with plain TypeScript output after the bundle proved unstable at runtime.
  - Verified workspace typecheck and build.
  - Verified `GET /health` locally.
  - Verified snapshot upload and download on the server with a local round-trip test.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/package-lock.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/domain/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

### Phase 5: Delivery
- **Status:** complete
- Actions taken:
  - Finalized the server-sync handoff with the implemented API shape and current limitations.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

## Session: 2026-05-10 (Kakao User Scoping)

### Phase 2: Planning & Structure
- **Status:** complete
- Actions taken:
  - Verified Kakao’s server-side flow against the official OAuth token and user-info endpoints.
  - Decided to remove client-controlled account ids from the sync API.
  - Chose a server-signed session token carrying the Kakao user id as the snapshot scope.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`

### Phase 3: Implementation
- **Status:** complete
- Actions taken:
  - Added Kakao code exchange and user-profile lookup on the server.
  - Added signed cloud-session types and sync client auth support.
  - Reworked snapshot endpoints to use bearer auth and authenticated Kakao user scope.
  - Updated the PWA to exchange the Kakao callback code with the server and store the returned cloud session locally.
  - Removed the manual account-id input from the PWA.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/domain/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/sync/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/App.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/styles.css`
  - `/Users/josemiguel/workspace-personal/kakao-lists/.env.example`
  - `/Users/josemiguel/workspace-personal/kakao-lists/README.md`

### Phase 4: Testing & Verification
- **Status:** complete
- Actions taken:
  - Re-ran full workspace typecheck and build after the auth refactor.
  - Added a SQLite schema migration for existing local dev databases.
  - Verified local snapshot isolation with two different signed identities against the protected API.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

## Session: 2026-05-10 (Auth-First Entry Flow)

### Phase 3: Implementation
- **Status:** complete
- Actions taken:
  - Converted the web app to an auth-first entry screen that only shows the saved lists page after a valid session exists.
  - Added automatic server-driven Kakao sync on authenticated page load in the PWA.
  - Reworked the extension popup into its own Kakao sign-in flow using `chrome.identity.launchWebAuthFlow`.
  - Added automatic saved-list sync on authenticated extension popup load.
  - Added the server endpoint used by both clients to sync from Kakao and persist the latest snapshot.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/src/App.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/PopupApp.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/public/manifest.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/OptionsApp.tsx`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/src/styles.css`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/domain/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/sync/src/index.ts`
  - `/Users/josemiguel/workspace-personal/kakao-lists/README.md`

### Phase 4: Testing & Verification
- **Status:** complete
- Actions taken:
  - Verified full workspace typecheck after the auth-first client changes.
  - Verified full workspace build after the auth-first client changes.
  - Verified the new authenticated `/api/sync/kakao` endpoint returns a snapshot and persists it.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

## Session: 2026-05-11 (pnpm Migration)

### Phase 2: Planning & Structure
- **Status:** complete
- Actions taken:
  - Confirmed the repo had mixed package-manager state: npm workspace syntax, `package-lock.json`, and `pnpm-lock.yaml`.
  - Chose pnpm as the single package manager and workspace source of truth.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`

### Phase 3: Implementation
- **Status:** complete
- Actions taken:
  - Added `packageManager` metadata and `pnpm-workspace.yaml`.
  - Updated root scripts from npm workspace syntax to pnpm filter syntax.
  - Converted internal package references to `workspace:*`.
  - Removed the npm lockfile.
  - Updated README commands to use pnpm.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/pnpm-workspace.yaml`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/pwa/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/apps/server/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/storage/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/packages/sync/package.json`
  - `/Users/josemiguel/workspace-personal/kakao-lists/README.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/package-lock.json`

### Phase 4: Testing & Verification
- **Status:** complete
- Actions taken:
  - Verified the installed pnpm version.
  - Refreshed the lockfile and workspace links with pnpm.
  - Verified `pnpm typecheck`.
  - Verified `pnpm build`.
  - Noted that pnpm blocked native build scripts for `better-sqlite3` pending explicit approval.
- Files created/modified:
  - `/Users/josemiguel/workspace-personal/kakao-lists/pnpm-lock.yaml`
  - `/Users/josemiguel/workspace-personal/kakao-lists/task_plan.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/findings.md`
  - `/Users/josemiguel/workspace-personal/kakao-lists/progress.md`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Workspace inspection | `ls -la` | Empty or initial repo state visible | Empty repo confirmed | ✓ |
| File search | `rg --files` | Repo file list or empty result | Empty result with exit code 1 | ✓ |
| Script coherence check | `rg -n 'build --workspaces|types\": \\[\"chrome\"\\]|createMockSyncAdapter|service_worker' -S .` | Find obvious config hotspots | Found and fixed root build scope issue | ✓ |
| Dependency install | `npm install` | Workspace dependencies installed | Installed 127 packages, 0 vulnerabilities | ✓ |
| Workspace typecheck | `npm run typecheck` | TypeScript completes without errors | Completed successfully | ✓ |
| Production build | `npm run build` | PWA and extension both build | Both builds completed successfully | ✓ |
| Server dependency install | `npm install` | New server dependencies installed | Installed server dependencies and typings successfully | ✓ |
| Full workspace typecheck after server changes | `npm run typecheck` | Server, PWA, extension, and packages compile cleanly | Completed successfully | ✓ |
| Full workspace build after server changes | `npm run build` | Server, PWA, and extension all build | Completed successfully | ✓ |
| Server health check | Local `GET /health` | Server responds with service metadata | Returned `ok: true` and DB path | ✓ |
| Server snapshot round trip | Local `PUT` then `GET` on `/api/accounts/demo-account/snapshot` | Snapshot stored and read back | Upload and download matched | ✓ |
| Auth-scoped snapshot isolation | Local `PUT /api/snapshot` and `GET /api/snapshot` with two signed identities | User A sees User A data, User B does not | Isolation verified | ✓ |
| Authenticated Kakao sync endpoint | Local `POST /api/sync/kakao` and `GET /api/snapshot` with a signed identity | Sync endpoint returns and persists the latest snapshot | Verified | ✓ |
| pnpm version check | `pnpm -v` | pnpm available for workspace verification | `10.18.3` | ✓ |
| pnpm install | `pnpm install --no-frozen-lockfile` | Lockfile and workspace links refresh successfully | Completed successfully | ✓ |
| pnpm typecheck | `pnpm typecheck` | Full workspace compiles under pnpm | Completed successfully | ✓ |
| pnpm build | `pnpm build` | Server, PWA, and extension build under pnpm | Completed successfully | ✓ |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-05-10 10:32 KST | `rg --files` exit code 1 | 1 | Treated as expected in an empty repository |
| 2026-05-10 10:47 KST | Root build script targeted all workspaces | 1 | Narrowed root build to the two app workspaces |
| 2026-05-10 11:08 KST | Shared mock adapter referenced `window` | 1 | Switched to `globalThis.setTimeout` |
| 2026-05-10 11:15 KST | Bundled server runtime was unstable | 1 | Replaced server bundling with plain `tsc` output |
| 2026-05-10 11:31 KST | Existing SQLite file still used legacy `account_id` columns | 1 | Added in-place migration to `kakao_user_id` |
| 2026-05-10 11:44 KST | Runtime sync test tried to insert tokens before the server initialized its schema | 1 | Reordered the test harness to start the server first |
| 2026-05-11 09:07 KST | pnpm tried to fetch internal packages from the registry | 1 | Changed internal dependencies to `workspace:*` |

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Phase 5 |
| Where am I going? | Delivery is complete; next work is real Kakao sync auth and conflict-aware sync |
| What's the goal? | Scope cross-device sync strictly to authenticated Kakao users |
| What have I learned? | The secure boundary is server-derived Kakao identity, and the repo now needs pnpm-native workspace links to stay coherent |
| What have I done? | Migrated the workspace to pnpm and verified install, typecheck, and build under pnpm |
