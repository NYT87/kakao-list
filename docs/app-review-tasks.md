# App review tasks

Source: [App review — 2026-10-25](app-review-2026-10-25.md). Implementation status is tracked below and in [remediation-status.md](remediation-status.md). Checking a task means its acceptance criteria have been verified, not merely that code was changed.

Priorities: **P1** security and persisted-data protection; **P2** reliability and operational safeguards; **P3** usability and maintenance. These are implementation priorities, not vulnerability severity ratings. Deployment-dependent findings and unverified exploit paths retain the qualifications in the source review.

For every dependency change, use releases published at least 14 days ago and preserve `minimumReleaseAge`. Do not introduce exceptions without an explicit request. Keep fixes reviewable and add regression coverage for security boundaries, data loss, and recovery behavior.

## P1 — Security and data protection

- [x] **TASK-01: Mitigate the vulnerable request parser**

  **Description:** Global JSON parsing uses an affected `body-parser` version with decompression enabled before authentication. Reject compressed request bodies if the application does not need them, and update the dependency when a patched release satisfies the release-age policy.

  **Acceptance criteria:** Normal JSON requests still work; unnecessary compressed bodies are rejected before decompression; the mitigation is documented and verified locally without attacking a deployed service.

  **Scope:** Server middleware and dependency lockfile. Review finding 1.

- [x] **TASK-02: Fail closed on insecure authentication configuration**

  **Description:** Remove the public signing-secret fallback. Validate the configured secret at startup and prevent mock authentication from being enabled in production. Document secret generation and rotation, including invalidating sessions if the fallback was previously deployed.

  **Acceptance criteria:** Missing, default, or insufficiently strong secrets prevent startup; valid secrets work; production mock authentication is refused; forged and expired sessions are rejected.

  **Scope:** Server configuration and session authentication. Review finding 2.

- [x] **TASK-03: Bind OAuth callbacks to individual sign-in attempts**

  **Description:** Replace fixed OAuth state values in the PWA and extension with unpredictable, expiring values bound to the initiating browser flow. Verify and consume state before exchanging a code. Evaluate PKCE support before adding it.

  **Acceptance criteria:** Valid callbacks succeed; missing, mismatched, expired, and replayed state fail without code exchange; cancellation permits a clean retry.

  **Scope:** PWA sign-in, extension background authentication, and shared OAuth helpers. Review finding 3.

- [x] **TASK-04: Isolate cached data by account**

  **Description:** Namespace snapshots by authenticated user id. Clear displayed lists and drafts when identity changes, handle empty server snapshots explicitly, and prevent stale requests from restoring data after logout. Handle session changes across browser tabs.

  **Acceptance criteria:** After A signs out and B signs in, B never sees A's lists, including while offline or when B has no snapshot; responses completing after logout cannot repopulate the screen; legacy cache migration cannot assign unidentified data to a new account.

  **Scope:** PWA, extension popup/options, and shared storage. Review finding 4.

- [x] **TASK-05: Preserve local notes during imports**

  **Description:** Separate imported Kakao data from user-authored local notes, or merge notes by stable list/item identity on the server. Missing notes in imports must not mean an explicit request to delete them.

  **Acceptance criteria:** Re-importing unchanged or updated lists preserves local notes; explicitly clearing a note still works; deletion/reappearance behavior is defined; the local cache reflects the preserved server result.

  **Scope:** Snapshot merge logic, extension imports, and note persistence. Review finding 5.

- [ ] **TASK-06: Prevent imports into a mismatched cloud account**

  **Description:** Establish a trustworthy connection between the account signed into Kakao Maps and the extension's cloud identity before upload. Do not use nicknames or client-side ownership stamps as identity proof. Define a safe recovery flow if the private API cannot supply a reliable mapping.

  **Acceptance criteria:** Switching the Maps login while retaining the old extension session cannot silently upload the new account's data into the old cloud account; mismatches or unverifiable identity produce clear recovery guidance.

  **Scope:** Maps extraction, extension authentication, and upload initiation. Review finding 6. Requires investigation of the available identity mapping.

- [ ] **TASK-07: Address the remaining dependency advisories**

  **Description:** Review the reported Zod, ip-address, and fast-uri advisories and update direct/transitive dependencies to compatible patched releases that satisfy the release-age policy. Track TASK-01's parser update here as well without duplicating its mitigation work.

  **Acceptance criteria:** A fresh audit no longer reports the affected resolutions, or each remaining advisory has a documented mitigation and follow-up; type checking, tests, and all builds pass. Record actual application reachability separately from advisory severity.

  **Scope:** Workspace dependencies and lockfile. Source review dependency table.

## P2 — Reliability and operational safeguards

