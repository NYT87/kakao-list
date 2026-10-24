import crypto from "node:crypto";
import {
  InvalidClientError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthServerProvider,
  OAuthTokenVerifier,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import cors from "cors";
import express from "express";
import { rateLimit } from "express-rate-limit";
import { AGENT_SCOPE_LISTS_READ } from "./agentTokens.js";
import { sendConsentPage, sendErrorPage } from "./oauthPages.js";
import type {
  NewAuthorizationCode,
  NewOAuthToken,
  OAuthStore,
} from "./oauthStore.js";
import { type RateLimitStoreFactory, rateLimitOptions } from "./rateLimits.js";

// OAuth 2.1 authorization server for MCP clients (claude.ai, Claude Code,
// Cursor, …), with Kakao as the identity provider. See docs/agent-access.md.
//
//   client → /authorize → our consent page → Kakao login
//   Kakao → /oauth/kakao/callback → our authorization code → client
//   client → /token (PKCE) → access + refresh token for /mcp
//
// The SDK's mcpAuthRouter implements the endpoints, metadata and PKCE check;
// this module supplies the provider behind it. Every client is registered as
// a public client (PKCE, no secret): the SDK compares client secrets in
// plaintext, and a secret adds nothing for apps that cannot keep one.

export const OAUTH_SUPPORTED_SCOPES = [AGENT_SCOPE_LISTS_READ];
export const OAUTH_ACCESS_TOKEN_PREFIX = "kl_at_";
export const OAUTH_MAX_ACTIVE_GRANTS = 20;

const REFRESH_TOKEN_PREFIX = "kl_rt_";
const AUTHORIZATION_CODE_PREFIX = "kl_ac_";
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;
const KAKAO_AUTHORIZE_ENDPOINT = "https://kauth.kakao.com/oauth/authorize";
const CALLBACK_PATH = "/oauth/kakao/callback";
const STATE_COOKIE = "kl_oauth_request";
const RANDOM_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CLIENT_NAME_MAX_LENGTH = 100;
const REDIRECT_URIS_MAX = 10;
const REDIRECT_URI_MAX_LENGTH = 2000;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TOO_MANY_GRANTS_MESSAGE =
  "Too many connected assistants. Disconnect one in Kakao Lists settings and try again.";

export interface KakaoOAuthOptions {
  store: OAuthStore;
  /** Public origin of this server, e.g. https://api.example.com. */
  publicUrl: URL;
  kakaoClientId: string;
  /** Exchanges a Kakao authorization code and returns the Kakao user id. */
  identifyKakaoUser: (code: string, redirectUri: string) => Promise<string>;
  kakaoAuthorizeEndpoint?: string;
  now?: () => Date;
  /**
   * Per-IP rate limits on every OAuth endpoint. `createStore` supplies a
   * shared store (Postgres in production); without it each instance counts
   * in memory. Tests pass `false` to disable limits.
   */
  rateLimit?:
    | false
    | {
        createStore?: RateLimitStoreFactory;
        callbackPerIpPer15Minutes?: number;
      };
}

export function createKakaoOAuth(options: KakaoOAuthOptions) {
  const { store, kakaoClientId, identifyKakaoUser } = options;
  const now = options.now ?? (() => new Date());
  const issuerUrl = new URL(`${options.publicUrl.origin}/`);
  const mcpResourceUrl = new URL("/mcp", issuerUrl);
  const callbackUrl = new URL(CALLBACK_PATH, issuerUrl).href;
  const kakaoAuthorizeEndpoint =
    options.kakaoAuthorizeEndpoint ?? KAKAO_AUTHORIZE_ENDPOINT;
  const cookieOptions = {
    httpOnly: true,
    secure: issuerUrl.protocol === "https:",
    sameSite: "lax" as const,
    path: CALLBACK_PATH,
  };

  function checkResource(resource: URL | string | undefined) {
    if (resource !== undefined && !sameResource(resource, mcpResourceUrl)) {
      throw new InvalidTargetError(
        "Tokens can only be issued for this server's /mcp endpoint",
      );
    }
  }

  function issueTokens(scopes: string[], issuedAt: Date) {
    const accessToken = generateToken(OAUTH_ACCESS_TOKEN_PREFIX);
    const refreshToken = generateToken(REFRESH_TOKEN_PREFIX);
    const records: NewOAuthToken[] = [
      {
        tokenHash: hashToken(accessToken),
        kind: "access",
        scopes,
        createdAt: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + ACCESS_TOKEN_TTL_MS),
      },
      {
        tokenHash: hashToken(refreshToken),
        kind: "refresh",
        scopes,
        createdAt: issuedAt,
        expiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS),
      },
    ];
    const response: OAuthTokens = {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
    return {
      records,
      response,
      grantExpiresAt: new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS),
    };
  }

  async function revokeReplayedGrant(grantId: string | null, what: string) {
    if (grantId) {
      await store.revokeGrant(grantId, now());
    }
    console.warn(
      `[oauth] ${what} was reused; ${grantId ? `revoked grant ${grantId}` : "no grant to revoke"}`,
    );
  }

  const provider: OAuthServerProvider = {
    clientsStore: {
      async getClient(clientId) {
        return (await store.getClient(clientId)) ?? undefined;
      },

      async registerClient(client) {
        const registered = toRegisteredClient(client);
        await store.saveClient(registered, now());
        return registered;
      },
    },

    async authorize(client, params, response) {
      const scopes = normalizeScopes(params.scopes);
      checkResource(params.resource);

      const requestId = generateToken("");
      const createdAt = now();
      const clientName = displayName(client);
      const saved = await store.savePendingAuthorization({
        idHash: hashToken(requestId),
        clientId: client.client_id,
        clientName,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state ?? null,
        scopes,
        resource: mcpResourceUrl.href,
        createdAt,
        expiresAt: new Date(createdAt.getTime() + PENDING_AUTHORIZATION_TTL_MS),
      });
      if (!saved) {
        // Cleanup removed this registration after the SDK looked it up.
        // Fail now, not at the token step; the client registers again.
        throw new InvalidClientError(
          "This client registration has expired. Register again.",
        );
      }

      const kakaoUrl = new URL(kakaoAuthorizeEndpoint);
      kakaoUrl.searchParams.set("response_type", "code");
      kakaoUrl.searchParams.set("client_id", kakaoClientId);
      kakaoUrl.searchParams.set("redirect_uri", callbackUrl);
      kakaoUrl.searchParams.set("state", requestId);

      // The cookie binds the Kakao round-trip to this browser (login CSRF).
      response.cookie(STATE_COOKIE, requestId, {
        ...cookieOptions,
        maxAge: PENDING_AUTHORIZATION_TTL_MS,
      });
      sendConsentPage(response, {
        clientName,
        returnTo: describeRedirect(params.redirectUri),
        kakaoUrl: kakaoUrl.href,
        cancelUrl: buildRedirect(params.redirectUri, {
          error: "access_denied",
          error_description: "The user cancelled the connection.",
          state: params.state,
        }),
      });
    },

    async challengeForAuthorizationCode(client, authorizationCode) {
      const code = await store.findAuthorizationCode(
        hashToken(authorizationCode),
      );
      if (!code || code.clientId !== client.client_id) {
        throw new InvalidGrantError("Invalid authorization code");
      }
      return code.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client,
      authorizationCode,
      _codeVerifier,
      redirectUri,
      resource,
    ) {
      checkResource(resource);
      const issuedAt = now();
      const codeHash = hashToken(authorizationCode);
      // Client and redirect URI never change after the code is issued, so
      // they can be checked before redeeming; a mismatch leaves the code for
      // its rightful client.
      const known = await store.findAuthorizationCode(codeHash);
      if (!known || known.clientId !== client.client_id) {
        throw new InvalidGrantError("Invalid authorization code");
      }
      if (redirectUri !== undefined && redirectUri !== known.redirectUri) {
        throw new InvalidGrantError(
          "redirect_uri does not match the authorization request",
        );
      }

      let issued: ReturnType<typeof issueTokens> | undefined;
      const result = await store.redeemAuthorizationCode(
        codeHash,
        issuedAt,
        (code) => {
          issued = issueTokens(code.scopes, issuedAt);
          return {
            grant: {
              id: crypto.randomUUID(),
              kakaoUserId: code.kakaoUserId,
              clientId: code.clientId,
              clientName: code.clientName,
              scopes: code.scopes,
              resource: code.resource,
              createdAt: issuedAt,
              expiresAt: issued.grantExpiresAt,
            },
            tokens: issued.records,
          };
        },
        OAUTH_MAX_ACTIVE_GRANTS,
      );
      if (result.status === "reused") {
        await revokeReplayedGrant(result.grantId, "authorization code");
        throw new InvalidGrantError("Authorization code was already used");
      }
      if (result.status === "invalid") {
        throw new InvalidGrantError("Invalid or expired authorization code");
      }
      if (result.status === "limit" || !issued) {
        throw new InvalidGrantError(TOO_MANY_GRANTS_MESSAGE);
      }

      const { grant } = result;
      console.info(
        `[oauth] created grant ${grant.id} for client ${client.client_id}`,
      );
      return issued.response;
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const issuedAt = now();
      const tokenHash = hashToken(refreshToken);
      const found = isOwnToken(refreshToken, REFRESH_TOKEN_PREFIX)
        ? await store.findToken(tokenHash)
        : null;
      if (
        found?.token.kind !== "refresh" ||
        found.grant.clientId !== client.client_id
      ) {
        throw new InvalidGrantError("Invalid refresh token");
      }

      const requested = scopes?.length ? scopes : found.token.scopes;
      if (!requested.every((scope) => found.token.scopes.includes(scope))) {
        throw new InvalidScopeError(
          "Requested scope exceeds the original grant",
        );
      }
      checkResource(resource);

      const issued = issueTokens(requested, issuedAt);
      const result = await store.rotateRefreshToken(
        tokenHash,
        issued.records,
        issued.grantExpiresAt,
        issuedAt,
      );
      if (result.status === "reused") {
        await revokeReplayedGrant(result.grantId, "refresh token");
        throw new InvalidGrantError("Refresh token was already used");
      }
      if (result.status === "invalid") {
        throw new InvalidGrantError("Invalid or expired refresh token");
      }
      return issued.response;
    },

    verifyAccessToken: (token) => verifier.verifyAccessToken(token),

    async revokeToken(client, request) {
      const isOurs =
        isOwnToken(request.token, OAUTH_ACCESS_TOKEN_PREFIX) ||
        isOwnToken(request.token, REFRESH_TOKEN_PREFIX);
      const found = isOurs
        ? await store.findToken(hashToken(request.token))
        : null;
      // RFC 7009: unknown or foreign tokens are ignored without an error.
      if (found && found.grant.clientId === client.client_id) {
        await store.revokeGrant(found.grant.id, now());
        console.info(
          `[oauth] client ${client.client_id} revoked grant ${found.grant.id}`,
        );
      }
    },
  };

  const verifier: OAuthTokenVerifier = {
    async verifyAccessToken(token): Promise<AuthInfo> {
      const currentTime = now();
      const found = isOwnToken(token, OAUTH_ACCESS_TOKEN_PREFIX)
        ? await store.findToken(hashToken(token))
        : null;
      if (
        found?.token.kind !== "access" ||
        found.grant.revokedAt !== null ||
        Date.parse(found.token.expiresAt) <= currentTime.getTime()
      ) {
        throw new InvalidTokenError("Invalid or expired access token");
      }

      await store.markGrantUsed(
        found.grant.id,
        currentTime,
        LAST_USED_RESOLUTION_MS,
      );
      return {
        token,
        clientId: found.grant.clientId,
        scopes: found.token.scopes,
        expiresAt: Date.parse(found.token.expiresAt) / 1000,
        resource: new URL(found.grant.resource),
        extra: {
          kakaoUserId: found.grant.kakaoUserId,
          oauthGrantId: found.grant.id,
        },
      };
    },
  };

  const callbackHandler: express.RequestHandler = async (request, response) => {
    const state =
      typeof request.query.state === "string" ? request.query.state : "";
    const cookieState = readCookie(request.headers.cookie, STATE_COOKIE);
    const stateMatches = Boolean(
      state && cookieState && safeEqual(state, cookieState),
    );
    // Only clear the cookie for its own sign-in: a stale or unsolicited
    // callback must not break a newer sign-in in the same browser.
    if (stateMatches) {
      response.cookie(STATE_COOKIE, "", { ...cookieOptions, maxAge: 0 });
    }

    try {
      const sendExpired = () =>
        sendErrorPage(
          response,
          400,
          "This sign-in link has expired",
          "It may have been used already or opened in a different browser. Start again from your AI assistant.",
        );
      const requestHash = hashToken(state);
      // Claimed, not consumed: only this request may contact Kakao and
      // complete the sign-in (a duplicate callback sees it expired), and the
      // row stays in place meanwhile, so its client is never left without a
      // pending sign-in or a code (which would let cleanup delete it).
      const pending = stateMatches
        ? await store.claimPendingAuthorization(requestHash, now())
        : null;
      if (!pending) {
        sendExpired();
        return;
      }

      // Every outcome completes the claimed sign-in, swapping it for the
      // code (if any) in one transaction.
      const finish = async (
        params: Record<string, string | undefined>,
        code: NewAuthorizationCode | null,
      ) => {
        const completed = await store.completePendingAuthorization(
          requestHash,
          now(),
          code,
        );
        if (!completed) {
          sendExpired();
          return;
        }
        response.redirect(
          302,
          buildRedirect(pending.redirectUri, {
            ...params,
            state: pending.state ?? undefined,
          }),
        );
      };

      const kakaoCode = request.query.code;
      if (request.query.error || typeof kakaoCode !== "string" || !kakaoCode) {
        await finish(
          {
            error: "access_denied",
            error_description: "Sign-in with Kakao was cancelled.",
          },
          null,
        );
        return;
      }

      let kakaoUserId: string;
      try {
        kakaoUserId = await identifyKakaoUser(kakaoCode, callbackUrl);
      } catch (error) {
        console.error(
          `[oauth] Kakao sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        await finish(
          {
            error: "server_error",
            error_description: "Sign-in with Kakao failed. Try again.",
          },
          null,
        );
        return;
      }

      const issuedAt = now();
      // Checked again atomically when the code is exchanged; checking here
      // lets the user see the reason in the browser.
      if (
        (await store.countActiveGrants(kakaoUserId, issuedAt)) >=
        OAUTH_MAX_ACTIVE_GRANTS
      ) {
        await finish(
          {
            error: "access_denied",
            error_description: TOO_MANY_GRANTS_MESSAGE,
          },
          null,
        );
        return;
      }

      const authorizationCode = generateToken(AUTHORIZATION_CODE_PREFIX);
      await finish(
        { code: authorizationCode },
        {
          codeHash: hashToken(authorizationCode),
          clientId: pending.clientId,
          clientName: pending.clientName,
          kakaoUserId,
          redirectUri: pending.redirectUri,
          codeChallenge: pending.codeChallenge,
          scopes: pending.scopes,
          resource: pending.resource,
          createdAt: issuedAt,
          expiresAt: new Date(issuedAt.getTime() + AUTHORIZATION_CODE_TTL_MS),
        },
      );
    } catch (error) {
      console.error(
        `[oauth] callback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      sendErrorPage(
        response,
        500,
        "Something went wrong",
        "Kakao Lists could not finish connecting your assistant. Start again from your AI assistant.",
      );
    }
  };

  const limits = options.rateLimit;
  // Keeps the SDK's default limits per endpoint, counted in the shared store.
  const endpointLimit = (name: string) =>
    limits === false
      ? { rateLimit: false as const }
      : limits?.createStore
        ? { rateLimit: rateLimitOptions(limits.createStore, `oauth-${name}:`) }
        : {};
  const callbackLimit =
    limits === false
      ? []
      : [
          rateLimit({
            ...rateLimitOptions(limits?.createStore, "oauth-callback:"),
            windowMs: 15 * 60 * 1000,
            limit: limits?.callbackPerIpPer15Minutes ?? 30,
            handler: (_request, response) => {
              sendErrorPage(
                response,
                429,
                "Too many sign-in attempts",
                "Wait a few minutes, then start again from your AI assistant.",
              );
            },
          }),
        ];
  const router = express.Router();
  // Served before the SDK's copy: the SDK always advertises
  // client_secret_post, but this server only registers public clients.
  const metadata = {
    ...createOAuthMetadata({
      provider,
      issuerUrl,
      scopesSupported: OAUTH_SUPPORTED_SCOPES,
    }),
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  };
  router.get(
    "/.well-known/oauth-authorization-server",
    cors(),
    (_request, response) => {
      response.json(metadata);
    },
  );
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: mcpResourceUrl,
      scopesSupported: OAUTH_SUPPORTED_SCOPES,
      resourceName: "Kakao Lists",
      authorizationOptions: endpointLimit("authorize"),
      tokenOptions: endpointLimit("token"),
      clientRegistrationOptions: endpointLimit("register"),
      revocationOptions: endpointLimit("revoke"),
    }),
  );
  router.get(CALLBACK_PATH, ...callbackLimit, callbackHandler);

  return {
    router,
    verifier,
    mcpResourceUrl,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpResourceUrl),
  };
}

