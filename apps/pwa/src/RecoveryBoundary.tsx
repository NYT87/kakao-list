import { Component, type ErrorInfo, type ReactNode } from "react";
export class RecoveryBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    console.error("The interface could not be displayed.");
  }
  render() {
    return this.state.failed ? (
      <main className="shell">
        <h1>Could not open your lists</h1>
        <p>Your saved data is still on the server. Reload to try again.</p>
        <button
          type="button"
          onClick={() => {
            window.history.replaceState({}, "", window.location.pathname);
            window.location.reload();
          }}
        >
          Reload
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
