import type { RequestHandler } from "express";
import { type Options, rateLimit, type Store } from "express-rate-limit";

/** Creates one store per limiter; `prefix` keeps limiters' keys apart. */
export type RateLimitStoreFactory = (prefix: string) => Store;

export interface McpRateLimits {
  /** Per client IP, before the token is checked (bounds unauthenticated load). */
  beforeAuth: RequestHandler;
  /** Per Kakao user, after the token is checked. */
  afterAuth: RequestHandler;
}

const MINUTE_MS = 60 * 1000;

/**
 * Options shared by every limiter. A store failure lets the request through:
 * the store is the database, and a database outage already fails the
 * request, so the limiter should not add a second failure mode.
 */
export function rateLimitOptions(
  createStore: RateLimitStoreFactory | undefined,
  prefix: string,
): Partial<Options> {
  return {
    standardHeaders: "draft-7",
    legacyHeaders: false,
    passOnStoreError: true,
    ...(createStore ? { store: createStore(prefix) } : {}),
  };
}

export function createMcpRateLimits(options: {
  createStore?: RateLimitStoreFactory;
  perIpPerMinute?: number;
  perUserPerMinute?: number;
}): McpRateLimits {
  const handler: Options["handler"] = (_request, response, _next, limit) => {
    response.status(limit.statusCode).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Too many requests. Wait a moment and try again.",
      },
      id: null,
    });
  };

  return {
    beforeAuth: rateLimit({
      ...rateLimitOptions(options.createStore, "mcp-ip:"),
      windowMs: MINUTE_MS,
      limit: options.perIpPerMinute ?? 300,
      handler,
    }),
    afterAuth: rateLimit({
      ...rateLimitOptions(options.createStore, "mcp-user:"),
      windowMs: MINUTE_MS,
      limit: options.perUserPerMinute ?? 120,
      // Every token of a user shares the user's budget.
      keyGenerator: (request) => {
        const userId = request.auth?.extra?.kakaoUserId;
        return typeof userId === "string" ? userId : "unknown-user";
      },
      handler,
    }),
  };
}

/**
 * Per-IP limit for the session-authenticated agent management API. Each
 * request re-validates the Kakao session with Kakao, so floods are costly.
 */
export function createApiRateLimit(options: {
  createStore?: RateLimitStoreFactory;
  prefix: string;
  perIpPerMinute?: number;
}): RequestHandler {
  return rateLimit({
    ...rateLimitOptions(options.createStore, options.prefix),
    windowMs: MINUTE_MS,
    limit: options.perIpPerMinute ?? 60,
    message: "Too many requests. Wait a moment and try again.",
  });
}
