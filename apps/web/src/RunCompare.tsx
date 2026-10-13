import type {
	AssertionResult,
	DeliveryResult,
	RunResponse,
} from "@webhook-tester/contracts";
import { type ReactNode, useEffect, useState } from "react";
import { loadRun } from "./api";
import { compareRuns } from "./run-comparison";

function RunIdentity({ label, run }: { label: string; run: RunResponse }) {
	return (
		<section className="panel run-summary" aria-label={`${label} run`}>
			<h2>{label} run</h2>
			<a className="mono" href={`#/runs/${run.id}`}>
				{run.id}
			</a>
			<dl>
				<div>
					<dt>Scenario</dt>
					<dd>{run.scenarioSnapshot.name}</dd>
				</div>
				<div>
					<dt>Target</dt>
					<dd>
						{run.targetSnapshot.name}{" "}
						<span className="mono">({run.targetSnapshot.id})</span>
					</dd>
				</div>
				<div>
					<dt>Status</dt>
					<dd>
						<span className={`run-status run-status-${run.status}`}>
							{run.status}
						</span>
					</dd>
				</div>
				<div>
					<dt>Phase</dt>
					<dd>{run.phase}</dd>
				</div>
				<div>
					<dt>Created</dt>
					<dd>
						<time dateTime={run.createdAt}>
							{new Date(run.createdAt).toLocaleString()}
						</time>
					</dd>
				</div>
				{run.sourceRunId && (
					<div>
						<dt>Source run</dt>
						<dd>
							<a className="mono" href={`#/runs/${run.sourceRunId}`}>
								{run.sourceRunId}
							</a>
						</dd>
					</div>
				)}
			</dl>
			{run.error && <p className="error-text">{run.error}</p>}
		</section>
	);
}

