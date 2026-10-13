import type { RunHistoryPage, RunSummary } from "@webhook-tester/contracts";
import { useEffect, useState } from "react";
import { loadRunHistory } from "./api";

function runLabel(run: RunSummary) {
	return `${run.scenarioName} · ${run.targetSnapshot.name} · ${run.status} · ${run.id}`;
}

export function RunComparisonPicker({
	runs,
	left,
	right,
	onLeft,
	onRight,
}: {
	runs: RunSummary[];
	left: RunSummary | null;
	right: RunSummary | null;
	onLeft: (run: RunSummary | null) => void;
	onRight: (run: RunSummary | null) => void;
}) {
	// Keep only this page and the two selected summaries, even after paging.
	const options = new Map(runs.map((run) => [run.id, run]));
	if (left && !options.has(left.id)) options.set(left.id, left);
	if (right && !options.has(right.id)) options.set(right.id, right);
	return (
		<section
			className="panel comparison-picker"
			aria-label="Select runs to compare"
		>
			<div className="form-field">
				<label>
					First run
					<select
						value={left?.id ?? ""}
						onChange={(event) =>
							onLeft(options.get(event.target.value) ?? null)
						}
					>
						<option value="">Choose a run</option>
						{[...options.values()].map((run) => (
							<option key={run.id} value={run.id}>
								{runLabel(run)}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className="form-field">
				<label>
					Second run
					<select
						value={right?.id ?? ""}
						onChange={(event) =>
							onRight(options.get(event.target.value) ?? null)
						}
					>
						<option value="">Choose a run</option>
						{[...options.values()].map((run) => (
							<option key={run.id} value={run.id}>
								{runLabel(run)}
							</option>
						))}
					</select>
				</label>
			</div>
			{left && right && left.id !== right.id ? (
				<a
					className="button-link primary"
					href={`#/compare/${encodeURIComponent(left.id)}/${encodeURIComponent(right.id)}`}
				>
					Compare runs
				</a>
			) : (
				<button type="button" disabled>
					Compare runs
				</button>
			)}
			<p className="section-help picker-help">
				Select two different saved runs. Selections stay available while paging.
			</p>
		</section>
	);
}

export function RunHistoryTable({ runs }: { runs: RunSummary[] }) {
	return (
		<div className="table-scroll">
			<table className="history-table" aria-label="Saved runs">
				<thead>
					<tr>
						<th>Created</th>
						<th>Scenario / run</th>
						<th>Target</th>
						<th>Status / phase</th>
						<th>Source run</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((run) => (
						<tr key={run.id}>
							<td>
								<time dateTime={run.createdAt}>
									{new Date(run.createdAt).toLocaleString()}
								</time>
							</td>
							<td>
								<a
									className="table-link"
									href={`#/runs/${encodeURIComponent(run.id)}`}
								>
									{run.scenarioName}
									<span className="mono history-run-id">{run.id}</span>
								</a>
							</td>
							<td>
								{run.targetSnapshot.name}
								<span className="mono history-run-id">
									{run.targetSnapshot.id}
								</span>
							</td>
							<td>
								<span className={`run-status run-status-${run.status}`}>
									{run.status}
								</span>
								<span className="history-run-id">{run.phase}</span>
							</td>
							<td>
								{run.sourceRunId ? (
									<a
										className="table-link mono"
										href={`#/runs/${encodeURIComponent(run.sourceRunId)}`}
									>
										{run.sourceRunId}
									</a>
								) : (
									"Original run"
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

export function RunHistory() {
	const [page, setPage] = useState<RunHistoryPage | null>(null);
	const [before, setBefore] = useState<string | undefined>();
	const [attempt, setAttempt] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [left, setLeft] = useState<RunSummary | null>(null);
	const [right, setRight] = useState<RunSummary | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry and refresh reload the selected saved page.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		setPage(null);
		void loadRunHistory(before, controller.signal)
			.then((saved) => {
				if (!controller.signal.aborted) setPage(saved);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted)
					setError(
						reason instanceof Error
							? reason.message
							: "Unable to load run history.",
					);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [before, attempt]);

	return (
		<>
			<header className="page-header">
				<div>
					<h1>Run history</h1>
					<p className="subheading">
						Browse saved runs and compare their results.
					</p>
				</div>
				<button
					type="button"
					disabled={loading}
					onClick={() => setAttempt((value) => value + 1)}
				>
					Refresh history
				</button>
			</header>
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
			{loading && <p role="status">Loading saved runs...</p>}
			{page?.runs.length || left || right ? (
				<RunComparisonPicker
					runs={page?.runs ?? []}
					left={left}
					right={right}
					onLeft={setLeft}
					onRight={setRight}
				/>
			) : null}
			{page && (
				<section className={page.runs.length ? "panel" : "empty-state"}>
					{page.runs.length ? (
						<RunHistoryTable runs={page.runs} />
					) : (
						<>
							<h2>No saved runs</h2>
							<p>
								{before
									? "No older runs are available."
									: "Run a saved scenario to see its results here."}
							</p>
						</>
					)}
				</section>
			)}
			<section className="history-pagination" aria-label="Run history pages">
				<button
					type="button"
					disabled={loading || !before}
					onClick={() => setBefore(undefined)}
				>
					Newest
				</button>
				<button
					type="button"
					disabled={loading || !page?.nextCursor}
					onClick={() => {
						if (page?.nextCursor) setBefore(page.nextCursor);
					}}
				>
					Older
				</button>
			</section>
		</>
	);
}
