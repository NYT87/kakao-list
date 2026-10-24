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

export class HttpCloudSyncClient implements CloudSyncClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAuthToken?: () => string | null,
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

    return parseJson<PushSnapshotResult>(response);
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

    return parseJson<PushSnapshotResult>(response);
  }

  async syncFromKakao(): Promise<PushSnapshotResult> {
    const response = await this.request(`${this.baseUrl}/api/sync/kakao`, {
      method: "POST",
      headers: withAuthHeaders(this.getAuthToken),
    });

    return parseJson<PushSnapshotResult>(response);
  }

  async pullLatestSnapshot(): Promise<PullSnapshotResult> {
    const response = await this.request(`${this.baseUrl}/api/snapshot`, {
      headers: withAuthHeaders(this.getAuthToken),
    });

    return parseJson<PullSnapshotResult>(response);
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

    return parseJson<PushSnapshotResult>(response);
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

  private async request(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    try {
      return await fetch(input, init);
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

async function ensureOk(response: Response) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      text || `Sync request failed with status ${response.status}`,
    );
  }
}

function toReadableNetworkError(baseUrl: string, error: unknown) {
  if (error instanceof TypeError) {
    return new Error(
      `Could not reach the sync server at ${baseUrl}. Start the local server or update VITE_SYNC_SERVER_URL, then rebuild the extension.`,
    );
  }

  return error instanceof Error ? error : new Error("Sync request failed.");
}
