# Task Plan: Chunked List-by-List Sync

## Goal
Split extension snapshot uploads into per-list requests so large imports do not require sending the entire snapshot in one request.

## Current Phase
Phase 3

## Phases
### Phase 1: Requirements & Discovery
- [x] Inspect the current whole-snapshot sync contract
- [x] Identify the smallest safe chunked-upload design that preserves deletions
- [x] Record the design in findings.md
- **Status:** complete

### Phase 2: Implementation
- [x] Add a server endpoint for upserting a single list into the current snapshot
- [x] Extend the shared sync client contract
- [x] Update the extension import flow to upload lists sequentially
- **Status:** complete

### Phase 3: Verification
- [x] Build the extension
- [x] Run repo typecheck
- [x] Update planning files with the final state
- **Status:** complete

## Key Questions
1. Can list-by-list sync be added without redesigning the database schema?
2. How do we prevent deleted Kakao lists from lingering on the server forever?
3. Should the extension still have a fallback whole-snapshot path for empty imports?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Keep the server’s stored shape as one latest snapshot blob | This minimizes schema churn and risk |
| Add `PUT /api/snapshot/list` to merge one list into the current snapshot | This reduces payload size while reusing the existing history/version model |
| Send `expectedListIds` on the final list upload | This lets the server prune lists that disappeared from the source import |
| Keep the existing whole-snapshot upload path for zero-list snapshots | An empty snapshot is small and still needs to clear server state cleanly |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Existing `task_plan.md` was stale for the previous import-local-first task | 1 | Replaced it with a plan for chunked list-by-list sync |

## Notes
- Re-read this plan before major decisions.
- Both the extension and the server must be updated together because the chunked upload path adds a new API endpoint.
