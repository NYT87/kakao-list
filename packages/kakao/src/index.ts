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
