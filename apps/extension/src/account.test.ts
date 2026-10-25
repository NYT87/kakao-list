import assert from "node:assert/strict";
import { it } from "node:test";
import { isCloudSession } from "@kakao-lists/domain";
import {
  requireCurrentCloudSession,
  writeStoredCloudSession,
} from "./cloudSession";

it("rejects corrupt and expired persisted extension sessions", () => {
  for (const expiresAt of ["broken", new Date(0).toISOString()])
    assert.equal(
      isCloudSession({ token: "token", user: { id: "a" }, expiresAt }),
      false,
    );
});

it("stops an in-flight extension action when the signed-in account changes", async () => {
  const oldChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  const values: Record<string, string> = {};
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: values[key] }),
          set: async (items: Record<string, string>) =>
            Object.assign(values, items),
          remove: async (key: string) => {
            delete values[key];
          },
        },
      },
    },
  });
  try {
    const first = {
      token: "first-session",
      user: { id: "first" },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const second = {
      ...first,
      token: "second-session",
      user: { id: "second" },
    };
    await writeStoredCloudSession(first);
    await requireCurrentCloudSession(first);
    await writeStoredCloudSession(second);
    await assert.rejects(requireCurrentCloudSession(first), /account changed/);
  } finally {
    if (oldChrome) Object.defineProperty(globalThis, "chrome", oldChrome);
    else Reflect.deleteProperty(globalThis, "chrome");
  }
});
