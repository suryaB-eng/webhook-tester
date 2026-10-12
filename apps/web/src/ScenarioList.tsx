import type {
	PublicTarget,
	ScenarioSummary,
	ScenarioV1,
} from "@webhook-tester/contracts";
import { useEffect, useRef, useState } from "react";
import {
	duplicateScenario,
	launchRun,
	loadScenario,
	loadScenarios,
	loadTargets,
} from "./api";
import { downloadScenario, ScenarioImport } from "./ScenarioEditor";

export function ScenarioList({
	onImport,
}: {
	onImport: (document: ScenarioV1) => void;
}) {
	const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
	const [targets, setTargets] = useState<PublicTarget[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [launching, setLaunching] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [busy, setBusy] = useState<string | null>(null);
	const launchController = useRef<AbortController | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: A retry reloads the server's saved scenarios.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setLaunching(null);
		setError(null);
		void Promise.all([
			loadScenarios(controller.signal),
			loadTargets(controller.signal),
		])
			.then(([saved, profiles]) => {
				setScenarios(saved);
				setTargets(profiles);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted)
					setError(
						reason instanceof Error
							? reason.message
							: "Unable to load scenarios.",
					);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => {
			controller.abort();
			launchController.current?.abort();
		};
	}, [attempt]);

	async function launch(scenarioId: string, targetId: string) {
		const controller = new AbortController();
		launchController.current = controller;
		setLaunching(`${scenarioId}:${targetId}`);
		setError(null);
		try {
			const runId = await launchRun(scenarioId, targetId, controller.signal);
			if (!controller.signal.aborted)
				window.location.hash = `/runs/${encodeURIComponent(runId)}`;
		} catch (reason) {
			if (!controller.signal.aborted)
				setError(
					reason instanceof Error ? reason.message : "Unable to start run.",
				);
		} finally {
			if (!controller.signal.aborted) setLaunching(null);
		}
	}
	async function manage(id: string, action: "duplicate" | "export") {
		const controller = new AbortController();
		launchController.current = controller;
		setBusy(`${id}:${action}`);
		setError(null);
		try {
			if (action === "duplicate") {
				const saved = await duplicateScenario(id, controller.signal);
				if (!controller.signal.aborted)
					window.location.hash = `/scenarios/${encodeURIComponent(saved.id)}/edit`;
			} else {
				const saved = await loadScenario(id, controller.signal);
				if (!controller.signal.aborted) downloadScenario(saved.document);
			}
		} catch (reason) {
			if (!controller.signal.aborted)
				setError(
					reason instanceof Error
						? reason.message
						: "Unable to complete the request.",
				);
		} finally {
			if (!controller.signal.aborted) setBusy(null);
		}
	}

	return (
		<>
			<header className="page-header">
				<div>
					<h1>Scenarios</h1>
					<p className="subheading">
						Run a saved webhook scenario against either profile.
					</p>
				</div>
				<div className="item-actions">
					<a className="button-link primary" href="#/scenarios/new">
						Create scenario
					</a>
					{!loading && (
						<span className="count">{scenarios.length} scenarios</span>
					)}
				</div>
			</header>
			<details className="panel">
				<summary>Import scenario JSON</summary>
				<ScenarioImport onImport={onImport} />
			</details>
			<p className="section-help profile-help">
				Without deduplication repeats payment effects and overwrites status on
				arrival. With deduplication applies each payment once and keeps the
				newest status version.
			</p>
			{error && (
				<div className="notice error" role="alert">
					<p>{error}</p>
					<button
						type="button"
						onClick={() => setAttempt((value) => value + 1)}
					>
						Try again
					</button>
				</div>
			)}
			{loading && <p role="status">Loading scenarios...</p>}
			{!loading && !error && scenarios.length === 0 && (
				<section className="empty-state">
					<h2>No saved scenarios</h2>
					<p>No scenarios are available in this workspace.</p>
				</section>
			)}
			<div className="scenario-list">
				{scenarios.map((scenario) => (
					<section
						className="panel scenario-card"
						key={scenario.id}
						aria-labelledby={`scenario-${scenario.id}`}
					>
						<h2 id={`scenario-${scenario.id}`}>{scenario.name}</h2>
						<p>{scenario.description}</p>
						<p className="scenario-revision">Revision {scenario.revision}</p>
						<div className="scenario-actions">
							<a
								className="button-link"
								href={`#/scenarios/${encodeURIComponent(scenario.id)}/edit`}
							>
								Edit
							</a>
							<button
								type="button"
								disabled={busy !== null || launching !== null}
								onClick={() => void manage(scenario.id, "duplicate")}
							>
								{busy === `${scenario.id}:duplicate`
									? "Duplicating…"
									: "Duplicate"}
							</button>
							<button
								type="button"
								disabled={busy !== null || launching !== null}
								onClick={() => void manage(scenario.id, "export")}
							>
								{busy === `${scenario.id}:export`
									? "Exporting…"
									: "Export JSON"}
							</button>
							{targets.map((target) => (
								<button
									key={target.id}
									type="button"
									disabled={launching !== null || busy !== null}
									onClick={() => void launch(scenario.id, target.id)}
								>
									{launching === `${scenario.id}:${target.id}`
										? "Starting..."
										: `Run · ${target.name}`}
								</button>
							))}
						</div>
					</section>
				))}
			</div>
		</>
	);
}
