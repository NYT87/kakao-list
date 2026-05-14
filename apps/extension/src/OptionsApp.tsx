import { useEffect, useMemo, useState } from "react";
import type { CloudSession, SyncStatus } from "@kakao-lists/domain";
import { LocalStorageFavoriteListsRepository } from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import {
  readThemePreference,
  type ThemePreference,
  writeThemePreference
} from "./theme";

const repository = new LocalStorageFavoriteListsRepository("kakao-lists:extension");
const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";

export default function OptionsApp() {
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(() => readCloudSession());
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState("Use these controls to manage the extension snapshot cache and session.");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [storedListCount, setStoredListCount] = useState(0);
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const redirectUri =
    typeof chrome !== "undefined" && chrome.identity?.getRedirectURL
      ? chrome.identity.getRedirectURL("kakao")
      : "Unavailable";
  const isBusy = busyAction !== null;

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(syncServerUrl, () => readCloudSession()?.token ?? null)
      : null;
  }, []);

  useEffect(() => {
    void hydrateLocalState();
  }, []);

  async function hydrateLocalState() {
    const [lists, syncedAt] = await Promise.all([
      repository.loadLists(),
      repository.getLastSyncedAt()
    ]);
    setStoredListCount(lists.length);
    setLastSyncedAt(syncedAt);
    setServerVersion(readLastKnownServerVersion());
  }

  async function pullServerData() {
    if (!cloudSync || !cloudSession) {
      setStatus("error");
      setMessage("Sign in before pulling the latest server snapshot.");
      return;
    }

    if (isBusy) {
      return;
    }

    setBusyAction("pull-server");
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
      setStoredListCount(result.snapshot.lists.length);
      setLastSyncedAt(result.snapshot.syncedAt);
      writeLastKnownServerVersion(result.serverVersion);
      setStatus("ready");
      setMessage(`Pulled server snapshot version ${result.serverVersion ?? "unknown"} into local extension storage.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Server pull failed.");
    } finally {
      setBusyAction(null);
    }
  }

  function signOut() {
    clearCloudSession();
    setCloudSession(null);
    setServerVersion(null);
    setStatus("idle");
    setMessage("Cloud session cleared from the extension.");
    window.location.replace("popup.html");
  }

  async function clearLocalData() {
    if (isBusy) {
      return;
    }

    setBusyAction("clear-local-data");
    clearLocalExtensionData();
    setServerVersion(null);
    setStoredListCount(0);
    setLastSyncedAt(null);
    setStatus("ready");
    setMessage("All local extension snapshot data was cleared. Your server copy was not changed.");
    setBusyAction(null);
  }

  function updateThemePreference(nextPreference: ThemePreference) {
    setThemePreference(nextPreference);
    writeThemePreference(nextPreference);
  }

  return (
    <main className="options-shell">
      <section className="options-panel">
        <header className="popup-header popup-header-options">
          <a className="icon-link" aria-label="Back to popup" href="popup.html" title="Back to popup">
            <span aria-hidden="true">←</span>
          </a>
          <div className="badge">Options</div>
          <span className="header-spacer" aria-hidden="true" />
        </header>

        <section className="options-panel-section">
          <div className="section-label">Appearance</div>
          <div className="segmented-control" role="group" aria-label="Theme preference">
            {(["system", "light", "dark"] as const).map((option) => (
              <button
                aria-pressed={themePreference === option}
                className={`segment${themePreference === option ? " is-active" : ""}`}
                key={option}
                onClick={() => updateThemePreference(option)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
        </section>

        <div className="actions actions-stacked">
          <button className="button primary" disabled={isBusy} onClick={() => void pullServerData()} type="button">
            Pull Server Data
          </button>
          <button className="button danger" disabled={isBusy} onClick={() => void clearLocalData()} type="button">
            Clear All Local Data
          </button>
        </div>

        <section className="options-panel-section">
          <div className="section-label">Session</div>
          <p aria-live="polite" className="small-copy" role="status">
            {message}
          </p>

          <ul className="compact-list meta">
            <li>
              <strong>Status</strong>
              <span>{status}</span>
            </li>
            <li>
              <strong>Kakao user</strong>
              <span>{cloudSession?.user.id ?? "Signed out"}</span>
            </li>
            <li>
              <strong>Stored lists</strong>
              <span>{formatCountLabel(storedListCount, "list", "lists")}</span>
            </li>
            <li>
              <strong>Last synced</strong>
              <span>{formatDate(lastSyncedAt)}</span>
            </li>
            <li>
              <strong>Server version</strong>
              <span>{serverVersion ?? "Unknown"}</span>
            </li>
          </ul>
        </section>

      </section>

      <section className="mini-panel options-debug-card">
        <div className="section-label">Debug</div>
        <ul className="options-list">
          <li>The extension popup signs in through `chrome.identity.launchWebAuthFlow`.</li>
          <li>
            Register this exact Kakao redirect URI in Kakao Developers:
            <code>{redirectUri}</code>
          </li>
          <li>
            If the URI keeps changing after reinstalling the unpacked extension, set
            <code>EXTENSION_PUBLIC_KEY</code> before building so the extension id stays fixed.
          </li>
          <li>Clearing local data removes the extension cache and local device id only. It does not delete the server snapshot.</li>
        </ul>
      </section>
    </main>
  );
}

function readCloudSession(): CloudSession | null {
  const raw = window.localStorage.getItem("kakao-lists:extension-cloud-session");
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CloudSession;
    if (!parsed?.token || !parsed?.expiresAt || !parsed?.user?.id) {
      clearCloudSession();
      return null;
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      clearCloudSession();
      return null;
    }

    return parsed;
  } catch {
    clearCloudSession();
    return null;
  }
}

function clearCloudSession() {
  window.localStorage.removeItem("kakao-lists:extension-cloud-session");
}

function clearLocalExtensionData() {
  window.localStorage.removeItem("kakao-lists:extension");
  window.localStorage.removeItem("kakao-lists:extension-device-id");
  window.localStorage.removeItem("kakao-lists:extension-server-version");
}

function readLastKnownServerVersion(): number | null {
  const raw = window.localStorage.getItem("kakao-lists:extension-server-version");
  if (!raw) {
    return null;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function writeLastKnownServerVersion(serverVersion: number | null) {
  if (serverVersion === null) {
    window.localStorage.removeItem("kakao-lists:extension-server-version");
    return;
  }

  window.localStorage.setItem("kakao-lists:extension-server-version", String(serverVersion));
}

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(getUserLocale(), {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function formatCountLabel(count: number, singular: string, plural: string) {
  const formattedCount = new Intl.NumberFormat(getUserLocale()).format(count);
  return `${formattedCount} ${count === 1 ? singular : plural}`;
}

function getUserLocale() {
  return navigator.language || "en-US";
}
