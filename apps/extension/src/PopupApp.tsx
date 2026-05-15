import { useEffect, useMemo, useState } from "react";
import type { CloudSession, FavoriteList, FavoriteListItem, SyncStatus } from "@kakao-lists/domain";
import { buildKakaoAuthorizeUrl } from "@kakao-lists/kakao";
import { LocalStorageFavoriteListsRepository } from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import { extractSnapshotFromKakaoMapsTab } from "./kakaoMapsExtractor";
import { readThemePreference, type ThemePreference, writeThemePreference } from "./theme";

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
  source?: "url" | "modal";
}

interface PlaceMembership {
  list: FavoriteList;
  item: FavoriteListItem;
}

type PopupView = "main" | "settings";

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
  const [view, setView] = useState<PopupView>("main");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
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

    const nextContext = await resolveActiveTabContext(tab);
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
      if (nextContext.source) {
        next.push(`active-place-source:${nextContext.source}`);
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

  async function copyKakaoNote(note: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable in this browser.");
      }

      await navigator.clipboard.writeText(note);
      setStatus("ready");
      setMessage("Kakao note copied to the clipboard.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Copy failed.");
    }
  }

  async function clearLocalData() {
    if (isBusy) {
      return;
    }

    setBusyAction("clear-local-data");
    clearLocalExtensionData();
    setLists([]);
    setLastSyncedAt(null);
    setServerVersion(null);
    setStatus("ready");
    setMessage("All local extension snapshot data was cleared. Your server copy was not changed.");
    setDebugLines(["local-data:cleared"]);
    setBusyAction(null);
  }

  function updateThemePreference(nextPreference: ThemePreference) {
    setThemePreference(nextPreference);
    writeThemePreference(nextPreference);
  }

  function openSettings() {
    setView("settings");
  }

  function closeSettings() {
    setView("main");
  }

  function clearSession() {
    clearCloudSession();
    setCloudSession(null);
    setLists([]);
    setLastSyncedAt(null);
    setServerVersion(null);
    setView("main");
    setStatus("idle");
    setMessage("Cloud session cleared from the extension.");
    setDebugLines(["session:cleared"]);
  }

  if (!cloudSession) {
    return (
      <main className="popup-shell">
        <header className="popup-header">
          <div className="popup-header-left">
            {view === "settings" ? (
              <button className="icon-button" aria-label="Back to main popup" disabled={isBusy} onClick={closeSettings} title="Back to main popup" type="button">
                <span aria-hidden="true">←</span>
              </button>
            ) : null}
          </div>
          <div>
            <div className="badge" aria-hidden="true">&nbsp;</div>
          </div>
          <div className="popup-header-actions">
            {view === "settings" ? <span className="header-spacer" aria-hidden="true" /> : (
              <button className="icon-button" aria-label="Options" disabled={isBusy} onClick={openSettings} title="Options" type="button">
                <span aria-hidden="true">⚙</span>
              </button>
            )}
          </div>
        </header>
        {view === "settings" ? (
          <>
            <section className="mini-panel settings-panel">
              <div className="options-panel-section">
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
              </div>
            </section>
            <section className="mini-panel options-debug-card">
              <div className="section-label">Debug</div>
              <ul className="options-list">
                <li>
                  Register this exact Kakao redirect URI in Kakao Developers:
                  <code>{redirectUri || "Unavailable"}</code>
                </li>
                <li>
                  If the URI keeps changing after reinstalling the unpacked extension, set
                  <code>EXTENSION_PUBLIC_KEY</code> before building so the extension id stays fixed.
                </li>
              </ul>
            </section>
          </>
        ) : (
          <>
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

            {status === "error" ? (
              <section className="mini-panel">
                <h2>Sign-In Error</h2>
                <p aria-live="polite" role="status">{message}</p>
              </section>
            ) : null}
          </>
        )}
      </main>
    );
  }

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="popup-header-left">
          {view === "settings" ? (
            <button className="icon-button" aria-label="Back to main popup" disabled={isBusy} onClick={closeSettings} title="Back to main popup" type="button">
              <span aria-hidden="true">←</span>
            </button>
          ) : null}
        </div>
        <div>
          <div className="badge" aria-hidden="true">&nbsp;</div>
        </div>
        <div className="popup-header-actions">
          {view === "settings" ? <span className="header-spacer" aria-hidden="true" /> : (
            <button className="icon-button" aria-label="Options" disabled={isBusy} onClick={openSettings} title="Options" type="button">
              <span aria-hidden="true">⚙</span>
            </button>
          )}
        </div>
      </header>
      {view === "settings" ? (
        <>
          <section className="mini-panel settings-panel">
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
              <button className="button primary" disabled={isBusy} onClick={() => void pullFromServer()} type="button">
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
                  <span>{cloudSession.user.id}</span>
                </li>
                <li>
                  <strong>Stored lists</strong>
                  <span>{formatCountLabel(lists.length, "list", "lists")}</span>
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
          <section className="mini-panel options-signout-card">
            <div className="section-label">Account</div>
            <div className="actions actions-stacked settings-actions">
              <button className="button danger" disabled={isBusy} onClick={clearSession} type="button">
                Sign Out
              </button>
            </div>
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
        </>
      ) : activeTab.kind === "place" ? (
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
                        <div className="kakao-note-body">
                          <button
                            aria-label="Copy Kakao note"
                            className="copy-note-button"
                            onClick={() => void copyKakaoNote(item.kakaoNote ?? "")}
                            title="Copy Kakao note"
                            type="button"
                          >
                            <CopyIcon />
                          </button>
                          <span>{item.kakaoNote}</span>
                        </div>
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
    </main>
  );
}

