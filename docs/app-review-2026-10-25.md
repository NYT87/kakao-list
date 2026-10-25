# App review — 2026-10-25

Reviewed commit `5642a78` across the Express server, MCP/OAuth implementation, extension, PWA, shared packages, deployment configuration, and CI. Application behavior was not changed.

This is a source review with local verification, not a production penetration test. High means a security boundary, sensitive data, or persisted user content is at material risk; Medium means a reproducible reliability problem or significant operational exposure. Deployment-dependent conditions are called out explicitly.

## Priority findings

### 1. High — Vulnerable request parser is installed and exposed before authentication

Evidence: [server middleware](../apps/server/src/index.ts), line 100; [lockfile](../pnpm-lock.yaml), line 673.

Express resolves to `body-parser@2.3.0`, affected by GHSA-27r3-jxmh-p828. The app installs `express.json({ limit: jsonBodyLimit })` globally with default decompression enabled, before authentication and route rate limits. The maintainer describes a process crash from a compressed request with trailing bytes; neither a matching route nor authentication is required. Actual exposure through Vercel depends on its handling of encoded bodies and was not tested.

Suggested fix: reject compressed request bodies with `inflate: false` if they are unnecessary, as the maintainer recommends. Update the dependency once a suitable release meets the repository's 14-day rule. Do not bypass the age policy automatically. [Maintainer advisory and mitigation](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).

The full dependency audit found seven advisories, including a second High on Zod; see the dependency table below. No denial-of-service payload was sent to a running app.

### 2. High, configuration-dependent — Missing signing secret permits forged sessions

Evidence: [server](../apps/server/src/index.ts), lines 48–49 and `verifySessionToken`/`signPayload` near lines 1045–1108.

If `SYNC_SERVER_SIGNING_SECRET` is absent, the server uses the public string `change-me-in-production`. Anyone knowing an existing user's Kakao service id can sign a session for that id. The Kakao-backed check does not stop this: it validates the victim's stored Kakao token against the same forged user id. This exposes snapshot reads/writes and agent-token issuance while that stored Kakao authorization remains usable.

An isolated probe of the actual signing/verifying functions accepted a token created with the public fallback for `existing-victim-id`. No deployed secret or real account was inspected.

Suggested fix: fail startup for absent, default, or insufficiently strong signing secrets; use a random secret. Rotate it if a deployment used the fallback. Also refuse production startup with `ALLOW_MOCK_AUTH=true`: the mock endpoint accepts a caller-selected user id and can otherwise impersonate existing users.

### 3. High — PWA OAuth callbacks are not bound to the initiating browser

Evidence: [PWA](../apps/pwa/src/App.tsx), lines 311–321 and 558–562; [extension background](../apps/extension/src/background.ts), lines 77–100.

The PWA sends the fixed state `kakao-lists-pwa` and never checks callback state before exchanging a code. An attacker can obtain an unredeemed authorization code for their own account and direct another person to the app's callback URL with it. The app signs that browser into the attacker's account without proving the browser initiated the flow. Subsequent notes can be saved into that account. This is login CSRF, not theft of the victim's Kakao credentials.

The extension also sends fixed state and does not compare returned state, although its Chrome-managed callback constrains the practical attack path. The separate MCP OAuth implementation already uses random, browser-bound state and should serve as a reference.

Suggested fix: generate unpredictable state per attempt, store it for that browser, compare it before exchanging a code, and consume it once. Add PKCE where supported. [OAuth security guidance](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.7).

### 4. High — Account switching exposes the previous account's cached lists

Evidence: [PWA repository and hydration](../apps/pwa/src/App.tsx), lines 26, 272–275, 296–303 and 443–460; [extension hydration](../apps/extension/src/PopupApp.tsx), lines 145–160 and 825–834; [storage implementation](../packages/storage/src/index.ts), lines 16–47.

Each surface stores a single snapshot under a fixed key, without an account id. Sign-out deletes the session but leaves the snapshot. Hydration loads those lists before fetching the newly signed-in account. If account B has no server snapshot, the null-snapshot branch returns without clearing account A's cached lists; a failed pull also leaves them visible. The extension likewise keeps and hydrates the prior account's cache.

Reproduction: sign in as A, load private notes, sign out, then sign in as B with no snapshot or while the server is unavailable. A's cached content remains available to B. An isolated repository probe confirmed that a new repository instance with the same key reads the prior instance's private note.

Suggested fix: namespace caches by verified user id, clear displayed state and drafts on identity changes, and handle an authoritative empty snapshot explicitly. Cancel or ignore requests completing after sign-out/account changes. Listen for session changes across tabs as appropriate.

### 5. High — Normal re-import deletes local notes

