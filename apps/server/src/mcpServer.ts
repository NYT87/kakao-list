import type { SyncSnapshot } from "@kakao-lists/domain";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";
import {
  findPlace,
  getListPage,
  LIST_PAGE_MAX_LIMIT,
  SEARCH_MAX_LIMIT,
  searchPlaces,
  summarizeLists,
} from "./agentQueries.js";
import { AGENT_SCOPE_LISTS_READ } from "./agentTokens.js";

export type SnapshotLoader = (
  kakaoUserId: string,
) => Promise<SyncSnapshot | null>;

const NO_SNAPSHOT_HINT =
  "No lists have been synced yet. Ask the user to open the Kakao Lists browser extension and import from Kakao Maps.";
const ID_SCHEMA = z.string().min(1).max(200);
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// Stateless Streamable HTTP: every POST builds a fresh server bound to the
// token owner, because the API runs as short-lived serverless functions
// (no sessions, no SSE streams kept open).
export function createMcpRouter(options: {
  verifier: OAuthTokenVerifier;
  loadSnapshot: SnapshotLoader;
}): express.Router {
  const router = express.Router();
  const auth = requireBearerAuth({
    verifier: options.verifier,
    requiredScopes: [AGENT_SCOPE_LISTS_READ],
  });

  router.post("/", auth, async (request, response) => {
    const kakaoUserId = getKakaoUserId(request.auth);
    if (!kakaoUserId) {
      response.status(401).json(jsonRpcError("Unauthorized"));
      return;
    }

    const server = createListsMcpServer(() =>
      options.loadSnapshot(kakaoUserId),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error(
        `[mcp] request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!response.headersSent) {
        response.status(500).json(jsonRpcError("Internal server error"));
      }
    }
  });

  router.all("/", (_request, response) => {
    response
      .status(405)
      .set("Allow", "POST")
      .json(
        jsonRpcError(
          "Method not allowed. This MCP server is stateless; use POST.",
        ),
      );
  });

  return router;
}

export function createListsMcpServer(
  loadSnapshot: () => Promise<SyncSnapshot | null>,
) {
  const server = new McpServer({ name: "kakao-lists", version: "0.1.0" });

  const withSnapshot =
    <Args>(
      handler: (snapshot: SyncSnapshot | null, args: Args) => CallToolResult,
    ) =>
    async (args: Args): Promise<CallToolResult> => {
      let snapshot: SyncSnapshot | null;
      try {
        snapshot = await loadSnapshot();
      } catch (error) {
        console.error(
          `[mcp] snapshot load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return errorResult(
          "Could not load the saved lists right now. Try again later.",
        );
      }
      return handler(snapshot, args);
    };

  server.registerTool(
    "list_lists",
    {
      title: "List saved lists",
      description:
        "List the user's saved Kakao Map lists with their id, name, description and number of places. Use the ids with get_list or search_places. syncedAt tells how fresh the data is.",
      annotations: READ_ONLY,
    },
    withSnapshot((snapshot) => {
      const overview = summarizeLists(snapshot);
      return jsonResult(
        snapshot ? overview : { ...overview, hint: NO_SNAPSHOT_HINT },
      );
    }),
  );

  server.registerTool(
    "get_list",
    {
      title: "Get places in a list",
      description: `Return one page of places in a saved list, including the user's notes. Use nextOffset to fetch the next page (max ${LIST_PAGE_MAX_LIMIT} per page).`,
      inputSchema: {
        listId: ID_SCHEMA.describe("List id from list_lists"),
        limit: z.number().int().min(1).max(LIST_PAGE_MAX_LIMIT).optional(),
        offset: z.number().int().min(0).optional(),
      },
      annotations: READ_ONLY,
    },
    withSnapshot((snapshot, { listId, limit, offset }) => {
      const page = getListPage(snapshot, listId, { limit, offset });
      return page
        ? jsonResult(page)
        : errorResult(notFoundMessage(snapshot, "List"));
    }),
  );

  server.registerTool(
    "search_places",
    {
      title: "Search saved places",
      description:
        "Search the user's saved places by name, address and notes (case- and accent-insensitive; every word must match). Optionally restrict to one list.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .describe("Words to search for"),
        listId: ID_SCHEMA.optional().describe("Only search this list"),
        limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
      },
      annotations: READ_ONLY,
    },
    withSnapshot((snapshot, { query, listId, limit }) => {
      const result = searchPlaces(snapshot, { query, listId, limit });
      return jsonResult(
        snapshot ? result : { ...result, hint: NO_SNAPSHOT_HINT },
      );
    }),
  );

  server.registerTool(
    "get_place",
    {
      title: "Get a saved place",
      description: "Return one saved place with its notes and Kakao Map link.",
      inputSchema: {
        listId: ID_SCHEMA.describe("List id"),
        placeId: ID_SCHEMA.describe("Place id from get_list or search_places"),
      },
      annotations: READ_ONLY,
    },
    withSnapshot((snapshot, { listId, placeId }) => {
      const place = findPlace(snapshot, listId, placeId);
      return snapshot && place
        ? jsonResult({ syncedAt: snapshot.syncedAt, place })
        : errorResult(notFoundMessage(snapshot, "Place"));
    }),
  );

  return server;
}

function getKakaoUserId(authInfo: AuthInfo | undefined) {
  const value = authInfo?.extra?.kakaoUserId;
  return typeof value === "string" && value ? value : null;
}

function notFoundMessage(snapshot: SyncSnapshot | null, kind: string) {
  return snapshot
    ? `${kind} not found. Use list_lists to see valid ids.`
    : NO_SNAPSHOT_HINT;
}

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function jsonRpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}
