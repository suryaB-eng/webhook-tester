import type { JsonScalar, RunEvent } from "@webhook-tester/contracts";
import { useState } from "react";
import { useRunStream } from "./useRunStream";

function time(value: string | null) {
	return value ? new Date(value).toLocaleString() : "—";
}
function scalar(value: JsonScalar) {
	return JSON.stringify(value);
}

const eventLabels: Record<RunEvent["type"], string> = {
	"run.queued": "Run queued",
	"run.started": "Run started",
	"run.phase": "Phase changed",
	"run.completed": "Run completed",
	"delivery.scheduled": "Delivery scheduled",
	"delivery.started": "Delivery started",
	"delivery.completed": "Delivery completed",
	"delivery.interrupted": "Delivery interrupted",
	"assertion.completed": "Assertion completed",
};

export function RunTimeline({ events, onSelectDelivery }: { events: RunEvent[]; onSelectDelivery?: (deliveryId: string) => void }) {
	return (
		<section className="panel" aria-labelledby="timeline-title">
			<h2 id="timeline-title">Activity</h2>
			<p className="section-help">Saved run activity in the order it was recorded.</p>
			{events.length === 0 ? <p className="section-help">No activity recorded yet.</p> : (
				<ol className="run-timeline">
					{events.map((event) => {
						const payload = event.payload;
						const deliveryId = payload.deliveryId;
						return (
							<li key={event.cursor}>
								<div className="timeline-heading">
									<strong>{eventLabels[event.type]}</strong>
									<time dateTime={event.createdAt}>{time(event.createdAt)}</time>
								</div>
								<div className="timeline-detail">
									{deliveryId && (onSelectDelivery ? (
										<button type="button" className="delivery-select mono" onClick={() => onSelectDelivery(deliveryId)}>{deliveryId}</button>
									) : <span className="mono">{deliveryId}</span>)}
									{payload.phase && <span>{payload.phase}</span>}
									{payload.status && <span>{payload.status}</span>}
									{payload.outcome && <span>{payload.outcome}</span>}
									{payload.httpStatus != null && <span>HTTP {payload.httpStatus}</span>}
									{payload.assertionName && <span>{payload.assertionName}</span>}
									{payload.assertionStatus && <span>{payload.assertionStatus}</span>}
								</div>
								{event.type === "assertion.completed" && (
									<p className="section-help mono">
										Expected {JSON.stringify(payload.expected)}; {payload.assertionStatus === "error" ? "Actual not recorded" : `actual ${JSON.stringify(payload.actual)}`}
									</p>
								)}
							</li>
							);
						})}
					</ol>
				)}
		</section>
	);
}

