import type { CloudSession } from "@kakao-lists/domain";

const CLOUD_SESSION_KEY = "kakao-lists:extension-cloud-session";

export async function readStoredCloudSession(): Promise<CloudSession | null> {
  const raw = await readChromeStorageValue(CLOUD_SESSION_KEY);
  if (typeof raw !== "string" || !raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as CloudSession;
    if (!isValidCloudSession(parsed)) {
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

function isValidCloudSession(
  value: CloudSession | null | undefined,
): value is CloudSession {
  return Boolean(value?.token && value?.expiresAt && value?.user?.id);
}

async function readChromeStorageValue(key: string): Promise<unknown> {
  const result = await chrome.storage.local.get(key);
  return result[key];
}