- [x] **TASK-08: Make partial snapshot updates atomic**

  **Description:** Protect the entire read/merge/write operation with a per-user transaction lock, including first writes, or implement expected-version checks with explicit retries. Cover list uploads and note edits.

  **Acceptance criteria:** Concurrent changes to different notes/lists survive; concurrent initial writes receive consistent versions; conflicts do not silently overwrite unrelated changes. Verify against PostgreSQL.

  **Scope:** Server snapshot routes and persistence. Review finding 7.

- [x] **TASK-09: Validate complete snapshot contracts**

  **Description:** Validate nested lists/items, field types, identifiers, dates, duplicates, note lengths, collection limits, and URL schemes before persistence. Add compatible checks for server responses and legacy cached records.

  **Acceptance criteria:** Malformed input receives a clear client error without changing the previous snapshot; valid existing imports remain compatible; invalid records cannot crash PWA, extension, or MCP readers.

  **Scope:** Server validation, shared contracts, and client cache boundaries. Review finding 8.

- [x] **TASK-10: Disable the production demo-sync endpoint**

  **Description:** Remove or explicitly disable `POST /api/sync/kakao` until it has a real implementation. Keep development mock data isolated from production user snapshots.

  **Acceptance criteria:** Calling the endpoint in production cannot replace real lists with demo content; obsolete client calls receive an explicit unavailable response; development fixtures cannot overwrite production accounts.

  **Scope:** Server route and shared sync client. Review finding 9.

- [x] **TASK-11: Bound main API traffic and snapshot storage**

  **Description:** Add early per-IP and authenticated per-user budgets for authentication and snapshot APIs. Define snapshot/history quotas and retention. Reduce full-snapshot copies and responses during chunked imports; evaluate staging an import and finalizing it atomically.

  **Acceptance criteria:** Excess traffic receives predictable rate-limit responses; storage growth is bounded; large imports retain recovery behavior and avoid unnecessary full-snapshot history writes for every chunk; cleanup preserves the current snapshot.

  **Scope:** Server rate limits, import protocol, history persistence, and maintenance. Review finding 10.

- [x] **TASK-12: Consume PWA authorization codes once**

  **Description:** Separate callback processing from cache hydration and session-triggered pulls. Guard in-flight exchanges and clear callback data in memory as well as in the URL.

  **Acceptance criteria:** One sign-in attempt exchanges its code once, including under development Strict Mode; session updates do not retry consumed codes; retries after failed attempts behave predictably.

  **Scope:** PWA authentication lifecycle. Review finding 11. Coordinate with TASK-03.

- [x] **TASK-13: Preserve unsaved note drafts**

  **Description:** Track dirty drafts by list/item identity and refresh only clean fields. Saving one note must not replace another note's draft or discard text entered while a request is in flight. Warn before navigation would discard changes.

  **Acceptance criteria:** Edit two notes and save one: the other draft remains; background refresh preserves dirty drafts; failed saves retain text; changes typed during a save are preserved.

  **Scope:** PWA and extension note editors. Review finding 12.

- [x] **TASK-14: Show actionable save and sync errors**

  **Description:** Display note-save and copy failures where the action occurs, with accessible feedback and a recovery action. Distinguish stale/offline data from a successful fresh pull and guide users back to sign-in when sessions expire.

  **Acceptance criteria:** Offline, expired-session, and server-error cases are visible on the list page and announced appropriately; drafts remain intact; retry/re-authentication is available; success feedback remains clear.

  **Scope:** PWA note UI and sync status. Review finding 13.

- [x] **TASK-15: Recover from corrupt caches and malformed routes**

  **Description:** Guard local-storage reads, JSON parsing, and record shape checks. Quarantine/reset invalid caches and continue toward recovery. Decode hash route components exactly once, reject malformed encoding safely, and add a top-level recovery boundary.

  **Acceptance criteria:** Invalid JSON, invalid snapshot shapes, unavailable storage, `#list/%`, and item ids containing percent signs do not leave a blank or unusable app; valid deep links still resolve after hydration.

  **Scope:** Shared storage and PWA startup/routing; extension hydration. Review finding 14.

- [ ] **TASK-16: Add application checks and regression coverage to CI**

  **Description:** Run type checking, linting, tests, and all application builds in CI. Add PostgreSQL integration execution and regression coverage for the main snapshot/authentication routes, shared storage, and critical browser flows. Fix the existing import-order errors and assess CSS specificity warnings.

  **Acceptance criteria:** Checks run for pull requests; PostgreSQL suites actually execute; regressions in account isolation, note preservation, authentication, and atomic updates fail CI; required checks pass. Pin any new Actions to eligible release SHAs.

  **Scope:** GitHub workflows and relevant test suites. Source review verification and CI follow-up.

