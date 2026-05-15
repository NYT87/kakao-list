# Task Plan: Fix `pnpm lint:fix`

## Goal
Resolve the remaining Biome diagnostics so `pnpm lint:fix` completes successfully, without regressing the PWA or extension TypeScript builds.

## Current Phase
Phase 4

## Phases
### Phase 1: Requirements & Discovery
- [x] Run `pnpm lint:fix` and capture the blocking diagnostics
- [x] Inspect the specific extension and PWA files referenced by Biome
- **Status:** complete

### Phase 2: Implementation
- [x] Fix unused symbols and stale helper functions
- [x] Fix React hook dependency and mount-root issues
- [x] Fix a11y and CSS diagnostics blocking Biome
- **Status:** complete

### Phase 3: Verification
- [x] Re-run `pnpm lint:fix`
- [x] Run `pnpm typecheck`
- **Status:** complete

## Key Findings
1. The failures were real code issues, not just formatting drift.
2. Most blockers were concentrated in extension popup/options React hooks plus a few entrypoint/a11y/CSS details.

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Fix the reported code directly instead of weakening Biome rules | The diagnostics were legitimate and the repo should conform to the configured tool |
| Run `pnpm typecheck` after the lint cleanup | Several fixes touched hook dependencies and TS entrypoints |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `pnpm lint:fix` initially failed with Biome diagnostics across extension and PWA files | 1 | Patched the blocking React, a11y, CSS, and unused-symbol issues, then reran successfully |

## Notes
- `pnpm lint:fix` now passes cleanly.
