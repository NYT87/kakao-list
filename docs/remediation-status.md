# Review remediation status — 2026-10-25

Implementation follows [the task checklist](app-review-tasks.md) and [API contract](remediation-contract.md). The original review remains a historical record of commit `5642a78`; findings there do not describe the remediated working tree.

## Implemented and locally verified

- Reject compressed request bodies before decompression; bound forwarded IP headers and collection sizes before vulnerable downstream parsers.
- Reject missing/example/weak server secrets and production mock auth. Browser sessions are opaque, hashed, expiring, and revocable; mock identities have a separate prefix.
- Random, expiring, one-use OAuth state in the PWA; random state comparison in the Chrome-managed extension flow. PWA callback exchange is guarded against repeated effects and account changes.
- Account-scoped snapshots, no reassignment of legacy unscoped caches, empty-snapshot handling, stale-response checks, and session-change listeners.
- Server-owned local notes preserved by imports; full read/merge/write transactions serialized per user, including first writes.
- Complete nested snapshot validation and limits; production demo sync disabled.
- Early and shared API limits, bounded history, and summary responses for intermediate import chunks.
- Dirty note drafts retained across refreshes and unrelated saves; user-visible retry/sign-in errors; malformed-cache and malformed-hash recovery boundaries.
- Tests and builds for all application layers in the PR workflow, including PostgreSQL and a local Kakao identity fixture.
- Logout/current-session and logout-all APIs; account deletion; encrypted recoverable Kakao credentials; cleanup/retention; deletion guards against stale agent-key or OAuth-code issuance.
- Five-second individual upstream deadlines, a 20-second request signal and 22-second response deadline, a 30-second Vercel budget, and a 25-second shared-client abort deadline. Public API errors omit internal payloads.
- Build-versioned public shell caching, immediate registration, explicit offline readiness, update handling, larger hit areas, improved focus contrast, plain settings copy, and portable README links.

## Explicit limitations and outstanding verification

**TASK-06:** Automatic Maps-to-Kakao-Login identity verification remains unavailable. The extension now requires explicit manual account confirmation before each import and Kakao-note edit, no longer stamps the cloud identity as proof of ownership, and no longer presents a misleading "skip owner validation" setting. Diagnostics say Maps ownership is unverified. An import or note save also rechecks the active extension session before each subsequent write and stops if accounts change mid-action. This prevents silent implicit account selection, but a person can still manually confirm the wrong accounts. Live Kakao verification is still required before calling this an automatic identity binding.

**TASK-07:** No patched dependency resolution currently satisfies the 14-day release-age rule. No exclusion was introduced. The parser mitigation is active, IP inputs and collections are bounded, and URI-related advisories have a source-level reachability assessment below. The audit therefore still reports the seven known advisories; mitigations do not make the registry audit green.

Reachability from the current dependency graph and source:

| Advisory package | Runtime path | Current boundary | Remaining risk |
| --- | --- | --- | --- |
| `body-parser` via Express | Every JSON route, including `/mcp` | `express.json({ inflate: false, limit: "10mb" })` rejects compressed bodies, the prerequisite for the reported trailing-bytes issue | A future parser configuration change could re-enable the vulnerable path; upgrade once eligible. |
| `ip-address` via `express-rate-limit` | Rate-limit keying on request IPs | Reject `X-Forwarded-For` over 512 bytes or with a non-IP component before any limiter runs | Other proxy headers and deployment-specific forwarding still need an integration check. |
| `zod` direct and via MCP SDK | MCP tool inputs and other schemas | JSON bodies have a 10 MB ceiling and a 50,000-node/5,000-entry pre-validation limit; tool fields have small string and numeric bounds | Oversized valid inputs can still consume resources within those limits; upgrade once eligible. |
| `fast-uri` via Ajv in the MCP SDK | Ajv compiles MCP tool JSON schemas | This server registers four fixed tool schemas; request values are data and cannot supply schema IDs or references | Low apparent reachability for these URI-parser advisories in the current tool set; a future dynamic schema source would change that assessment. |

This is a source-level reachability assessment, not proof that a vulnerable dependency is safe. The lockfile still resolves `body-parser@2.3.0`, `ip-address@10.7.3`, `zod@4.6.5`, and `fast-uri@3.1.8`.

| Package | First reported patched version | Published UTC | Earliest eligible UTC |
| --- | --- | --- | --- |
| zod | 4.6.6 | 2026-10-11 16:18:23 | 2026-10-25 16:18:23 |
| ip-address | 10.7.4 | 2026-10-11 19:34:42 | 2026-10-25 19:34:42 |
| fast-uri | 3.1.9 | 2026-10-19 23:05:26 | 2026-11-02 23:05:26 |
| body-parser | 2.4.0 | 2026-10-22 11:39:38 | 2026-11-05 11:39:38 |

Dates came from npm publication metadata during this implementation. A fresh `pnpm audit --json` on 2026-10-25 still reported seven advisories (two high, three moderate, two low) for these four locked packages. Re-evaluate available versions at upgrade time and run pnpm with the release-age setting intact. Patched floors are not a request to bypass that setting.

