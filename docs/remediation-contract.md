# Review remediation contract

The existing JSON snapshot/list/note endpoints retain their request/response shapes. Server-owned local notes survive imports; only PATCH item-note explicitly edits or clears a note. Nested snapshots must validate before writes. Per-user transactions cover the full read/merge/write, including first writes. Imports from older clients remain compatible.

Sessions become opaque, hashed, expiring database records. Existing signed sessions must sign in again. POST /api/auth/logout revokes the current bearer session; POST /api/auth/logout-all revokes all browser sessions for that user. These operations do not disconnect assistants. DELETE /api/account deletes snapshots, history, Kakao credentials, sessions, agent keys, and OAuth grants/codes for that user; shared OAuth client registrations remain. All protected operations require a live session and Kakao-backed identity.

POST /api/sync/kakao returns 410 without modifying data. Mock auth is development-only and uses a mock-prefixed identity. Session/authenticated responses use Cache-Control: no-store. Main API errors use {error: {code, message}} with stable public messages. Invalid payloads return 400, unauthenticated requests 401, limits 429, upstream failures 502/504, unavailable database 503.

User caches are scoped by authenticated user id. Legacy unscoped data is discarded, never attributed to the next user. Empty server snapshots clear that account's cache. Logout removes displayed data, drafts, and cached private data; delayed requests cannot restore it. Offline app-shell caches exclude API responses, credentials, and saved-list JSON.

Kakao Maps and Kakao Login use different identity namespaces. Imports require an explicit account verification step when a trusted identity mapping is unavailable; the UI must say this is manual confirmation. An observable Maps identity change invalidates prior confirmation. No automatic ownership stamp may be treated as identity proof.

Dependency changes must meet the 14-day release-age policy. No production deployment, database deletion, or secret rotation is performed by this remediation work.

For chunk uploads, `?summary=true` returns the receipt fields without `snapshot`; existing requests retain their full response. A minimal one-day deletion guard prevents already-started authorizations/agent-key requests from recreating access after account deletion. Pending authorizations have no user id until callback and expire after ten minutes; callbacks begun before deletion are rejected once identity is known.

Deleting a list/place through a later import also removes its current local note. Reappearing places with new membership identifiers start without the removed note. Retained history is operational data, not a promised user-facing restore facility.

`GET /health` remains public and checks PostgreSQL. A healthy response includes `ok`, `service`, `database`, `version` (server package version), and `commit` (five-character build commit, or `unknown` when unavailable). Failed health responses retain the stable `{error: {code, message}}` envelope and also include `version` and `commit`. Client settings show each installed client's own package version and build commit; these are not snapshot server versions.
