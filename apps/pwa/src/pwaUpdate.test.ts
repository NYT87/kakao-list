import assert from "node:assert/strict";
import { it } from "node:test";

it("prepares offline use and reloads only after an explicitly accepted update", async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const oldCustomEvent = Object.getOwnPropertyDescriptor(
    globalThis,
    "CustomEvent",
  );
  const events = new EventTarget();
  let reloads = 0;
  const waiting = { postMessage: (message: unknown) => messages.push(message) };
  const messages: unknown[] = [];
  const registration = new EventTarget() as EventTarget & {
    waiting: typeof waiting | null;
    installing: EventTarget | null;
    update: () => Promise<void>;
  };
  registration.waiting = null;
  registration.installing = null;
  registration.update = async () => {};
  const serviceWorker = new EventTarget() as EventTarget & {
    controller: object | null;
    register: () => Promise<typeof registration>;
    ready: Promise<typeof registration>;
  };
  serviceWorker.controller = {};
  serviceWorker.register = async () => registration;
  serviceWorker.ready = Promise.resolve(registration);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: Object.assign(events, { location: { reload: () => reloads++ } }),
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { serviceWorker },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: Object.assign(new EventTarget(), { visibilityState: "visible" }),
  });
  Object.defineProperty(globalThis, "CustomEvent", {
    configurable: true,
    value: class<T> extends Event {
      detail: T;
      constructor(type: string, init: { detail: T }) {
        super(type);
        this.detail = init.detail;
      }
    },
  });
  try {
    const updates = await import("./pwaUpdate");
    const states: Array<{ available: boolean; offlineReady: boolean }> = [];
    updates.subscribeToPwaUpdateAvailability((state) => states.push(state));
    updates.registerPwaUpdateLifecycle();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(states.at(-1)?.offlineReady, true);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(reloads, 0, "first service worker claim should not reload");
    registration.waiting = waiting;
    registration.dispatchEvent(new Event("updatefound"));
    assert.equal(updates.requestPwaUpdate(), true);
    assert.deepEqual(messages, [{ type: "SKIP_WAITING" }]);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(reloads, 1);
  } finally {
    for (const [key, descriptor] of [
      ["window", oldWindow],
      ["navigator", oldNavigator],
      ["document", oldDocument],
      ["CustomEvent", oldCustomEvent],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
