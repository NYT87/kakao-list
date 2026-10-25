# Kakao Lists

> [!IMPORTANT]
> Kakao and related names, logos, services, and other marks are trademarks or registered trademarks of their respective owners. This project is an independent, open-source tool and is not made by, affiliated with, endorsed by, sponsored by, or approved by Kakao.

Kakao Lists is a pnpm workspace monorepo for a browser-based project that combines:

- a Chrome/Brave extension
- a PWA
- a sync server for cross-device data transfer
- Kakao OAuth wiring
- local synced list storage behind a browser-compatible persistence abstraction

## Download the extension

- Open the [releases page](https://github.com/NYT87/kakao-list/releases), choose the newest `extension-v*` release, and download `kakao-lists-extension.zip` or its versioned equivalent, such as `kakao-lists-extension-0.1.2-abcde.zip`.

Unzip the download, open `chrome://extensions` or `brave://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted `dist` folder. See [extension public key setup](docs/extension-public-key.md) if Kakao sign-in needs a stable callback URL.

The PWA's **Settings → App Update** and the extension's settings/options show their own package version and five-character build commit. The sync server's public `GET /health` response includes its `version` and `commit`, even when its database check fails. For Git deployments, Vercel provides `VERCEL_GIT_COMMIT_SHA` when [system environment variables are exposed](https://vercel.com/docs/environment-variables/system-environment-variables); builds can also set `BUILD_COMMIT_SHA`. Local builds read Git directly. A commit value of `unknown` means neither source was available. Uncommitted edits are not represented by the commit ID.

## Architecture

```text
apps/
  extension/    Manifest V3 shell for popup, options, and background sync hooks
  pwa/          Web app shell with Kakao OAuth entry and synced list dashboard
  server/       Postgres-backed sync API for snapshot upload/download across devices
packages/
  domain/       Shared types, sync contracts, and mock data adapter
  kakao/        Kakao OAuth URL/building helpers and callback parsing
  storage/      Repository contracts, localStorage implementation, SQLite adapter contract
  sync/         HTTP client for the sync server
```

More detail lives in [`docs/`](docs):

- [Architecture decisions](docs/architecture-decisions.md): why the sync, auth and build setup work the way they do, plus known limitations
- [Kakao Maps private endpoints](docs/kakao-maps-private-api.md) used by the extension
- [Agent access (MCP)](docs/agent-access.md) design and status
- [Extension public key](docs/extension-public-key.md)

## Important Constraint

The extension and the PWA do not naturally share a single local SQLite file in the browser. They run under different origins and storage sandboxes. This scaffold therefore:

1. shares data models and repository contracts
2. provides a local implementation per surface
3. leaves room for a future shared backend or native companion if true cross-surface shared persistence is required

## Server Auth Model

The sync server is multi-user and scopes data by Kakao service user id:

1. The browser gets a Kakao authorization code.
2. The PWA sends that code to the sync server.
3. The server exchanges the code with Kakao and calls Kakao's user-info endpoint.
4. The returned Kakao user id becomes the only storage scope key on the server.
5. The server returns an opaque, expiring session token stored by hash in Postgres. Snapshot APIs require that bearer token, and logout revokes it.

The client no longer chooses an `accountId`. Snapshot access is derived from authenticated Kakao identity.

## Entry Flow

Both the web app and the extension now open on a Kakao sign-in screen.

- If there is no session, the first screen is a single primary action: `Sign in with Kakao`.
- If there is an active session, the UI opens directly on the saved lists page.
- The web app is now a read-only viewer of the latest server snapshot and does not create fresh snapshots from Kakao Maps.
- The extension is the only client that creates fresh snapshots from Kakao Maps, and it only imports when the user clicks the popup import button.

The extension imports real lists using the experimental private Kakao Maps web endpoints. Server-side import is unavailable; the old demo-sync endpoint returns 410.

## Kakao Maps Extraction

The extension now contains the first practical extraction path for Kakao Maps "places lists".

- It looks for an open `https://map.kakao.com/*` tab that is already signed in.
- It calls the private Kakao Maps web endpoints observed in the browser session:
  - `GET /folder/list`
  - `GET /favorite/mine/list?folderid=<folderid>`
- It normalizes the returned folders and places into the shared `SyncSnapshot` shape.
- It stores that snapshot locally in the extension and then uploads it to the sync server under the authenticated Kakao user.
- It does not run automatically on popup open; imports only happen when the user clicks `Import from Kakao Maps`.

This path is intentionally experimental:

- it depends on Kakao Maps private web endpoints
- it depends on the browser session being signed into Kakao Maps
- it can break when Kakao changes the site
- it is distinct from the public Kakao Login REST flow already used for your sync-server identity

## AI Agents (MCP)

The sync server exposes a read-only [MCP](https://modelcontextprotocol.io) endpoint at `/mcp`, so AI agents can answer questions about a user's saved places and notes. Tools: `list_lists`, `get_list`, `search_places`, `get_place`.

**Sign in with Kakao (recommended).** In the assistant (for example a custom connector in Claude), add `https://<sync-server>/mcp` and sign in with Kakao when asked. The web app shows these steps under **Settings → AI Assistants → Connect an assistant**. This needs `PUBLIC_SERVER_URL` on the server and `${PUBLIC_SERVER_URL}/oauth/kakao/callback` registered as a Redirect URI in Kakao Developers.

**Connection key (fallback).** For assistants without sign-in support, choose **My assistant needs a key instead** and create a key (shown once). For Claude Code:

```bash
claude mcp add --transport http kakao-lists https://<sync-server>/mcp \
  --header "Authorization: Bearer kl_pat_…"
```

Access is read-only. Both kinds of connection are listed in the same screen and can be disconnected there. Design and roadmap: [docs/agent-access.md](docs/agent-access.md).

## Tests

```bash
pnpm test
# Include the Postgres integration tests (uses a temporary schema):
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/kakao_lists pnpm test
```

## Local Mock Auth

For local development without real Kakao credentials:

1. Set `VITE_ENABLE_MOCK_AUTH=true`
2. Set `ALLOW_MOCK_AUTH=true`
3. Start the server and web app
4. Click `Use Mock Sign In` on the first page

This creates a dev-only server session and lets you test the saved-lists flow without a real Kakao OAuth round-trip.

If you do not need any optional Kakao profile fields, leave:

```dotenv
VITE_KAKAO_SCOPE=
```

## Kakao Scope

Kakao Login proves cloud identity; Kakao Maps list extraction uses a separate browser session. Their user ids cannot be compared directly. The extension asks you to check both accounts before each import or Kakao-note edit. This is manual confirmation, not automatic identity verification. Cancel and sign in again if the accounts differ.

## Getting Started

1. Install dependencies:

```bash
pnpm install
```

2. Create your env file from the example values below:

```bash
cp .env.example .env.local
```

3. Fill in your Kakao app values.

4. Start the PWA:

```bash
pnpm dev:pwa
```

Generate a server secret with `openssl rand -hex 32` and put it in `SYNC_SERVER_SIGNING_SECRET`. Keep it stable: it derives the credential-encryption key. Never use the example placeholder. Startup rejects missing/example/weak secrets and production mock authentication.

5. Start the sync server:

```bash
pnpm dev:server
```

   Or start the PWA and the sync server together:

```bash
pnpm dev
```

6. Start local Postgres if you want the server database via Docker Compose:

```bash
docker compose up -d postgres
```

7. Start the extension build/dev flow:

```bash
pnpm dev:extension
```

8. Create a distributable zip for manual extension installation:

```bash
pnpm bundle:extension
```

This writes a ZIP in `apps/extension/` named for the extension manifest version and the short Git commit ID, for example:

- `apps/extension/kakao-lists-extension-0.1.2-abcde.zip`

The commit ID identifies `HEAD`; uncommitted local changes are not represented in the filename. CI and release builds use a clean checkout.

## Kakao App Setup Notes

- Register the web redirect URI from `VITE_KAKAO_REDIRECT_URI` in your Kakao app.
- For the extension flow, register the Chrome identity redirect URI returned by `chrome.identity.getRedirectURL("kakao")` for your installed extension id.
- If you want that extension redirect URI to stay stable across local reinstalls, set `EXTENSION_PUBLIC_KEY` before building the extension. Chrome derives the extension id, and therefore the `chromiumapp.org` callback URI, from that key.
- Full instructions for generating `EXTENSION_PUBLIC_KEY` are in [docs/extension-public-key.md](docs/extension-public-key.md).
- Set `DATABASE_URL`, `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, and `SYNC_SERVER_SIGNING_SECRET` on the server before using sign-in.

## Environment Variables

See [.env.example](.env.example).

## Zip Distribution Notes

- The generated zip is for manual distribution, not Chrome Web Store publishing.
- Users cannot normally install a random zip directly in Chrome or Brave.
- Users must unzip it, open `chrome://extensions`, enable Developer mode, click `Load unpacked`, and select the extracted `dist` folder.
- If you need a stable Kakao redirect URI for this manual distribution flow, see [docs/extension-public-key.md](docs/extension-public-key.md).
- The repo bundle command is `pnpm bundle:extension`, and it writes `apps/extension/kakao-lists-extension-<version>-<commit>.zip`.
- The [verification workflow](.github/workflows/ci.yml) runs checks and builds on pull requests or manual dispatch. It does not publish a ZIP.
- The [Release Please workflow](.github/workflows/release-please.yml) runs on pushes to `main`. It opens or updates a release PR with version bumps for affected packages. Merging that PR creates a GitHub release only for the extension; the extension bundle job uploads the versioned ZIP and a stable `kakao-lists-extension.zip` filename, then links the asset in the run summary. Changes to other packages can still update their versions and dependent workspace versions without creating GitHub releases.
- Release versions are tracked in [.release-please-manifest.json](.release-please-manifest.json) and [release-please-config.json](release-please-config.json). Extension release PRs update both `apps/extension/package.json` and `apps/extension/public/manifest.json`. Use conventional commit subjects (`fix:`, `feat:`) for changes that should open a version PR; package paths determine which versions change. The Node workspace plugin can also bump apps when their shared package dependencies change.
- Repository Actions must allow GitHub Actions to create pull requests. Release Please uses `GITHUB_TOKEN`; GitHub may require manual approval before pull-request checks run on its generated PR. The bundle job stays in the same workflow because releases made with `GITHUB_TOKEN` do not trigger a separate release workflow.
- If you want every release asset to keep the same extension ID, set the repository Actions secret `EXTENSION_PUBLIC_KEY` to the same one-line public-key value described in [docs/extension-public-key.md](docs/extension-public-key.md).
- Set the repository Actions variable `VITE_SYNC_SERVER_URL` to the deployed API base URL, including `https://`, so release bundles point at the hosted sync server.
- Set the repository Actions secret `VITE_KAKAO_REST_API_KEY` so the released extension can start Kakao sign-in.
- Set the repository Actions variable `VITE_PWA_BASE_URL` to the deployed PWA base URL so extension links open the hosted web app instead of localhost.

## Deploying To Vercel

Deploy the PWA and sync API as two separate Vercel projects from the same repo.

### 1. Create the PWA project

- Root Directory: `apps/pwa`
- Build Command: `pnpm build`
- Output Directory: `dist`
- Install Command: `pnpm install`

Recommended PWA environment variables:

```dotenv
VITE_KAKAO_REST_API_KEY=your_kakao_rest_api_key
VITE_KAKAO_REDIRECT_URI=https://your-pwa-domain/auth/kakao/callback
VITE_KAKAO_SCOPE=
VITE_PWA_BASE_URL=https://your-pwa-domain
VITE_SYNC_SERVER_URL=https://your-api-domain
VITE_ENABLE_MOCK_AUTH=false
```

Important:

- `VITE_KAKAO_REDIRECT_URI` must be the deployed PWA callback URL, not the API domain.
- `VITE_SYNC_SERVER_URL` must be the deployed API base URL, including `https://`.
- For example:
  - `VITE_KAKAO_REDIRECT_URI=https://kakao-list-pwa.vercel.app/auth/kakao/callback`
  - `VITE_SYNC_SERVER_URL=https://kakao-list-api.vercel.app`

### 2. Create the API project

- Root Directory: `apps/server`
- Build Command: `pnpm build`
- Install Command: `pnpm install`

Recommended API environment variables:

```dotenv
DATABASE_URL=postgres://...
KAKAO_REST_API_KEY=your_kakao_rest_api_key
KAKAO_CLIENT_SECRET=your_kakao_client_secret
SYNC_SERVER_SIGNING_SECRET=<at-least-32-random-characters>
ALLOW_MOCK_AUTH=false
```

The server project now includes [apps/server/vercel.json](apps/server/vercel.json), which routes all requests through a single Vercel function backed by the shared Express app.

### 3. Enable monorepo source access

Both projects import shared workspace packages from `/packages`, so in each Vercel project you must enable:

- `Include source files outside of the Root Directory`

Without that setting, the selected app directory cannot see the shared workspace packages during the Vercel build.

### 4. Connect the deployed domains

After the API is deployed:

1. Copy the API domain.
2. Set `VITE_SYNC_SERVER_URL` in the PWA project to that domain.
3. Set the same `VITE_SYNC_SERVER_URL` value in the extension build environment.
4. Rebuild the extension so its manifest includes the deployed API origin in `host_permissions`.
5. Redeploy the PWA.

Kakao setup reminder:

- In Kakao Developers, register the same deployed PWA callback URL used by `VITE_KAKAO_REDIRECT_URI`.
- Do not register the API domain as the Kakao redirect URI for the PWA flow.

For the extension, `VITE_SYNC_SERVER_URL` now serves two purposes:

- runtime base URL for `HttpCloudSyncClient`
- build-time source for the API `host_permissions` entry in the generated extension manifest

If the API domain changes, rebuild the extension before loading or publishing it.

### Notes

- The extension is not deployed on Vercel. Build and load it separately.
- The PWA uses hash-based navigation, so it does not need SPA rewrite rules for list or place routes.
- The API still initializes its Postgres tables on startup/cold start, so `DATABASE_URL` must point to a writable Postgres instance before the first request.

## Local Postgres With Docker Compose

The repo now includes a Postgres service for local development:

```bash
docker compose up -d postgres
```

It exposes:

- host: `localhost`
- port: `5432`
- database: `kakao_lists`
- user: `postgres`
- password: `postgres`

The matching server connection string is:

```dotenv
DATABASE_URL=postgres://postgres:postgres@localhost:5432/kakao_lists
```

## Open follow-ups

- Verify whether Kakao Maps and Kakao Login accounts can be bound automatically. Until there is a trustworthy mapping, the extension asks for manual account confirmation before imports and Kakao-note edits.
- Upgrade the dependencies with remaining advisories once patched versions meet the repository's 14-day release-age rule.
- Run the configured checks on GitHub and add automated browser/loaded-extension coverage.
- Check the interface on a small phone in portrait and landscape, and run a VoiceOver pass on the Chrome extension.

See the [task checklist](docs/app-review-tasks.md) and [remediation status](docs/remediation-status.md) for the remaining evidence and constraints. Import staging and session renewal remain optional design follow-ups in the [architecture decisions](docs/architecture-decisions.md).

## Security and recovery

- Local notes are server-owned and survive imports. Use the note editor to change or clear them.
- Local snapshots are scoped by account. Legacy unscoped caches are discarded rather than assigned to a new login.
- Sign-out revokes the current browser session and clears its cache. Account deletion is available in PWA settings; it does not delete original Kakao Maps lists.
- Kakao access/refresh tokens are encrypted before database storage. On first startup after this migration, plaintext token records are removed and existing signed sessions stop working. Users must sign in again. Back up and stage deployments before rollout.
- Snapshot history retains at most 20 recorded versions per account and 30 days. Incomplete import chunks update the latest snapshot but do not create full history copies. History is not a user-facing restore feature.
- Daily cron requires `CRON_SECRET`. It removes expired sessions, old history, and Kakao credentials unused for 60 days, alongside the existing assistant cleanup.
- The production PWA build caches its public app shell for offline use. Private snapshots remain in the account-scoped repository; API/auth responses are not service-worker cached. First sign-in and fresh imports require a connection.

## Verification and remediation

Run `pnpm check`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. The pull-request workflow runs these checks with PostgreSQL. `TEST_DATABASE_URL` must point to a disposable test database: tests create/drop isolated schemas. See [remediation status](docs/remediation-status.md), [API behavior](docs/remediation-contract.md), and [task checklist](docs/app-review-tasks.md).

For HTTP upstream checks, run `postman mock run postman/mocks/kakao --port 4499 --no-history --output ndjson`, then run tests with `KAKAO_SIMULATION_URL=http://127.0.0.1:4499` and `TEST_DATABASE_URL` set. This uses synthetic identities only. CI runs the same fixture directly with Node. Live Kakao consent and Maps behavior still need manual checks.
