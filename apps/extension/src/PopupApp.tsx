import { useEffect, useMemo, useState } from "react";
import type { CloudSession, FavoriteList, SyncStatus } from "@kakao-lists/domain";
import { buildKakaoAuthorizeUrl } from "@kakao-lists/kakao";
import { LocalStorageFavoriteListsRepository } from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";

const repository = new LocalStorageFavoriteListsRepository("kakao-lists:extension");
const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";
const kakaoClientId = import.meta.env.VITE_KAKAO_REST_API_KEY ?? "";
const kakaoScope = import.meta.env.VITE_KAKAO_SCOPE ?? "";

export default function PopupApp() {
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(() => readCloudSession());
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState("Sign in with Kakao to load your saved lists.");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<number | null>(null);

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(syncServerUrl, () => readCloudSession()?.token ?? null)
      : null;
  }, []);

  useEffect(() => {
    void hydrate();
  }, []);

  useEffect(() => {
    if (!cloudSession || !cloudSync) {
      return;
    }

    void syncOnLoad();
  }, [cloudSession, cloudSync]);

  async function hydrate() {
    const [savedLists, syncedAt] = await Promise.all([
      repository.loadLists(),
      repository.getLastSyncedAt()
    ]);
    setLists(savedLists);
    setLastSyncedAt(syncedAt);
  }

  async function signIn() {
    if (!cloudSync) {
      setStatus("error");
      setMessage("Set VITE_SYNC_SERVER_URL to enable sign-in.");
      return;
    }

    if (!kakaoClientId) {
      setStatus("error");
      setMessage("Set VITE_KAKAO_REST_API_KEY to enable Kakao sign-in.");
      return;
    }

    const redirectUri = chrome.identity.getRedirectURL("kakao");
    const authUrl = buildKakaoAuthorizeUrl({
      clientId: kakaoClientId,
      redirectUri,
      scope: kakaoScope,
      state: "kakao-lists-extension"
    });

    setStatus("syncing");
    setMessage("Opening Kakao sign-in...");

    try {
      const callbackUrl = await chrome.identity.launchWebAuthFlow({
        interactive: true,
        url: authUrl
      });

      if (!callbackUrl) {
        throw new Error("Kakao sign-in did not return a callback URL.");
      }

      const code = new URL(callbackUrl).searchParams.get("code");
      if (!code) {
        throw new Error("No Kakao authorization code was returned to the extension.");
      }

      const session = await cloudSync.exchangeKakaoCode({
        code,
        redirectUri
      });

      writeCloudSession(session);
      setCloudSession(session);
      setStatus("syncing");
      setMessage(`Signed in as Kakao user ${session.user.id}. Syncing saved lists...`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Extension sign-in failed.");
    }
  }

  async function syncOnLoad() {
    if (!cloudSync || !cloudSession) {
      return;
    }

    setStatus("syncing");
    setMessage("Syncing saved lists from Kakao and storing them locally...");

    try {
      const result = await cloudSync.syncFromKakao();
      await repository.saveSnapshot(result.snapshot);
      setLists(result.snapshot.lists);
      setLastSyncedAt(result.snapshot.syncedAt);
      setServerVersion(result.serverVersion);
      setStatus("ready");
      setMessage(`Loaded ${result.snapshot.lists.length} saved lists for Kakao user ${result.userId}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Automatic sync failed.");
    }
  }

  function clearSession() {
    clearCloudSession();
    setCloudSession(null);
    setLists([]);
    setLastSyncedAt(null);
    setServerVersion(null);
    setStatus("idle");
    setMessage("Cloud session cleared from the extension.");
  }

  if (!cloudSession) {
    return (
      <main className="popup-shell">
        <div className="badge">Extension / Sign In</div>
        <h1>Sign in with Kakao.</h1>
        <p className="copy">
          Once a session exists, the popup opens on your saved lists page and refreshes from Kakao on
          every load.
        </p>

        <div className="actions">
          <button className="button primary" onClick={signIn} type="button">
            Sign in with Kakao
          </button>
          <a className="button ghost" href="options.html">
            Options
          </a>
        </div>

        <section className="mini-panel">
          <h2>Status</h2>
          <p>{message}</p>
        </section>
      </main>
    );
  }

  return (
    <main className="popup-shell">
      <div className="badge">Extension / Saved Lists</div>
      <h1>Your Kakao saved lists.</h1>
      <p className="copy">
        Each popup load refreshes the latest Kakao snapshot through the sync server, stores it
        locally, and then renders the current saved lists.
      </p>

      <div className="actions">
        <button className="button primary" onClick={syncOnLoad} type="button">
          Sync Now
        </button>
        <button className="button" onClick={clearSession} type="button">
          Sign Out
        </button>
        <a className="button ghost" href="options.html">
          Options
        </a>
      </div>

      <section className="mini-panel">
        <h2>Session</h2>
        <p>{message}</p>
        <ul className="compact-list meta">
          <li>
            <strong>Kakao user</strong>
            <span>{cloudSession.user.id}</span>
          </li>
          <li>
            <strong>Last synced</strong>
            <span>{lastSyncedAt ?? "Never"}</span>
          </li>
          <li>
            <strong>Server version</strong>
            <span>{serverVersion ?? "Not synced yet"}</span>
          </li>
        </ul>
      </section>

      <section className="mini-panel">
        <h2>Stored Lists</h2>
        {lists.length === 0 ? (
          <p>No saved lists stored yet.</p>
        ) : (
          <ul className="compact-list">
            {lists.map((list) => (
              <li key={list.id}>
                <strong>{list.name}</strong>
                <span>{list.itemCount} items</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function readCloudSession(): CloudSession | null {
  const raw = window.localStorage.getItem("kakao-lists:extension-cloud-session");
  if (!raw) {
    return null;
  }

  const parsed = JSON.parse(raw) as CloudSession;
  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    clearCloudSession();
    return null;
  }

  return parsed;
}

function writeCloudSession(session: CloudSession) {
  window.localStorage.setItem("kakao-lists:extension-cloud-session", JSON.stringify(session));
}

function clearCloudSession() {
  window.localStorage.removeItem("kakao-lists:extension-cloud-session");
}