**TASK-16:** The local checks pass and CI is configured; a hosted GitHub Actions run has not been triggered or observed. Browser flow checks are partly manual; CI currently automates shared browser logic and backend behavior, not a full headless browser/loaded-extension suite. Pull requests run verification without publishing a ZIP. Pushes to `main` run Release Please, which opens package-version PRs. Merging a release PR creates package-specific releases; only an extension release runs the bundle job. It uploads `kakao-lists-extension-<manifest version>-<short commit>.zip` and a stable `kakao-lists-extension.zip` filename to the extension release and links the versioned asset in the run summary. The repository-wide latest release may be another package, so downloaders should choose the newest `extension-v*` release.

**TASK-21 (complete):** Shell fetch/privacy behavior and explicit update activation are covered by local service-worker lifecycle tests; the production build includes versioned assets. In a dedicated Safari window, an initial online load cached a synthetic account and two-place list. With both local servers stopped, reloading opened the app shell, retained the list, and showed a connection error instead of claiming a fresh sync. Serving a second frontend build on the same origin produced "New version ready"; "Update now" activated it and settings returned to "Up to date". No real Kakao account or production API was used.

**TASK-22:** Desktop sign-in, list navigation/focus, note drafts, and light-theme settings were inspected in Brave with synthetic data. Safari verification covered a compact window at high zoom, settings navigation, the accessibility tree's headings/control names, keyboard focus on Technical details, and rendered light/dark modes. The focus indicator was clearly visible. The dark screenshot exposed a grid overlay crossing content, which was removed; the light screenshot exposed low-contrast header icons, corrected with explicit light-theme colors and verified after reload. Semantic text/focus tokens are independently contrast-tested in both themes. The extension's note controls have 44 px hit areas, but a physical small-phone/landscape check and full VoiceOver pass of the Chrome extension remain open; a Safari accessibility tree is not equivalent to spoken screen-reader testing.

## Local evidence

- Shared/client tests cover snapshot validation, account cache isolation, corrupt/blocked storage, OAuth state replay/expiry, deep-link decoding, service-worker cache boundaries, and network error copy.
- Server tests cover real PostgreSQL snapshot races, first writes, note preservation/clearing, session revocation, account data isolation/deletion, stale credential issuance, encrypted credential persistence, disabled demo sync, malformed data, request limits, and timeouts, plus existing MCP/OAuth suites.
- Kakao HTTP checks use the real application against `postman/mocks/kakao`. The local Postman request log confirms token exchange, user-info validation, and a 500 upstream response were exercised. The fixture's timeout response exceeds the application's upstream deadline. No real Kakao credentials or accounts are used.
- CLI 1.69.0 lacks the skill's newer `postman simulation` command; the supported single-service `postman mock run` was used instead. CI runs that same local handler directly with Node.
- Test databases use isolated temporary schemas in a disposable PostgreSQL container. No production database, environment secrets, deployments, or GitHub remote state were changed.

The most recent complete run passed **188 tests** (16 shared/client tests and 172 server tests), zero failures and zero skipped tests. All PostgreSQL suites ran against the disposable database and local Kakao fixture. After adding the in-flight account-switch guard, its two targeted extension tests passed. The latest `pnpm check` (101 files, no diagnostics), `pnpm typecheck`, `pnpm build`, and `git diff --check` passed after the Safari-driven styling fixes. No dependency versions were changed; the registry advisories remain open under the documented release-age constraint.

## Rollout and data lifecycle

1. Back up the database and stage the migration. Preserve a stable, randomly generated `SYNC_SERVER_SIGNING_SECRET` of at least 32 characters; it derives the credential encryption key through domain-separated HKDF. Use `openssl rand -hex 32` to generate a value.
2. Existing signed sessions become invalid. Startup deletes legacy plaintext Kakao credential records; users must sign in again. The encrypted format authenticates ciphertext with AES-256-GCM. No plaintext migration secrets are logged.
3. Rebuild/redeploy the server and clients together. Old clients can receive opaque tokens, but cannot call logout/account deletion until rebuilt. The domain runtime must be built before starting the compiled server; the server build script does this automatically.
4. Configure `CRON_SECRET` for serverless cleanup. History retains at most 20 records/account and 30 days; expired browser sessions and credentials unused for 60 days are purged. A minimal account-id/deletion-time guard remains for at most a day plus the cron interval to reject stale authorization work. It contains no lists, notes, tokens, or profile data. Pending sign-ins without known identity expire after ten minutes; shared OAuth registrations use their existing cleanup rules.
5. Rotating the encryption secret invalidates stored recoverable credentials. Plan re-authentication and browser-session invalidation together; there is no automatic multi-key migration in this change. Restrict production database and secret access, and handle backups according to the deployment's own retention policy.
6. Validate live Kakao consent/cancellation, extension imports and note editing, manual account-mismatch recovery, production proxy headers, deployed request budgets, offline/update behavior, and the remaining accessibility checks. No production deployment is included here.
