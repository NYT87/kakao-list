# Kakao Lists

Kakao Lists is a pnpm workspace monorepo for a browser-based project that combines:

- a Chrome/Brave extension
- a PWA
- a sync server for cross-device data transfer
- Kakao OAuth wiring
- local synced list storage behind a browser-compatible SQLite abstraction

## Architecture

```text
apps/
  extension/    Manifest V3 shell for popup, options, and background sync hooks
  pwa/          Web app shell with Kakao OAuth entry and synced list dashboard
  server/       SQLite-backed sync API for snapshot upload/download across devices
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
- On each authenticated load, the client asks the server to sync from Kakao, stores the returned snapshot locally, and then renders the saved lists.

The current Kakao list import is still mocked on the server until the exact production list endpoint is verified.

## Kakao Scope

This scaffold supports the start of Kakao auth from browser surfaces and captures the authorization code callback. The actual favorite-list sync is intentionally isolated behind an adapter because an official public Kakao "favorite lists" API was not verified in the current docs pass.

## Getting Started

1. Install dependencies:

```bash
pnpm install
```

If pnpm blocks native dependency scripts, approve the SQLite build once:

```bash
pnpm approve-builds
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

6. Start the extension build/dev flow:

```bash
pnpm dev:extension
```

## Kakao App Setup Notes

- Register the web redirect URI from `VITE_KAKAO_REDIRECT_URI` in your Kakao app.
- For the extension flow, register the Chrome identity redirect URI returned by `chrome.identity.getRedirectURL("kakao")` for your installed extension id.
- Set `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, and `SYNC_SERVER_SIGNING_SECRET` on the server before using sign-in.

## Environment Variables

See [.env.example](/Users/josemiguel/workspace-personal/kakao-lists/.env.example).

## Next Implementation Steps

- Replace the mock sync adapter in `packages/domain` with the real Kakao list-sync implementation once the endpoint contract is verified.
- Replace the localStorage repository with a browser SQLite engine wired to OPFS/WASM.
- Decide whether the extension should authenticate directly or delegate sign-in to the PWA.
- Replace whole-snapshot sync with versioned merge logic if concurrent multi-device edits become important.
- Add refresh/renewal logic for cloud sessions instead of relying on a single short-lived signed token.