/**
 * Applies the registration policy: public clients only, a bounded name and
 * redirect URI list, and only redirect URIs a native or web client can own.
 * Only known fields are kept, so stored registrations stay small.
 */
function toRegisteredClient(
  client: Omit<
    OAuthClientInformationFull,
    "client_id" | "client_id_issued_at"
  > &
    Partial<
      Pick<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
    >,
): OAuthClientInformationFull {
  if (!client.client_id) {
    throw new InvalidClientMetadataError("client_id was not generated");
  }

  const name = client.client_name?.trim();
  if (
    name !== undefined &&
    (name.length > CLIENT_NAME_MAX_LENGTH || /\p{Cc}/u.test(name))
  ) {
    throw new InvalidClientMetadataError(
      `client_name must be at most ${CLIENT_NAME_MAX_LENGTH} characters without control characters`,
    );
  }

  const redirectUris = client.redirect_uris.map(String);
  if (redirectUris.length === 0 || redirectUris.length > REDIRECT_URIS_MAX) {
    throw new InvalidClientMetadataError(
      `Register between 1 and ${REDIRECT_URIS_MAX} redirect URIs`,
    );
  }
  const rejected = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
  if (rejected !== undefined) {
    throw new InvalidClientMetadataError(
      "Redirect URIs must use https, http on a loopback address, or a reverse-domain app scheme, without credentials or a fragment",
    );
  }

  return {
    client_id: client.client_id,
    client_id_issued_at: client.client_id_issued_at,
    client_name: name || undefined,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: OAUTH_SUPPORTED_SCOPES.join(" "),
  };
}

