import type {
  AgentToken,
  CloudSyncClient,
  CreateAgentTokenInput,
  CreatedAgentToken,
} from "@kakao-lists/domain";
import { useCallback, useEffect, useState } from "react";

type Lifetime = NonNullable<CreateAgentTokenInput["expiresInDays"]>;

const LIFETIME_OPTIONS: Array<{ days: Lifetime; label: string }> = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
];

interface AgentAccessPanelProps {
  client: CloudSyncClient;
  mcpUrl: string;
  formatDate: (value: string) => string;
  /** Short confirmations go to the app toast; errors stay inline. */
  onNotify: (message: string) => void;
}

// Lets the user connect AI assistants (Claude, Cursor, …) to their lists
// through the read-only MCP endpoint. Starts collapsed because most users
// never connect one. See docs/agent-access.md.
export function AgentAccessPanel({
  client,
  mcpUrl,
  formatDate,
  onNotify,
}: AgentAccessPanelProps) {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [name, setName] = useState("");
  const [lifetime, setLifetime] = useState<Lifetime>(90);
  const [created, setCreated] = useState<CreatedAgentToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback((cause: unknown, fallback: string) => {
    setError(
      cause instanceof Error && cause.message ? cause.message : fallback,
    );
  }, []);

  const loadTokens = useCallback(async () => {
    try {
      setTokens(await client.listAgentTokens());
    } catch (cause) {
      setTokens([]);
      showError(cause, "Could not load your connected assistants.");
    }
  }, [client, showError]);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const hasConnections = (tokens?.length ?? 0) > 0;
  const isExpanded = isFormOpen || hasConnections || created !== null;

  async function createToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setCreating(true);
    setError(null);
    try {
      const result = await client.createAgentToken({
        name: name.trim(),
        expiresInDays: lifetime,
      });
      setCreated(result);
      setName("");
      setIsFormOpen(false);
      await loadTokens();
    } catch (cause) {
      showError(cause, "Could not create the connection key.");
    } finally {
      setBusy(false);
      setCreating(false);
    }
  }

  async function revokeToken(token: AgentToken) {
    if (
      !window.confirm(
        `Disconnect "${token.name}"? It will stop being able to read your lists right away.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await client.revokeAgentToken(token.id);
      if (created?.agentToken.id === token.id) {
        setCreated(null);
      }
      await loadTokens();
      onNotify(`"${token.name}" disconnected`);
    } catch (cause) {
      showError(cause, "Could not disconnect the assistant.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, confirmation: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Copying is not available in this browser.");
      }
      await navigator.clipboard.writeText(text);
      setError(null);
      onNotify(confirmation);
    } catch {
      // Browser messages here are technical; give a plain next step instead.
      setError("Could not copy automatically. Select the text and copy it.");
    }
  }

  function openForm() {
    setIsFormOpen(true);
    setError(null);
  }

  function cancelForm() {
    setIsFormOpen(false);
    setName("");
    setError(null);
  }

  return (
    <article className="panel agent-panel">
      <h2>AI Assistants</h2>
      <p className="panel-copy">
        Connect an AI assistant, such as Claude, to ask questions about your
        saved places. It can read your lists and notes but cannot change them.
      </p>

      {!isExpanded ? (
        <div className="hero-actions compact agent-actions">
          <button
            className="button secondary"
            disabled={tokens === null}
            onClick={openForm}
            type="button"
          >
            Connect an assistant
          </button>
        </div>
      ) : null}

      {created ? (
        <section aria-live="polite" className="agent-created">
          <p className="agent-created-title">Your connection key is ready</p>
          <p className="agent-created-copy">
            Copy it and paste it into your assistant. For your security, it will
            not be shown again.
          </p>
          <code className="agent-secret">{created.token}</code>
          <div className="hero-actions compact">
            <button
              className="button primary"
              onClick={() => copy(created.token, "Key copied")}
              type="button"
            >
              Copy key
            </button>
            <button
              className="button secondary"
              onClick={() => {
                setCreated(null);
                setError(null);
              }}
              type="button"
            >
              Done, I saved it
            </button>
          </div>
          <details className="agent-details">
            <summary>Setup details</summary>
            <dl className="meta-list">
              <div>
                <dt>Server address</dt>
                <dd>
                  <code>{mcpUrl}</code>
                </dd>
              </div>
              <div>
                <dt>Claude Code</dt>
                <dd>
                  <button
                    className="button secondary"
                    onClick={() =>
                      copy(
                        `claude mcp add --transport http kakao-lists ${mcpUrl} --header "Authorization: Bearer ${created.token}"`,
                        "Command copied",
                      )
                    }
                    type="button"
                  >
                    Copy setup command
                  </button>
                </dd>
              </div>
              <div>
                <dt>Other assistants</dt>
                <dd>
                  Add a remote MCP server with the address above and send the
                  key in the header{" "}
                  <code>Authorization: Bearer &lt;key&gt;</code>.
                </dd>
              </div>
            </dl>
          </details>
        </section>
      ) : null}

      {isExpanded && !created ? (
        isFormOpen || !hasConnections ? (
          <form className="agent-form" onSubmit={createToken}>
            <label className="agent-field">
              <span>Assistant name</span>
              <input
                className="agent-input"
                disabled={busy}
                maxLength={60}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. Claude on my laptop"
                required
                value={name}
              />
            </label>
            <label className="agent-field">
              <span>Key expires after</span>
              <select
                className="agent-input"
                disabled={busy}
                onChange={(event) =>
                  setLifetime(Number(event.target.value) as Lifetime)
                }
                value={lifetime}
              >
                {LIFETIME_OPTIONS.map((option) => (
                  <option key={option.days} value={option.days}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="agent-form-actions">
              <button
                className="button primary"
                disabled={busy || !name.trim()}
                type="submit"
              >
                {creating ? "Creating…" : "Create connection key"}
              </button>
              <button
                className="button secondary"
                disabled={busy}
                onClick={cancelForm}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <div className="hero-actions compact agent-actions">
            <button
              className="button secondary"
              disabled={busy}
              onClick={openForm}
              type="button"
            >
              Connect another assistant
            </button>
          </div>
        )
      ) : null}

      {error ? (
        <p className="agent-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      {hasConnections && tokens ? (
        <>
          <h3 className="agent-list-title">Connected assistants</h3>
          <ul className="agent-list">
            {tokens.map((token) => (
              <li className="agent-row" key={token.id}>
                <div className="agent-row-copy">
                  <strong>{token.name}</strong>
                  <span>
                    Key ending in {token.tokenHint.slice(-4)} ·{" "}
                    {token.status === "expired"
                      ? `Expired ${formatDate(token.expiresAt)}`
                      : `Expires ${formatDate(token.expiresAt)}`}
                  </span>
                  <span>
                    {token.lastUsedAt
                      ? `Last used ${formatDate(token.lastUsedAt)}`
                      : "Not used yet"}
                  </span>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => revokeToken(token)}
                  type="button"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </article>
  );
}
