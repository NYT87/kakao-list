import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { AGENT_TOKEN_PREFIX } from "./agentTokens.js";
import { OAUTH_ACCESS_TOKEN_PREFIX } from "./kakaoOAuth.js";

/**
 * Accepts both kinds of credentials on /mcp: personal agent tokens (phase 1)
 * and OAuth access tokens from signing in with Kakao (phase 2). Agent tokens
 * have no audience of their own, so they are bound to this server's /mcp
 * resource here; that lets /mcp enforce the resource for every token.
 */
export function createAgentVerifier(options: {
  agentTokens: OAuthTokenVerifier;
  oauth?: OAuthTokenVerifier;
  resource?: URL;
}): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token) {
      if (token.startsWith(AGENT_TOKEN_PREFIX)) {
        const authInfo = await options.agentTokens.verifyAccessToken(token);
        return options.resource
          ? { ...authInfo, resource: options.resource }
          : authInfo;
      }
      if (options.oauth && token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
        return options.oauth.verifyAccessToken(token);
      }
      throw new InvalidTokenError("Invalid access token");
    },
  };
}