function isAllowedRedirectUri(value: string) {
  if (value.length > REDIRECT_URI_MAX_LENGTH || !URL.canParse(value)) {
    return false;
  }

  const url = new URL(value);
  if (url.hash || url.username || url.password) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  // Private-use scheme for native apps (RFC 8252 §7.1): reverse domain name.
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/i.test(url.protocol);
}

function normalizeScopes(requested: string[] | undefined) {
  const scopes = (requested ?? []).filter(Boolean);
  if (scopes.length === 0) {
    return [...OAUTH_SUPPORTED_SCOPES];
  }
  if (!scopes.every((scope) => OAUTH_SUPPORTED_SCOPES.includes(scope))) {
    throw new InvalidScopeError(
      `Supported scopes: ${OAUTH_SUPPORTED_SCOPES.join(" ")}`,
    );
  }
  return [...new Set(scopes)];
}

function displayName(client: OAuthClientInformationFull) {
  return client.client_name?.trim() || "An unnamed assistant";
}

function describeRedirect(redirectUri: string) {
  const url = new URL(redirectUri);
  return url.host || url.protocol.slice(0, -1);
}

function buildRedirect(
  redirectUri: string,
  params: Record<string, string | undefined>,
) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.href;
}

function sameResource(value: URL | string, expected: URL) {
  const normalize = (url: URL | string) => {
    const text = String(url);
    const hash = text.indexOf("#");
    return (hash === -1 ? text : text.slice(0, hash)).replace(/\/$/, "");
  };
  return normalize(value) === normalize(expected);
}

function generateToken(prefix: string) {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

// High-entropy random tokens, so a fast hash is enough (see agentTokens.ts).
function hashToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function isOwnToken(token: string, prefix: string) {
  return (
    token.startsWith(prefix) &&
    RANDOM_TOKEN_PATTERN.test(token.slice(prefix.length))
  );
}

function safeEqual(left: string, right: string) {
  return crypto.timingSafeEqual(
    Buffer.from(hashToken(left), "hex"),
    Buffer.from(hashToken(right), "hex"),
  );
}

function readCookie(header: string | undefined, name: string) {
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}
