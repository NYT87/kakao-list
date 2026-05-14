const UPDATE_EVENT = "kakao-lists:pwa-update";

type UpdateEventDetail = {
  available: boolean;
};

let activeRegistration: ServiceWorkerRegistration | null = null;

export function registerPwaUpdateLifecycle() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  let refreshing = false;

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((registration) => {
      activeRegistration = registration;

      if (registration.waiting) {
        emitUpdateAvailability(true);
      }

      registration.addEventListener("updatefound", () => {
        const nextWorker = registration.installing;
        if (!nextWorker) {
          return;
        }

        nextWorker.addEventListener("statechange", () => {
          if (nextWorker.state === "installed" && navigator.serviceWorker.controller) {
            emitUpdateAvailability(true);
          }
        });
      });

      void registration.update().catch(() => {
        // Ignore update polling errors in the scaffold stage.
      });
    }).catch(() => {
      // Ignore registration errors in the scaffold stage.
    });
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) {
      return;
    }

    refreshing = true;
    window.location.reload();
  });
}

export function requestPwaUpdate() {
  const waitingWorker = activeRegistration?.waiting;
  if (!waitingWorker) {
    return false;
  }

  waitingWorker.postMessage({
    type: "SKIP_WAITING"
  });
  emitUpdateAvailability(false);
  return true;
}

export function subscribeToPwaUpdateAvailability(
  listener: (detail: UpdateEventDetail) => void
) {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<UpdateEventDetail>;
    listener(customEvent.detail);
  };

  window.addEventListener(UPDATE_EVENT, handler as EventListener);
  return () => {
    window.removeEventListener(UPDATE_EVENT, handler as EventListener);
  };
}

function emitUpdateAvailability(available: boolean) {
  window.dispatchEvent(
    new CustomEvent<UpdateEventDetail>(UPDATE_EVENT, {
      detail: {
        available
      }
    })
  );
}
