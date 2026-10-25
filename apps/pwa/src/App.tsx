import type {
  CloudSession,
  FavoriteList,
  SyncStatus,
} from "@kakao-lists/domain";
import { isCloudSession, noteKey } from "@kakao-lists/domain";
import {
  buildKakaoAuthorizeUrl,
  consumeOAuthAttempt,
  createOAuthAttempt,
  isKakaoConfigured,
  readKakaoCallback,
} from "@kakao-lists/kakao";
import {
  browserStorage,
  LocalStorageFavoriteListsRepository,
} from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentAccessPanel } from "./AgentAccessPanel";
import {
  requestPwaUpdate,
  subscribeToPwaUpdateAvailability,
} from "./pwaUpdate";
import { parseRoute } from "./routes";
import {
  readThemePreference,
  type ThemePreference,
  writeThemePreference,
} from "./theme";

const rootRepository = new LocalStorageFavoriteListsRepository(
  "kakao-lists:pwa",
);
let callbackExchange: { code: string; promise: Promise<CloudSession> } | null =
  null;
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
  const [storedLists, setStoredLists] = useState<FavoriteList[]>([]);
  const [listsOwner, setListsOwner] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState<string>(
    "Sign in with Kakao to load your saved lists.",
  );
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(() =>
    readCloudSession(),
  );
  const repository = useMemo(
    () => rootRepository.forAccount(cloudSession?.user.id),
    [cloudSession?.user.id],
  );
  const lists = useMemo(
    () => (listsOwner === cloudSession?.user.id ? storedLists : []),
    [listsOwner, storedLists, cloudSession?.user.id],
  );
  const setLists = useCallback(
    (next: FavoriteList[]) => {
      setListsOwner(cloudSession?.user.id ?? null);
      setStoredLists(next);
    },
    [cloudSession?.user.id],
  );
  const dirtyDrafts = useRef(new Set<string>());
  const draftValues = useRef<Record<string, string>>({});
  const hasDirtyDrafts = useCallback(() => dirtyDrafts.current.size > 0, []);
  const callbackHandled = useRef(false);
  const authGeneration = useRef(0);
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
  const [offlineReady, setOfflineReady] = useState(false);
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false);

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(
          syncServerUrl,
          () => cloudSession?.token ?? null,
        )
      : null;
  }, [cloudSession?.token]);

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
    const next: Record<string, string> = {};
    for (const list of lists)
      for (const item of list.items)
        next[noteKey(list.id, item.id)] = item.localNote ?? "";
    setLocalNoteDrafts((current) => {
      const result = { ...next };
      for (const key of dirtyDrafts.current)
        if (key in current) result[key] = current[key];
      draftValues.current = result;
      return result;
    });
  }, [lists]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (hasDirtyDrafts()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const change = (event: StorageEvent) => {
      if (event.key !== null && event.key !== "kakao-lists:cloud-session")
        return;
      authGeneration.current += 1;
      const session = readCloudSession();
      setCloudSession(session);
      setStoredLists([]);
      setListsOwner(null);
      setLocalNoteDrafts({});
      dirtyDrafts.current.clear();
    };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("storage", change);
    return () => {
      window.removeEventListener("beforeunload", warn);
      window.removeEventListener("storage", change);
    };
  }, [hasDirtyDrafts]);

  useEffect(() => {
    const selector =
      route.view === "list" && route.listId ? ".detail-summary h2" : "h1,h2,h3";
    const target = document.querySelector<HTMLElement>(selector);
    if (target) {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  }, [route.view, route.listId]);

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
    return subscribeToPwaUpdateAvailability(({ available, offlineReady }) => {
      setOfflineReady(offlineReady);
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
      setMessage("Refreshing your saved lists…");

      try {
        const result = await activeCloudSync.pullLatestSnapshot();
        if (readCloudSession()?.token !== activeCloudSession.token) return;
        setServerVersion(result.serverVersion);

        if (!result.snapshot) {
          repository.clear();
          setLists([]);
          setLastSyncedAt(null);
          setStatus("ready");
          setMessage(
            "No saved lists yet. Import them with the Kakao Lists extension.",
          );
          return;
        }

        const snapshot = sanitizeSnapshot(result.snapshot);
        await repository.saveSnapshot(snapshot);
        setLists(snapshot.lists);
        setLastSyncedAt(snapshot.syncedAt);
        setStatus("ready");
        setMessage("Your saved lists are up to date.");
      } catch (error) {
        setStatus("error");
        setMessage(
          `Showing saved data. ${error instanceof Error ? error.message : "Could not refresh your lists."}`,
        );
      }
    },
    [cloudSession, cloudSync, repository, setLists],
  );

  useEffect(() => {
    if (callbackHandled.current || (!callback.code && !callback.error)) return;
    callbackHandled.current = true;
    if (callback.error) {
      setStatus("error");
      setMessage("Sign-in was cancelled. Please try again.");
      return;
    }
    if (!callback.code || !syncServerUrl) return;
    const code = callback.code;
    const generation = authGeneration.current;
    try {
      if (!callbackExchange || callbackExchange.code !== code) {
        if (!consumeOAuthAttempt(callback.state, window.sessionStorage))
          throw new Error(
            "This sign-in attempt has expired. Start sign-in again.",
          );
        callbackExchange = {
          code,
          promise: new HttpCloudSyncClient(syncServerUrl).exchangeKakaoCode({
            code,
            redirectUri: kakaoConfig.redirectUri,
          }),
        };
      }
      window.history.replaceState(
        {},
        document.title,
        window.location.pathname + window.location.hash,
      );
      setStatus("syncing");
      setMessage("Signing you in…");
      void callbackExchange.promise
        .then((session) => {
          if (authGeneration.current !== generation) {
            void new HttpCloudSyncClient(syncServerUrl, () => session.token)
              .logout()
              .catch(() => {});
            return;
          }
          writeCloudSession(session);
          setCloudSession(session);
          setStatus("ready");
          setMessage("Signed in.");
        })
        .catch((error) => {
          setStatus("error");
          setMessage(
            error instanceof Error
              ? error.message
              : "Could not sign in. Please try again.",
          );
        });
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Could not sign in.");
    }
  }, [callback]);

  useEffect(() => {
    let cancelled = false;
    dirtyDrafts.current.clear();
    setLocalNoteDrafts({});
    setStoredLists([]);
    setListsOwner(null);
    setLastSyncedAt(null);
    if (!cloudSession) return;
    const session = cloudSession;
    void Promise.all([repository.loadLists(), repository.getLastSyncedAt()])
      .then(([saved, at]) => {
        if (cancelled || readCloudSession()?.token !== session.token) return;
        setLists(filterVisibleLists(saved));
        setLastSyncedAt(at);
        setHasHydratedLocalSnapshot(true);
        if (cloudSync) void syncOnLoad(cloudSync, session);
      })
      .catch(() => {
        if (!cancelled) {
          setStatus("error");
          setMessage("Could not load saved data. Try refreshing your lists.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [cloudSession, repository, cloudSync, setLists, syncOnLoad]);

  async function signInWithMock() {
    if (!cloudSync) {
      setStatus("error");
      setMessage("Set VITE_SYNC_SERVER_URL to enable mock auth.");
      return;
    }

    if (isBusy) {
      return;
    }

    authGeneration.current += 1;
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
    setMessage("Refreshing your saved lists…");

    try {
      const result = await cloudSync.pullLatestSnapshot();
      if (readCloudSession()?.token !== cloudSession.token) return;
      setServerVersion(result.serverVersion);

      if (!result.snapshot) {
        repository.clear();
        setLists([]);
        setLastSyncedAt(null);
        setStatus("ready");
        setMessage(
          "No saved lists yet. Import them with the Kakao Lists extension.",
        );
        return;
      }

      if (readCloudSession()?.token !== cloudSession.token) return;
      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setStatus("ready");
      setMessage("Your saved lists are up to date.");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Pull failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function signOutCloud() {
    if (
      isBusy ||
      (hasDirtyDrafts() &&
        !window.confirm("Discard unsaved notes and sign out?"))
    )
      return;
    authGeneration.current += 1;
    setBusyAction("logout");
    try {
      await cloudSync?.logout();
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not sign out. Try again when connected.",
      );
      setBusyAction(null);
      return;
    }
    repository.clear();
    dirtyDrafts.current.clear();
    setLocalNoteDrafts({});
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
    setMessage("Signed out.");
    setBusyAction(null);
  }

  function openList(listId: string, itemId?: string) {
    if (
      hasDirtyDrafts() &&
      !window.confirm("Leave this page with unsaved notes?")
    )
      return;
    setRoute({
      view: "list",
      listId,
      itemId: itemId ?? null,
    });
    window.location.hash = buildListHash(listId, itemId);
  }

  function goBackToMainPage() {
    if (
      hasDirtyDrafts() &&
      !window.confirm("Leave this page with unsaved notes?")
    )
      return;
    setRoute({
      view: "overview",
      listId: null,
      itemId: null,
    });
    navigateToOverview();
  }

  function openSettings() {
    if (
      hasDirtyDrafts() &&
      !window.confirm("Leave this page with unsaved notes?")
    )
      return;
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
    if (
      hasDirtyDrafts() &&
      !window.confirm("Update now and discard unsaved notes?")
    )
      return;
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

    const key = noteKey(listId, itemId);
    const localNote = localNoteDrafts[key] ?? "";
    setBusyAction(actionKey);
    setStatus("syncing");
    setMessage("Saving your local note to the sync server...");

    try {
      const result = await cloudSync.updateLocalNote({
        listId,
        itemId,
        localNote,
      });
      if (readCloudSession()?.token !== cloudSession.token) return;
      const snapshot = sanitizeSnapshot(result.snapshot);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setServerVersion(result.serverVersion);
      setStatus("ready");
      if (draftValues.current[key] === localNote)
        dirtyDrafts.current.delete(key);
      setMessage("Note saved.");
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

  const authorizeUrl = isKakaoConfigured(kakaoConfig) ? "#sign-in" : null;
  function startSignIn(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    if (isBusy) return;
    try {
      const state = createOAuthAttempt(window.sessionStorage);
      window.location.assign(buildKakaoAuthorizeUrl({ ...kakaoConfig, state }));
    } catch {
      setStatus("error");
      setMessage("Enable browser storage to sign in securely.");
    }
  }

  async function deleteAccount() {
    if (
      !cloudSync ||
      isBusy ||
      !window.confirm(
        "Delete all your saved lists, notes, and assistant connections from Kakao Lists? This cannot be undone.",
      )
    )
      return;
    authGeneration.current += 1;
    setBusyAction("delete-account");
    try {
      await cloudSync.deleteAccount();
      repository.clear();
      clearCloudSession();
      dirtyDrafts.current.clear();
      setLocalNoteDrafts({});
      setCloudSession(null);
      setStoredLists([]);
      navigateToOverview();
      setStatus("idle");
      setMessage("Your Kakao Lists data was deleted.");
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : "Could not delete your data.",
      );
    } finally {
      setBusyAction(null);
    }
  }

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
          <h1>Sign in with Kakao.</h1>
          <p className="lede">
            See your saved places and notes on any device. Import your lists
            with the Kakao Lists browser extension, then view them here.
          </p>
          <div className="hero-actions">
            {authorizeUrl ? (
              <a
                aria-disabled={isBusy}
                className={`button primary${isBusy ? " is-disabled" : ""}`}
                href={isBusy ? undefined : authorizeUrl}
                onClick={startSignIn}
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
          {status === "error" ? (
            <div className="status-card is-error" role="alert">
              <span className="status-label">Sign-in error</span>
              <p>{message}</p>
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className={`topbar${isSettingsPage ? " is-settings" : ""}`}>
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
            {isSettingsPage ? (
              <span aria-current="page" className="topbar-page-label">
                / Settings
              </span>
            ) : null}
          </div>
        </div>

        <div className="topbar-actions">
          {!isSettingsPage ? (
            <button
              aria-label="Settings"
              className="icon-button"
              disabled={isBusy}
              onClick={openSettings}
              type="button"
            >
              <GearIcon />
            </button>
          ) : null}
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

      {status === "error" ? (
        <div className="status-card is-error" role="alert">
          <p>{message}</p>
          <button
            type="button"
            className="button secondary"
            disabled={isBusy}
            onClick={() => void pullFromServer()}
          >
            Try again
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={startSignIn}
          >
            Sign in again
          </button>
        </div>
      ) : null}
      {status === "syncing" && !isSettingsPage ? (
        <p role="status" aria-live="polite">
          Refreshing your lists…
        </p>
      ) : null}
      {isSettingsPage ? (
        <section className="settings-page">
          <article className="panel settings-summary">
            <h1 className="settings-title">Settings.</h1>
            <p className="lede settings-lede">
              Choose your appearance, refresh saved lists, and manage connected
              assistants.
            </p>
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
              <h2>Saved lists</h2>
              <p>
                Import new places with the Kakao Lists browser extension.
                Refresh here to see your latest lists and notes.
              </p>
              <div className="hero-actions compact">
                <button
                  className="button primary"
                  disabled={isBusy}
                  onClick={() => void pullFromServer()}
                  type="button"
                >
                  Refresh saved lists
                </button>
                <button
                  className="button secondary"
                  disabled={isBusy}
                  onClick={() => void signOutCloud()}
                  type="button"
                >
                  Sign out
                </button>
              </div>
            </article>
            <article className="panel settings-update">
              <h2>App version</h2>
              <p>
                {offlineReady
                  ? "Ready to open offline on this device."
                  : "Keep this page open while offline support is prepared."}
              </p>
              <dl className="meta-list update-meta">
                <div>
                  <dt>Version</dt>
                  <dd>{__APP_VERSION__}</dd>
                </div>
                <div>
                  <dt>Commit</dt>
                  <dd>{__COMMIT_ID__}</dd>
                </div>
              </dl>
              {updateAvailable ? (
                <>
                  <div className="hero-actions compact update-actions">
                    <button
                      className="button primary"
                      disabled={isApplyingUpdate || isBusy}
                      onClick={applyPwaUpdate}
                      type="button"
                    >
                      {isApplyingUpdate ? "Updating…" : "Update now"}
                    </button>
                  </div>
                  <p className="panel-copy">
                    A newer app version has been downloaded and is ready to
                    activate.
                  </p>
                </>
              ) : null}
            </article>
            <article className="panel">
              <h2>Your account</h2>
              <p>
                Signed in as {cloudSession.user.nickname ?? "a Kakao account"}.
              </p>
              <p>Sign-in expires {formatDate(cloudSession.expiresAt)}.</p>
              <p>
                Lists last imported:{" "}
                {lastSyncedAt ? formatDate(lastSyncedAt) : "Not yet"}.
              </p>
              <details>
                <summary>Technical details</summary>
                <dl className="meta-list">
                  <div>
                    <dt>Account id</dt>
                    <dd>{cloudSession.user.id}</dd>
                  </div>
                  <div>
                    <dt>Device id</dt>
                    <dd>{deviceId}</dd>
                  </div>
                  <div>
                    <dt>Saved version</dt>
                    <dd>{serverVersion ?? "None"}</dd>
                  </div>
                </dl>
              </details>
            </article>
            <article className="panel">
              <h2>Delete account data</h2>
              <p>
                Remove your lists, notes, and connected assistants from Kakao
                Lists. Your original Kakao Maps lists are not changed.
              </p>
              <button
                type="button"
                className="button secondary"
                disabled={isBusy}
                onClick={() => void deleteAccount()}
              >
                Delete my Kakao Lists data
              </button>
            </article>
            {cloudSync ? (
              <AgentAccessPanel
                client={cloudSync}
                formatDate={formatDate}
                mcpUrl={`${syncServerUrl.replace(/\/+$/, "")}/mcp`}
                onNotify={setToastMessage}
              />
            ) : null}
            <article
              aria-live="polite"
              className={`panel settings-activity is-${status}`}
              role="status"
            >
              <h2>Sync status</h2>
              <span className="status-label">{status}</span>
              <p>{message}</p>
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
                              value={
                                localNoteDrafts[
                                  noteKey(selectedList.id, item.id)
                                ] ?? ""
                              }
                              onChange={(event) => {
                                const key = noteKey(selectedList.id, item.id);
                                const value = event.target.value;
                                dirtyDrafts.current.add(key);
                                draftValues.current[key] = value;
                                setLocalNoteDrafts((current) => ({
                                  ...current,
                                  [key]: value,
                                }));
                              }}
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
                Import your lists with the Kakao Lists extension, then refresh
                this page.
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
  return parseRoute(window.location.hash);
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
  let existing: string | null = null;
  try {
    existing = browserStorage().getItem("kakao-lists:device-id");
  } catch {
    /* Use ephemeral id. */
  }
  if (existing) {
    return existing;
  }

  const next = `device-${Math.random().toString(36).slice(2, 10)}`;
  try {
    browserStorage().setItem("kakao-lists:device-id", next);
  } catch {
    /* Use ephemeral id. */
  }
  return next;
}

function readCloudSession(): CloudSession | null {
  let raw: string | null = null;
  try {
    raw = browserStorage().getItem("kakao-lists:cloud-session");
  } catch {
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CloudSession;
    if (!isCloudSession(parsed)) {
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
  browserStorage().setItem(
    "kakao-lists:cloud-session",
    JSON.stringify(session),
  );
}

function clearCloudSession() {
  try {
    browserStorage().removeItem("kakao-lists:cloud-session");
  } catch {
    /* Already unavailable. */
  }
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
