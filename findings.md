# Findings & Decisions

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
- No browser UI inspection was needed yet.
