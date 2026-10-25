export function BuildDetails() {
  return (
    <section className="options-panel-section">
      <div className="section-label">About</div>
      <ul className="compact-list meta">
        <li>
          <strong>Extension version</strong>
          <span>{__APP_VERSION__}</span>
        </li>
        <li>
          <strong>Build commit</strong>
          <span>{__COMMIT_ID__}</span>
        </li>
      </ul>
    </section>
  );
}
