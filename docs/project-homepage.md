# Project Homepage (GitHub Pages)

A public homepage for Kakao Lists on GitHub Pages: what the project is, how to get each app, how to connect an AI assistant, and a privacy page. The apps themselves stay on Vercel; this is the front door that links to them.

Status: **planned**, not started.

## Why

- The apps live on separate Vercel addresses (web app, API, and later the map app), and the extension ships as a zip on GitHub Releases. Nothing ties them together for a new user; the README is written for developers.
- A **privacy page** is needed for public listings: Kakao Developers asks for a privacy policy URL, and so would a future Chrome Web Store listing.
- GitHub Pages is free for this public repository, needs no server, and deploys from the repo.

## Address

`https://nyt87.github.io/kakao-list/` (a project page). A custom domain can be added later without changing the site; it would need a `CNAME` and DNS setup.

## Pages

| Page | Content |
|---|---|
| **Home** (`/`) | One-line pitch; what you can do (import Kakao Map lists, see them on any device, keep your own notes, ask an AI assistant about your places); screenshots of the web app and extension; buttons: **Open the web app**, **Get the extension** |
| **Get started** (`/get-started/`) | Step by step: install the extension (download the latest release, unzip, load it in Chrome or Brave), sign in, import from Kakao Maps, open the web app on your phone |
| **AI assistants** (`/ai-assistants/`) | Add `https://kakao-list-api.vercel.app/mcp` as a custom connector and sign in with Kakao; the connection-key fallback; what assistants can and cannot do (read-only) |
| **Privacy** (`/privacy/`) | What is stored (Kakao user id and nickname, imported lists and places, your notes and links, hashed tokens), what is not (Kakao passwords, Kakao Maps cookies; they never leave the browser), what is shared with AI assistants you connect, how long data is kept, and how to delete everything (Settings → Delete account data) |

Every page has the trademark notice from the README in the footer (independent project, not affiliated with Kakao), and links to GitHub, the releases page and the changelog.

- **Extension download** links straight to the stable asset of the latest release: `https://github.com/NYT87/kakao-list/releases/latest/download/kakao-lists-extension.zip`. The release workflow already uploads that filename, so the link never needs updating.
- The map app (`docs/map-view.md`) is added to Home and Get started when it ships.

## Design

Same design context as the apps (`AGENTS.md`): simple, calm, familiar to Kakao Map users, light and dark themes, phone first, accessible (real headings, alt text on screenshots, visible focus, readable contrast). No tracking, analytics or cookies, which also keeps the privacy page short and true.

## Build and deploy

- **Source:** a new `apps/homepage`, a static multi-page site built with Vite, with no client-side framework (plain HTML and CSS). It reuses the web app's colour tokens and fonts, and is built with the base path `/kakao-list/` for GitHub Pages.
- **Deploy:** a new workflow, `.github/workflows/pages.yml`, runs on pushes to `main` that touch `apps/homepage`, and can also be started by hand.
  - Steps: build, then upload with `actions/upload-pages-artifact` and publish with `actions/deploy-pages`.
  - Permissions: `pages: write` and `id-token: write`, in the `github-pages` environment.
  - Actions are pinned to the commit SHA of releases at least 14 days old, and it uses the same Node version as CI (`AGENTS.md`, `docs/architecture-decisions.md`).
- **CI:** the existing verify workflow also builds the homepage and checks its internal links, so a broken page can't be merged.
- **One-time setup** (repository settings, by hand): Settings → Pages → Source: **GitHub Actions**.
- `apps/homepage` is private and excluded from Release Please releases, like the other apps without their own release.

## Work breakdown

1. Scaffold `apps/homepage` (Vite multi-page, base path, shared tokens), with Home and the footer.
2. Get started, AI assistants and Privacy pages, with screenshots taken in light and dark mode.
3. The Pages workflow, the CI build and link check, and the one-time Pages setting.
4. Add the homepage URL to the repository's About section and the README, and as the privacy policy URL in Kakao Developers.

## Open questions

- Languages: English only, or Korean and English? Most users are likely Korean speakers.
- Custom domain now, or the `github.io` address for a start?
