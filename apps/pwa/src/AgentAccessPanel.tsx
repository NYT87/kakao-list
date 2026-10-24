import type {
  AgentConnection,
  AgentToken,
  CloudSyncClient,
  CreateAgentTokenInput,
  CreatedAgentToken,
} from "@kakao-lists/domain";
import { useCallback, useEffect, useState } from "react";

type Lifetime = NonNullable<CreateAgentTokenInput["expiresInDays"]>;
type View = "collapsed" | "signIn" | "keyForm";

/** One row in "Connected assistants": a Kakao sign-in or a connection key. */
type ConnectedAssistant =
  | { kind: "signIn"; createdAt: string; connection: AgentConnection }
  | { kind: "key"; createdAt: string; token: AgentToken };

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
// through the read-only MCP endpoint. The main path is adding the server
// address in the assistant and signing in with Kakao; connection keys are the
// fallback for assistants without sign-in support. Starts collapsed because
// most users never connect one. See docs/agent-access.md.
export function AgentAccessPanel({
  client,
  mcpUrl,
  formatDate,
  onNotify,
}: AgentAccessPanelProps) {
  const [assistants, setAssistants] = useState<ConnectedAssistant[] | null>(
    null,
  );
  const [signInAvailable, setSignInAvailable] = useState(false);
  const [view, setView] = useState<View>("collapsed");
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

  const loadAssistants = useCallback(async () => {
    try {
      const available = await client.isAgentSignInAvailable();
      const [tokens, connections] = await Promise.all([
        client.listAgentTokens(),
        available ? client.listAgentConnections() : Promise.resolve([]),
      ]);
      setSignInAvailable(available);
      setAssistants(
        [
          ...connections.map(
            (connection): ConnectedAssistant => ({
              kind: "signIn",
              createdAt: connection.createdAt,
              connection,
            }),
          ),
          ...tokens.map(
            (token): ConnectedAssistant => ({
              kind: "key",
              createdAt: token.createdAt,
              token,
            }),
          ),
        ].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
      );
    } catch (cause) {
      setAssistants([]);
      showError(cause, "Could not load your connected assistants.");
    }
  }, [client, showError]);

  useEffect(() => {
    void loadAssistants();
  }, [loadAssistants]);

  const hasConnections = (assistants?.length ?? 0) > 0;

  function openConnect() {
    setView(signInAvailable ? "signIn" : "keyForm");
    setError(null);
  }

  function closeConnect() {
    setView("collapsed");
    setName("");
    setError(null);
  }

  async function finishSignIn() {
    closeConnect();
    await loadAssistants();
  }

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
      setView("collapsed");
      await loadAssistants();
    } catch (cause) {
      showError(cause, "Could not create the connection key.");
    } finally {
      setBusy(false);
      setCreating(false);
    }
  }

  async function disconnect(assistant: ConnectedAssistant) {
    const label =
      assistant.kind === "signIn"
        ? assistant.connection.clientName
        : assistant.token.name;
    if (
      !window.confirm(
        `Disconnect "${label}"? It will stop being able to read your lists right away.`,
      )
    ) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      if (assistant.kind === "signIn") {
        await client.revokeAgentConnection(assistant.connection.id);
      } else {
        await client.revokeAgentToken(assistant.token.id);
        if (created?.agentToken.id === assistant.token.id) {
          setCreated(null);
        }
      }
      await loadAssistants();
      onNotify(`"${label}" disconnected`);
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

  return (
    <article className="panel agent-panel">
      <h2>AI Assistants</h2>
      <p className="panel-copy">
        Connect an AI assistant, such as Claude, to ask questions about your
        saved places. It can read your lists and notes but cannot change them.
      </p>

      {view === "collapsed" && !created ? (
        <div className="hero-actions compact agent-actions">
          <button
            className="button secondary"
            disabled={assistants === null || busy}
            onClick={openConnect}
            type="button"
          >
            {hasConnections
              ? "Connect another assistant"
              : "Connect an assistant"}
          </button>
        </div>
      ) : null}

      {view === "signIn" ? (
        <section
          className="agent-created"
          aria-labelledby="agent-sign-in-title"
        >
          <p className="agent-created-title" id="agent-sign-in-title">
            Add Kakao Lists to your assistant
          </p>
          <ol className="agent-steps">
            <li>
              In your assistant, add a custom connector with this address:
              <code className="agent-secret">{mcpUrl}</code>
            </li>
            <li>When it asks, sign in with Kakao.</li>
            <li>Ask it about your saved places.</li>
          </ol>
          <div className="hero-actions compact">
            <button
              className="button primary"
              onClick={() => copy(mcpUrl, "Address copied")}
              type="button"
            >
              Copy address
            </button>
            <button
              className="button secondary"
              onClick={() => void finishSignIn()}
              type="button"
            >
              Done
            </button>
          </div>
          <button
            className="agent-link"
            onClick={() => {
              setView("keyForm");
              setError(null);
            }}
            type="button"
          >
            My assistant needs a key instead
          </button>
        </section>
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

      {view === "keyForm" && !created ? (
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
              onClick={() =>
                signInAvailable ? setView("signIn") : closeConnect()
              }
              type="button"
            >
              {signInAvailable ? "Back" : "Cancel"}
            </button>
          </div>
        </form>
      ) : null}

      {error ? (
        <p className="agent-feedback is-error" role="alert">
          {error}
        </p>
      ) : null}

      {hasConnections && assistants ? (
        <>
          <h3 className="agent-list-title">Connected assistants</h3>
          <ul className="agent-list">
            {assistants.map((assistant) => (
              <li
                className="agent-row"
                key={`${assistant.kind}:${
                  assistant.kind === "signIn"
                    ? assistant.connection.id
                    : assistant.token.id
                }`}
              >
                {assistant.kind === "signIn" ? (
                  <div className="agent-row-copy">
                    <strong>{assistant.connection.clientName}</strong>
                    <span>
                      Signed in with Kakao · Connected{" "}
                      {formatDate(assistant.connection.createdAt)}
                    </span>
                    <span>
                      {assistant.connection.lastUsedAt
                        ? `Last used ${formatDate(assistant.connection.lastUsedAt)}`
                        : "Not used yet"}
                    </span>
                  </div>
                ) : (
                  <div className="agent-row-copy">
                    <strong>{assistant.token.name}</strong>
                    <span>
                      Key ending in {assistant.token.tokenHint.slice(-4)} ·{" "}
                      {assistant.token.status === "expired"
                        ? `Expired ${formatDate(assistant.token.expiresAt)}`
                        : `Expires ${formatDate(assistant.token.expiresAt)}`}
                    </span>
                    <span>
                      {assistant.token.lastUsedAt
                        ? `Last used ${formatDate(assistant.token.lastUsedAt)}`
                        : "Not used yet"}
                    </span>
                  </div>
                )}
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void disconnect(assistant)}
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
