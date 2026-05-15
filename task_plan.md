# Task Plan: Extension Place-Modal Detection

## Goal
Make the extension popup detect when the active Kakao Maps tab has an open place modal on `map.kakao.com`, extract that place id from the modal link, and render the same saved-list membership details that already appear on direct `place.map.kakao.com/<id>` pages.

## Current Phase
Phase 3

## Phases
### Phase 1: Requirements & Discovery
- [x] Read the planning-with-files skill and recover current repo context
- [x] Inspect the extension popup active-tab detection flow
- [x] Confirm the existing place-page membership rendering path can be reused
- **Status:** complete

### Phase 2: Implementation
- [x] Add a Kakao Maps page probe that detects an open place modal and extracts its place id/title/url
- [x] Feed modal-derived place context into the popup active-tab state
- [x] Keep direct `place.map.kakao.com/<id>` detection working unchanged
- **Status:** complete

### Phase 3: Testing & Delivery
- [x] Build the extension and fix any regressions
- [x] Summarize the behavior change and any remaining limitations
- **Status:** complete

## Key Questions
1. Can the popup safely read the active `map.kakao.com` DOM on demand without introducing a persistent content script?
2. Is the modal place anchor stable enough to treat its `href` place id as the same `placeKey` used on direct place pages?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Reuse the existing popup `kind: "place"` UI path for modal matches | The saved-list rendering and note editing are already implemented there |
| Probe the active tab with `chrome.scripting.executeScript(...)` only when URL-based detection does not already yield a place id | This keeps the direct place-page path simple and adds the modal case only where needed |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| None | 0 | N/A |

## Notes
- The current popup only treats `place.map.kakao.com/<id>` URLs as place context.
- The provided modal markup includes a stable anchor to `https://place.map.kakao.com/<id>`, which should map cleanly onto existing `placeKey` matching.
- Verification completed with `pnpm --filter @kakao-lists/extension build` and `pnpm --filter @kakao-lists/extension exec tsc --noEmit`.