export function RunView({ runId }: { runId: string }) {
	const { run, error, connection, refreshing, refresh } = useRunStream(runId);
	const [selectedId, setSelectedId] = useState<string | null>(null);

	const selected =
		run?.deliveries.find((delivery) => delivery.deliveryId === selectedId) ??
		run?.deliveries[0];
	return (
		<>
			<a className="back-link" href="#/scenarios">
				← Scenarios
			</a>
			{error && (
				<div className="notice error" role="alert">
					<p>{error}</p>
					<button
						type="button"
						onClick={refresh}
						disabled={refreshing}
					>
						Try again
					</button>
				</div>
			)}
			{!run && !error && <p role="status">Loading run...</p>}
			{run && (
				<>
					<header className="page-header">
						<div>
							<h1>{run.scenarioSnapshot.name}</h1>
							<p className="subheading">{run.targetSnapshot.name}</p>
						</div>
						<span
							className={`run-status run-status-${run.status}`}
							role="status"
						>
							{run.status}
						</span>
					</header>
					<div className="run-live-controls">
						<p role="status" aria-live="polite" className={`stream-state stream-state-${connection}`}>
							{connection === "complete" ? "Saved run complete" : connection === "live" ? "Live updates connected" : connection === "reconnecting" ? "Reconnecting to live updates..." : "Connecting to live updates..."}
							{refreshing && " Updating saved results..."}
						</p>
						<button type="button" onClick={refresh} disabled={refreshing}>Refresh results</button>
					</div>
					<section className="panel run-summary" aria-label="Run details">
						<dl>
							<div>
								<dt>Run ID</dt>
								<dd className="mono">{run.id}</dd>
							</div>
							<div>
								<dt>Phase</dt>
								<dd>{run.phase}</dd>
							</div>
							<div>
								<dt>Created</dt>
								<dd>{time(run.createdAt)}</dd>
							</div>
							<div>
								<dt>Started</dt>
								<dd>{time(run.startedAt)}</dd>
							</div>
							<div>
								<dt>Completed</dt>
								<dd>{time(run.completedAt)}</dd>
							</div>
						</dl>
						{run.error && <p className="error-text">{run.error}</p>}
					</section>
					<RunTimeline events={run.events} onSelectDelivery={setSelectedId} />
					<section className="panel" aria-labelledby="deliveries-title">
						<h2 id="deliveries-title">Deliveries</h2>
						<p className="section-help">
							Select a delivery to inspect its request and response.
						</p>
						<div className="table-scroll">
							<table>
								<thead>
									<tr>
										<th>Delivery</th>
										<th>Outcome</th>
										<th>HTTP</th>
										<th>Duration</th>
									</tr>
								</thead>
								<tbody>
									{run.deliveries.map((delivery) => (
										<tr key={delivery.deliveryId}>
											<td>
												<button
													type="button"
													className="delivery-select mono"
													aria-pressed={
														selected?.deliveryId === delivery.deliveryId
													}
													onClick={() => setSelectedId(delivery.deliveryId)}
												>
													{delivery.deliveryId}
												</button>
											</td>
											<td>{delivery.outcome}</td>
											<td>{delivery.httpStatus ?? "—"}</td>
											<td>
												{delivery.durationMs === null
													? "—"
													: `${delivery.durationMs} ms`}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
						{run.deliveries.length === 0 && <p>No deliveries recorded yet.</p>}
					</section>
					{selected && (
						<section className="panel" aria-labelledby="request-title">
							<h2 id="request-title">Request details</h2>
							<p className="mono section-help">{selected.deliveryId}</p>
							<dl className="timings">
								<div>
									<dt>Scheduled</dt>
									<dd>{time(selected.scheduledAt)}</dd>
								</div>
								<div>
									<dt>Started</dt>
									<dd>{time(selected.startedAt)}</dd>
								</div>
								<div>
									<dt>Completed</dt>
									<dd>{time(selected.completedAt)}</dd>
								</div>
							</dl>
							<h3>Payload</h3>
							<pre>{JSON.stringify(selected.requestPayload, null, 2)}</pre>
							<h3>Response</h3>
							<pre>{selected.responseExcerpt ?? "No response recorded."}</pre>
							{selected.responseTruncated && (
								<p className="section-help">Response truncated to 16 KiB.</p>
							)}
							{selected.error && <p className="error-text">{selected.error}</p>}
						</section>
					)}
					<section className="panel" aria-labelledby="assertions-title">
						<h2 id="assertions-title">Assertions</h2>
						<div className="assertion-list">
							{run.assertions.map((assertion) => (
								<article className="assertion" key={assertion.id}>
									<div className="assertion-header">
										<h3>{assertion.name}</h3>
										<span
											className={`run-status run-status-${assertion.status}`}
										>
											{assertion.status}
										</span>
									</div>
									<dl className="scalar-values">
										<div>
											<dt>Expected</dt>
											<dd className="mono">{scalar(assertion.expected)}</dd>
										</div>
										<div>
											<dt>Actual</dt>
											<dd className="mono">
												{assertion.status === "pending" ||
												assertion.status === "error"
													? "—"
													: scalar(assertion.actual)}
											</dd>
										</div>
									</dl>
									<details>
										<summary>SQL query</summary>
										<pre>{assertion.query}</pre>
									</details>
									{assertion.error && (
										<p className="error-text">{assertion.error}</p>
									)}
								</article>
							))}
						</div>
					</section>
				</>
			)}
		</>
	);
}
