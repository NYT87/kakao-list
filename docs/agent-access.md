# Agent Access (MCP)

Design notes for letting AI agents (Claude Code, Claude Desktop, claude.ai, ChatGPT, Cursor, …) read a user's saved Kakao lists and ask the extension to refresh them.

Status: **phase 1 implemented** (read-only MCP with personal access tokens). Phases 2 and 3 are proposals.

## Goals

- Users can ask an agent questions about their saved places and notes ("which cafés in Busan did I save?", "what did I write about X?", "plan a day from my Jeju list").
- Users connect an agent by signing in with Kakao — no tokens to copy.
- Agents can request a fresh import from Kakao Maps.
- Read-only by default; users can see and revoke connected agents.

## Overview

The sync server (`apps/server`) already stores the latest snapshot per Kakao user id (`latest_snapshots`). We expose it through an **MCP (Model Context Protocol) server** mounted on the same Express app.

| Phase | Scope |
|---|---|
| 1 | `/mcp` endpoint with read-only tools |
| 2 | OAuth 2.1 authorization server that delegates login to Kakao |
| 3 | Agent-triggered sync, executed by the extension |

Personal access tokens (see [Alternative: personal access tokens](#alternative-personal-access-tokens)) are an optional fallback, and are how phase 1 shipped before OAuth exists.

## Phase 1 implementation

| Piece | Location |
|---|---|
| Query helpers (filtering, search, pagination) | `apps/server/src/agentQueries.ts` |
| Agent tokens: generation, hashing, verifier, Postgres store | `apps/server/src/agentTokens.ts` |
| Token management API for the PWA | `apps/server/src/agentTokenRoutes.ts` |
| MCP endpoint and tools | `apps/server/src/mcpServer.ts` |
| Wiring (`/mcp`, `/api/agent-tokens`, table creation) | `apps/server/src/index.ts` |
| PWA settings panel "AI Assistants" | `apps/pwa/src/AgentAccessPanel.tsx` |
| Tests | `apps/server/src/*.test.ts` (`pnpm test`) |

Decisions:

- **Helpers live in the server, not `packages/domain`.** The compiled server (`node dist/index.js`) only imports types from `@kakao-lists/domain`, whose entry point is a raw `.ts` file; importing runtime code from it would break the production build. Move them when the domain package gets a build step.
- **`/mcp` uses the SDK's `requireBearerAuth` with a pluggable `OAuthTokenVerifier`.** Phase 2 adds an OAuth verifier next to the agent-token one without touching the tools.
- **Agent tokens do not re-check the Kakao login on each request.** They are independent, revocable credentials with a fixed expiry (30, 90 or 365 days; default 90). Re-validating against Kakao would add a Kakao API round-trip to every tool call.
- **SHA-256 for token hashes.** Tokens carry 256 random bits, so a slow password hash adds latency without adding security.
- **At most 10 active tokens per user**, enforced under a per-user advisory lock. `last_used_at` is written at most every 5 minutes.
- **Snapshot load failures** are logged and returned to the agent as a generic message; database details never reach the agent.

API (session-authenticated, used by the PWA):

| Method | Path | Result |
|---|---|---|
| `GET` | `/api/agent-tokens` | `{ tokens: AgentToken[] }` (no secrets; every active token first, then up to 100 total with the most recent expired ones) |
| `POST` | `/api/agent-tokens` | `{ name, expiresInDays? }` → `201 { token, agentToken }`, `400` invalid, `409` limit reached |
| `DELETE` | `/api/agent-tokens/:id` | `204`, or `404` when unknown or not owned |

`/mcp` accepts `POST` only (stateless); `GET`/`DELETE` return `405`. Missing or invalid tokens get `401` with a `WWW-Authenticate: Bearer` challenge; tokens without `lists:read` get `403`.

Known gaps:

- **No rate limiting** on `/mcp` or `/api/agent-tokens`. An in-memory limiter is ineffective on serverless instances; this needs a shared store or platform rules (e.g. Vercel firewall).
- Token issuance and revocation are logged with the token id only; there is no persistent audit log.

Implementation notes:

- **Dependencies:** `@modelcontextprotocol/sdk` and `zod` are pinned to exact versions in `apps/server/package.json`; `@types/node` is pinned at the root.
- **Tokens must expire.** The SDK's `requireBearerAuth` rejects auth info without `expiresAt`, which is why agent tokens always have an expiry.
- **Stateless transport.** Streamable HTTP with `enableJsonResponse` creates one MCP server per `POST` and keeps no sessions, which fits short-lived Vercel functions.
- **Token format:** `kl_pat_` followed by 32 random bytes (base64url). The prefix makes leaked tokens easy to find with secret scanners and grep.

Verification (2026-10-24): `pnpm test` (60 tests, 6 of them Postgres integration), `pnpm typecheck`, `biome check`, server and PWA builds, and a curl smoke test against local Postgres. The Postgres tests only run with `TEST_DATABASE_URL` set and need the local database running (`docker compose up -d postgres`); otherwise they fail with `ECONNREFUSED`.

---

## Phase 1 — MCP server

### Transport

- Use `@modelcontextprotocol/sdk` with the **Streamable HTTP** transport in **stateless** mode.
- Stateless is required: the server runs as a Vercel function (`maxDuration: 10`), so no long-lived sessions or in-memory state.
- Every request: authenticate bearer token → resolve Kakao user id → `getLatestSnapshotRow(userId)` → answer.

### Tools

Filter server-side; never dump the whole snapshot into the agent context.

| Tool | Input | Returns |
|---|---|---|
| `list_lists` | — | List id, name, description, item count, `updatedAt` |
| `get_list` | `listId`, `limit?`, `offset?` | Paginated places in one list |
| `search_places` | `query`, `listId?` | Matches across `title`, `subtitle`, `kakaoNote`, `localNote` |
| `get_place` | `listId`, `itemId` | Full place detail, notes, Kakao link (`href`) |

Every read response includes the snapshot `syncedAt`, so the agent can tell the user how fresh the data is and offer a sync (phase 3).

Search/pagination helpers can live in `packages/domain` so the PWA can reuse them.

### Privacy

- Notes are sent to whichever AI provider the user connects. The connect screen must say so.
- Read tools require the `lists:read` scope only.
- Write tools (e.g. `update_local_note`) are out of scope for now and would get their own scope later.

---

## Phase 2 — Authentication via Kakao (OAuth 2.1)

### Why agents can't use Kakao OAuth directly

1. **Redirect URIs** — each MCP client has its own callback (claude.ai uses a fixed URL; Claude Code and Cursor use `http://localhost:<random port>`). Kakao only accepts redirect URIs pre-registered in its developer console.
2. **Client registration** — MCP clients expect dynamic client registration (or Client ID Metadata Documents). Kakao supports neither.
3. **Wrong token** — the agent would end up holding a Kakao API token. We want a token that grants read access to our server only.

### Solution: our server is the authorization server, Kakao is the identity provider

```
Agent (Claude, Cursor…)          Our server                          Kakao
  │ 1. GET /mcp  → 401 + WWW-Authenticate (resource metadata URL)
  │ 2. discovers OAuth metadata, registers (DCR)
  │ 3. opens browser: /authorize?client_id&redirect_uri&code_challenge&scope…
  │                               │ 4. stores pending request, redirects ──► Kakao login + consent
  │                               │ 5. /oauth/kakao/callback?code  ◄──────
  │                               │    exchange code → Kakao user id
  │                               │    (reuse existing Kakao exchange logic)
  │                               │ 6. issues OUR auth code, redirects
  │ ◄──────────────── agent redirect_uri?code&state
  │ 7. POST /token (code + PKCE verifier)
  │ ◄── access_token (+ refresh_token), bound to the Kakao user id
  │ 8. calls /mcp with Bearer token → tools read that user's snapshot
```

From the user's side: click **Connect** → familiar Kakao login → done.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /.well-known/oauth-protected-resource` | Points MCP clients at the authorization server |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata |
| `POST /register` | Dynamic client registration |
| `GET /authorize` | Validates request, shows consent line, redirects to Kakao |
| `GET /oauth/kakao/callback` | Kakao redirect target; resolves user, issues our auth code |
| `POST /token` | `authorization_code` (PKCE) and `refresh_token` grants |
| `POST /revoke` | Optional token revocation |

The SDK's `mcpAuthRouter` (Express) implements the endpoint wiring and PKCE validation; we implement its `OAuthServerProvider` interface against Postgres.

### Storage (Postgres)

State must be in Postgres (serverless, no memory between requests).

| Table | Contents |
|---|---|
| `oauth_clients` | Registered clients: id, name, redirect URIs, created at |
| `oauth_pending_authorizations` | Request parked during the Kakao round-trip (client, redirect URI, PKCE challenge, state, scope), short TTL |
| `oauth_codes` | Our authorization codes, single use, ~1 min TTL |
| `oauth_tokens` | **Hashed** access/refresh tokens, `kakao_user_id`, client id, scope, `last_used_at`, `revoked_at` |

### Kakao configuration

Register one additional redirect URI in the Kakao developer console:

```
https://<server>/oauth/kakao/callback
```

This is the only URI Kakao ever sees, regardless of how many agents connect.

### Token policy

- Access tokens: short-lived (~1 hour) so revocation takes effect quickly.
- Refresh tokens: longer-lived, rotated on use.
- Scopes: `lists:read`, `lists:sync` (phase 3).
- Do **not** reuse the existing session token: it is a 7-day HMAC token with no revocation.

### UX

- Consent line before redirecting to Kakao, e.g. "Claude wants read access to your saved lists" — Kakao's consent screen describes our app, not the agent.
- PWA **Connected agents** screen: client name, scopes, last used, **Revoke**.

### Reused code

- Kakao code exchange and user-info lookup from `/api/auth/kakao/exchange`.
- Kakao user id as the storage scope key.

---

## Phase 3 — Agent-triggered sync

### Constraint

The extension imports lists by calling **private Kakao Maps web endpoints** (`/folder/list`, `/favorite/mine/list`) with the browser's map.kakao.com session cookies (`kakaoMapsExtractor.ts`, `credentials: "include"`).

- The Kakao Developers OAuth token (stored in `kakao_tokens`) cannot call these endpoints, and there is no public Kakao API for saved lists. This is why `/api/sync/kakao` is still mocked.
- Copying the user's Kakao web cookies to the server is rejected: it means holding full Kakao sessions server-side, the cookies expire unpredictably, and it looks like session hijacking.

So the extension, running in the user's signed-in browser, remains the only component that performs the import. The agent can only **request** a sync.

### Flow

```
Agent ──request_sync──► Server: insert sync_requests row (pending) ──► returns request id
                                       ▲
Extension (chrome.alarms, ~1 min) ─────┘ polls for pending requests
   └─ runs existing import → PUT /api/snapshot → marks request done / failed
Agent ──get_sync_status(id)──► "done, 12 lists, synced 14:03"  or  "waiting for browser"
```

### Server

- Table `sync_requests`: `id`, `kakao_user_id`, `status` (`pending` | `running` | `done` | `failed` | `expired`), `requested_by` (OAuth client name), `error`, timestamps.
- MCP tools:
  - `request_sync` — requires `lists:sync`; returns the existing request if one is already pending.
  - `get_sync_status` — status, error, and resulting `syncedAt` / list count.
- Extension endpoints (authenticated with the extension's session):
  - `GET /api/sync-requests/pending`
  - `PATCH /api/sync-requests/:id`
- Pending requests expire after ~10 minutes.
- The server never waits for the extension inside a request (Vercel 10s limit); the agent polls `get_sync_status`.

### Extension

- `background.ts`: `chrome.alarms` job (minimum 30s; ~1 min is enough) that polls only while the user is signed in.
- Reuse the existing import + upload code path.
- Today the extractor requires an open map.kakao.com tab. Options: open an inactive tab, or call the endpoints directly from the background using host permissions — **needs testing** with Kakao's cookies.
- If the Kakao Maps session is missing, mark the request `failed` with an actionable reason ("Open Kakao Maps and sign in") for the agent to relay.
- Optional: badge or notification "Sync requested by Claude".

### Limitations

- Requires the browser running with the extension installed and Kakao Maps signed in; otherwise the request expires and the agent reports it.
- Not instant: request now, confirmation within about a minute.
- Same fragility as today: private Kakao Maps endpoints may change.

### Alternative

Agents with browser control (e.g. Claude in Chrome) can open Kakao Maps and click **Import** in the extension directly. No server changes, but it only works for those agents; the request queue works for any MCP client.

---

## Alternative: personal access tokens

Simpler stopgap for phase 1 before OAuth exists, and a fallback for clients without OAuth support.

- PWA screen "Connect an AI agent" creates a token `kl_pat_…`, shown once.
- Stored hashed in `api_tokens` (`kakao_user_id`, `name`, `scope`, `last_used_at`, `revoked_at`).
- Sent as `Authorization: Bearer kl_pat_…`.

Example (Claude Code):

```bash
claude mcp add --transport http kakao-lists https://<server>/mcp \
  --header "Authorization: Bearer kl_pat_…"
```

Does not work with claude.ai / ChatGPT connectors, which require OAuth.

---

## Work breakdown

1. **MCP read tools** — `/mcp` route, 4 tools, search/pagination helpers. *Done (phase 1).*
2. **OAuth via Kakao** — metadata, DCR, authorize/callback/token, tables, Kakao redirect URI.
3. **PWA** — Connected agents screen (list + revoke). *Done for personal access tokens (Settings → AI Agents).*
4. **Sync requests** — table, MCP tools, extension endpoints.
5. **Extension** — alarm poller, background import, status reporting.
6. **Docs** — README section with connection steps for Claude Code, Claude Desktop, claude.ai. *Claude Code steps done; the others need OAuth (phase 2).*
