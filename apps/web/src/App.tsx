import { useEffect, useState } from "react";
import { RunView } from "./RunView";
import { ScenarioList } from "./ScenarioList";

function currentRunId() {
	const match = /^#\/runs\/([^/]+)$/.exec(window.location.hash);
	try {
		return match?.[1] ? decodeURIComponent(match[1]) : null;
	} catch {
		return null;
	}
}

export function App() {
	const [runId, setRunId] = useState(currentRunId);
	useEffect(() => {
		const navigate = () => setRunId(currentRunId());
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);

	return (
		<div className="shell">
			<aside className="sidebar">
				<a className="brand" href="#/scenarios">
					Webhook tester
				</a>
				<nav aria-label="Main navigation">
					<a href="#/scenarios" aria-current={runId ? undefined : "page"}>
						Scenarios
					</a>
				</nav>
				<p className="sidebar-note">Local workspace</p>
			</aside>
			<main>
				{runId ? <RunView key={runId} runId={runId} /> : <ScenarioList />}
			</main>
		</div>
	);
}
