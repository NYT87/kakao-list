import type {
  AgentConnection,
  AgentToken,
  CloudSession,
  CloudSyncClient,
  CreateAgentTokenInput,
  CreatedAgentToken,
  ExchangeKakaoCodeInput,
  MockAuthInput,
  PullSnapshotResult,
  PushSnapshotInput,
  PushSnapshotListInput,
  PushSnapshotResult,
  UpdateLocalNoteInput,
} from "@kakao-lists/domain";
import { parseSnapshot } from "@kakao-lists/domain";

export class HttpCloudSyncClient implements CloudSyncClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAuthToken?: () => string | null,
    private readonly timeoutMs = 25000,
  ) {}

  async exchangeKakaoCode(
    input: ExchangeKakaoCodeInput,
  ): Promise<CloudSession> {
    const response = await this.request(
      `${this.baseUrl}/api/auth/kakao/exchange`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
    );

    return parseJson<CloudSession>(response);
  }

  async createMockSession(input: MockAuthInput = {}): Promise<CloudSession> {
    const response = await this.request(`${this.baseUrl}/api/auth/mock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    });

    return parseJson<CloudSession>(response);
  }

  async pushSnapshot(input: PushSnapshotInput): Promise<PushSnapshotResult> {
    const response = await this.request(`${this.baseUrl}/api/snapshot`, {
      method: "PUT",
      headers: withAuthHeaders(this.getAuthToken, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(input),
    });

    const result = await parseJson<PushSnapshotResult>(response);
    return { ...result, snapshot: parseSnapshot(result.snapshot) };
  }

  async pushSnapshotList(
    input: PushSnapshotListInput,
  ): Promise<PushSnapshotResult> {
    const response = await this.request(`${this.baseUrl}/api/snapshot/list`, {
      method: "PUT",
      headers: withAuthHeaders(this.getAuthToken, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(input),
    });

    const result = await parseJson<PushSnapshotResult>(response);
    return { ...result, snapshot: parseSnapshot(result.snapshot) };
  }

  async pushSnapshotListChunk(
    input: PushSnapshotListInput,
  ): Promise<Omit<PushSnapshotResult, "snapshot">> {
    const response = await this.request(
      `${this.baseUrl}/api/snapshot/list?summary=true`,
      {
        method: "PUT",
        headers: withAuthHeaders(this.getAuthToken, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(input),
      },
    );
    return parseJson<Omit<PushSnapshotResult, "snapshot">>(response);
  }

  async syncFromKakao(): Promise<PushSnapshotResult> {
    const response = await this.request(`${this.baseUrl}/api/sync/kakao`, {
      method: "POST",
      headers: withAuthHeaders(this.getAuthToken),
    });

    const result = await parseJson<PushSnapshotResult>(response);
    return { ...result, snapshot: parseSnapshot(result.snapshot) };
  }

  async pullLatestSnapshot(): Promise<PullSnapshotResult> {
    const response = await this.request(`${this.baseUrl}/api/snapshot`, {
      headers: withAuthHeaders(this.getAuthToken),
    });

    const result = await parseJson<PullSnapshotResult>(response);
    return {
      ...result,
      snapshot: result.snapshot ? parseSnapshot(result.snapshot) : null,
    };
  }

  async updateLocalNote(
    input: UpdateLocalNoteInput,
  ): Promise<PushSnapshotResult> {
    const response = await this.request(
      `${this.baseUrl}/api/snapshot/item-note`,
      {
        method: "PATCH",
        headers: withAuthHeaders(this.getAuthToken, {
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(input),
      },
    );

    const result = await parseJson<PushSnapshotResult>(response);
    return { ...result, snapshot: parseSnapshot(result.snapshot) };
  }

  async listAgentTokens(): Promise<AgentToken[]> {
    const response = await this.request(`${this.baseUrl}/api/agent-tokens`, {
      headers: withAuthHeaders(this.getAuthToken),
    });

    return (await parseJson<{ tokens: AgentToken[] }>(response)).tokens;
  }

  async createAgentToken(
    input: CreateAgentTokenInput,
  ): Promise<CreatedAgentToken> {
    const response = await this.request(`${this.baseUrl}/api/agent-tokens`, {
      method: "POST",
      headers: withAuthHeaders(this.getAuthToken, {
        "Content-Type": "application/json",
      }),
      body: JSON.stringify(input),
    });

    return parseJson<CreatedAgentToken>(response);
  }

  async revokeAgentToken(id: string): Promise<void> {
    const response = await this.request(
      `${this.baseUrl}/api/agent-tokens/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: withAuthHeaders(this.getAuthToken),
      },
    );

    await ensureOk(response);
  }

  async isAgentSignInAvailable(): Promise<boolean> {
    try {
      const response = await this.request(
        `${this.baseUrl}/.well-known/oauth-protected-resource/mcp`,
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async listAgentConnections(): Promise<AgentConnection[]> {
    const response = await this.request(
      `${this.baseUrl}/api/agent-connections`,
      { headers: withAuthHeaders(this.getAuthToken) },
    );

    return (await parseJson<{ connections: AgentConnection[] }>(response))
      .connections;
  }

  async revokeAgentConnection(id: string): Promise<void> {
    const response = await this.request(
      `${this.baseUrl}/api/agent-connections/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: withAuthHeaders(this.getAuthToken),
      },
    );

    await ensureOk(response);
  }

  async logout(allDevices = false): Promise<void> {
    await ensureOk(
      await this.request(
        `${this.baseUrl}/api/auth/${allDevices ? "logout-all" : "logout"}`,
        { method: "POST", headers: withAuthHeaders(this.getAuthToken) },
      ),
    );
  }

  async deleteAccount(): Promise<void> {
    await ensureOk(
      await this.request(`${this.baseUrl}/api/account`, {
        method: "DELETE",
        headers: withAuthHeaders(this.getAuthToken),
      }),
    );
  }

  private async request(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(input, {
        ...init,
        cache: "no-store",
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw toReadableNetworkError(this.baseUrl, error);
    }
  }
}

function withAuthHeaders(
  getAuthToken?: () => string | null,
  headers: Record<string, string> = {},
): Record<string, string> {
  const token = getAuthToken?.();
  if (!token) {
    return headers;
  }

  return {
    ...headers,
    Authorization: `Bearer ${token}`,
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  await ensureOk(response);
  return (await response.json()) as T;
}

export class SyncRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function ensureOk(response: Response) {
  if (response.ok) return;
  let message = "Could not complete this action. Please try again.";
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    if (typeof body.error?.message === "string") message = body.error.message;
  } catch {
    /* HTML and upstream messages are not public UI copy. */
  }
  if (response.status === 401)
    message = "Your session has ended. Sign in again.";
  if (response.status === 429)
    message = "Too many requests. Wait a moment and try again.";
  throw new SyncRequestError(message, response.status);
}

function toReadableNetworkError(_baseUrl: string, error: unknown) {
  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  )
    return new Error(
      "This request took too long. Check your connection and try again.",
    );
  if (error instanceof TypeError)
    return new Error("Could not connect. Check your connection and try again.");
  return error instanceof Error
    ? error
    : new Error("Could not complete this action.");
}
