import { useEffect, useMemo, useState } from "react";
import type { CloudSession, FavoriteList, FavoriteListItem, SyncStatus } from "@kakao-lists/domain";
import { buildKakaoAuthorizeUrl } from "@kakao-lists/kakao";
import { LocalStorageFavoriteListsRepository } from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import { extractSnapshotFromKakaoMapsTab } from "./kakaoMapsExtractor";

const repository = new LocalStorageFavoriteListsRepository("kakao-lists:extension");
const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";
const kakaoClientId = import.meta.env.VITE_KAKAO_REST_API_KEY ?? "";
const kakaoScope = import.meta.env.VITE_KAKAO_SCOPE ?? "";
const pwaBaseUrl = import.meta.env.VITE_PWA_BASE_URL ?? "http://localhost:5173";
const mockAuthEnabled = import.meta.env.VITE_ENABLE_MOCK_AUTH === "true";
const extensionRedirectPath = "kakao";

interface ActiveTabContext {
  kind: "default" | "place";
  tabId: number | null;
  title?: string;
  url?: string;
  placeKey?: string;
}

interface PlaceMembership {
  list: FavoriteList;
  item: FavoriteListItem;
}

export default function PopupApp() {
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(() => readCloudSession());
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState("Sign in with Kakao to load your saved lists.");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [debugLines, setDebugLines] = useState<string[]>([]);
  const [localNoteDrafts, setLocalNoteDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTabContext>({
    kind: "default",
    tabId: null
  });
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const redirectUri = useMemo(() => getExtensionRedirectUri(), []);
  const isBusy = busyAction !== null;

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(syncServerUrl, () => readCloudSession()?.token ?? null)
      : null;
  }, []);

  const placeMemberships = useMemo(() => {
    if (activeTab.kind !== "place" || !activeTab.placeKey) {
      return [];
    }

    return lists.flatMap((list) =>
      list.items
        .filter((item) => item.placeKey === activeTab.placeKey || extractPlaceKeyFromHref(item.href) === activeTab.placeKey)
        .map((item) => ({
          list,
          item
        }))
    );
  }, [activeTab, lists]);

  useEffect(() => {
    void hydrate();
    void hydrateActiveTab();
  }, []);

  useEffect(() => {
    if (!cloudSession || !cloudSync) {
      return;
    }

    setStatus("ready");
    setMessage("Session is active. Import from Kakao Maps only runs when you click the button.");
  }, [cloudSession, cloudSync, deviceId]);

  useEffect(() => {
    if (activeTab.kind !== "place" || !cloudSession || !cloudSync) {
      return;
    }

    void refreshPlaceViewFromServer(cloudSync);
  }, [activeTab.kind, activeTab.placeKey, cloudSession, cloudSync]);

  useEffect(() => {
    if (placeMemberships.length === 0) {
      return;
    }

    setLocalNoteDrafts((current) => {
      const next = { ...current };
      for (const membership of placeMemberships) {
        next[getMembershipKey(membership.list.id, membership.item.id)] = membership.item.localNote ?? "";
      }
      return next;
    });
  }, [placeMemberships]);

  async function hydrate() {
    const [savedLists, syncedAt] = await Promise.all([
      repository.loadLists(),
      repository.getLastSyncedAt()
    ]);
    setLists(filterVisibleLists(savedLists));
    setLastSyncedAt(syncedAt);
    setDebugLines((current) =>
      current.length > 0 ? current : [`hydrated-local-lists:${savedLists.length}`, `hydrated-last-sync:${syncedAt ?? "never"}`]
    );
  }

  async function hydrateActiveTab() {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });

    if (!tab) {
      setActiveTab({
        kind: "default",
        tabId: null
      });
      return;
    }

    const nextContext = resolveActiveTabContext(tab);
    setActiveTab(nextContext);
    setDebugLines((current) => {
      const next = [...current];
      next.push(`active-tab-kind:${nextContext.kind}`);
      if (nextContext.url) {
        next.push(`active-tab-url:${nextContext.url}`);
      }
      if (nextContext.placeKey) {
        next.push(`active-place-key:${nextContext.placeKey}`);
      }
      return dedupeLines(next);
    });
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

    if (!redirectUri) {
      setStatus("error");
      setMessage("Chrome identity is unavailable, so the extension redirect URI could not be resolved.");
      return;
    }

    if (isBusy) {
      return;
    }

    const authUrl = buildKakaoAuthorizeUrl({
      clientId: kakaoClientId,
      redirectUri,
      scope: kakaoScope,
      state: "kakao-lists-extension"
    });

    setBusyAction("sign-in");
    setStatus("syncing");
    setMessage("Opening Kakao sign-in...");
    setDebugLines([`auth-mode:real`, `redirect-uri:${redirectUri}`]);

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
      setStatus("ready");
      setMessage(`Signed in as Kakao user ${session.user.id}. Click import when you want to fetch lists from Kakao Maps.`);
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? `${error.message} Register this redirect URI in Kakao Developers: ${redirectUri}`
          : `Extension sign-in failed. Register this redirect URI in Kakao Developers: ${redirectUri}`
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function signInWithMock() {
    if (!cloudSync) {
      setStatus("error");
      setMessage("Set VITE_SYNC_SERVER_URL to enable mock sign-in.");
      return;
    }

    if (isBusy) {
      return;
    }

    setBusyAction("mock-sign-in");
    setStatus("syncing");
    setMessage("Creating a mock cloud session...");
    setDebugLines(["auth-mode:mock"]);

    try {
      const session = await cloudSync.createMockSession();
      writeCloudSession(session);
      setCloudSession(session);
      setStatus("ready");
      setMessage(`Signed in with mock auth as ${session.user.id}. Click import when you want to fetch lists from Kakao Maps.`);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Mock sign-in failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function importFromKakaoMaps(activeCloudSync = cloudSync, activeCloudSession = cloudSession, activeDeviceId = deviceId) {
    if (!activeCloudSync || !activeCloudSession) {
      return;
    }

    if (isBusy) {
      return;
    }

    setBusyAction("import");
    setStatus("syncing");
    setMessage("Checking Kakao Maps tabs for a live places-list import...");
    setDebugLines(["phase:tab-discovery"]);

    try {
      const extracted = await extractSnapshotFromKakaoMapsTab();
      if (extracted) {
        setDebugLines(extracted.debug);
        const pushedSnapshot = sanitizeSnapshot(extracted.snapshot);
        const result = await activeCloudSync.pushSnapshot({
          deviceId: activeDeviceId,
          snapshot: pushedSnapshot
        });

        const storedSnapshot = sanitizeSnapshot(result.snapshot);
        await repository.saveSnapshot(storedSnapshot);
      setLists(storedSnapshot.lists);
      setLastSyncedAt(storedSnapshot.syncedAt);
      setServerVersion(result.serverVersion);
      writeLastKnownServerVersion(result.serverVersion);
      setStatus("ready");
        setMessage(
          `Imported ${extracted.placeCount} places across ${extracted.folderCount} lists from ${
            extracted.tabTitle ?? "Kakao Maps"
          } and synced version ${result.serverVersion}.`
        );
        return;
      }

      setDebugLines(["phase:tab-discovery", "result:no-kakao-maps-tab"]);
      setStatus("ready");
      setMessage("Open Kakao Maps in a signed-in tab before importing.");
    } catch (error) {
      setStatus("error");
      setDebugLines((current) => [
        ...current,
        `error:${error instanceof Error ? error.message : "Import failed."}`
      ]);
      setMessage(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function pullFromServer() {
    if (!cloudSync || !cloudSession) {
      setStatus("error");
      setMessage("Sign in before pulling the server snapshot.");
      return;
    }

    if (isBusy) {
      return;
    }

    setBusyAction("pull-server");
    setStatus("syncing");
    setMessage("Downloading the latest snapshot from the sync server...");
    setDebugLines(["phase:pull-server"]);

    try {
      const result = await fetchServerSnapshot(cloudSync);
      setServerVersion(result.serverVersion);

      if (!result.snapshot) {
        setStatus("ready");
        setMessage("No server snapshot exists for this Kakao user yet.");
        return;
      }

      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setStatus("ready");
      writeLastKnownServerVersion(result.serverVersion);
      setDebugLines((current) => [
        ...current,
        `server-version:${result.serverVersion ?? "none"}`,
        `server-lists:${snapshot.lists.length}`
      ]);
      setMessage(`Loaded server snapshot version ${result.serverVersion ?? "unknown"}.`);
    } catch (error) {
      setStatus("error");
      setDebugLines((current) => [...current, `error:${error instanceof Error ? error.message : "Server pull failed."}`]);
      setMessage(error instanceof Error ? error.message : "Server pull failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function refreshPlaceViewFromServer(activeCloudSync: HttpCloudSyncClient) {
    setDebugLines((current) =>
      dedupeLines([
        ...current,
        "phase:background-server-refresh"
      ])
    );

    try {
      const result = await fetchServerSnapshot(activeCloudSync);
      if (!result.snapshot) {
        setDebugLines((current) =>
          dedupeLines([
            ...current,
            "background-refresh:no-server-snapshot"
          ])
        );
        return;
      }

      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setServerVersion(result.serverVersion);
      writeLastKnownServerVersion(result.serverVersion);
      setStatus("ready");
      setMessage("Rendered local snapshot first, then refreshed this place view from the server.");
      setDebugLines((current) =>
        dedupeLines([
          ...current,
          `background-refresh:server-version:${result.serverVersion ?? "none"}`,
          `background-refresh:server-lists:${snapshot.lists.length}`
        ])
      );
    } catch (error) {
      setDebugLines((current) =>
        dedupeLines([
          ...current,
          `background-refresh-error:${error instanceof Error ? error.message : "Server refresh failed."}`
        ])
      );
    }
  }

  async function openListInPwa(listId: string, itemId: string) {
    const url = buildPwaListUrl(listId, itemId);
    if (!url) {
      return;
    }

    await chrome.tabs.create({
      url,
      active: true
    });
  }

  async function openStoredListInPwa(listId: string) {
    const url = buildPwaListUrl(listId);
    if (!url) {
      return;
    }

    await chrome.tabs.create({
      url,
      active: true
    });
  }

  async function savePlaceLocalNote(listId: string, itemId: string) {
    if (!cloudSync || !cloudSession) {
      setStatus("error");
      setMessage("Sign in before saving local notes.");
      return;
    }

    if (isBusy) {
      return;
    }

    const membershipKey = getMembershipKey(listId, itemId);
    const localNote = localNoteDrafts[membershipKey] ?? "";
    setBusyAction(`save-note:${membershipKey}`);
    setStatus("syncing");
    setMessage("Saving the local note to the sync server...");

    try {
      const result = await cloudSync.updateLocalNote({
        listId,
        itemId,
        localNote
      });
      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setServerVersion(result.serverVersion);
      writeLastKnownServerVersion(result.serverVersion);
      setStatus("ready");
      setMessage("Local note saved locally and on the sync server.");
      setDebugLines((current) =>
        dedupeLines([
          ...current,
          `local-note-saved:${listId}:${itemId}`
        ])
      );
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Local note save failed.");
      setDebugLines((current) =>
        dedupeLines([
          ...current,
          `local-note-save-error:${error instanceof Error ? error.message : "Local note save failed."}`
        ])
      );
    } finally {
      setBusyAction(null);
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
    setDebugLines(["session:cleared"]);
  }

  if (!cloudSession) {
    return (
      <main className="popup-shell">
        <header className="popup-header">
          <div>
            <div className="badge" aria-hidden="true">&nbsp;</div>
          </div>
          <div className="popup-header-actions">
            <a className="icon-link" aria-label="Options" href="options.html" title="Options">
              <span aria-hidden="true">⚙</span>
            </a>
          </div>
        </header>
        <div className="badge">Extension / Sign In</div>
        <h1>Sign in with Kakao.</h1>
        <p className="copy">
          Once a session exists, the popup can import your lists from an open Kakao Maps tab, but
          only when you explicitly click the import button.
        </p>

        <div className="actions actions-stacked">
          <button className="button primary" disabled={isBusy} onClick={signIn} type="button">
            Sign in with Kakao
          </button>
          {mockAuthEnabled ? (
            <button className="button" disabled={isBusy} onClick={signInWithMock} type="button">
              Use Mock Sign In
            </button>
          ) : null}
        </div>

        <section className="mini-panel">
          <h2>Status</h2>
          <p aria-live="polite" role="status">{message}</p>
          <p className="small-copy">
            Kakao callback URI: <code>{redirectUri || "Unavailable"}</code>
          </p>
          <p className="small-copy">
            Register that exact URI in Kakao Developers. To keep it stable across reinstalls, build the
            extension with <code>EXTENSION_PUBLIC_KEY</code> set.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div>
          <div className="badge" aria-hidden="true">&nbsp;</div>
        </div>
        <div className="popup-header-actions">
          <button className="icon-button" aria-label="Sign out" disabled={isBusy} onClick={clearSession} title="Sign out" type="button">
            <span aria-hidden="true">⇥</span>
          </button>
          <a className="icon-link" aria-label="Options" href="options.html" title="Options">
            <span aria-hidden="true">⚙</span>
          </a>
        </div>
      </header>
      {activeTab.kind === "place" ? (
        <>
          <section className="mini-panel">
            <div className="section-head-inline">
              <h2>Saved In Lists</h2>
              <button
                className="stored-list-action"
                disabled={isBusy}
                onClick={() => void pullFromServer()}
                aria-label="Refresh saved lists from the server"
                title="Refresh saved lists from the server"
                type="button"
              >
                <span aria-hidden="true">↻</span>
              </button>
            </div>
            {placeMemberships.length === 0 ? (
              <p>That place is not present in the currently stored snapshot. Pull the server copy or import again.</p>
            ) : (
              <ul className="match-list">
                {placeMemberships.map(({ list, item }) => (
                  <li className="match-card" key={`${list.id}:${item.id}`}>
                    <div className="match-head">
                      <button
                        className="match-title-link"
                        onClick={() => void openStoredListInPwa(list.id)}
                        aria-label={`Open ${list.name} in the PWA`}
                        title={`Open ${list.name} in the PWA`}
                        type="button"
                      >
                        {list.name}
                      </button>
                      <span>{list.creatorName ?? "Unknown creator"}</span>
                    </div>
                    <p>{item.subtitle ?? "No address summary stored."}</p>
                    {item.kakaoNote ? (
                      <div className="note-block">
                        <label>Kakao note</label>
                        <span>{item.kakaoNote}</span>
                      </div>
                    ) : null}
                    <div className="note-block">
                      <label>Local note</label>
                      <input
                        className="note-input"
                        maxLength={500}
                        type="text"
                        value={localNoteDrafts[getMembershipKey(list.id, item.id)] ?? ""}
                        onChange={(event) =>
                          setLocalNoteDrafts((current) => ({
                            ...current,
                            [getMembershipKey(list.id, item.id)]: event.target.value
                          }))
                        }
                        placeholder="Add your own note"
                      />
                    </div>
                    <div className="match-actions">
                      <button
                        aria-label="Save local note"
                        className="icon-button match-action-icon"
                        disabled={isBusy}
                        onClick={() => void savePlaceLocalNote(list.id, item.id)}
                        title="Save local note"
                        type="button"
                      >
                        <span aria-hidden="true">💾</span>
                      </button>
                      <button
                        className="stored-list-action match-open-action"
                        onClick={() => void openListInPwa(list.id, item.id)}
                        aria-label={`Open ${list.name} in the PWA`}
                        title={`Open ${list.name} in the PWA`}
                        type="button"
                      >
                        <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <>
          <div className="actions">
            <button className="button primary" disabled={isBusy} onClick={() => void importFromKakaoMaps()} type="button">
              Import from Kakao Maps
            </button>
          </div>
          <p className="copy">
            The extension is the only place that creates fresh snapshots from Kakao Maps. Imports only
            run when you click the button.
          </p>

          <section className="mini-panel">
            <h2>Stored Lists</h2>
            {lists.length === 0 ? (
              <p>No saved lists stored yet. Open Kakao Maps in a signed-in tab, then import again.</p>
            ) : (
              <ul className="compact-list stored-list">
                {lists.map((list) => (
                  <li key={list.id}>
                    <div className="stored-list-copy">
                      <strong>{list.name}</strong>
                      <span>{formatCountLabel(list.itemCount, "item", "items")}</span>
                    </div>
                    <button
                      className="stored-list-action"
                      onClick={() => void openStoredListInPwa(list.id)}
                      aria-label={`Open ${list.name} in the PWA`}
                      title={`Open ${list.name} in the PWA`}
                      type="button"
                    >
                      <span aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="mini-panel popup-debug-card">
        <h2>Debug</h2>
        {debugLines.length === 0 ? (
          <p>No debug data yet.</p>
        ) : (
          <ul className="compact-list debug-list">
            {debugLines.map((line, index) => (
              <li key={`${line}-${index}`}>
                <code>{line}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

async function fetchServerSnapshot(cloudSync: HttpCloudSyncClient) {
  const result = await cloudSync.pullLatestSnapshot();
  if (result.snapshot) {
    await repository.saveSnapshot(sanitizeSnapshot(result.snapshot));
  }

  return result;
}

function resolveActiveTabContext(tab: chrome.tabs.Tab): ActiveTabContext {
  const url = tab.url ?? "";
  const placeKey = extractPlaceKeyFromUrl(url);

  if (placeKey) {
    return {
      kind: "place",
      tabId: tab.id ?? null,
      title: tab.title ?? undefined,
      url,
      placeKey
    };
  }

  return {
    kind: "default",
    tabId: tab.id ?? null,
    title: tab.title ?? undefined,
    url
  };
}

function extractPlaceKeyFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "place.map.kakao.com") {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments[0] ?? null;
  } catch {
    return null;
  }
}

function extractPlaceKeyFromHref(href?: string): string | null {
  return href ? extractPlaceKeyFromUrl(href) : null;
}

function dedupeLines(lines: string[]) {
  return Array.from(new Set(lines));
}

function getMembershipKey(listId: string, itemId: string) {
  return `${listId}:${itemId}`;
}

function buildPwaListUrl(listId: string, itemId?: string) {
  try {
    const base = new URL(pwaBaseUrl);
    const params = new URLSearchParams();
    if (itemId) {
      params.set("item", itemId);
    }
    const query = params.toString();
    base.hash = query ? `list/${encodeURIComponent(listId)}?${query}` : `list/${encodeURIComponent(listId)}`;
    return base.toString();
  } catch {
    return "";
  }
}

function sanitizeSnapshot(snapshot: { syncedAt: string; source: string; lists: FavoriteList[] }) {
  return {
    ...snapshot,
    lists: filterVisibleLists(snapshot.lists)
  };
}

function filterVisibleLists(lists: FavoriteList[]) {
  return lists.filter((list) => !isDeletedFolderPlaceholder(list));
}

function isDeletedFolderPlaceholder(list: FavoriteList) {
  return list.itemCount === 0 && /^Folder \d+$/.test(list.name.trim());
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

function writeCloudSession(session: CloudSession) {
  window.localStorage.setItem("kakao-lists:extension-cloud-session", JSON.stringify(session));
}

function clearCloudSession() {
  window.localStorage.removeItem("kakao-lists:extension-cloud-session");
}

function writeLastKnownServerVersion(serverVersion: number | null) {
  if (serverVersion === null) {
    window.localStorage.removeItem("kakao-lists:extension-server-version");
    return;
  }

  window.localStorage.setItem("kakao-lists:extension-server-version", String(serverVersion));
}

function getOrCreateDeviceId() {
  const existing = window.localStorage.getItem("kakao-lists:extension-device-id");
  if (existing) {
    return existing;
  }

  const next = `extension-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem("kakao-lists:extension-device-id", next);
  return next;
}

function getExtensionRedirectUri() {
  if (typeof chrome === "undefined" || !chrome.identity?.getRedirectURL) {
    return "";
  }

  return chrome.identity.getRedirectURL(extensionRedirectPath);
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