interface OpenPlaceModalContext {
  href?: string;
  placeKey?: string;
  title?: string;
}

async function fetchServerSnapshot(cloudSync: HttpCloudSyncClient) {
  const result = await cloudSync.pullLatestSnapshot();
  if (result.snapshot) {
    await repository.saveSnapshot(sanitizeSnapshot(result.snapshot));
  }

  return result;
}

async function resolveActiveTabContext(tab: chrome.tabs.Tab): Promise<ActiveTabContext> {
  const url = tab.url ?? "";
  const placeKey = extractPlaceKeyFromUrl(url);

  if (placeKey) {
    return {
      kind: "place",
      tabId: tab.id ?? null,
      title: tab.title ?? undefined,
      url,
      placeKey,
      source: "url"
    };
  }

  if (tab.id && isKakaoMapsPageUrl(url)) {
    const modalPlace = await readOpenPlaceModalContext(tab.id);
    if (modalPlace?.placeKey) {
      return {
        kind: "place",
        tabId: tab.id,
        title: modalPlace.title ?? tab.title ?? undefined,
        url: modalPlace.href ?? url,
        placeKey: modalPlace.placeKey,
        source: "modal"
      };
    }
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

function isKakaoMapsPageUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "map.kakao.com";
  } catch {
    return false;
  }
}

async function readOpenPlaceModalContext(tabId: number): Promise<OpenPlaceModalContext | null> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: findOpenPlaceModalInPage
    });

    if (!result || typeof result !== "object") {
      return null;
    }

    const candidate = result as OpenPlaceModalContext;
    const placeKey = extractPlaceKeyFromHref(candidate.href);
    if (!placeKey) {
      return null;
    }

    return {
      href: candidate.href,
      placeKey,
      title: candidate.title
    };
  } catch {
    return null;
  }
}

function findOpenPlaceModalInPage(): OpenPlaceModalContext | null {
  const selectors = [
    '#view\\.mapContainer div.head_tooltip > strong > a.name[href*="place.map.kakao.com/"]',
    '#view\\.mapContainer div.head_tooltip a.name[href*="place.map.kakao.com/"]',
    '#view\\.mapContainer a.name[data-id="name"][href*="place.map.kakao.com/"]'
  ];

  const isVisible = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };

  for (const selector of selectors) {
    const anchor = document.querySelector<HTMLAnchorElement>(selector);
    if (!anchor || !isVisible(anchor)) {
      continue;
    }

    return {
      href: anchor.href,
      title: anchor.textContent?.trim() || anchor.title?.trim() || undefined
    };
  }

  const fallbackAnchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('#view\\.mapContainer a[href*="place.map.kakao.com/"]')
  );

  for (const anchor of fallbackAnchors) {
    if (!isVisible(anchor)) {
      continue;
    }

    return {
      href: anchor.href,
      title: anchor.textContent?.trim() || anchor.title?.trim() || undefined
    };
  }

  return null;
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

function clearLocalExtensionData() {
  window.localStorage.removeItem("kakao-lists:extension");
  window.localStorage.removeItem("kakao-lists:extension-device-id");
  window.localStorage.removeItem("kakao-lists:extension-server-version");
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

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <rect height="12" rx="2" stroke="currentColor" strokeWidth="1.7" width="11" x="9" y="8" />
      <path d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
