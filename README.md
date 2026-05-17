# Kakao Lists

> [!IMPORTANT]
> Kakao and related names, logos, services, and other marks are trademarks or registered trademarks of their respective owners. This project is an independent, open-source tool and is not made by, affiliated with, endorsed by, sponsored by, or approved by Kakao.

Kakao Lists is a pnpm workspace monorepo for a browser-based project that combines:

- a Chrome/Brave extension
- a PWA
- a sync server for cross-device data transfer
- Kakao OAuth wiring
- local synced list storage behind a browser-compatible persistence abstraction

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
5. The server returns a signed session token, and snapshot APIs require that bearer token.

The client no longer chooses an `accountId`. Snapshot access is derived from authenticated Kakao identity.

## Entry Flow

Both the web app and the extension now open on a Kakao sign-in screen.

- If there is no session, the first screen is a single primary action: `Sign in with Kakao`.
- If there is an active session, the UI opens directly on the saved lists page.
- The web app is now a read-only viewer of the latest server snapshot and does not create fresh snapshots from Kakao Maps.
- The extension is the only client that creates fresh snapshots from Kakao Maps, and it only imports when the user clicks the popup import button.

The current Kakao list import is still mocked on the server until the exact production list endpoint is verified.

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

This scaffold supports the start of Kakao auth from browser surfaces and captures the authorization code callback. The actual favorite-list sync is intentionally isolated behind an adapter because an official public Kakao "favorite lists" API was not verified in the current docs pass.

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

5. Start the sync server:

```bash
pnpm dev:server
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

This writes:

- `apps/extension/kakao-lists-extension.zip`

## Kakao App Setup Notes

- Register the web redirect URI from `VITE_KAKAO_REDIRECT_URI` in your Kakao app.
- For the extension flow, register the Chrome identity redirect URI returned by `chrome.identity.getRedirectURL("kakao")` for your installed extension id.
- If you want that extension redirect URI to stay stable across local reinstalls, set `EXTENSION_PUBLIC_KEY` before building the extension. Chrome derives the extension id, and therefore the `chromiumapp.org` callback URI, from that key.
- Full instructions for generating `EXTENSION_PUBLIC_KEY` are in [docs/extension-public-key.md](/Users/josemiguel/workspace-personal/kakao-lists/docs/extension-public-key.md).
- Set `DATABASE_URL`, `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, and `SYNC_SERVER_SIGNING_SECRET` on the server before using sign-in.

## Environment Variables

See [.env.example](/Users/josemiguel/workspace-personal/kakao-lists/.env.example).

## Zip Distribution Notes

- The generated zip is for manual distribution, not Chrome Web Store publishing.
- Users cannot normally install a random zip directly in Chrome or Brave.
- Users must unzip it, open `chrome://extensions`, enable Developer mode, click `Load unpacked`, and select the extracted `dist` folder.
- If you need a stable Kakao redirect URI for this manual distribution flow, see [docs/extension-public-key.md](/Users/josemiguel/workspace-personal/kakao-lists/docs/extension-public-key.md).
- The repo bundle command is `pnpm bundle:extension`, and it writes [apps/extension/kakao-lists-extension.zip](/Users/josemiguel/workspace-personal/kakao-lists/apps/extension/kakao-lists-extension.zip).
- GitHub release automation is defined in [.github/workflows/release-extension.yml](/Users/josemiguel/workspace-personal/kakao-lists/.github/workflows/release-extension.yml). When a GitHub release is published, the workflow rebuilds the extension zip and uploads it to the release assets automatically.
- If you want every release asset to keep the same extension ID, set the repository Actions variable `EXTENSION_PUBLIC_KEY` to the same one-line public-key value described in [docs/extension-public-key.md](/Users/josemiguel/workspace-personal/kakao-lists/docs/extension-public-key.md).

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
SYNC_SERVER_SIGNING_SECRET=replace_with_a_long_random_secret
ALLOW_MOCK_AUTH=false
```

The server project now includes [apps/server/vercel.json](/Users/josemiguel/workspace-personal/kakao-lists/apps/server/vercel.json), which routes all requests through a single Vercel function backed by the shared Express app.

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

## Next Implementation Steps

- Replace the mock sync adapter in `packages/domain` with the real Kakao list-sync implementation once the endpoint contract is verified.
- Replace the localStorage repository with a browser SQLite engine wired to OPFS/WASM.
- Decide whether the extension should authenticate directly or delegate sign-in to the PWA.
- Replace whole-snapshot sync with versioned merge logic if concurrent multi-device edits become important.
- Add refresh/renewal logic for cloud sessions instead of relying on a single short-lived signed token.

Created by [nyt87](https://nyt87.github.io/).