Evidence: [extractor](../apps/extension/src/kakaoMapsExtractor.ts), line 390; [import upload](../apps/extension/src/PopupApp.tsx), lines 291–329; [server list replacement](../apps/server/src/index.ts), lines 733–737.

Every extracted item gets `localNote: undefined`. Import saves that snapshot locally and sends each replacement list to the server. The server replaces the existing list wholesale, without preserving user-authored local notes. Refreshing lists therefore deletes notes even with a single device and no concurrent writes. This is distinct from the documented multi-device last-write-wins limitation.

An isolated probe of `mergeSnapshotList` reproduced a saved local note disappearing when the same list/place was re-imported.

Suggested fix: preserve local notes on the server by stable list/item identity during imports, or store local notes separately from imported data. Distinguish an import's missing note from an explicit user request to clear it. Reconcile the local cache with the preserved result.

### 6. High, account-mismatch scenario — Import trusts a different browser login as the cloud account

Evidence: [tab extraction](../apps/extension/src/kakaoMapsExtractor.ts), lines 121–140 and 278–300; [ownership stamping](../apps/extension/src/PopupApp.tsx), lines 1886–1902; [import upload](../apps/extension/src/PopupApp.tsx), lines 291–329.

The Kakao Maps tab's cookie session and the extension's seven-day cloud session are independent. No identity comparison connects them. Import extracts whichever Maps account is signed in, stamps those lists as imported by the cloud user, and uploads them into that user's server account. A browser that changes its Maps login from A to B while the extension stays signed in as A can upload B's private places and memos into A's account, where A's connected assistants can read them.

Suggested fix: establish a reliable identity binding between the Maps session and the cloud account before importing; block mismatches. Do not treat ownership stamping or nickname matching as proof of identity. If a trustworthy mapping is unavailable, make the uncertainty explicit and require an account-selection/re-authentication flow. This conclusion is source analysis; no live Kakao account-switch test was performed.

### 7. Medium — Partial updates merge outside the write transaction

Evidence: [list route](../apps/server/src/index.ts), lines 365–377; note route, lines 406–449; writer, lines 758–791.

Both list uploads and note edits read the snapshot and construct the replacement before `saveLatestSnapshot` acquires a row lock. Two requests can read the same old snapshot, change different lists/notes, and then commit successfully in sequence; the second writes its stale copy over the first. Locking only the version increment does not protect the earlier read/merge. On the first write there is no row to lock, so concurrent initial writes can also both choose version 1.

Suggested fix: acquire a per-user lock before reading and keep the read/merge/write inside the same transaction, including the no-existing-row case. Alternatively enforce an expected version and explicit retry. Isolated merge probes show the stale inputs; actual PostgreSQL interleavings were not exercised.

### 8. Medium — Invalid snapshots can be persisted and break all readers of that account

Evidence: [validator](../apps/server/src/index.ts), lines 710–723; [client filtering](../apps/pwa/src/App.tsx), lines 1072–1077; [agent queries](../apps/server/src/agentQueries.ts), lines 62–72.

`validateSnapshot` checks only truthiness of source/date and whether lists is an array. It accepts `lists: [null]`, lists with missing/non-array items, and non-string names. The authenticated whole-snapshot route can persist these values. PWA/extension hydration and MCP queries assume the full shape, so a buggy client can poison its owner's snapshot. The isolated validator probe accepted `{"syncedAt":"now","source":"probe","lists":[null]}`.

Suggested fix: validate the complete nested contract at the server boundary, including identifiers, types, unique ids, dates, collection sizes, note limits, and allowed URL schemes. Apply compatible guards when loading cached/legacy data. Verify payloads before saving any client cache.

### 9. Medium — A production endpoint overwrites real data with demo lists

Evidence: [server](../apps/server/src/index.ts), lines 261–277 and `buildMockKakaoSnapshot`; [shared client](../packages/sync/src/index.ts), `syncFromKakao`.

`POST /api/sync/kakao` remains active even when `ALLOW_MOCK_AUTH=false`. Any valid user session can call it; it writes mock lists into that user's latest snapshot, replacing real imports and local notes. Current visible clients need not use it for an older client or manual call to cause data loss.

Suggested fix: remove the endpoint or return an explicit unavailable response until real server import exists. Development mocks should use an isolated development account/database and never silently replace production data.

### 10. Medium — Main API traffic has no rate limits and snapshot history grows without bounds

Evidence: [server routes](../apps/server/src/index.ts), lines 207–459 and 773–778; [maintenance](../apps/server/src/maintenance.ts), `runMaintenance`; [chunk loop](../apps/extension/src/PopupApp.tsx), lines 322–329.

