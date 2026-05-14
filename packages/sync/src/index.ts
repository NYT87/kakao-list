import type {
  CloudSession,
  CloudSyncClient,
  ExchangeKakaoCodeInput,
  MockAuthInput,
  PullSnapshotResult,
  PushSnapshotInput,
  PushSnapshotResult,
  UpdateLocalNoteInput
} from "@kakao-lists/domain";

export class HttpCloudSyncClient implements CloudSyncClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getAuthToken?: () => string | null
  ) {}

  async exchangeKakaoCode(input: ExchangeKakaoCodeInput): Promise<CloudSession> {
    const response = await fetch(`${this.baseUrl}/api/auth/kakao/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    return parseJson<CloudSession>(response);
  }

  async createMockSession(input: MockAuthInput = {}): Promise<CloudSession> {
    const response = await fetch(`${this.baseUrl}/api/auth/mock`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    });

    return parseJson<CloudSession>(response);
  }

  async pushSnapshot(input: PushSnapshotInput): Promise<PushSnapshotResult> {
    const response = await fetch(`${this.baseUrl}/api/snapshot`, {
      method: "PUT",
      headers: withAuthHeaders(this.getAuthToken, {
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    return parseJson<PushSnapshotResult>(response);
  }

  async syncFromKakao(): Promise<PushSnapshotResult> {
    const response = await fetch(`${this.baseUrl}/api/sync/kakao`, {
      method: "POST",
      headers: withAuthHeaders(this.getAuthToken)
    });

    return parseJson<PushSnapshotResult>(response);
  }

  async pullLatestSnapshot(): Promise<PullSnapshotResult> {
    const response = await fetch(`${this.baseUrl}/api/snapshot`, {
      headers: withAuthHeaders(this.getAuthToken)
    });

    return parseJson<PullSnapshotResult>(response);
  }

  async updateLocalNote(input: UpdateLocalNoteInput): Promise<PushSnapshotResult> {
    const response = await fetch(`${this.baseUrl}/api/snapshot/item-note`, {
      method: "PATCH",
      headers: withAuthHeaders(this.getAuthToken, {
        "Content-Type": "application/json"
      }),
      body: JSON.stringify(input)
    });

    return parseJson<PushSnapshotResult>(response);
  }
}

function withAuthHeaders(
  getAuthToken?: () => string | null,
  headers: Record<string, string> = {}
): Record<string, string> {
  const token = getAuthToken?.();
  if (!token) {
    return headers;
  }

  return {
    ...headers,
    Authorization: `Bearer ${token}`
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Sync request failed with status ${response.status}`);
  }

  return (await response.json()) as T;
}
