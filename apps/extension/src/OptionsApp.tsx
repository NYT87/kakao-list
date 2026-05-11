export default function OptionsApp() {
  return (
    <main className="options-shell">
      <section className="options-panel">
        <div className="badge">Extension / Options</div>
        <h1>Sync strategy notes</h1>
        <ul className="options-list">
          <li>The extension popup now has its own Kakao sign-in entry point through `chrome.identity`.</li>
          <li>Extension background alarms are scaffolded for later scheduled sync.</li>
          <li>With an active session, each popup load syncs from Kakao through the server and stores the snapshot locally.</li>
          <li>The shared storage package already includes a browser SQLite repository contract.</li>
        </ul>
      </section>
    </main>
  );
}
