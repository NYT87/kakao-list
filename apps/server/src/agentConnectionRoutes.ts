import express from "express";
import type { SessionAuthenticator } from "./agentTokenRoutes.js";
import type { OAuthGrantRecord, OAuthStore } from "./oauthStore.js";

export interface AgentConnectionView {
  id: string;
  clientName: string;
  scopes: string[];
  status: "active" | "expired";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Session-authenticated endpoints the PWA uses to list and disconnect
// assistants connected by signing in with Kakao (OAuth grants).
export function createAgentConnectionRouter(options: {
  store: OAuthStore;
  authenticate: SessionAuthenticator;
  now?: () => Date;
}): express.Router {
  const { store, authenticate } = options;
  const now = options.now ?? (() => new Date());
  const router = express.Router();

  router.get("/", async (request, response) => {
    const userId = await authenticate(request, response);
    if (!userId) {
      return;
    }

    try {
      const currentTime = now();
      const grants = await store.listGrantsForUser(userId, currentTime);
      response.json({
        connections: grants.map((grant) => toView(grant, currentTime)),
      });
    } catch (error) {
      logFailure("list", error);
      response.status(500).send("Could not load connected assistants.");
    }
  });

  router.delete("/:id", async (request, response) => {
    const userId = await authenticate(request, response);
    if (!userId) {
      return;
    }

    const { id } = request.params;
    try {
      // Unknown, malformed and foreign ids all get the same 404.
      const revoked = UUID_PATTERN.test(id)
        ? await store.revokeGrant(id, now(), userId)
        : false;
      if (!revoked) {
        response.status(404).send("Connection not found.");
        return;
      }

      console.info(`[oauth] user revoked grant ${id}`);
      response.status(204).end();
    } catch (error) {
      logFailure("revoke", error);
      response.status(500).send("Could not disconnect the assistant.");
    }
  });

  return router;
}

function toView(grant: OAuthGrantRecord, now: Date): AgentConnectionView {
  return {
    id: grant.id,
    clientName: grant.clientName,
    scopes: grant.scopes,
    status: Date.parse(grant.expiresAt) > now.getTime() ? "active" : "expired",
    createdAt: grant.createdAt,
    expiresAt: grant.expiresAt,
    lastUsedAt: grant.lastUsedAt,
  };
}

function logFailure(action: string, error: unknown) {
  console.error(
    `[agent-connections] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
