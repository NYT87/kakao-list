import type { CloudSession } from "@kakao-lists/domain";

export type AuthBridgeRequest =
  | { type: "auth:begin-kakao-sign-in" }
  | { type: "auth:begin-mock-sign-in" }
  | { type: "auth:clear-cloud-session" };

export type AuthBridgeResponse =
  | { ok: true; session?: CloudSession | null }
  | { ok: false; error: string };

export async function beginKakaoSignIn(): Promise<CloudSession> {
  const response = await sendAuthBridgeMessage({
    type: "auth:begin-kakao-sign-in",
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  if (!response.session) {
    throw new Error("Kakao sign-in completed without a stored cloud session.");
  }

  return response.session;
}

export async function beginMockSignIn(): Promise<CloudSession> {
  const response = await sendAuthBridgeMessage({
    type: "auth:begin-mock-sign-in",
  });

  if (!response.ok) {
    throw new Error(response.error);
  }

  if (!response.session) {
    throw new Error("Mock sign-in completed without a stored cloud session.");
  }

  return response.session;
}

export async function clearCloudSessionInBackground(): Promise<void> {
  const response = await sendAuthBridgeMessage({
    type: "auth:clear-cloud-session",
  });

  if (!response.ok) {
    throw new Error(response.error);
  }
}

function sendAuthBridgeMessage(
  message: AuthBridgeRequest,
): Promise<AuthBridgeResponse> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response?: AuthBridgeResponse) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message));
        return;
      }

      if (!response) {
        reject(new Error("Extension auth bridge returned no response."));
        return;
      }

      resolve(response);
    });
  });
}
