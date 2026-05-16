# Task Plan: Editable Kakao Notes

## Goal
Allow editing Kakao notes from the extension by always showing a Kakao-note input and saving it back to Kakao Maps plus local/server snapshot state.

## Current Phase
Phase 3

## Phases
### Phase 1: Requirements & Discovery
- [x] Inspect the current place-note UI and note persistence flow
- [x] Identify the Kakao Maps write endpoint and required request shape
- [x] Record the note-editing design in findings.md
- **Status:** complete

### Phase 2: Implementation
- [x] Always render a Kakao-note input
- [x] Add Kakao-note save through a live Kakao Maps tab
- [x] Persist the edited note locally and sync the changed list back to the server
- **Status:** complete

### Phase 3: Verification
- [x] Build the extension
- [x] Run repo typecheck
- [x] Update planning files with the final state
- **Status:** complete

## Key Questions
1. Where in the popup should Kakao note become editable instead of read-only?
2. What minimum request fields are needed for `favorite/update.json` based on the observed network call?
3. How should the extension behave if Kakao note save succeeds on Kakao Maps but server sync fails afterward?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Reuse the existing `kakaoNote` field instead of adding a new note property | The imported snapshot already models the Kakao memo separately from the local note |
| Save Kakao note through a Kakao Maps tab-context fetch to `favorite/update.json` | The write operation depends on the logged-in Kakao Maps browser session |
| Treat Kakao note save as Kakao-first, then local/server persistence | The source of truth for the Kakao memo is Kakao Maps itself |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Existing `task_plan.md` was stale for the previous chunked-sync task | 1 | Replaced it with a plan for editable Kakao notes |

## Notes
- Re-read this plan before major decisions.
- Both the extension and the server must be updated together because the chunked upload path adds a new API endpoint.
