# Task Plan: Vercel Deployment Readiness

## Goal
Make the PWA and sync API deployable on Vercel from this monorepo by adapting the server runtime shape, adding project-level Vercel configuration where it materially helps, and documenting the exact deploy setup and environment variables.

## Current Phase
Phase 4

## Phases
### Phase 1: Requirements & Discovery
- [x] Read the planning-with-files skill and recover prior unsynced context
- [x] Inspect the current PWA/server build and runtime shape
- [x] Identify the minimum repo changes needed for Vercel deployment
- **Status:** complete

### Phase 2: Planning & Findings
- [x] Record the Vercel deployment decisions in `findings.md`
- [x] Update `progress.md` with the current session scope
- **Status:** complete

### Phase 3: Implementation
- [x] Refactor the server into a reusable app module plus a Vercel handler entrypoint
- [x] Add server-side Vercel routing/configuration
- [x] Add any PWA-side Vercel metadata that improves deployment clarity
- [x] Document exact Vercel setup and required environment variables in `README.md`
- **Status:** complete

### Phase 4: Testing & Delivery
- [x] Run server build verification
- [x] Run repo typecheck verification
- [x] Summarize the Kakao-backed auth hardening, behavior changes, and any residual caveats
- **Status:** complete

## Key Questions
1. What is the safest server shape for both local `pnpm dev:server` and Vercel request handling?
2. Which deployment details belong in code/config versus README instructions?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Treat the API and PWA as two separate Vercel projects | It matches the monorepo structure and keeps env vars and domains separate |
| Refactor the server into a shared Express app plus a Vercel-specific entrypoint | The current `app.listen(...)` startup shape is local-dev oriented and should not be the only server entry |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| `task_plan.md` was still tracking an older audit task | 1 | Replaced it with a new plan for the Vercel deployment work |

## Notes
- Session catchup reported unsynced context from the prior Vercel deployment discussion, so the planning files needed a fresh pass before implementation.
- The server is already Postgres-backed, which removes the largest deployment blocker.
- This plan was later extended to cover backend auth hardening after deployment setup was completed.