function CompareTable({
	title,
	headers,
	rows,
	empty,
}: {
	title: string;
	headers: string[];
	rows: Array<{ id: string; cells: ReactNode[] }>;
	empty?: string;
}) {
	return (
		<section className="panel">
			<h2>{title}</h2>
			{rows.length === 0 ? (
				<p className="section-help">{empty}</p>
			) : (
				<div className="table-scroll">
					<table className="comparison-table" aria-label={title}>
						<thead>
							<tr>
								{headers.map((header) => (
									<th scope="col" key={header}>
										{header}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.id}>
									{headers.map((header, index) =>
										index === 0 ? (
											<th scope="row" key={header}>
												{row.cells[index]}
											</th>
										) : (
											<td key={header}>{row.cells[index]}</td>
										),
									)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

function ConfigurationValue({
	value,
	label,
}: {
	value: string;
	label: string;
}) {
	return value.includes("\n") ? (
		<details>
			<summary aria-label={`View ${label}`}>View saved JSON</summary>
			<pre className="comparison-value">{value}</pre>
		</details>
	) : (
		<span className="comparison-value">{value || "(empty)"}</span>
	);
}

function DeliveryValue({ delivery }: { delivery: DeliveryResult | null }) {
	if (!delivery) return <span>Missing</span>;
	return (
		<>
			<dl>
				<div>
					<dt>HTTP</dt>
					<dd>{delivery.httpStatus ?? "Not recorded"}</dd>
				</div>
				<div>
					<dt>Outcome</dt>
					<dd>{delivery.outcome}</dd>
				</div>
				<div>
					<dt>Duration</dt>
					<dd>
						{delivery.durationMs === null
							? "Not recorded"
							: `${delivery.durationMs} ms`}
					</dd>
				</div>
			</dl>
			{delivery.error && <p className="error-text">{delivery.error}</p>}
		</>
	);
}

function AssertionValue({ assertion }: { assertion: AssertionResult | null }) {
	if (!assertion) return <span>Missing</span>;
	return (
		<>
			<p>{assertion.name}</p>
			<dl>
				<div>
					<dt>Status</dt>
					<dd>
						<span className={`run-status run-status-${assertion.status}`}>
							{assertion.status}
						</span>
					</dd>
				</div>
				<div>
					<dt>Expected</dt>
					<dd className="mono comparison-value">
						{JSON.stringify(assertion.expected)}
					</dd>
				</div>
				<div>
					<dt>Actual</dt>
					<dd className="mono comparison-value">
						{assertion.status === "pending" || assertion.status === "error"
							? "Actual not recorded"
							: JSON.stringify(assertion.actual)}
					</dd>
				</div>
			</dl>
			<details>
				<summary>SQL query</summary>
				<pre className="comparison-value">{assertion.query}</pre>
			</details>
			{assertion.error && <p className="error-text">{assertion.error}</p>}
		</>
	);
}

export function RunComparisonView({
	left,
	right,
}: {
	left: RunResponse;
	right: RunResponse;
}) {
	const comparison = compareRuns(left, right);
	return (
		<>
			<div className="comparison-identities">
				<RunIdentity label="First" run={left} />
				<RunIdentity label="Second" run={right} />
			</div>
			{comparison.isSnapshotRerun && (
				<p className="section-help">
					{right.sourceRunId === left.id
						? "Second run is a snapshot rerun of the first."
						: "First run is a snapshot rerun of the second."}
				</p>
			)}
			<CompareTable
				title="Saved configuration"
				headers={["Setting", "First run", "Second run", "Comparison"]}
				rows={comparison.configuration.map((row) => ({
					id: row.label,
					cells: [
						row.label,
						<ConfigurationValue
							key="left"
							value={row.values[0]}
							label={`first run ${row.label}`}
						/>,
						<ConfigurationValue
							key="right"
							value={row.values[1]}
							label={`second run ${row.label}`}
						/>,
						row.same ? "Same" : "Different",
					],
				}))}
			/>
			<CompareTable
				title="Delivery results"
				headers={["Delivery ID", "First run", "Second run"]}
				empty="No deliveries recorded in either run."
				rows={comparison.deliveries.map((row) => ({
					id: row.deliveryId,
					cells: [
						<span className="mono" key="id">
							{row.deliveryId}
						</span>,
						<DeliveryValue key="left" delivery={row.left} />,
						<DeliveryValue key="right" delivery={row.right} />,
					],
				}))}
			/>
			<CompareTable
				title="Assertion results"
				headers={["Assertion ID", "First run", "Second run"]}
				empty="No assertions recorded in either run."
				rows={comparison.assertions.map((row) => ({
					id: row.assertionId,
					cells: [
						<span className="mono" key="id">
							{row.assertionId}
						</span>,
						<AssertionValue key="left" assertion={row.left} />,
						<AssertionValue key="right" assertion={row.right} />,
					],
				}))}
			/>
		</>
	);
}

interface ComparisonState {
	key: string;
	runs: [RunResponse, RunResponse] | null;
	error: string | null;
	loading: boolean;
}

export function RunCompare({
	leftId,
	rightId,
}: {
	leftId: string;
	rightId: string;
}) {
	const key = JSON.stringify([leftId, rightId]);
	const [state, setState] = useState<ComparisonState>({
		key,
		runs: null,
		error: null,
		loading: true,
	});
	const [refreshCount, setRefreshCount] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Manual refresh reloads the two persisted run responses.
	useEffect(() => {
		if (!leftId || !rightId) return;
		const controller = new AbortController();
		setState((previous) => ({
			key,
			runs: previous.key === key ? previous.runs : null,
			error: null,
			loading: true,
		}));
		void Promise.all([
			loadRun(leftId, controller.signal),
			loadRun(rightId, controller.signal),
		])
			.then(([left, right]) => {
				if (!controller.signal.aborted)
					setState({ key, runs: [left, right], error: null, loading: false });
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted)
					setState((previous) => ({
						...previous,
						error:
							error instanceof Error
								? error.message
								: "Could not load both saved runs.",
						loading: false,
					}));
			});
		return () => controller.abort();
	}, [leftId, rightId, key, refreshCount]);
	const current =
		state.key === key ? state : { key, runs: null, error: null, loading: true };
	const refresh = () => setRefreshCount((count) => count + 1);
	return (
		<>
			<a className="back-link" href="#/runs">
				← Run history
			</a>
			<header className="page-header">
				<div>
					<h1>Compare saved runs</h1>
					<p className="subheading">
						First: <span className="mono">{leftId}</span> · Second:{" "}
						<span className="mono">{rightId}</span>
					</p>
				</div>
				{leftId && rightId && (
					<button type="button" onClick={refresh} disabled={current.loading}>
						Refresh results
					</button>
				)}
			</header>
			{!leftId || !rightId ? (
				<p className="notice" role="alert">
					Choose two saved runs from <a href="#/runs">run history</a>.
				</p>
			) : (
				<>
					{current.error && (
						<div className="notice error" role="alert">
							<p>{current.error}</p>
							<button
								type="button"
								onClick={refresh}
								disabled={current.loading}
							>
								Try again
							</button>
						</div>
					)}
					{current.loading && (
						<p role="status">
							{current.runs
								? "Refreshing saved results..."
								: "Loading saved runs..."}
						</p>
					)}
					{current.runs && (
						<>
							<p className="section-help">
								Showing saved results. Refresh to update active runs.
							</p>
							<RunComparisonView
								left={current.runs[0]}
								right={current.runs[1]}
							/>
						</>
					)}
				</>
			)}
		</>
	);
}
