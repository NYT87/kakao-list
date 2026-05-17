# Task Plan: Kakao Note Seq Resolution

## Goal
Use the real Kakao saved-item context, including per-item `folderid`, so Kakao-note saves resolve the correct `seq` and the popup debug shows the exact live record being updated.

## Current Phase
Phase 3

## Phases
### Phase 1: Requirements & Discovery
- [x] Compare the popup debug values against the real `favorite/mine/list?folderid=...` payload
- [x] Identify the missing item-level Kakao folder context
- [x] Record the seq-resolution gap in findings.md
- **Status:** complete

### Phase 2: Implementation
- [x] Preserve Kakao `folderid` on imported items
- [x] Use the item-level Kakao folder id during live favorite resolution and update
- [x] Expand debug output with the resolved live favorite object
- **Status:** complete

### Phase 3: Verification
- [x] Build the extension
- [x] Run repo typecheck
- [x] Update planning files with the final state
- **Status:** complete

## Key Questions
1. Is the correct Kakao `seq` tied to the item’s own `folderid` rather than the derived list id?
2. Should the popup expose the exact live favorite record it resolves before updating the note?
3. Can the imported snapshot preserve enough Kakao metadata to avoid this mismatch on future saves?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Preserve Kakao `folderid` on each imported item | The real Kakao saved-place payload includes item-level folder context |
| Prefer `item.kakaoFolderId` over parsing `list.id` during note save | The save flow should follow the same lookup context as Kakao Maps web |
| Show the resolved live favorite in debug mode | This makes future seq mismatches visible without extra instrumentation |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Existing `task_plan.md` still described the earlier editable-notes milestone | 1 | Replaced it with the current seq-resolution follow-up plan |

## Notes
- This bug is extension-side; the key missing detail is preserving and using the Kakao item `folderid`.
