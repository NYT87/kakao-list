import type { CloudSession } from "@kakao-lists/domain";
import { isCloudSession } from "@kakao-lists/domain";

const CLOUD_SESSION_KEY = "kakao-lists:extension-cloud-session";

export async function readStoredCloudSession(): Promise<CloudSession | null> {
  let raw: unknown;
  try {
    raw = await readChromeStorageValue(CLOUD_SESSION_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== "string" || !raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CloudSession;
    if (!isCloudSession(parsed)) {
      await clearStoredCloudSession();
      return null;
    }

    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      await clearStoredCloudSession();
      return null;
    }

    return parsed;
  } catch {
    await clearStoredCloudSession();
    return null;
  }
}

export async function writeStoredCloudSession(
  session: CloudSession,
): Promise<void> {
  await chrome.storage.local.set({
    [CLOUD_SESSION_KEY]: JSON.stringify(session),
  });
}

export async function clearStoredCloudSession(): Promise<void> {
  await chrome.storage.local.remove(CLOUD_SESSION_KEY);
}

export async function requireCurrentCloudSession(session: CloudSession) {
  if ((await readStoredCloudSession())?.token !== session.token)
    throw new Error(
      "The signed-in account changed during this action. Sign in to the intended account and try again.",
    );
}

async function readChromeStorageValue(key: string): Promise<unknown> {
  const result = await chrome.storage.local.get(key);
  return result[key];
}
