import { buildKakaoAuthorizeUrl } from "@kakao-lists/kakao";
import { HttpCloudSyncClient } from "@kakao-lists/sync";
import type { AuthBridgeRequest, AuthBridgeResponse } from "./authBridge";
import {
  clearStoredCloudSession,
  writeStoredCloudSession,
} from "./cloudSession";

const syncServerUrl = import.meta.env.VITE_SYNC_SERVER_URL ?? "";
const kakaoClientId = import.meta.env.VITE_KAKAO_REST_API_KEY ?? "";
const kakaoScope = import.meta.env.VITE_KAKAO_SCOPE?.trim() ?? "";

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("kakao-lists-sync", { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "kakao-lists-sync") {
    console.info("Scheduled sync placeholder fired.");
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: AuthBridgeRequest,
    _sender,
    sendResponse: (response: AuthBridgeResponse) => void,
  ) => {
    void handleAuthBridgeMessage(message)
      .then((response) => sendResponse(response))
      .catch((error) =>
        sendResponse({
          ok: false,
          error:
            error instanceof Error ? error.message : "Extension auth failed.",
        }),
      );

    return true;
  },
);

async function handleAuthBridgeMessage(
  message: AuthBridgeRequest,
): Promise<AuthBridgeResponse> {
  switch (message.type) {
    case "auth:begin-kakao-sign-in":
      return { ok: true, session: await signInWithKakao() };
    case "auth:begin-mock-sign-in":
      return { ok: true, session: await signInWithMock() };
    case "auth:clear-cloud-session":
      await clearStoredCloudSession();
      return { ok: true };
  }
}

async function signInWithKakao() {
  if (!syncServerUrl) {
    throw new Error("Set VITE_SYNC_SERVER_URL to enable sign-in.");
  }

  if (!kakaoClientId) {
    throw new Error("Set VITE_KAKAO_REST_API_KEY to enable Kakao sign-in.");
  }

  const redirectUri = chrome.identity.getRedirectURL("kakao");
  if (!redirectUri) {
    throw new Error(
      "Chrome identity is unavailable, so the extension redirect URI could not be resolved.",
    );
  }

  const authUrl = buildKakaoAuthorizeUrl({
    clientId: kakaoClientId,
    redirectUri,
    scope: kakaoScope,
    state: "kakao-lists-extension",
  });

  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    interactive: true,
    url: authUrl,
  });

  if (!callbackUrl) {
    throw new Error("Kakao sign-in did not return a callback URL.");
  }

  const code = new URL(callbackUrl).searchParams.get("code");
  if (!code) {
    throw new Error(
      "No Kakao authorization code was returned to the extension.",
    );
  }

  const cloudSync = new HttpCloudSyncClient(syncServerUrl);
  const session = await cloudSync.exchangeKakaoCode({
    code,
    redirectUri,
  });
  await writeStoredCloudSession(session);
  return session;
}

async function signInWithMock() {
  if (!syncServerUrl) {
    throw new Error("Set VITE_SYNC_SERVER_URL to enable mock sign-in.");
  }

  const cloudSync = new HttpCloudSyncClient(syncServerUrl);
  const session = await cloudSync.createMockSession();
  await writeStoredCloudSession(session);
  return session;
}
