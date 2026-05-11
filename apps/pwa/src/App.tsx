import { useEffect, useMemo, useState } from "react";
import {
  type CloudSession,
  type FavoriteList,
  type SyncStatus
} from "@kakao-lists/domain";
import { buildKakaoAuthorizeUrl, isKakaoConfigured, readKakaoCallback } from "@kakao-lists/kakao";
import { LocalStorageFavoriteListsRepository } from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";

const repository = new LocalStorageFavoriteListsRepository("kakao-lists:pwa");
const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";

const kakaoConfig = {
  clientId: import.meta.env.VITE_KAKAO_REST_API_KEY ?? "",
  redirectUri: import.meta.env.VITE_KAKAO_REDIRECT_URI ?? "",
  scope: import.meta.env.VITE_KAKAO_SCOPE ?? ""
};

export default function App() {
  const callback = useMemo(() => readKakaoCallback(window.location), []);
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string>("Sign in with Kakao to load your saved lists.");
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(() => readCloudSession());
  const [serverVersion, setServerVersion] = useState<number | null>(null);

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(syncServerUrl, () => readCloudSession()?.token ?? null)
      : null;
  }, []);

  const deviceId = useMemo(() => getOrCreateDeviceId(), []);

  useEffect(() => {
    void hydrate();
  }, [callback.code, callback.error, cloudSync]);

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

    if (callback.error) {
      setStatus("error");
      setMessage(`Kakao returned an error: ${callback.error}`);
      return;
    }

    if (callback.code && cloudSync) {
      setStatus("syncing");
      setMessage("Exchanging the Kakao authorization code with the sync server...");

      try {
        const session = await cloudSync.exchangeKakaoCode({
          code: callback.code,
          redirectUri: kakaoConfig.redirectUri
        });
        writeCloudSession(session);
        setCloudSession(session);
        window.history.replaceState({}, document.title, window.location.pathname);
        setStatus("syncing");
        setMessage(`Signed in as Kakao user ${session.user.id}. Syncing your saved lists...`);
        return;
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "Kakao server sign-in failed.");
        return;
      }
    }

    if (callback.code) {
      setStatus("ready");
      setMessage("Authorization code captured. Configure the sync server to turn it into a cloud session.");
    }
  }

  async function syncLists() {
    await syncOnLoad();
  }

  async function syncOnLoad() {
    if (!cloudSync || !cloudSession) {
      return;
    }

    setStatus("syncing");
    setMessage("Syncing saved lists from Kakao, storing them locally, and refreshing the cloud snapshot...");

    try {
      const result = await syncSnapshotFromServerKakao(
        cloudSync,
        setLists,
        setLastSyncedAt,
        setServerVersion
      );
      setStatus("ready");
      setMessage(`Loaded ${result.snapshot.lists.length} saved lists for Kakao user ${result.userId}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Automatic sync failed.");
    }
  }

  async function pushToServer() {
    if (!cloudSync) {
      setStatus("error");
      setMessage("Set VITE_SYNC_SERVER_URL to enable cloud sync.");
      return;
    }

    if (!cloudSession) {
      setStatus("error");
      setMessage("Sign in to the sync server with Kakao before pushing.");
      return;
    }

    const snapshot = await loadCurrentSnapshot();
    if (!snapshot) {
      setStatus("error");
      setMessage("No local snapshot is available yet.");
      return;
    }

    setStatus("syncing");
    setMessage("Uploading the current snapshot to the sync server...");

    try {
      const result = await cloudSync.pushSnapshot({
        deviceId,
        snapshot
      });
      setServerVersion(result.serverVersion);
      setStatus("ready");
      setMessage(`Server stored snapshot version ${result.serverVersion} for Kakao user ${result.userId}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Push failed.");
    }
  }

  async function pullFromServer() {
    if (!cloudSync) {
      setStatus("error");
      setMessage("Set VITE_SYNC_SERVER_URL to enable cloud sync.");
      return;
    }

    if (!cloudSession) {
      setStatus("error");
      setMessage("Sign in to the sync server with Kakao before pulling.");
      return;
    }

    setStatus("syncing");
    setMessage("Downloading the latest snapshot from the sync server...");

    try {
      const result = await cloudSync.pullLatestSnapshot();
      setServerVersion(result.serverVersion);

      if (!result.snapshot) {
        setStatus("ready");
        setMessage("No server snapshot exists for this Kakao user yet.");
        return;
      }

      await repository.saveSnapshot(result.snapshot);
      setLists(result.snapshot.lists);
      setLastSyncedAt(result.snapshot.syncedAt);
      setStatus("ready");
      setMessage(`Pulled server snapshot version ${result.serverVersion} from Kakao user ${result.userId}.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Pull failed.");
    }
  }

  function signOutCloud() {
    clearCloudSession();
    setCloudSession(null);
    setLists([]);
    setLastSyncedAt(null);
    setServerVersion(null);
    setStatus("idle");
    setMessage("Cloud session cleared from this browser.");
  }

  const authorizeUrl = isKakaoConfigured(kakaoConfig)
    ? buildKakaoAuthorizeUrl({
        ...kakaoConfig,
        state: "kakao-lists-pwa"
      })
    : null;

  if (!cloudSession) {
    return (
      <main className="shell">
        <section className="hero auth-hero">
          <p className="eyebrow">Kakao Lists / Web</p>
          <h1>Sign in with Kakao.</h1>
          <p className="lede">
            Your saved lists page appears after an active session exists. On each load, the app syncs
            from Kakao, stores the latest snapshot locally, and then keeps the server copy in sync.
          </p>
          <div className="hero-actions">
            {authorizeUrl ? (
              <a className="button primary" href={authorizeUrl}>
                Sign in with Kakao
              </a>
            ) : (
              <span className="button disabled">Add Kakao env vars to enable auth</span>
            )}
          </div>
          <div className={`status-card is-${status}`}>
            <span className="status-label">{status}</span>
            <p>{message}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Kakao Lists / Saved Lists</p>
        <h1>Your Kakao saved lists.</h1>
        <p className="lede">
          Every time this page loads with an active session, it refreshes the latest saved lists from
          Kakao through the sync server, stores the snapshot locally, and keeps the cloud copy current.
        </p>

        <div className="hero-actions">
          <button className="button primary" onClick={syncLists} type="button">
            Sync Now
          </button>
          <button className="button secondary" onClick={pullFromServer} type="button">
            Pull Latest Server Snapshot
          </button>
        </div>

        <div className={`status-card is-${status}`}>
          <span className="status-label">{status}</span>
          <p>{message}</p>
        </div>
      </section>

      <section className="grid">
        <article className="panel">
          <h2>Callback State</h2>
          <dl className="meta-list">
            <div>
              <dt>Kakao user</dt>
              <dd>{cloudSession.user.id}</dd>
            </div>
            <div>
              <dt>Nickname</dt>
              <dd>{cloudSession.user.nickname ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Last synced</dt>
              <dd>{lastSyncedAt ?? "Never"}</dd>
            </div>
            <div>
              <dt>Repository</dt>
              <dd>LocalStorage now, SQLite contract next</dd>
            </div>
            <div>
              <dt>Device id</dt>
              <dd>{deviceId}</dd>
            </div>
            <div>
              <dt>Server version</dt>
              <dd>{serverVersion ?? "Not pushed yet"}</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <h2>Cloud Sync</h2>
          <div className="hero-actions compact">
            <button className="button secondary" onClick={signOutCloud} type="button">
              Clear Cloud Session
            </button>
          </div>
          <ul className="bullet-list">
            <li>The Kakao list import is still mocked on the server until the real list endpoint is verified.</li>
            <li>The sync server scopes data by Kakao service user id derived server-side from Kakao.</li>
            <li>Concurrent edits are last-write-wins for now; there is no merge logic yet.</li>
          </ul>
        </article>
      </section>

      <section className="lists">
        <div className="section-head">
          <h2>Synced Favorite Lists</h2>
          <span>{lists.length} list(s)</span>
        </div>

        {lists.length === 0 ? (
          <div className="empty-state">
            <p>No lists stored yet.</p>
            <p>The next authenticated load will sync the latest Kakao snapshot into local storage.</p>
          </div>
        ) : (
          <div className="list-grid">
            {lists.map((list) => (
              <article className="list-card" key={list.id}>
                <header>
                  <h3>{list.name}</h3>
                  <span>{list.itemCount} items</span>
                </header>
                <p>Updated {new Date(list.updatedAt).toLocaleString()}</p>
                <ul className="item-list">
                  {list.items.map((item) => (
                    <li key={item.id}>
                      <strong>{item.title}</strong>
                      {item.note ? <span>{item.note}</span> : null}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

async function loadCurrentSnapshot() {
  const lists = await repository.loadLists();
  const syncedAt = await repository.getLastSyncedAt();

  if (!syncedAt) {
    return null;
  }

  return {
    syncedAt,
    source: "pwa-local-repository",
    lists
  };
}

async function syncSnapshotFromServerKakao(
  cloudSync: HttpCloudSyncClient,
  setLists: (lists: FavoriteList[]) => void,
  setLastSyncedAt: (value: string | null) => void,
  setServerVersion: (value: number | null) => void
) {
  const result = await cloudSync.syncFromKakao();
  await repository.saveSnapshot(result.snapshot);
  setLists(result.snapshot.lists);
  setLastSyncedAt(result.snapshot.syncedAt);
  setServerVersion(result.serverVersion);
  return result;
}

function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem("kakao-lists:device-id");
  if (existing) {
    return existing;
  }

  const next = `device-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem("kakao-lists:device-id", next);
  return next;
}

function readCloudSession(): CloudSession | null {
  const raw = window.localStorage.getItem("kakao-lists:cloud-session");
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
  window.localStorage.setItem("kakao-lists:cloud-session", JSON.stringify(session));
}

function clearCloudSession() {
  window.localStorage.removeItem("kakao-lists:cloud-session");
}