- [x] **TASK-17: Revoke server sessions on logout**

  **Description:** Introduce revocable sessions or another server-side invalidation mechanism. Define current-session logout separately from signing out all devices, and avoid unintentionally revoking independently authorized assistant connections.

  **Acceptance criteria:** A copied session token stops working after its session is logged out; expiry remains enforced; multi-device and assistant-connection behavior is documented and tested.

  **Scope:** Server session model and PWA/extension logout.

- [x] **TASK-18: Align request and deployment timeouts**

  **Description:** Define an end-to-end server deadline covering database work, Kakao validation, refresh, and revalidation. Align it with the deployment budget and add abort deadlines to the shared HTTP client.

  **Acceptance criteria:** Slow/unreachable dependencies terminate within the documented budget; controls leave their busy state; timeout errors offer a useful retry path; requests do not depend on multiple full upstream timeouts fitting into a shorter function limit.

  **Scope:** Server Kakao calls, shared sync client, and Vercel configuration.

- [x] **TASK-19: Define credential and account-data lifecycle**

  **Description:** Minimize retained Kakao credentials and assess encryption/key management for credentials that must remain recoverable. Define account deletion across snapshots, history, credentials, agent tokens, and OAuth grants, coordinated with history retention.

  **Acceptance criteria:** Retention and deletion rules are documented; account deletion removes or invalidates all relevant records; credentials do not appear in logs or responses; required secrets/keys have an operational management plan.

  **Scope:** Server persistence, maintenance, and account management. Coordinate with TASK-11 and TASK-17.

- [x] **TASK-20: Return stable public API errors**

  **Description:** Replace raw database and upstream error messages in API/health responses with safe, stable messages and error identifiers. Preserve useful diagnostic details only in server logs without exposing credentials or OAuth codes.

  **Acceptance criteria:** Database outages and Kakao failures produce suitable HTTP statuses and understandable public errors; responses omit internal connection details and upstream payloads; logs allow diagnosis without leaking secrets.

  **Scope:** Main server routes, health checks, and shared client error handling.

## P3 — Usability and maintenance

- [x] **TASK-21: Implement reliable PWA offline loading and updates**

  **Description:** Add a versioned app-shell caching strategy and update detection that changes with frontend releases. Define behavior for cached private data, logout, and offline navigation without caching authenticated API responses indiscriminately.

  **Acceptance criteria:** After an initial online load, the app shell opens offline; users can distinguish cached data from fresh data; a frontend release is detected and activated predictably; logout/account isolation remains intact.

  **Scope:** PWA service worker, build integration, and update UI. Complete account-isolation safeguards first.

- [ ] **TASK-22: Improve touch and keyboard interaction**

  **Description:** Increase practical hit areas for compact note controls, inspect focus-ring contrast in both themes, and manage keyboard focus after hash navigation. Verify responsive layouts and screen-reader feedback in a real browser.

  **Acceptance criteria:** Note controls are comfortable on a small phone; keyboard focus remains visible and predictable; navigation lands focus appropriately; reduced-motion preferences and light/dark themes work. Record actual accessibility results rather than assuming a failure from size alone.

  **Scope:** PWA and extension UI styles and navigation.

- [x] **TASK-23: Simplify product text and refresh setup documentation**

  **Description:** Replace scaffold-era explanations with plain descriptions of importing, viewing, saving, and recovering. Move technical identifiers into optional diagnostics where useful. Correct outdated README statements and absolute paths from an old checkout.

  **Acceptance criteria:** Ordinary users can understand import/sync states without server terminology; diagnostics remain available when needed; repository links work from any checkout; setup instructions accurately describe current capabilities.

  **Scope:** PWA/extension copy, README, and supporting documentation.

## Remaining verification and policy constraints

- **TASK-06:** Manual confirmation is implemented for every import/note edit. The misleading "skip owner validation" control has been removed, and in-flight actions stop after an extension account switch. A trustworthy automatic identity mapping and live mismatch verification remain unresolved.
- **TASK-07:** Mitigations are implemented; patched dependency versions remain ineligible under the 14-day rule. Exact eligible dates are in remediation-status.md.
- **TASK-16:** CI configuration, PostgreSQL tests, and shared/client tests are implemented and pass locally. A hosted run and a full automated browser/extension suite remain unverified.
- **TASK-22:** Touch/focus/reduced-motion changes, compact Safari layout, visible keyboard focus, and rendered light/dark checks are complete. A real small-phone/landscape device and VoiceOver pass of the Chrome extension remain open.

No unchecked task means work was skipped: these entries retain specific verification or external-policy follow-ups rather than claiming unverified completion.
