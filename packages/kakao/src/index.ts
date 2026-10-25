export interface KakaoOAuthConfig {
  clientId: string;
  redirectUri: string;
  scope?: string;
  state?: string;
}

export interface KakaoAuthCallbackPayload {
  code: string | null;
  state: string | null;
  error: string | null;
}

const KAKAO_AUTHORIZE_URL = "https://kauth.kakao.com/oauth/authorize";

export function buildKakaoAuthorizeUrl(config: KakaoOAuthConfig): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
  });

  if (config.scope) {
    params.set("scope", config.scope);
  }

  if (config.state) {
    params.set("state", config.state);
  }

  return `${KAKAO_AUTHORIZE_URL}?${params.toString()}`;
}

export function readKakaoCallback(
  locationLike: Pick<Location, "search">,
): KakaoAuthCallbackPayload {
  const params = new URLSearchParams(locationLike.search);

  return {
    code: params.get("code"),
    state: params.get("state"),
    error: params.get("error"),
  };
}

export function isKakaoConfigured(
  config: Partial<KakaoOAuthConfig>,
): config is KakaoOAuthConfig {
  return Boolean(config.clientId && config.redirectUri);
}

const STATE_KEY = "kakao-lists:oauth-attempt";
const STATE_TTL = 10 * 60 * 1000;

export function createOAuthAttempt(
  storage: Pick<Storage, "setItem">,
  now = Date.now(),
): string {
  const state = crypto.randomUUID();
  storage.setItem(STATE_KEY, JSON.stringify({ state, createdAt: now }));
  return state;
}

export function consumeOAuthAttempt(
  state: string | null,
  storage: Pick<Storage, "getItem" | "removeItem">,
  now = Date.now(),
): boolean {
  try {
    const raw = storage.getItem(STATE_KEY);
    if (!raw || !state) return false;
    const pending = JSON.parse(raw) as { state: string; createdAt: number };
    if (
      pending.state !== state ||
      !Number.isFinite(pending.createdAt) ||
      now < pending.createdAt ||
      now - pending.createdAt > STATE_TTL
    )
      return false;
    storage.removeItem(STATE_KEY);
    return true;
  } catch {
    return false;
  }
}