Limits protect MCP/OAuth and agent management, but not code exchange, snapshot reads, snapshot writes, or notes. A valid account can repeatedly upload bodies up to 10 MB, and every write appends a complete snapshot to history. A normal N-list import performs N full-snapshot history writes and receives N full snapshots; with similarly sized lists, copying grows roughly quadratically during an initial import. Maintenance never prunes snapshot history. Each protected API call also contacts Kakao, amplifying upstream traffic.

Suggested fix: add early per-IP and authenticated per-user budgets to the main API; bound input sizes and stored history; avoid recording/returning a full snapshot for every chunk. Preserve import recovery semantics when changing the protocol. Consider a staging import plus one atomic finalization.

### 11. Medium — A successful PWA sign-in retries the consumed authorization code

Evidence: [PWA](../apps/pwa/src/App.tsx), lines 48, 317–333 and 357–361.

The callback is captured once with `useMemo`. Successful exchange changes `cloudSession`, which changes the `hydrate` callback and reruns its effect. Removing the code from the URL does not update that memoized callback, so hydration attempts to exchange the same one-time code again. React Strict Mode can also initiate duplicate exchanges during development. The redundant request fails and races the successful snapshot load's status updates.

Suggested fix: consume the callback through a dedicated, once-per-attempt operation with an in-flight guard; separate callback processing from cache hydration and session-triggered pulls. Clear the in-memory callback as well as the URL.

### 12. Medium — Saving one note silently discards other unsaved drafts

Evidence: [PWA](../apps/pwa/src/App.tsx), lines 191–200 and 516–521; [extension](../apps/extension/src/PopupApp.tsx), lines 796–814.

The PWA replaces every draft whenever the selected list object changes. Saving one row loads a fresh server snapshot, triggering that reset. Edit notes in two rows, save only the first, and the second draft reverts. The extension resets all membership drafts on refreshed membership data, including background refreshes and saves.

Suggested fix: track dirty fields by list/item id, update only clean drafts on refresh, and clear a dirty flag only for a successfully saved value. Preserve changes typed while a save is in flight and warn before navigation discards dirty drafts.

### 13. Medium — List-page save failures are invisible

Evidence: [PWA save handler](../apps/pwa/src/App.tsx), lines 526–536; status rendering at lines 614–620 and 682–688; list view at lines 816–934.

Failed saves and copy operations only update `status`/`message`. Those values render on the sign-in and settings pages, not the authenticated list page. A note-save failure, expired session, or network error therefore provides no visible or screen-reader feedback at the point of editing. Only a successful note save creates a toast.

Suggested fix: render persistent errors beside the affected note with an alert/live region, keep the draft, and provide retry or re-authentication. Surface background pull failures with a clear stale/offline indicator rather than silently showing old data.

### 14. Medium — Malformed local data or deep links can break startup

Evidence: [storage](../packages/storage/src/index.ts), lines 26–47; [PWA hydration](../apps/pwa/src/App.tsx), lines 296–303 and 359–361; [route parser](../apps/pwa/src/App.tsx), lines 1032–1038.

Storage parsing has no recovery or schema guard, and callers run hydration without catching its initial reads. Corrupted JSON rejects before the PWA reaches authentication or a cloud pull. An isolated repository probe reproduced `SyntaxError`. The route parser also throws on `#list/%`, and it decodes item ids twice: `URLSearchParams` has already decoded `item`. A legitimate id containing `%` can therefore throw or be altered. A malformed hash can crash rendering before any recovery controls appear.

Suggested fix: safely parse and validate cache records, quarantine/reset bad entries, continue to sign-in/server recovery, and catch storage failures. Decode each route component exactly once with an explicit invalid-route fallback. Add a top-level recovery boundary.

## Dependency audit

`pnpm audit --json` completed against the npm advisory service on the review date: **2 High, 3 Moderate, 2 Low**. These are seven advisories affecting four installed package names, not seven independently demonstrated application exploits. Patched floors below are registry-reported; their publication ages were not checked, and dependencies were not changed.

