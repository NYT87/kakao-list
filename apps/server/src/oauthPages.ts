import type express from "express";

// Minimal server-rendered pages for the OAuth flow. They are shown in the
// user's browser between their AI assistant and Kakao, so they follow the
// app's calm style and stay readable in light and dark mode. Every
// interpolated value is HTML-escaped: the assistant name comes from dynamic
// client registration and is attacker-controlled.

const PAGE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function sendConsentPage(
  response: express.Response,
  page: {
    clientName: string;
    returnTo: string;
    kakaoUrl: string;
    cancelUrl: string;
  },
) {
  const name = escapeHtml(page.clientName);
  sendPage(
    response,
    200,
    "Connect an AI assistant",
    `
      <p class="eyebrow">Kakao Lists</p>
      <h1>Connect <span class="name">${name}</span></h1>
      <p><span class="name">${name}</span> wants <strong>read-only</strong> access to your saved Kakao Map lists and notes. It cannot change anything.</p>
      <p class="muted">After you sign in, you will return to <strong>${escapeHtml(page.returnTo)}</strong>. Only continue if you started this from your assistant.</p>
      <div class="actions">
        <a class="button kakao" href="${escapeHtml(page.kakaoUrl)}">Continue with Kakao</a>
        <a class="button secondary" href="${escapeHtml(page.cancelUrl)}">Cancel</a>
      </div>
    `,
  );
}

export function sendErrorPage(
  response: express.Response,
  status: number,
  title: string,
  message: string,
) {
  sendPage(
    response,
    status,
    title,
    `
      <p class="eyebrow">Kakao Lists</p>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
    `,
  );
}

function sendPage(
  response: express.Response,
  status: number,
  title: string,
  body: string,
) {
  response
    .status(status)
    .set(PAGE_HEADERS)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Kakao Lists</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f5f5; --panel: #ffffff; --line: #d6d2cd;
    --text: #1a1a1a; --muted: #666666; --focus: rgba(215, 25, 33, 0.34);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000; --panel: #111111; --line: #333333;
      --text: #ffffff; --muted: #999999;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 24px 16px; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: min(100%, 480px); padding: 32px 24px; border-radius: 16px;
    border: 1px solid var(--line); background: var(--panel);
  }
  .eyebrow { margin: 0 0 8px; color: var(--muted); font-size: 0.85rem; }
  h1 { margin: 0 0 16px; font-size: 1.5rem; line-height: 1.3; }
  p { margin: 0 0 16px; }
  .name { overflow-wrap: anywhere; }
  .muted { color: var(--muted); font-size: 0.95rem; }
  .actions { display: grid; gap: 12px; margin-top: 24px; }
  .button {
    display: flex; align-items: center; justify-content: center;
    min-height: 48px; padding: 0 20px; border-radius: 999px;
    font-weight: 600; text-decoration: none;
  }
  .button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .kakao { background: #fee500; color: rgba(0, 0, 0, 0.85); }
  .secondary { border: 1px solid var(--line); color: var(--text); }
</style>
</head>
<body>
<main>${body}</main>
</body>
</html>`);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
