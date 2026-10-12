import { useEffect, useState } from "react";
import { checkHealth } from "./health";

type Connection = "checking" | "connected" | "unavailable";

export function App() {
  const [connection, setConnection] = useState<Connection>("checking");
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: The retry counter deliberately triggers a fresh health request.
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    let active = true;
    setConnection("checking");
    void checkHealth(controller.signal)
      .then(() => {
        if (active) setConnection("connected");
      })
      .catch(() => {
        if (active) setConnection("unavailable");
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [attempt]);

  function retry() {
    setConnection("checking");
    setAttempt((value) => value + 1);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#scenarios">Webhook tester</a>
        <nav aria-label="Main navigation">
          <a href="#scenarios">Scenarios</a>
          <a href="#connection">Connection</a>
        </nav>
        <p className="sidebar-note">Local workspace</p>
      </aside>
      <main>
        <header className="page-header">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1 id="scenarios">Scenarios</h1>
          </div>
          <span className="count">0 scenarios</span>
        </header>
        <section className="empty-state" aria-label="Scenario list">
          <span className="empty-icon" aria-hidden="true">↗</span>
          <h2>No scenarios yet</h2>
          <p>This workspace is empty. Scenario creation and execution are planned.</p>
        </section>
        <section id="connection" className="connection-card" aria-labelledby="connection-title">
          <div>
            <h2 id="connection-title">API connection</h2>
            <p>Checks the local API health endpoint.</p>
          </div>
          <div className="connection-actions">
            <p className={`status status-${connection}`} role="status" aria-live="polite">
              <span className="status-dot" aria-hidden="true" />
              {connection === "checking" ? "Checking…" : connection === "connected" ? "Connected" : "Unavailable"}
            </p>
            <button type="button" onClick={retry} disabled={connection === "checking"}>
              Check again
            </button>
          </div>
          {connection === "unavailable" && (
            <p className="connection-help">The API could not be reached or returned an unexpected response. Start the API and check again.</p>
          )}
        </section>
      </main>
    </div>
  );
}
