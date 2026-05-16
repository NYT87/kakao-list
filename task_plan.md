# Task Plan: Extension Import Local-First + Server Payload Limit

## Goal
Make extension imports persist locally even when server sync fails, and raise the server JSON body limit so larger snapshots can be uploaded.

## Current Phase
Phase 3

## Phases
### Phase 1: Requirements & Discovery
- [x] Inspect the extension import path and current server request body limit
- [x] Confirm why imported lists disappear when server sync fails
- [x] Record the root cause in findings.md
- **Status:** complete

### Phase 2: Implementation
- [x] Save imported snapshots locally before attempting the server push
- [x] Surface a clear partial-success error when local import succeeds but server sync fails
- [x] Raise or parameterize the server JSON body limit
- **Status:** complete

### Phase 3: Verification
- [x] Build and typecheck the extension
- [x] Verify the server code still typechecks through the repo build
- [x] Update planning files with the final state
- **Status:** complete

## Key Questions
1. Where in the import flow should local persistence happen so server failures do not discard the import?
2. What message should the user see when import succeeds locally but sync fails remotely?
3. Is the payload error coming from Vercel itself or from the app’s own `express.json` limit?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Treat import as local-first, then remote-sync | The extension should remain useful even when the server is down or rejects a large payload |
| Keep the UI in an error state if remote sync fails after local save | The user should know the server copy is stale even though local data exists |
| Increase the server body limit via a configurable setting | The current hardcoded `1mb` limit is too low for realistic imported snapshots |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Existing `task_plan.md` was stale for the previous auth-persistence task | 1 | Replaced it with a plan for the import/sync failure work |

## Notes
- Re-read this plan before major decisions.
- Keep findings current as server upload behavior is clarified.
