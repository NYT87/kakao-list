const UPDATE_EVENT = "kakao-lists:pwa-update";
type UpdateEventDetail = { available: boolean; offlineReady: boolean };
let activeRegistration: ServiceWorkerRegistration | null = null;
let state: UpdateEventDetail = { available: false, offlineReady: false };
function emit(change: Partial<UpdateEventDetail>) {
  state = { ...state, ...change };
  window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: state }));
}

export function registerPwaUpdateLifecycle() {
  if (!("serviceWorker" in navigator)) return;
  let requested = false;
  let refreshing = false;
  window.addEventListener("kakao-lists:apply-update", () => {
    requested = true;
  });
  // Register immediately: waiting on window.load can delay offline readiness
  // indefinitely when an optional third-party font request is slow.
  void navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      activeRegistration = registration;
      if (registration.waiting) emit({ available: true });
      const observe = (worker: ServiceWorker | null) => {
        worker?.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            emit({ available: true });
        });
      };
      observe(registration.installing);
      registration.addEventListener("updatefound", () =>
        observe(registration.installing),
      );
      void registration.update().catch(() => {});
    })
    .catch(() => {
      emit({ offlineReady: false });
    });
  void navigator.serviceWorker.ready.then(() => emit({ offlineReady: true }));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // First activation claims the page; only an explicit update should reload it.
    if (!requested || refreshing) return;
    refreshing = true;
    window.location.reload();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible")
      void activeRegistration?.update().catch(() => {});
  });
}

export function requestPwaUpdate() {
  const worker = activeRegistration?.waiting;
  if (!worker) return false;
  window.dispatchEvent(new Event("kakao-lists:apply-update"));
  worker.postMessage({ type: "SKIP_WAITING" });
  emit({ available: false });
  return true;
}

export function subscribeToPwaUpdateAvailability(
  listener: (detail: UpdateEventDetail) => void,
) {
  const handler = (event: Event) =>
    listener((event as CustomEvent<UpdateEventDetail>).detail);
  window.addEventListener(UPDATE_EVENT, handler);
  listener(state);
  return () => window.removeEventListener(UPDATE_EVENT, handler);
}
