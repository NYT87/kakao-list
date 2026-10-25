import type {
  CloudSession,
  FavoriteList,
  FavoriteListItem,
  PushSnapshotResult,
  SyncStatus,
} from "@kakao-lists/domain";
import { noteKey } from "@kakao-lists/domain";
import {
  browserStorage,
  LocalStorageFavoriteListsRepository,
} from "@kakao-lists/storage";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  beginKakaoSignIn,
  beginMockSignIn,
  clearCloudSessionInBackground,
} from "./authBridge";
import { BuildDetails } from "./BuildDetails";
import {
  readStoredCloudSession,
  requireCurrentCloudSession,
} from "./cloudSession";
import {
  extractSnapshotFromKakaoMapsTab,
  KakaoNoteUpdateError,
  resolveKakaoFavoriteForPlace,
  updateKakaoFavoriteNote,
} from "./kakaoMapsExtractor";
import { useDebugMode } from "./preferences";
import {
  readThemePreference,
  type ThemePreference,
  writeThemePreference,
} from "./theme";

const rootRepository = new LocalStorageFavoriteListsRepository(
  "kakao-lists:extension",
);
const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";
const kakaoClientId = import.meta.env.VITE_KAKAO_REST_API_KEY ?? "";
const pwaBaseUrl = import.meta.env.VITE_PWA_BASE_URL ?? "http://localhost:5173";
const mockAuthEnabled = import.meta.env.VITE_ENABLE_MOCK_AUTH === "true";
const extensionRedirectPath = "kakao";
const KAKAO_NOTE_MAX_LENGTH = 50;

interface ActiveTabContext {
  kind: "default" | "place";
  tabId: number | null;
  title?: string;
  url?: string;
  placeKey?: string;
  source?: "url" | "modal";
  /** Kakao folder currently open in the tab, when one could be detected. */
  openFolderId?: number;
}

type PopupView = "main" | "settings";

