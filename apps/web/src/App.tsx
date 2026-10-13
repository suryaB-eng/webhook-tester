import { useCallback, useEffect, useRef, useState } from "react";
import { RunView } from "./RunView";
import { RunHistory } from "./RunHistory";
import { RunCompare } from "./RunCompare";
import { ScenarioList } from "./ScenarioList";
import { ScenarioEditor } from "./ScenarioEditor";
import type { ScenarioV1 } from "@webhook-tester/contracts";

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
	const [hash, setHash] = useState(window.location.hash);
	const [imported, setImported] = useState<ScenarioV1 | undefined>();
	const dirty = useRef(false);
	const previousHash = useRef(window.location.hash);
	const setDirty = useCallback((value: boolean) => {
		dirty.current = value;
	}, []);
	useEffect(() => {
		const navigate = () => {
			if (
				dirty.current &&
				window.location.hash !== previousHash.current &&
				!window.confirm("Discard unsaved changes and leave this scenario?")
			) {
				window.history.replaceState(
					null,
					"",
					previousHash.current || "#/scenarios",
				);
				return;
			}
			dirty.current = false;
			previousHash.current = window.location.hash;
			setRunId(currentRunId());
			setHash(window.location.hash);
			if (window.location.hash !== "#/scenarios/new") setImported(undefined);
		};
		window.addEventListener("hashchange", navigate);
		return () => window.removeEventListener("hashchange", navigate);
	}, []);
	let editingId: string | undefined;
	try {
		const match = /^#\/scenarios\/([^/]+)\/edit$/.exec(hash);
		editingId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
	} catch {
		/* Invalid route returns to the list. */
	}
	const creating = hash === "#/scenarios/new";
	let comparison: { leftId: string; rightId: string } | null = null;
	try {
		const match = /^#\/compare\/([^/]+)\/([^/]+)$/.exec(hash);
		if (match?.[1] && match[2])
			comparison = {
				leftId: decodeURIComponent(match[1]),
				rightId: decodeURIComponent(match[2]),
			};
	} catch {
		/* Invalid route returns to the scenario list. */
	}
	const history = hash === "#/runs";
	const viewingRuns = history || Boolean(runId) || Boolean(comparison);

	return (
		<div className="shell">
			<aside className="sidebar">
				<a className="brand" href="#/scenarios">
					Webhook tester
				</a>
				<nav aria-label="Main navigation">
					<a href="#/scenarios" aria-current={viewingRuns ? undefined : "page"}>
						Scenarios
					</a>
					<a href="#/runs" aria-current={viewingRuns ? "page" : undefined}>
						Run history
					</a>
				</nav>
				<p className="sidebar-note">Local workspace</p>
			</aside>
			<main>
				{comparison ? (
					<RunCompare
						key={`${comparison.leftId}:${comparison.rightId}`}
						leftId={comparison.leftId}
						rightId={comparison.rightId}
					/>
				) : history ? (
					<RunHistory />
				) : runId ? (
					<RunView key={runId} runId={runId} />
				) : creating || editingId ? (
					<ScenarioEditor
						key={editingId ?? "new"}
						{...(editingId ? { scenarioId: editingId } : {})}
						{...(imported ? { initialDocument: imported } : {})}
						onDirtyChange={setDirty}
					/>
				) : (
					<ScenarioList
						onImport={(document) => {
							setImported(document);
							window.location.hash = "/scenarios/new";
						}}
					/>
				)}
			</main>
		</div>
	);
}