| Package and installed version | Audit severity | Advisory | Reported patched floor |
| --- | --- | --- | --- |
| `express > body-parser@2.3.0` | High | [Compressed-body process crash](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828) | `2.4.0` |
| `zod@4.6.5` | High | [Collection validation memory exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `4.6.6` |
| `express-rate-limit > ip-address@10.7.3` | Moderate | [Quadratic IPv6 zone parsing](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | `10.7.4` |
| `@modelcontextprotocol/sdk > ajv > fast-uri@3.1.8` | Moderate | [Scheme spoofing](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) | `3.1.9` |
| Same `fast-uri` dependency | Moderate | [Host confusion](https://github.com/advisories/GHSA-wjr9-j795-jxcr) | `3.1.9` |
| Same `fast-uri` dependency | Low | [Relative path equivalence](https://github.com/advisories/GHSA-xhq7-xmqj-769h) | `3.1.9` |
| Same `fast-uri` dependency | Low | [Suffix scheme injection](https://github.com/advisories/GHSA-333x-w4r6-6crp) | `3.1.9` |

Zod is used directly and by the MCP SDK, including public OAuth request schemas. Exact exploitability of the Zod, IP parser, and URI advisories was not established. Treat the body-parser middleware match as the clearest immediate dependency exposure.

## Other follow-ups

- **CI does not gate application correctness.** [Build workflow](../.github/workflows/build-extension.yml), lines 37–41, builds only the extension. Neither workflow runs tests, type checking, lint, the server build, or the PWA build. Add required checks, including PostgreSQL integration coverage for transactions. The current tests cover MCP/OAuth well but do not import the main Express app or exercise its snapshot/auth routes; no PWA, extension, or shared-storage test suite exists.
- **Logout does not revoke server sessions.** Clients delete local tokens only; the signed token remains valid for up to seven days, subject to the stored Kakao authorization. Add revocable sessions or a per-user/session invalidation mechanism for stolen credentials. A fresh login also leaves older signed tokens usable.
- **Timeout budgets conflict.** [Vercel API config](../apps/server/vercel.json) allows 10 seconds total, while each Kakao request can take 10 seconds and a protected request can perform validation, refresh, and revalidation. Set an end-to-end deadline and deployment budget that includes database work and all upstream calls. The shared HTTP client also lacks an abort timeout, so an unresponsive server can leave controls busy indefinitely.
- **The PWA has no offline app-shell cache.** [Service worker](../apps/pwa/public/sw.js) has install/activate/message listeners but no fetch handler or precache. Cached list JSON does not make an installed app reliably load offline. Deployments can also change hashed assets without changing `sw.js`, so the service-worker update button is not a reliable detector of frontend releases. Add versioned asset caching/update detection if offline/update behavior is intended.
- **Token/data lifecycle needs tightening.** Kakao access and refresh tokens are retained in plaintext application columns, including refresh tokens that outlive local sign-out. No account-data deletion flow or snapshot-history retention exists. Minimize stored credentials, restrict database access, and define deletion/retention behavior. No claim is made about the deployed database's disk encryption or access controls.
- **Internal errors escape to clients.** Several main API/database-health handlers return raw database or upstream messages. Log detailed failures server-side and return stable public errors. The newer agent routes already use safer generic errors.
- **Small touch controls.** The note-copy button is 24×24 CSS px, while the save control is 42×42. The copy button meets the basic 24px web target floor, so this is a mobile usability follow-up, not an asserted WCAG failure. Increase hit areas where space permits. Review focus-ring contrast and keyboard focus after hash navigation in a real browser.
- **User-facing implementation language and stale docs.** Settings expose device ids, server versions, and scaffold-era explanations to ordinary users. README still says list import is mocked and uses absolute paths from an old checkout. Update documentation and simplify normal sync/error messages around user actions.

## Verification and limits

| Check | Result |
| --- | --- |
| `pnpm typecheck` | Passed |
| `pnpm build` | Server, PWA, and extension passed |
| `pnpm test` | 115 enabled tests passed, 0 failures |
| PostgreSQL integration suites | Four suites disabled without `TEST_DATABASE_URL`; not exercised |
| `pnpm check` | Failed: four import-order errors and five CSS specificity warnings |
| `pnpm audit --json` | Seven advisories as detailed above |
| Isolated actual-source function probes | Reproduced note loss, invalid snapshot acceptance, fallback-secret signature acceptance, shared cache reads, corrupt-cache exception |

The first sandboxed test run could not bind local HTTP listeners; the permitted rerun outside the sandbox passed. The dependency audit likewise required permitted network access. Existing HTTP tests use in-memory stores and injected Kakao identity results; they do not verify live Kakao behavior. Isolated probes transpiled selected source functions into a VM and did not call production services. The concurrency finding follows the transaction boundaries in source; no live PostgreSQL race was reproduced.

No live Kakao login, loaded Chrome extension, production deployment, browser rendering/screen-reader pass, or destructive security payload was tested. This review does not establish whether production uses the fallback secret, has edge protections, or is already running a different dependency resolution. Local secrets were not read or disclosed. Only this report was added to tracked project files.

Suggested implementation order: mitigate the parser advisory and fail closed on secrets; bind OAuth and isolate account caches/import identity; preserve local notes; fix transaction boundaries and payload validation; then close UI feedback, recovery, and CI gaps.
