import express from "express";
import {
  AgentTokenLimitError,
  type AgentTokenRecord,
  type AgentTokenStore,
  issueAgentToken,
  parseAgentTokenInput,
} from "./agentTokens.js";

/** Resolves the signed-in Kakao user id, or sends an error response and returns null. */
export type SessionAuthenticator = (
  request: express.Request,
  response: express.Response,
) => Promise<string | null>;

export interface AgentTokenView {
  id: string;
  name: string;
  tokenHint: string;
  scopes: string[];
  status: "active" | "expired";
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Session-authenticated endpoints the PWA uses to manage agent tokens.
export function createAgentTokenRouter(options: {
  store: AgentTokenStore;
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
      const records = await store.listForUser(userId, currentTime);
      response.json({
        tokens: records.map((record) => toView(record, currentTime)),
      });
    } catch (error) {
      logFailure("list", error);
      response.status(500).send("Could not load agent tokens.");
    }
  });

  router.post("/", async (request, response) => {
    const userId = await authenticate(request, response);
    if (!userId) {
      return;
    }

    const input = parseAgentTokenInput(request.body);
    if (!input) {
      response
        .status(400)
        .send(
          "Body must include a name (1-60 characters) and optionally expiresInDays (30, 90, or 365).",
        );
      return;
    }

    try {
      const { token, record } = await issueAgentToken(
        store,
        { ...input, kakaoUserId: userId },
        now,
      );
      response
        .status(201)
        .set("Cache-Control", "no-store")
        .json({ token, agentToken: toView(record, now()) });
    } catch (error) {
      if (error instanceof AgentTokenLimitError) {
        response.status(409).send(error.message);
        return;
      }

      logFailure("create", error);
      response.status(500).send("Could not create the agent token.");
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
        ? await store.revoke(userId, id, now())
        : false;
      if (!revoked) {
        response.status(404).send("Agent token not found.");
        return;
      }

      console.info(`[agent-tokens] revoked token ${id}`);
      response.status(204).end();
    } catch (error) {
      logFailure("revoke", error);
      response.status(500).send("Could not revoke the agent token.");
    }
  });

  return router;
}

function toView(record: AgentTokenRecord, now: Date): AgentTokenView {
  return {
    id: record.id,
    name: record.name,
    tokenHint: record.tokenHint,
    scopes: record.scopes,
    status: Date.parse(record.expiresAt) > now.getTime() ? "active" : "expired",
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function logFailure(action: string, error: unknown) {
  console.error(
    `[agent-tokens] ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
