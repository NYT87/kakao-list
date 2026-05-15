import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CloudSession,
  FavoriteList,
  SyncStatus,
} from "@kakao-lists/domain";
import {
  buildKakaoAuthorizeUrl,
  isKakaoConfigured,
  readKakaoCallback,
} from "@kakao-lists/kakao";
import { LocalStorageFavoriteListsRepository } from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import {
  requestPwaUpdate,
  subscribeToPwaUpdateAvailability,
} from "./pwaUpdate";
import {
  readThemePreference,
  type ThemePreference,
  writeThemePreference,
} from "./theme";

const repository = new LocalStorageFavoriteListsRepository("kakao-lists:pwa");
const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";
const mockAuthEnabled = import.meta.env.VITE_ENABLE_MOCK_AUTH === "true";

const kakaoConfig = {
  clientId: import.meta.env.VITE_KAKAO_REST_API_KEY ?? "",
  redirectUri: import.meta.env.VITE_KAKAO_REDIRECT_URI ?? "",
  scope: import.meta.env.VITE_KAKAO_SCOPE?.trim() ?? "",
};

type AppRoute = {
  view: "overview" | "settings" | "list";
  listId: string | null;
  itemId: string | null;
};

function getScrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export default function App() {
  const callback = useMemo(() => readKakaoCallback(window.location), []);
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string>(
    "Sign in with Kakao to load your saved lists.",
  );
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(() =>
    readCloudSession(),
  );
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [route, setRoute] = useState<AppRoute>(() => readRoute());
  const [localNoteDrafts, setLocalNoteDrafts] = useState<
    Record<string, string>
  >({});
  const [listSearch, setListSearch] = useState("");
  const [placeSearch, setPlaceSearch] = useState("");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readThemePreference(),
  );
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [hasHydratedLocalSnapshot, setHasHydratedLocalSnapshot] =
    useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(
          syncServerUrl,
          () => readCloudSession()?.token ?? null,
        )
      : null;
  }, []);

  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const selectedList = route.listId
    ? (lists.find((list) => list.id === route.listId) ?? null)
    : null;
  const isSettingsPage = route.view === "settings";
  const isListPage = route.view === "list" && selectedList !== null;
  const showBackButton = route.view !== "overview";
  const isBusy = busyAction !== null;
  const filteredLists = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) {
      return lists.map((list) => ({
        list,
        matchedItems: [],
      }));
    }

    return lists
      .map((list) => {
        const listHaystack = [list.name, list.description, list.creatorName]
          .filter(Boolean)
          .join(" ");
        const listMatches = listHaystack.toLowerCase().includes(query);
        const matchedItems = list.items.filter((item) => {
          const haystack = [
            item.title,
            item.subtitle,
            item.kakaoNote,
            item.localNote,
          ]
            .filter(Boolean)
            .join(" ");
          return haystack.toLowerCase().includes(query);
        });

        if (!listMatches && matchedItems.length === 0) {
          return null;
        }

        return {
          list,
          matchedItems,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          list: FavoriteList;
          matchedItems: FavoriteList["items"];
        } => entry !== null,
      );
  }, [listSearch, lists]);
  const filteredItems = useMemo(() => {
    if (!selectedList) {
      return [];
    }

    const query = placeSearch.trim().toLowerCase();
    if (!query) {
      return selectedList.items;
    }

    return selectedList.items.filter((item) => {
      const haystack = [
        item.title,
        item.subtitle,
        item.kakaoNote,
        item.localNote,
      ]
        .filter(Boolean)
        .join(" ");
      return haystack.toLowerCase().includes(query);
    });
  }, [placeSearch, selectedList]);

  useEffect(() => {
    const onHashChange = () => {
      setRoute(readRoute());
    };

    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedLocalSnapshot) {
      return;
    }

    if (
      route.view === "list" &&
      route.listId &&
      !selectedList &&
      lists.length > 0
    ) {
      setRoute({
        view: "overview",
        listId: null,
        itemId: null,
      });
      navigateToOverview();
    }
  }, [hasHydratedLocalSnapshot, lists.length, route, selectedList]);

  useEffect(() => {
    if (!selectedList) {
      return;
    }

    const nextDrafts = Object.fromEntries(
      selectedList.items.map((item) => [item.id, item.localNote ?? ""]),
    );
    setLocalNoteDrafts(nextDrafts);
  }, [selectedList]);

  useEffect(() => {
    if (selectedList) {
      setPlaceSearch("");
      return;
    }

    setPlaceSearch("");
  }, [selectedList]);

  useEffect(() => {
    if (!selectedList || !route.itemId) {
      return;
    }

    const target = document.getElementById(`place-item-${route.itemId}`);
    target?.scrollIntoView({
      block: "center",
      behavior: getScrollBehavior(),
    });
  }, [selectedList, route.itemId]);

  useEffect(() => {
    if (route.itemId) {
      return;
    }

    window.scrollTo({
      top: 0,
      behavior: getScrollBehavior(),
    });
  }, [route.itemId]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setToastMessage(null);
    }, 2200);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [toastMessage]);

  useEffect(() => {
    return subscribeToPwaUpdateAvailability(({ available }) => {
      setUpdateAvailable(available);
      if (!available) {
        setIsApplyingUpdate(false);
      }
    });
  }, []);

  const syncOnLoad = useCallback(
    async (activeCloudSync = cloudSync, activeCloudSession = cloudSession) => {
      if (!activeCloudSync || !activeCloudSession) {
        return;
      }

      setStatus("syncing");
      setMessage(
        "Pulling the latest snapshot created by the extension from the sync server...",
      );

      try {
        const result = await activeCloudSync.pullLatestSnapshot();
        setServerVersion(result.serverVersion);

        if (!result.snapshot) {
          setStatus("ready");
          setMessage("No extension-created snapshot exists on the server yet.");
          return;
        }

        const snapshot = sanitizeSnapshot(result.snapshot);
        await repository.saveSnapshot(snapshot);
        setLists(snapshot.lists);
        setLastSyncedAt(snapshot.syncedAt);
        setStatus("ready");
        setMessage(
          `Loaded ${result.snapshot.lists.length} saved lists created by the extension for Kakao user ${result.userId}.`,
        );
      } catch (error) {
        setStatus("error");
        setMessage(
          error instanceof Error ? error.message : "Server pull failed.",
        );
      }
    },
    [cloudSession, cloudSync],
  );

  const hydrate = useCallback(async () => {
    const [savedLists, syncedAt] = await Promise.all([
      repository.loadLists(),
      repository.getLastSyncedAt(),
    ]);
    setLists(filterVisibleLists(savedLists));
    setLastSyncedAt(syncedAt);
    setHasHydratedLocalSnapshot(true);

    if (callback.error) {
      setStatus("error");
      setMessage(`Kakao returned an error: ${callback.error}`);
      return;
    }

    if (callback.code && cloudSync) {
      setStatus("syncing");
      setMessage(
        "Exchanging the Kakao authorization code with the sync server...",
      );

      try {
        const session = await cloudSync.exchangeKakaoCode({
          code: callback.code,
          redirectUri: kakaoConfig.redirectUri,
        });
        writeCloudSession(session);
        setCloudSession(session);
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname + window.location.hash,
        );
        setStatus("ready");
        setMessage(
          `Signed in as Kakao user ${session.user.id}. Pulling the latest snapshot created by the extension...`,
        );
        await syncOnLoad(cloudSync, session);
        return;
      } catch (error) {
        setStatus("error");
        setMessage(
          error instanceof Error
            ? error.message
            : "Kakao server sign-in failed.",
        );
        return;
      }
    }

    if (callback.code) {
      setStatus("ready");
      setMessage(
        "Authorization code captured. Configure the sync server to turn it into a cloud session.",
      );
      return;
    }

    if (cloudSync && cloudSession) {
      await syncOnLoad(cloudSync, cloudSession);
    }
  }, [callback.code, callback.error, cloudSession, cloudSync, syncOnLoad]);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  async function signInWithMock() {
    if (!cloudSync) {
      setStatus("error");
      setMessage("Set VITE_SYNC_SERVER_URL to enable mock auth.");
      return;
    }

    if (isBusy) {
      return;
    }

    setBusyAction("mock-sign-in");
    setStatus("syncing");
    setMessage("Creating a mock cloud session...");

    try {
      const session = await cloudSync.createMockSession();
      writeCloudSession(session);
      setCloudSession(session);
      setStatus("ready");
      setMessage(
        `Signed in with mock auth as ${session.user.id}. Pull the latest snapshot created by the extension when you need it.`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : "Mock sign-in failed.",
      );
    } finally {
      setBusyAction(null);
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

      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setStatus("ready");
      setMessage(
        `Pulled server snapshot version ${result.serverVersion} from Kakao user ${result.userId}.`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Pull failed.");
    } finally {
      setBusyAction(null);
    }
  }

  function signOutCloud() {
    clearCloudSession();
    setCloudSession(null);
    setLists([]);
    setLastSyncedAt(null);
    setServerVersion(null);
    setRoute({
      view: "overview",
      listId: null,
      itemId: null,
    });
    navigateToOverview();
    setStatus("idle");
    setMessage("Cloud session cleared from this browser.");
  }

  function openList(listId: string, itemId?: string) {
    setRoute({
      view: "list",
      listId,
      itemId: itemId ?? null,
    });
    window.location.hash = buildListHash(listId, itemId);
  }

  function goBackToMainPage() {
    setRoute({
      view: "overview",
      listId: null,
      itemId: null,
    });
    navigateToOverview();
  }

  function openSettings() {
    setRoute({
      view: "settings",
      listId: null,
      itemId: null,
    });
    window.location.hash = "settings";
  }

  function updateThemePreference(nextPreference: ThemePreference) {
    setThemePreference(nextPreference);
    writeThemePreference(nextPreference);
  }

  function applyPwaUpdate() {
    if (!requestPwaUpdate()) {
      setUpdateAvailable(false);
      setIsApplyingUpdate(false);
      setToastMessage("No new version is ready yet");
      return;
    }

    setIsApplyingUpdate(true);
    setToastMessage("Updating app…");
  }

  async function saveLocalNote(listId: string, itemId: string) {
    if (!cloudSync || !cloudSession) {
      setStatus("error");
      setMessage("Sign in to the sync server before saving local notes.");
      return;
    }

    const actionKey = `save-note:${listId}:${itemId}`;
    if (isBusy) {
      return;
    }

    const localNote = localNoteDrafts[itemId] ?? "";
    setBusyAction(actionKey);
    setStatus("syncing");
    setMessage("Saving your local note to the sync server...");

    try {
      const result = await cloudSync.updateLocalNote({
        listId,
        itemId,
        localNote,
      });
      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setServerVersion(result.serverVersion);
      setStatus("ready");
      setMessage("Local note saved to the sync server.");
      setToastMessage("Note saved");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : "Local note save failed.",
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

  const authorizeUrl = isKakaoConfigured(kakaoConfig)
    ? buildKakaoAuthorizeUrl({
        ...kakaoConfig,
        state: "kakao-lists-pwa",
      })
    : null;

  if (!cloudSession) {
    return (
      <main className="shell">
        <header className="topbar">
          <div className="topbar-brand">
            <span className="topbar-kicker">KL</span>
            <strong>Kakao Lists</strong>
          </div>
        </header>

        <section className="hero auth-hero">
          <p className="eyebrow">Kakao Lists / Web</p>
          <h1>Sign in with Kakao.</h1>
          <p className="lede">
            Your saved lists page appears after an active session exists. The
            web app now reads the latest snapshot produced by the extension
            instead of importing directly from Kakao Maps.
          </p>
          <div className="hero-actions">
            {authorizeUrl ? (
              <a
                aria-disabled={isBusy}
                className={`button primary${isBusy ? " is-disabled" : ""}`}
                href={isBusy ? undefined : authorizeUrl}
                onClick={(event) => {
                  if (isBusy) {
                    event.preventDefault();
                  }
                }}
              >
                Sign in with Kakao
              </a>
            ) : (
              <span className="button disabled">
                Add Kakao env vars to enable real auth
              </span>
            )}
            {mockAuthEnabled ? (
              <button
                className={authorizeUrl ? "button secondary" : "button primary"}
                disabled={isBusy}
                onClick={signInWithMock}
                type="button"
              >
                Use Mock Sign In
              </button>
            ) : null}
          </div>
          <div
            aria-live="polite"
            className={`status-card is-${status}`}
            role="status"
          >
            <span className="status-label">{status}</span>
            <p>{message}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="topbar-left">
          {showBackButton ? (
            <button
              aria-label="Back to main page"
              className="icon-button"
              disabled={isBusy}
              onClick={goBackToMainPage}
              type="button"
            >
              <ArrowLeftIcon />
            </button>
          ) : null}
          <div className="topbar-brand">
            <span className="topbar-kicker">KL</span>
            <strong>Kakao Lists</strong>
          </div>
        </div>

        <div className="topbar-actions">
          <button
            aria-label="Settings"
            className="icon-button"
            disabled={isBusy}
            onClick={openSettings}
            type="button"
          >
            <GearIcon />
          </button>
          <button
            aria-label="Log out"
            className="icon-button"
            disabled={isBusy}
            onClick={signOutCloud}
            type="button"
          >
            <LogoutIcon />
          </button>
        </div>
      </header>

      {isSettingsPage ? (
        <section className="settings-page">
          <article className="panel settings-summary">
            <p className="eyebrow">Kakao Lists / Settings</p>
            <div className="settings-summary-header">
              <div>
                <h1 className="settings-title">Settings.</h1>
                <p className="lede settings-lede">
                  Manage your local cloud session, pull the latest server
                  snapshot, and review sync status in one place.
                </p>
              </div>
              <div
                aria-live="polite"
                className={`status-card is-${status} settings-status`}
                role="status"
              >
                <span className="status-label">{status}</span>
                <p>{message}</p>
              </div>
            </div>
          </article>

          <div className="grid settings-grid">
            <article className="panel">
              <h2>Appearance</h2>
              <fieldset
                className="segmented-control"
                aria-label="Theme preference"
              >
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
              </fieldset>
              <p className="panel-copy">Default follows your device setting.</p>
            </article>

            <article className="panel">
              <h2>App Update</h2>
              <dl className="meta-list update-meta">
                <div>
                  <dt>Status</dt>
                  <dd>
                    {updateAvailable ? "New version ready" : "Up to date"}
                  </dd>
                </div>
              </dl>
              <div className="hero-actions compact update-actions">
                <button
                  className="button primary"
                  disabled={!updateAvailable || isApplyingUpdate || isBusy}
                  onClick={applyPwaUpdate}
                  type="button"
                >
                  {isApplyingUpdate ? "Updating…" : "Update now"}
                </button>
              </div>
              <p className="panel-copy">
                {updateAvailable
                  ? "A newer app version has been downloaded and is ready to activate."
                  : "This device is already using the latest downloaded app version."}
              </p>
            </article>

            <article className="panel">
              <h2>Session Information</h2>
              <dl className="meta-list">
                <div>
                  <dt>Kakao user</dt>
                  <dd>{cloudSession.user.id}</dd>
                </div>
                <div>
                  <dt>Expires at</dt>
                  <dd>{formatDate(cloudSession.expiresAt)}</dd>
                </div>
                <div>
                  <dt>Last synced</dt>
                  <dd>{lastSyncedAt ?? "Never"}</dd>
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
                <button
                  className="button primary"
                  disabled={isBusy}
                  onClick={pullFromServer}
                  type="button"
                >
                  Pull Latest Server Snapshot
                </button>
                <button
                  className="button secondary"
                  disabled={isBusy}
                  onClick={signOutCloud}
                  type="button"
                >
                  Clear Cloud Session
                </button>
              </div>
              <ul className="bullet-list">
                <li>
                  List overview cards now hide place rows until you open a
                  dedicated list page.
                </li>
                <li>
                  List metadata can show description and creator when the
                  snapshot includes it.
                </li>
                <li>
                  The PWA is read-only for snapshots; create or refresh them
                  from the extension popup.
                </li>
              </ul>
            </article>
          </div>
        </section>
      ) : isListPage ? (
        <>
          <section className="detail-summary">
            <article className="panel detail-summary-card">
              <div className="detail-summary-header">
                <h2>{selectedList.name}</h2>
                <span className="detail-summary-count">
                  {formatCountLabel(filteredItems.length, "place", "places")}
                </span>
              </div>
              {selectedList.description ? (
                <p>{selectedList.description}</p>
              ) : null}
              <span className="detail-summary-author">
                By {selectedList.creatorName ?? "Unknown creator"}
              </span>
            </article>
          </section>

          <section className="lists detail-page">
            <article className="detail-card">
              <label className="search-field">
                <span className="sr-only">Search places in this list</span>
                <input
                  type="search"
                  value={placeSearch}
                  onChange={(event) => setPlaceSearch(event.target.value)}
                  placeholder="Filter by title, note, or summary"
                />
              </label>

              {filteredItems.length === 0 ? (
                <div className="empty-state compact-empty-state">
                  <p>No places match this filter.</p>
                  <p>Try a different title, note, or summary term.</p>
                </div>
              ) : (
                <ul className="place-list">
                  {filteredItems.map((item) => {
                    return (
                      <li
                        className={`place-row${route.itemId === item.id ? " is-active" : ""}`}
                        id={`place-item-${item.id}`}
                        key={item.id}
                      >
                        {item.href ? (
                          <a
                            aria-label={`Open ${item.title} in Kakao Maps`}
                            className="place-map-link"
                            href={item.href}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <MapPinIcon />
                          </a>
                        ) : (
                          <span
                            className="place-map-link is-placeholder"
                            aria-hidden="true"
                          />
                        )}
                        <div className="place-copy">
                          <strong>{item.title}</strong>
                          {item.subtitle ? <span>{item.subtitle}</span> : null}
                          {item.kakaoNote ? (
                            <div className="note-field kakao-note-field">
                              <span>Kakao note</span>
                              <div className="kakao-note-body">
                                <button
                                  aria-label="Copy Kakao note"
                                  className="copy-note-button"
                                  onClick={() =>
                                    void copyKakaoNote(item.kakaoNote ?? "")
                                  }
                                  title="Copy Kakao note"
                                  type="button"
                                >
                                  <CopyIcon />
                                </button>
                                <p>{item.kakaoNote}</p>
                              </div>
                            </div>
                          ) : null}
                          <label className="note-field">
                            <span>Local note</span>
                            <input
                              maxLength={500}
                              type="text"
                              value={localNoteDrafts[item.id] ?? ""}
                              onChange={(event) =>
                                setLocalNoteDrafts((current) => ({
                                  ...current,
                                  [item.id]: event.target.value,
                                }))
                              }
                              placeholder="Add your own note"
                            />
                          </label>
                        </div>
                        <button
                          aria-label="Save local note"
                          className="button secondary note-save"
                          disabled={isBusy}
                          onClick={() =>
                            void saveLocalNote(selectedList.id, item.id)
                          }
                          title="Save local note"
                          type="button"
                        >
                          <SaveIcon />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          </section>
        </>
      ) : (
        <section className="lists">
          <div className="section-head">
            <label className="search-field overview-search">
              <span className="sr-only">Search saved lists and places</span>
              <input
                type="search"
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder="Search or filter lists"
              />
            </label>
          </div>

          {lists.length === 0 ? (
            <div className="empty-state">
              <p>No lists stored yet.</p>
              <p>
                The next authenticated load will sync the latest Kakao snapshot
                into local storage.
              </p>
            </div>
          ) : filteredLists.length === 0 ? (
            <div className="empty-state compact-empty-state">
              <p>No lists match this search.</p>
              <p>Try a list name, creator, place title, or note.</p>
            </div>
          ) : (
            <div className="overview-grid">
              {filteredLists.map(({ list, matchedItems }) => (
                <article className="overview-card" key={list.id}>
                  <button
                    className="overview-card-button"
                    onClick={() => openList(list.id)}
                    type="button"
                  >
                    <div className="overview-header">
                      <div className="overview-title-row">
                        <h3>{list.name}</h3>
                        <span className="overview-count">
                          {formatCountLabel(list.itemCount, "place", "places")}
                        </span>
                      </div>
                      <span className="overview-creator">
                        {list.creatorName ?? "Unknown creator"}
                      </span>
                    </div>
                  </button>

                  {matchedItems.length > 0 ? (
                    <section className="overview-matches">
                      <span className="overview-matches-label">
                        Matching places
                      </span>
                      <ul className="overview-match-list">
                        {matchedItems.map((item) => (
                          <li className="overview-match-item" key={item.id}>
                            <button
                              className="overview-match-button"
                              onClick={() => openList(list.id, item.id)}
                              type="button"
                            >
                              <strong>{item.title}</strong>
                              {item.subtitle ? (
                                <span>{item.subtitle}</span>
                              ) : null}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {toastMessage ? (
        <div aria-live="polite" className="toast" role="status">
          {toastMessage}
        </div>
      ) : null}
    </main>
  );
}

function readRoute(): AppRoute {
  const hash = window.location.hash.replace(/^#/, "");
  const [route, query = ""] = hash.split("?");

  if (route === "settings") {
    return {
      view: "settings",
      listId: null,
      itemId: null,
    };
  }

  if (route.startsWith("list/")) {
    const params = new URLSearchParams(query);
    const itemId = params.get("item");
    return {
      view: "list",
      listId: decodeURIComponent(route.slice("list/".length)),
      itemId: itemId ? decodeURIComponent(itemId) : null,
    };
  }

  return {
    view: "overview",
    listId: null,
    itemId: null,
  };
}

function buildListHash(listId: string, itemId?: string) {
  const route = `list/${encodeURIComponent(listId)}`;
  if (!itemId) {
    return route;
  }

  const params = new URLSearchParams({
    item: itemId,
  });
  return `${route}?${params.toString()}`;
}

function sanitizeSnapshot(snapshot: {
  syncedAt: string;
  source: string;
  lists: FavoriteList[];
}) {
  return {
    ...snapshot,
    lists: filterVisibleLists(snapshot.lists),
  };
}

function filterVisibleLists(lists: FavoriteList[]) {
  return lists.filter((list) => !isDeletedFolderPlaceholder(list));
}

function isDeletedFolderPlaceholder(list: FavoriteList) {
  return list.itemCount === 0 && /^Folder \d+$/.test(list.name.trim());
}

function navigateToOverview() {
  if (window.location.hash) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(getUserLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatCountLabel(count: number, singular: string, plural: string) {
  const formattedCount = new Intl.NumberFormat(getUserLocale()).format(count);
  return `${formattedCount} ${count === 1 ? singular : plural}`;
}

function getUserLocale() {
  return navigator.language || "en-US";
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
  window.localStorage.setItem(
    "kakao-lists:cloud-session",
    JSON.stringify(session),
  );
}

function clearCloudSession() {
  window.localStorage.removeItem("kakao-lists:cloud-session");
}

function ArrowLeftIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M15 5 8 12l7 7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="m12 3 1.1 2.3 2.5.4.7 2.4 2 1.6-1 2.3 1 2.3-2 1.6-.7 2.4-2.5.4L12 21l-1.1-2.3-2.5-.4-.7-2.4-2-1.6 1-2.3-1-2.3 2-1.6.7-2.4 2.5-.4L12 3Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      />
      <circle
        cx="12"
        cy="12"
        r="3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M9 4H5.8A1.8 1.8 0 0 0 4 5.8v12.4A1.8 1.8 0 0 0 5.8 20H9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M13 8l4 4-4 4M17 12H9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M12 21s-5.5-5.2-5.5-10A5.5 5.5 0 1 1 17.5 11C17.5 15.8 12 21 12 21Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <circle
        cx="12"
        cy="11"
        r="2.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect
        x="9"
        y="9"
        width="10"
        height="10"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M15 9V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path
        d="M5 5h11l3 3v11H5Z"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
      <path
        d="M8 5v5h8V5M9 19v-5h6v5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