export default function PopupApp() {
  const [cloudSession, setCloudSession] = useState<CloudSession | null>(null);
  const repository = useMemo(
    () => rootRepository.forAccount(cloudSession?.user.id),
    [cloudSession?.user.id],
  );
  const dirtyLocal = useRef(new Set<string>());
  const dirtyKakao = useRef(new Set<string>());
  const localValues = useRef<Record<string, string>>({});
  const kakaoValues = useRef<Record<string, string>>({});
  const [lists, setLists] = useState<FavoriteList[]>([]);
  const [status, setStatus] = useState<SyncStatus>("idle");
  const [message, setMessage] = useState(
    "Sign in with Kakao to load your saved lists.",
  );
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [serverVersion, setServerVersion] = useState<number | null>(null);
  const [_debugLines, setDebugLines] = useState<string[]>([]);
  const [kakaoNoteDrafts, setKakaoNoteDrafts] = useState<
    Record<string, string>
  >({});
  const [localNoteDrafts, setLocalNoteDrafts] = useState<
    Record<string, string>
  >({});
  const [kakaoNoteErrors, setKakaoNoteErrors] = useState<
    Record<string, KakaoNoteFailure>
  >({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [view, setView] = useState<PopupView>("main");
  const [themePreference, setThemePreference] = useState<ThemePreference>(() =>
    readThemePreference(),
  );
  const [debugMode, setDebugMode] = useDebugMode();
  const [activeTab, setActiveTab] = useState<ActiveTabContext>({
    kind: "default",
    tabId: null,
  });
  const [lastResolvedKakaoFavorite, setLastResolvedKakaoFavorite] = useState<
    unknown | null
  >(null);
  const deviceId = useMemo(() => getOrCreateDeviceId(), []);
  const redirectUri = useMemo(() => getExtensionRedirectUri(), []);
  const isBusy = busyAction !== null;

  const cloudSync = useMemo(() => {
    return syncServerUrl
      ? new HttpCloudSyncClient(
          syncServerUrl,
          () => cloudSession?.token ?? null,
        )
      : null;
  }, [cloudSession]);

  const placeMemberships = useMemo(() => {
    if (activeTab.kind !== "place" || !activeTab.placeKey) {
      return [];
    }

    const memberships = lists.flatMap((list) =>
      list.items
        .filter(
          (item) =>
            item.placeKey === activeTab.placeKey ||
            extractPlaceKeyFromHref(item.href) === activeTab.placeKey,
        )
        .map((item) => ({
          list,
          item,
        })),
    );

    const openFolderId = activeTab.openFolderId;
    if (openFolderId === undefined) {
      return memberships;
    }

    // The list open in the Kakao Maps tab is the one the user is working in,
    // so surface it first while keeping the remaining order untouched.
    return memberships
      .map((membership, index) => ({ membership, index }))
      .sort((left, right) => {
        const leftOpen = isMembershipInFolder(left.membership, openFolderId);
        const rightOpen = isMembershipInFolder(right.membership, openFolderId);
        if (leftOpen !== rightOpen) {
          return leftOpen ? -1 : 1;
        }

        return left.index - right.index;
      })
      .map(({ membership }) => membership);
  }, [activeTab, lists]);

  const hydrate = useCallback(async () => {
    const storedSession = await readStoredCloudSession();
    const scoped = rootRepository.forAccount(storedSession?.user.id);
    const [savedLists, syncedAt] = storedSession
      ? await Promise.all([scoped.loadLists(), scoped.getLastSyncedAt()])
      : [[], null];
    setLists(filterVisibleLists(savedLists));
    setLastSyncedAt(syncedAt);
    setCloudSession(storedSession);
    setDebugLines((current) =>
      current.length > 0
        ? current
        : [
            `hydrated-local-lists:${savedLists.length}`,
            `hydrated-last-sync:${syncedAt ?? "never"}`,
          ],
    );
  }, []);

  const hydrateActiveTab = useCallback(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab) {
      setActiveTab({
        kind: "default",
        tabId: null,
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
  }, []);

  useEffect(() => {
    const changed = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area === "local" && changes["kakao-lists:extension-cloud-session"]) {
        repository.clear();
        window.location.reload();
      }
    };
    const warn = (event: BeforeUnloadEvent) => {
      if (dirtyLocal.current.size || dirtyKakao.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    chrome.storage.onChanged.addListener(changed);
    window.addEventListener("beforeunload", warn);
    return () => {
      chrome.storage.onChanged.removeListener(changed);
      window.removeEventListener("beforeunload", warn);
    };
  }, [repository]);

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
      setMessage(
        "Chrome identity is unavailable, so the extension redirect URI could not be resolved.",
      );
      return;
    }

    if (isBusy) {
      return;
    }

    setBusyAction("sign-in");
    setStatus("syncing");
    setMessage("Opening Kakao sign-in...");
    setDebugLines([`auth-mode:real`, `redirect-uri:${redirectUri}`]);

    try {
      const session = await beginKakaoSignIn();
      setCloudSession(session);
      setStatus("ready");
      setMessage(
        `Signed in as Kakao user ${session.user.id}. Click import when you want to fetch lists from Kakao Maps.`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? `${error.message} Register this redirect URI in Kakao Developers: ${redirectUri}`
          : `Extension sign-in failed. Register this redirect URI in Kakao Developers: ${redirectUri}`,
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
      const session = await beginMockSignIn();
      setCloudSession(session);
      setStatus("ready");
      setMessage(
        `Signed in with mock auth as ${session.user.id}. Click import when you want to fetch lists from Kakao Maps.`,
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

  async function importFromKakaoMaps(
    activeCloudSync = cloudSync,
    activeCloudSession = cloudSession,
    activeDeviceId = deviceId,
  ) {
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
        if (
          !(await confirmImportAccount(
            activeCloudSession,
            extracted.snapshot.lists,
          ))
        )
          throw new Error(
            "Import cancelled. Sign into the same Kakao account in Maps and Kakao Lists, then try again.",
          );
        await requireCurrentCloudSession(activeCloudSession);
        const localSnapshot = sanitizeSnapshot(
          extracted.snapshot,
          activeCloudSession,
        );
        const prior = new Map(
          lists.map((list) => [
            list.id,
            new Map(list.items.map((item) => [item.id, item.localNote])),
          ]),
        );
        for (const list of localSnapshot.lists)
          for (const item of list.items)
            item.localNote = prior.get(list.id)?.get(item.id);
        await rootRepository
          .forAccount(activeCloudSession.user.id)
          .saveSnapshot(localSnapshot);
        if (
          (await readStoredCloudSession())?.token !== activeCloudSession.token
        )
          return;
        setLists(localSnapshot.lists);
        setLastSyncedAt(localSnapshot.syncedAt);
        setServerVersion(null);
        setStatus("ready");
        setMessage(
          `Imported ${extracted.placeCount} places across ${extracted.folderCount} lists from ${
            extracted.tabTitle ?? "Kakao Maps"
          }. Syncing to the server...`,
        );

        try {
          const expectedListIds = localSnapshot.lists.map((list) => list.id);
          let finalResult: Awaited<
            ReturnType<HttpCloudSyncClient["pushSnapshotList"]>
          > | null = null;

          if (localSnapshot.lists.length === 0) {
            await requireCurrentCloudSession(activeCloudSession);
            finalResult = await activeCloudSync.pushSnapshot({
              deviceId: activeDeviceId,
              snapshot: localSnapshot,
            });
          } else {
            for (const [index, list] of localSnapshot.lists.entries()) {
              await requireCurrentCloudSession(activeCloudSession);
              const isLastList = index === localSnapshot.lists.length - 1;
              const chunk = {
                deviceId: activeDeviceId,
                list,
                syncedAt: localSnapshot.syncedAt,
                source: localSnapshot.source,
                expectedListIds: isLastList ? expectedListIds : undefined,
              };
              if (isLastList)
                finalResult = await activeCloudSync.pushSnapshotList(chunk);
              else await activeCloudSync.pushSnapshotListChunk(chunk);
            }
          }

          if (!finalResult) {
            throw new Error("Snapshot sync did not return a server result.");
          }

          if (
            (await readStoredCloudSession())?.token !== activeCloudSession.token
          )
            return;
          const storedSnapshot = sanitizeSnapshot(
            finalResult.snapshot,
            activeCloudSession,
          );
          await repository.saveSnapshot(storedSnapshot);
          setLists(storedSnapshot.lists);
          setLastSyncedAt(storedSnapshot.syncedAt);
          setServerVersion(finalResult.serverVersion);
          writeLastKnownServerVersion(finalResult.serverVersion);
          setStatus("ready");
          setMessage(
            `Imported ${extracted.placeCount} places across ${extracted.folderCount} lists from ${
              extracted.tabTitle ?? "Kakao Maps"
            } and synced version ${finalResult.serverVersion}.`,
          );
        } catch (error) {
          setStatus("error");
          setDebugLines((current) => [
            ...current,
            `server-sync-error:${error instanceof Error ? error.message : "Server sync failed after local import."}`,
          ]);
          setMessage(
            error instanceof Error
              ? `Imported locally, but failed to sync to the server: ${error.message}`
              : "Imported locally, but failed to sync to the server.",
          );
        }

        return;
      }

      setDebugLines(["phase:tab-discovery", "result:no-kakao-maps-tab"]);
      setStatus("ready");
      setMessage("Open Kakao Maps in a signed-in tab before importing.");
    } catch (error) {
      setStatus("error");
      setDebugLines((current) => [
        ...current,
        `error:${error instanceof Error ? error.message : "Import failed."}`,
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
        repository.clear();
        setLists([]);
        setLastSyncedAt(null);
        setStatus("ready");
        setMessage("No server snapshot exists for this Kakao user yet.");
        return;
      }

      if ((await readStoredCloudSession())?.token !== cloudSession.token)
        return;
      const snapshot = sanitizeSnapshot(result.snapshot, cloudSession);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setStatus("ready");
      writeLastKnownServerVersion(result.serverVersion);
      setDebugLines((current) => [
        ...current,
        `server-version:${result.serverVersion ?? "none"}`,
        `server-lists:${snapshot.lists.length}`,
      ]);
      setMessage(
        `Loaded server snapshot version ${result.serverVersion ?? "unknown"}.`,
      );
    } catch (error) {
      setStatus("error");
      setDebugLines((current) => [
        ...current,
        `error:${error instanceof Error ? error.message : "Server pull failed."}`,
      ]);
      setMessage(
        error instanceof Error ? error.message : "Server pull failed.",
      );
    } finally {
      setBusyAction(null);
    }
  }

  const refreshPlaceViewFromServer = useCallback(
    async (
      activeCloudSync: HttpCloudSyncClient,
      activeCloudSession: CloudSession,
    ) => {
      setDebugLines((current) =>
        dedupeLines([...current, "phase:background-server-refresh"]),
      );

      try {
        const result = await fetchServerSnapshot(activeCloudSync);
        if (
          (await readStoredCloudSession())?.token !== activeCloudSession.token
        )
          return;
        if (!result.snapshot) {
          rootRepository.forAccount(activeCloudSession.user.id).clear();
          setLists([]);
          setLastSyncedAt(null);
          setDebugLines((current) =>
            dedupeLines([...current, "background-refresh:no-server-snapshot"]),
          );
          return;
        }

        const snapshot = sanitizeSnapshot(result.snapshot, activeCloudSession);
        await rootRepository
          .forAccount(activeCloudSession.user.id)
          .saveSnapshot(snapshot);
        setLists(snapshot.lists);
        setLastSyncedAt(snapshot.syncedAt);
        setServerVersion(result.serverVersion);
        writeLastKnownServerVersion(result.serverVersion);
        setStatus("ready");
        setMessage(
          "Rendered local snapshot first, then refreshed this place view from the server.",
        );
        setDebugLines((current) =>
          dedupeLines([
            ...current,
            `background-refresh:server-version:${result.serverVersion ?? "none"}`,
            `background-refresh:server-lists:${snapshot.lists.length}`,
          ]),
        );
      } catch (error) {
        setStatus("error");
        setMessage(
          "Showing saved data. Could not refresh your lists. Check your connection and retry.",
        );
        setDebugLines((current) =>
          dedupeLines([
            ...current,
            `background-refresh-error:${error instanceof Error ? error.message : "Server refresh failed."}`,
          ]),
        );
      }
    },
    [],
  );

  async function openListInPwa(listId: string, itemId: string) {
    const url = buildPwaListUrl(listId, itemId);
    if (!url) {
      return;
    }

    await chrome.tabs.create({
      url,
      active: true,
    });
  }

  async function openStoredListInPwa(listId: string) {
    const url = buildPwaListUrl(listId);
    if (!url) {
      return;
    }

    await chrome.tabs.create({
      url,
      active: true,
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
        localNote,
      });
      if ((await readStoredCloudSession())?.token !== cloudSession.token)
        return;
      const snapshot = sanitizeSnapshot(result.snapshot, cloudSession);
      await repository.saveSnapshot(snapshot);
      setLists(snapshot.lists);
      setLastSyncedAt(snapshot.syncedAt);
      setServerVersion(result.serverVersion);
      writeLastKnownServerVersion(result.serverVersion);
      setStatus("ready");
      if (localValues.current[membershipKey] === localNote)
        dirtyLocal.current.delete(membershipKey);
      setMessage("Note saved.");
      setDebugLines((current) =>
        dedupeLines([...current, `local-note-saved:${listId}:${itemId}`]),
      );
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error ? error.message : "Local note save failed.",
      );
      setDebugLines((current) =>
        dedupeLines([
          ...current,
          `local-note-save-error:${error instanceof Error ? error.message : "Local note save failed."}`,
        ]),
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function savePlaceKakaoNote(listId: string, itemId: string) {
    if (!cloudSync || !cloudSession) {
      setStatus("error");
      setMessage("Sign in before saving Kakao notes.");
      return;
    }

    if (isBusy) {
      return;
    }

    const match = placeMemberships.find(
      (membership) =>
        membership.list.id === listId && membership.item.id === itemId,
    );
    if (!match) {
      setStatus("error");
      setMessage("The selected saved place is no longer available locally.");
      return;
    }

    const membershipKey = getMembershipKey(listId, itemId);
    const kakaoNote = kakaoNoteDrafts[membershipKey] ?? "";
    const folderId =
      match.item.kakaoFolderId ?? extractFolderIdFromListId(listId);
    if (folderId === null) {
      setStatus("error");
      setMessage(
        "The saved list id could not be mapped back to a Kakao folder.",
      );
      return;
    }
    setBusyAction(`save-kakao-note:${membershipKey}`);
    setStatus("syncing");
    setMessage("Saving the Kakao note to Kakao Maps...");
    setKakaoNoteErrors((current) => {
      if (!current[membershipKey]) {
        return current;
      }

      const { [membershipKey]: _cleared, ...rest } = current;
      return rest;
    });

    try {
      if (!(await confirmImportAccount(cloudSession, [match.list])))
        throw new Error(
          "Save cancelled. Check your Kakao accounts and try again.",
        );
      const liveFavorite = await resolveKakaoFavoriteForPlace({
        folderId,
        placeKey: match.item.placeKey,
        display1: match.item.title,
        fallbackSeq: match.item.id,
      });
      setLastResolvedKakaoFavorite(liveFavorite);
      await requireCurrentCloudSession(cloudSession);

      const kakaoResult = await updateKakaoFavoriteNote({
        folderId: liveFavorite.folderId ?? folderId,
        seq: liveFavorite.seq,
        placeKey: liveFavorite.key ?? match.item.placeKey,
        display1: liveFavorite.display1,
        display2: liveFavorite.display2,
        color: liveFavorite.color,
        memo: kakaoNote,
      });

      setDebugLines((current) =>
        dedupeLines([...current, ...kakaoResult.debug]),
      );

      const updatedLists = lists.map((list) => {
        if (list.id !== listId) {
          return list;
        }

        return {
          ...list,
          updatedAt: new Date().toISOString(),
          items: list.items.map((item) =>
            item.id === itemId
              ? {
                  ...item,
                  kakaoNote: kakaoResult.memo.trim() || undefined,
                }
              : item,
          ),
        };
      });

      const updatedSnapshot = sanitizeSnapshot(
        {
          syncedAt: new Date().toISOString(),
          source: "extension-kakao-note-edit",
          lists: updatedLists,
        },
        cloudSession,
      );

      await requireCurrentCloudSession(cloudSession);
      await repository.saveSnapshot(updatedSnapshot);
      if ((await readStoredCloudSession())?.token !== cloudSession.token)
        return;
      setLists(updatedSnapshot.lists);
      setLastSyncedAt(updatedSnapshot.syncedAt);
      if (kakaoValues.current[membershipKey] === kakaoNote)
        dirtyKakao.current.delete(membershipKey);
      setKakaoNoteDrafts((current) =>
        current[membershipKey] === kakaoNote
          ? { ...current, [membershipKey]: kakaoResult.memo }
          : current,
      );

      try {
        const updatedList = updatedSnapshot.lists.find(
          (list) => list.id === listId,
        );
        if (!updatedList) {
          throw new Error(
            "Updated list was not found after saving the Kakao note.",
          );
        }

        let result: PushSnapshotResult;
        try {
          await requireCurrentCloudSession(cloudSession);
          result = await cloudSync.pushSnapshotList({
            deviceId,
            list: updatedList,
            syncedAt: updatedSnapshot.syncedAt,
            source: updatedSnapshot.source,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (
            message.includes("Cannot PUT /api/snapshot/list") ||
            message.includes("404")
          ) {
            result = await cloudSync.pushSnapshot({
              deviceId,
              snapshot: updatedSnapshot,
            });
          } else {
            throw error;
          }
        }

        if ((await readStoredCloudSession())?.token !== cloudSession.token)
          return;
        const snapshot = sanitizeSnapshot(result.snapshot, cloudSession);
        await repository.saveSnapshot(snapshot);
        setLists(snapshot.lists);
        setLastSyncedAt(snapshot.syncedAt);
        setServerVersion(result.serverVersion);
        writeLastKnownServerVersion(result.serverVersion);
        setStatus("ready");
        setMessage("Kakao note saved on Kakao Maps and synced to the server.");
      } catch (error) {
        setStatus("error");
        setMessage(
          error instanceof Error
            ? `Kakao note saved locally and on Kakao Maps, but failed to sync to the server: ${error.message}`
            : "Kakao note saved locally and on Kakao Maps, but failed to sync to the server.",
        );
        setDebugLines((current) =>
          dedupeLines([
            ...current,
            `kakao-note-server-sync-error:${error instanceof Error ? error.message : "Server sync failed after Kakao note save."}`,
          ]),
        );
      }
    } catch (error) {
      const failure = toKakaoNoteFailure(error);
      setStatus("error");
      setMessage(failure.message);
      setKakaoNoteErrors((current) => ({
        ...current,
        [membershipKey]: failure,
      }));
      setDebugLines((current) =>
        dedupeLines([...current, `kakao-note-save-error:${failure.message}`]),
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
    repository.clear();
    clearLocalExtensionData();
    setLists([]);
    setLastSyncedAt(null);
    setServerVersion(null);
    setStatus("ready");
    setMessage(
      "All local extension snapshot data was cleared. Your server copy was not changed.",
    );
    setDebugLines(["local-data:cleared"]);
    setBusyAction(null);
  }

  function updateThemePreference(nextPreference: ThemePreference) {
    setThemePreference(nextPreference);
    writeThemePreference(nextPreference);
  }

  useEffect(() => {
    void hydrate();
    void hydrateActiveTab();
  }, [hydrate, hydrateActiveTab]);

  useEffect(() => {
    if (!cloudSession || !cloudSync) {
      return;
    }

    setStatus("ready");
    setMessage(
      "Session is active. Import from Kakao Maps only runs when you click the button.",
    );
  }, [cloudSession, cloudSync]);

  useEffect(() => {
    if (activeTab.kind !== "place" || !cloudSession || !cloudSync) {
      return;
    }

    void refreshPlaceViewFromServer(cloudSync, cloudSession);
  }, [activeTab.kind, cloudSession, cloudSync, refreshPlaceViewFromServer]);

  useEffect(() => {
    if (placeMemberships.length === 0) {
      return;
    }

    setLocalNoteDrafts((current) => {
      const next = { ...current };
      for (const membership of placeMemberships) {
        const key = getMembershipKey(membership.list.id, membership.item.id);
        if (!dirtyLocal.current.has(key))
          next[key] = membership.item.localNote ?? "";
      }
      return next;
    });
    setKakaoNoteDrafts((current) => {
      const next = { ...current };
      for (const membership of placeMemberships) {
        const key = getMembershipKey(membership.list.id, membership.item.id);
        if (!dirtyKakao.current.has(key))
          next[key] = membership.item.kakaoNote ?? "";
      }
      return next;
    });
  }, [placeMemberships]);

  function openSettings() {
    setView("settings");
  }

  function closeSettings() {
    setView("main");
  }

  async function clearSession() {
    if (isBusy) return;
    if (
      (dirtyLocal.current.size || dirtyKakao.current.size) &&
      !window.confirm("Discard unsaved notes and sign out?")
    )
      return;
    try {
      await clearCloudSessionInBackground();
    } catch (error) {
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not sign out. Try again.",
      );
      return;
    }
    repository.clear();
    setLocalNoteDrafts({});
    setKakaoNoteDrafts({});
    dirtyLocal.current.clear();
    dirtyKakao.current.clear();
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
              <button
                className="icon-button"
                aria-label="Back to main popup"
                disabled={isBusy}
                onClick={closeSettings}
                title="Back to main popup"
                type="button"
              >
                <span aria-hidden="true">←</span>
              </button>
            ) : null}
          </div>
          <div>
            <div className="badge" aria-hidden="true">
              &nbsp;
            </div>
          </div>
          <div className="popup-header-actions">
            {view === "settings" ? (
              <span className="header-spacer" aria-hidden="true" />
            ) : (
              <button
                className="icon-button"
                aria-label="Options"
                disabled={isBusy}
                onClick={openSettings}
                title="Options"
                type="button"
              >
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
              </div>
              <div className="options-panel-section">
                <div className="section-label">Developer</div>
                <button
                  aria-pressed={debugMode}
                  className={`button toggle-button${debugMode ? " is-active" : ""}`}
                  onClick={() => setDebugMode(!debugMode)}
                  type="button"
                >
                  {debugMode ? "Debug mode: on" : "Debug mode: off"}
                </button>
                <p className="small-copy">
                  Shows ownership and payload debug cards in the place view.
                </p>
              </div>
              <BuildDetails />
            </section>
            {debugMode ? (
              <section className="mini-panel options-debug-card">
                <div className="section-label">Debug</div>
                <ul className="options-list">
                  <li>
                    Register this exact Kakao redirect URI in Kakao Developers:
                    <code>{redirectUri || "Unavailable"}</code>
                  </li>
                  <li>
                    If the URI keeps changing after reinstalling the unpacked
                    extension, set
                    <code>EXTENSION_PUBLIC_KEY</code> before building so the
                    extension id stays fixed.
                  </li>
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <>
            <div className="actions actions-stacked">
              <button
                className="button primary"
                disabled={isBusy}
                onClick={signIn}
                type="button"
              >
                Sign in with Kakao
              </button>
              {mockAuthEnabled ? (
                <button
                  className="button"
                  disabled={isBusy}
                  onClick={signInWithMock}
                  type="button"
                >
                  Use Mock Sign In
                </button>
              ) : null}
            </div>

            {status === "error" ? (
              <section className="mini-panel">
                <h2>Sign-In Error</h2>
                <p aria-live="polite" role="status">
                  {message}
                </p>
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
            <button
              className="icon-button"
              aria-label="Back to main popup"
              disabled={isBusy}
              onClick={closeSettings}
              title="Back to main popup"
              type="button"
            >
              <span aria-hidden="true">←</span>
            </button>
          ) : activeTab.kind === "place" ? (
            <button
              className="icon-button"
              aria-label="Import from Kakao Maps"
              disabled={isBusy}
              onClick={() => void importFromKakaoMaps()}
              title="Import from Kakao Maps"
              type="button"
            >
              <span aria-hidden="true">↓</span>
            </button>
          ) : null}
        </div>
        <div>
          <div className="badge" aria-hidden="true">
            &nbsp;
          </div>
        </div>
        <div className="popup-header-actions">
          {view === "settings" ? (
            <span className="header-spacer" aria-hidden="true" />
          ) : (
            <button
              className="icon-button"
              aria-label="Options"
              disabled={isBusy}
              onClick={openSettings}
              title="Options"
              type="button"
            >
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
            </section>

            <section className="options-panel-section">
              <div className="section-label">Developer</div>
              <button
                aria-pressed={debugMode}
                className={`button toggle-button${debugMode ? " is-active" : ""}`}
                onClick={() => setDebugMode(!debugMode)}
                type="button"
              >
                {debugMode ? "Debug mode: on" : "Debug mode: off"}
              </button>
              <p className="small-copy">
                Shows ownership and payload debug cards in the place view.
              </p>
            </section>

            <div className="actions actions-stacked">
              <button
                className="button primary"
                disabled={isBusy}
                onClick={() => void pullFromServer()}
                type="button"
              >
                Pull Server Data
              </button>
              <button
                className="button danger"
                disabled={isBusy}
                onClick={() => void clearLocalData()}
                type="button"
              >
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
            <BuildDetails />
          </section>
          <section className="mini-panel options-signout-card">
            <div className="section-label">Account</div>
            <div className="actions actions-stacked settings-actions">
              <button
                className="button danger"
                disabled={isBusy}
                onClick={() => void clearSession()}
                type="button"
              >
                Sign Out
              </button>
            </div>
          </section>
          {debugMode ? (
            <section className="mini-panel options-debug-card">
              <div className="section-label">Debug</div>
              <ul className="options-list">
                <li>
                  The extension popup signs in through
                  `chrome.identity.launchWebAuthFlow`.
                </li>
                <li>
                  Register this exact Kakao redirect URI in Kakao Developers:
                  <code>{redirectUri}</code>
                </li>
                <li>
                  If the URI keeps changing after reinstalling the unpacked
                  extension, set
                  <code>EXTENSION_PUBLIC_KEY</code> before building so the
                  extension id stays fixed.
                </li>
                <li>
                  Clearing local data removes the extension cache and local
                  device id only. It does not delete the server snapshot.
                </li>
              </ul>
            </section>
          ) : null}
        </>
      ) : activeTab.kind === "place" ? (
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
          <p aria-live="polite" className="small-copy" role="status">
            {message}
          </p>
          {placeMemberships.length === 0 ? (
            <p>
              That place is not present in the currently stored snapshot. Pull
              the server copy or import again.
            </p>
          ) : (
            <ul className="match-list">
              {placeMemberships.map(({ list, item }) => (
                <li className="match-card" key={`${list.id}:${item.id}`}>
                  {(() => {
                    const canEditKakao = Boolean(cloudSession);
                    const kakaoNoteError =
                      kakaoNoteErrors[getMembershipKey(list.id, item.id)];

                    return (
                      <>
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
                        <div className="note-block">
                          <label
                            className="note-label"
                            htmlFor={`kakao-note-${list.id}-${item.id}`}
                          >
                            Kakao note
                          </label>
                          <div className="editable-kakao-note-row">
                            <input
                              className="note-input"
                              disabled={!canEditKakao || isBusy}
                              id={`kakao-note-${list.id}-${item.id}`}
                              maxLength={KAKAO_NOTE_MAX_LENGTH}
                              type="text"
                              value={
                                kakaoNoteDrafts[
                                  getMembershipKey(list.id, item.id)
                                ] ?? ""
                              }
                              onChange={(event) => {
                                const key = getMembershipKey(list.id, item.id);
                                const value = event.target.value;
                                dirtyKakao.current.add(key);
                                kakaoValues.current[key] = value;
                                setKakaoNoteDrafts((current) => ({
                                  ...current,
                                  [key]: value,
                                }));
                              }}
                              placeholder={
                                canEditKakao
                                  ? `Add or edit the Kakao note (${KAKAO_NOTE_MAX_LENGTH} max)`
                                  : "Only the list creator can edit the Kakao note"
                              }
                            />
                            <button
                              aria-label="Save Kakao note"
                              className="icon-button match-action-icon"
                              disabled={!canEditKakao || isBusy}
                              onClick={() =>
                                void savePlaceKakaoNote(list.id, item.id)
                              }
                              title="Save Kakao note"
                              type="button"
                            >
                              <span aria-hidden="true">✎</span>
                            </button>
                            <button
                              aria-label="Copy Kakao note"
                              className="copy-note-button"
                              disabled={
                                (
                                  kakaoNoteDrafts[
                                    getMembershipKey(list.id, item.id)
                                  ] ?? ""
                                ).length === 0
                              }
                              onClick={() =>
                                void copyKakaoNote(
                                  kakaoNoteDrafts[
                                    getMembershipKey(list.id, item.id)
                                  ] ?? "",
                                )
                              }
                              title="Copy Kakao note"
                              type="button"
                            >
                              <CopyIcon />
                            </button>
                          </div>
                          {!canEditKakao ? (
                            <p className="small-copy note-help">
                              Only the creator of this saved list can edit the
                              Kakao note.
                            </p>
                          ) : null}
                          {kakaoNoteError ? (
                            <div className="note-error" role="alert">
                              <strong>Kakao Maps rejected this save</strong>
                              <p>{kakaoNoteError.message}</p>
                              {kakaoNoteError.kakaoCode ||
                              kakaoNoteError.httpStatus ? (
                                <p className="small-copy">
                                  {[
                                    kakaoNoteError.kakaoCode
                                      ? `code ${kakaoNoteError.kakaoCode}`
                                      : null,
                                    kakaoNoteError.httpStatus
                                      ? `HTTP ${kakaoNoteError.httpStatus}`
                                      : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              ) : null}
                              {debugMode && kakaoNoteError.responsePreview ? (
                                <pre className="note-debug-json">
                                  <code>{kakaoNoteError.responsePreview}</code>
                                </pre>
                              ) : null}
                            </div>
                          ) : null}
                          {debugMode ? (
                            <div className="note-debug">
                              <div className="ownership-debug-card">
                                <div className="section-label">
                                  Ownership debug
                                </div>
                                <ul className="compact-list meta">
                                  <li>
                                    <strong>List owner id (Maps)</strong>
                                    <span>{list.ownerId ?? "Unknown"}</span>
                                  </li>
                                  <li>
                                    <strong>Imported by (account)</strong>
                                    <span>
                                      {list.importedByUserId ?? "Unknown"}
                                    </span>
                                  </li>
                                  <li>
                                    <strong>Logged user id (account)</strong>
                                    <span>
                                      {cloudSession?.user.id ?? "Signed out"}
                                    </span>
                                  </li>
                                  <li>
                                    <strong>Maps ownership</strong>
                                    <span>Not verified</span>
                                  </li>
                                  <li>
                                    <strong>Can edit</strong>
                                    <span>{String(canEditKakao)}</span>
                                  </li>
                                </ul>
                              </div>
                              <code>{`creator=${list.creatorName ?? "none"}`}</code>
                              <code>{`list.ownerId=${list.ownerId ?? "none"}`}</code>
                              <code>{`list.importedByUserId=${list.importedByUserId ?? "none"}`}</code>
                              <code>{`user.id=${cloudSession?.user.id ?? "none"}`}</code>
                              <code>{`user.nickname=${cloudSession?.user.nickname ?? "none"}`}</code>
                              <code>{`item.seq=${item.id}`}</code>
                              <code>{`item.placeKey=${item.placeKey ?? "none"}`}</code>
                              <code>{`item.kakaoFolderId=${item.kakaoFolderId ?? "none"}`}</code>
                              <code>mapsOwnership=unverified</code>
                              <code>{`canEdit=${String(canEditKakao)}`}</code>
                              <pre className="note-debug-json">
                                <code>
                                  {JSON.stringify(activeTab, null, 2)}
                                </code>
                              </pre>
                              <pre className="note-debug-json">
                                <code>{JSON.stringify(list, null, 2)}</code>
                              </pre>
                              <pre className="note-debug-json">
                                <code>{JSON.stringify(item, null, 2)}</code>
                              </pre>
                              <pre className="note-debug-json">
                                <code>
                                  {JSON.stringify(
                                    lastResolvedKakaoFavorite,
                                    null,
                                    2,
                                  )}
                                </code>
                              </pre>
                            </div>
                          ) : null}
                        </div>
                        <div className="note-block">
                          <label
                            className="note-label"
                            htmlFor={`local-note-${list.id}-${item.id}`}
                          >
                            Local note
                          </label>
                          <input
                            className="note-input"
                            id={`local-note-${list.id}-${item.id}`}
                            maxLength={500}
                            type="text"
                            value={
                              localNoteDrafts[
                                getMembershipKey(list.id, item.id)
                              ] ?? ""
                            }
                            onChange={(event) => {
                              const key = getMembershipKey(list.id, item.id);
                              const value = event.target.value;
                              dirtyLocal.current.add(key);
                              localValues.current[key] = value;
                              setLocalNoteDrafts((current) => ({
                                ...current,
                                [key]: value,
                              }));
                            }}
                            placeholder="Add your own note"
                          />
                        </div>
                        <div className="match-actions">
                          <button
                            aria-label="Save local note"
                            className="icon-button match-action-icon"
                            disabled={isBusy}
                            onClick={() =>
                              void savePlaceLocalNote(list.id, item.id)
                            }
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
                      </>
                    );
                  })()}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          <div className="actions">
            <button
              className="button primary"
              disabled={isBusy}
              onClick={() => void importFromKakaoMaps()}
              type="button"
            >
              Import from Kakao Maps
            </button>
          </div>
          <p className="copy">
            The extension is the only place that creates fresh snapshots from
            Kakao Maps. Imports only run when you click the button.
          </p>

          <section className="mini-panel">
            <h2>Stored Lists</h2>
            {lists.length === 0 ? (
              <p>
                No saved lists stored yet. Open Kakao Maps in a signed-in tab,
                then import again.
              </p>
            ) : (
              <ul className="compact-list stored-list">
                {lists.map((list) => (
                  <li key={list.id}>
                    <div className="stored-list-copy">
                      <strong>{list.name}</strong>
                      <span>
                        {formatCountLabel(list.itemCount, "item", "items")}
                      </span>
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
  return cloudSync.pullLatestSnapshot();
}

async function confirmImportAccount(
  session: CloudSession,
  lists: FavoriteList[],
): Promise<boolean> {
  const owners = [
    ...new Set(lists.map((list) => list.ownerId).filter(Boolean)),
  ];
  const ownerDescription =
    owners.length === 1
      ? `Maps profile ${owners[0]}`
      : "the account currently open in Kakao Maps";
  // Kakao's app-scoped Login id cannot be compared to a Maps profile id.
  // Confirmation is deliberately per import, never silently remembered as proof.
  return window.confirm(
    `Check your accounts before importing. Kakao Maps identity cannot be automatically verified against Kakao Lists. You are about to upload lists from ${ownerDescription} to Kakao Lists account ${session.user.nickname ?? session.user.id}. Confirm both are your intended account. If not, cancel and sign in again.`,
  );
}

async function resolveActiveTabContext(
  tab: chrome.tabs.Tab,
): Promise<ActiveTabContext> {
  const url = tab.url ?? "";
  const placeKey = extractPlaceKeyFromUrl(url);

  if (placeKey) {
    // A place page carries no folder, so fall back to the Kakao Maps tab the
    // list is open in.
    const openFolderId =
      extractFolderIdFromUrl(url) ??
      (await readOpenFavoriteFolderIdFromKakaoMapsTabs()) ??
      undefined;

    return {
      kind: "place",
      tabId: tab.id ?? null,
      title: tab.title ?? undefined,
      url,
      placeKey,
      source: "url",
      openFolderId,
    };
  }

  if (tab.id && isKakaoMapsPageUrl(url)) {
    const modalPlace = await readOpenPlaceModalContext(tab.id);
    if (modalPlace?.placeKey) {
      const openFolderId =
        (await readOpenFavoriteFolderId(tab.id)) ??
        extractFolderIdFromUrl(url) ??
        undefined;

      return {
        kind: "place",
        tabId: tab.id,
        title: modalPlace.title ?? tab.title ?? undefined,
        url: modalPlace.href ?? url,
        placeKey: modalPlace.placeKey,
        source: "modal",
        openFolderId,
      };
    }
  }

  return {
    kind: "default",
    tabId: tab.id ?? null,
    title: tab.title ?? undefined,
    url,
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

function isMembershipInFolder(
  membership: { list: FavoriteList; item: FavoriteListItem },
  folderId: number,
) {
  return (
    membership.item.kakaoFolderId === folderId ||
    extractFolderIdFromListId(membership.list.id) === folderId
  );
}

function extractFolderIdFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    return (
      parseFolderId(parsed.search) ??
      parseFolderId(parsed.hash) ??
      parseFolderId(parsed.pathname)
    );
  } catch {
    return null;
  }
}

function parseFolderId(value: string): number | null {
  const match = /folder[_-]?id=(\d+)/i.exec(value);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function readOpenFavoriteFolderIdFromKakaoMapsTabs(): Promise<
  number | null
> {
  try {
    const tabs = await chrome.tabs.query({ url: "https://map.kakao.com/*" });
    for (const tab of tabs) {
      const fromUrl = extractFolderIdFromUrl(tab.url ?? "");
      if (fromUrl) {
        return fromUrl;
      }

      if (tab.id) {
        const fromPage = await readOpenFavoriteFolderId(tab.id);
        if (fromPage) {
          return fromPage;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function readOpenFavoriteFolderId(tabId: number): Promise<number | null> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: findOpenFavoriteFolderInPage,
    });

    return typeof result === "number" && Number.isFinite(result) && result > 0
      ? result
      : null;
  } catch {
    return null;
  }
}

function findOpenFavoriteFolderInPage(): number | null {
  const readFolderId = (value?: string | null) => {
    if (!value) {
      return null;
    }

    const match = /folder[_-]?id=(\d+)/i.exec(value);
    const raw = match ? match[1] : value.trim();
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  };

  const isVisible = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  const fromLocation =
    readFolderId(window.location.search) ?? readFolderId(window.location.hash);
  if (fromLocation) {
    return fromLocation;
  }

  // Kakao marks the folder currently being viewed as the selected entry.
  const selectedSelectors = [
    "[data-folderid].on",
    "[data-folderid].active",
    "[data-folderid].selected",
    "[data-folderid][aria-selected='true']",
    ".on [data-folderid]",
  ];

  for (const selector of selectedSelectors) {
    const element = document.querySelector(selector);
    if (!isVisible(element)) {
      continue;
    }

    const folderId =
      readFolderId(element.getAttribute("data-folderid")) ??
      readFolderId(element.getAttribute("href"));
    if (folderId) {
      return folderId;
    }
  }

  const folderNodes = Array.from(
    document.querySelectorAll("[data-folderid], a[href*='folderid=']"),
  ).filter(isVisible);

  const uniqueIds = new Set<number>();
  for (const node of folderNodes) {
    const folderId =
      readFolderId(node.getAttribute("data-folderid")) ??
      readFolderId(node.getAttribute("href"));
    if (folderId) {
      uniqueIds.add(folderId);
    }
  }

  // Only trust this fallback when the page shows exactly one folder, which is
  // what an opened list looks like.
  return uniqueIds.size === 1 ? [...uniqueIds][0] : null;
}

function extractFolderIdFromListId(listId: string): number | null {
  const prefix = "kakao-folder-";
  if (!listId.startsWith(prefix)) {
    return null;
  }

  const value = Number(listId.slice(prefix.length));
  return Number.isFinite(value) ? value : null;
}

function isKakaoMapsPageUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "map.kakao.com";
  } catch {
    return false;
  }
}

async function readOpenPlaceModalContext(
  tabId: number,
): Promise<OpenPlaceModalContext | null> {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: findOpenPlaceModalInPage,
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
      title: candidate.title,
    };
  } catch {
    return null;
  }
}

function findOpenPlaceModalInPage(): OpenPlaceModalContext | null {
  const selectors = [
    '#view\\.mapContainer div.head_tooltip > strong > a.name[href*="place.map.kakao.com/"]',
    '#view\\.mapContainer div.head_tooltip a.name[href*="place.map.kakao.com/"]',
    '#view\\.mapContainer a.name[data-id="name"][href*="place.map.kakao.com/"]',
  ];

  const isVisible = (element: Element | null): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  };

  for (const selector of selectors) {
    const anchor = document.querySelector<HTMLAnchorElement>(selector);
    if (!anchor || !isVisible(anchor)) {
      continue;
    }

    return {
      href: anchor.href,
      title: anchor.textContent?.trim() || anchor.title?.trim() || undefined,
    };
  }

  const fallbackAnchors = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      '#view\\.mapContainer a[href*="place.map.kakao.com/"]',
    ),
  );

  for (const anchor of fallbackAnchors) {
    if (!isVisible(anchor)) {
      continue;
    }

    return {
      href: anchor.href,
      title: anchor.textContent?.trim() || anchor.title?.trim() || undefined,
    };
  }

  return null;
}

function dedupeLines(lines: string[]) {
  return Array.from(new Set(lines));
}

function getMembershipKey(listId: string, itemId: string) {
  return noteKey(listId, itemId);
}

function buildPwaListUrl(listId: string, itemId?: string) {
  try {
    const base = new URL(pwaBaseUrl);
    const params = new URLSearchParams();
    if (itemId) {
      params.set("item", itemId);
    }
    const query = params.toString();
    base.hash = query
      ? `list/${encodeURIComponent(listId)}?${query}`
      : `list/${encodeURIComponent(listId)}`;
    return base.toString();
  } catch {
    return "";
  }
}

function sanitizeSnapshot(
  snapshot: {
    syncedAt: string;
    source: string;
    lists: FavoriteList[];
  },
  _cloudSession?: CloudSession | null,
) {
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

function clearLocalExtensionData() {
  browserStorage().removeItem("kakao-lists:extension");
  browserStorage().removeItem("kakao-lists:extension-device-id");
  browserStorage().removeItem("kakao-lists:extension-server-version");
}

function writeLastKnownServerVersion(serverVersion: number | null) {
  if (serverVersion === null) {
    browserStorage().removeItem("kakao-lists:extension-server-version");
    return;
  }

  browserStorage().setItem(
    "kakao-lists:extension-server-version",
    String(serverVersion),
  );
}

function getOrCreateDeviceId() {
  const existing = browserStorage().getItem("kakao-lists:extension-device-id");
  if (existing) {
    return existing;
  }

  const next = `extension-${Math.random().toString(36).slice(2, 10)}`;
  try {
    browserStorage().setItem("kakao-lists:extension-device-id", next);
  } catch {
    /* Ephemeral id is sufficient. */
  }
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
    timeStyle: "short",
  }).format(date);
}

function formatCountLabel(count: number, singular: string, plural: string) {
  const formattedCount = new Intl.NumberFormat(getUserLocale()).format(count);
  return `${formattedCount} ${count === 1 ? singular : plural}`;
}

interface KakaoNoteFailure {
  message: string;
  kakaoCode?: string;
  httpStatus?: number;
  responsePreview?: string;
}

function toKakaoNoteFailure(error: unknown): KakaoNoteFailure {
  if (error instanceof KakaoNoteUpdateError) {
    return {
      message: error.message,
      kakaoCode: error.kakaoCode,
      httpStatus: error.httpStatus,
      responsePreview: error.responsePreview,
    };
  }

  return {
    message: error instanceof Error ? error.message : "Kakao note save failed.",
  };
}

function getUserLocale() {
  return navigator.language || "en-US";
}

function CopyIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <rect
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.7"
        width="11"
        x="9"
        y="8"
      />
      <path
        d="M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}
