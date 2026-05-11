# Task Plan: Kakao Lists Project Scaffold

## Goal
Extend the Kakao-linked monorepo with a sync server so favorite-list snapshots can be uploaded and downloaded across devices, scoped strictly to the authenticated Kakao user id.

## Current Phase
Phase 5

## Phases
### Phase 1: Requirements & Discovery
- [x] Understand user intent
- [x] Identify constraints and requirements
- [x] Document findings in findings.md
- **Status:** complete

### Phase 2: Planning & Structure
- [x] Define sync-server technical approach
- [x] Update project structure for the new server app
- [x] Document decisions with rationale
- **Status:** complete

### Phase 3: Implementation
- [x] Add server app with SQLite persistence
- [x] Add shared sync contracts/client helpers
- [x] Wire the PWA to push and pull server snapshots
- **Status:** complete

### Phase 4: Testing & Verification
- [x] Verify builds and runtime scripts
- [x] Document setup and limitations
- [x] Fix any issues found
- **Status:** complete

### Phase 5: Delivery
- [x] Review all output files
- [x] Ensure deliverables are complete
- [x] Deliver to user
- **Status:** complete

## Key Questions
1. How should the PWA and extension share logic while keeping platform-specific storage and auth entry points manageable?
2. What is the safest way to model Kakao sync when the “favorite lists” API surface is not yet verified as an official public endpoint?
3. What server-side sync model is simple enough for a first version but still useful across devices?
4. How should the server derive the user scope so clients cannot choose arbitrary account ids?
5. How should the web app and extension behave on first load versus active-session load?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use an npm workspace monorepo with `apps/*` and `packages/*` | Keeps the extension and PWA separate while sharing domain code cleanly |
| Keep Kakao sync behind an adapter interface | The official login surface is documented, but the target list-sync API is still unverified |
| Model local persistence as a browser SQLite abstraction instead of a hard dependency on one library | Lets the project start with clean contracts while acknowledging browser/extension storage constraints |
| Document the shared-DB limitation explicitly | Extension and PWA live under different origins and cannot reliably share one local SQLite file directly |
| Use PWA-owned Kakao OAuth callback capture in the first scaffold | It keeps the initial login flow concrete without forcing a premature extension-auth design |
| Use a separate SQLite-backed sync server with whole-snapshot upload/download | This solves cross-device transfer now without waiting for fine-grained merge logic |
| Use account-scoped latest-snapshot records with history rows | Keeps the first server API simple while preserving an audit trail for debugging |
| Derive snapshot scope from Kakao user id on the server | Prevents clients from requesting or overwriting other users' data by changing an account id |
| Make both clients auth-first and auto-sync on authenticated load | This matches the intended product behavior better than exposing sync mechanics first |
| Standardize the repo on pnpm | The workspace already has a pnpm lockfile, and one package manager should be the single source of truth |
| Use `workspace:*` for internal package links | pnpm should resolve internal packages as workspace links rather than registry packages |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `rg --files` returned exit code 1 in empty workspace | 1 | Treated as expected because the repository has no files yet |
| Root build script would have targeted all workspaces, including packages without build scripts | 1 | Narrowed the root build to the two app workspaces |
| Shared mock adapter referenced `window`, which broke server-inclusive typechecking | 1 | Switched to `globalThis.setTimeout` |
| Bundled server artifact exited immediately and was not a reliable runtime target | 1 | Replaced the bundle build with plain `tsc` output for the server app |
| Existing SQLite file still used the old `account_id` schema | 1 | Added an in-place migration to the new `kakao_user_id` schema |
| pnpm initially tried to fetch internal packages from the registry | 1 | Converted internal dependency versions from `0.1.0` to `workspace:*` |

## Notes
- Re-read this plan before major decisions.
- Keep findings current as architecture constraints are discovered.
