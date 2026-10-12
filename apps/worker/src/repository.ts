import { performance } from "node:perf_hooks";
import type {
	JsonScalar,
	AssertionResult,
	PublicTarget,
	ScenarioV1,
} from "@webhook-tester/contracts";
import { appendRunEvent, connectWithTimeout } from "@webhook-tester/db";
import type { Pool } from "pg";
import { budgetSession, type ApplicationSession } from "./session.js";
import type { DeliveryCompletion } from "./target.js";

export interface ClaimedRun {
	id: string;
	scenario: ScenarioV1;
	target: PublicTarget;
}
async function transaction<T>(
	client: ApplicationSession,
	operation: () => Promise<T>,
): Promise<T> {
	await client.query("BEGIN");
	try {
		const result = await operation();
		await client.query("COMMIT");
		return result;
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			/* A lost owning session cannot roll back again. */
		}
		throw error;
	}
}
export async function interruptAbandoned(
	client: ApplicationSession,
): Promise<void> {
	await transaction(client, async () => {
		const rows = await client.query<{
			id: string;
		}>("SELECT id FROM runs WHERE status='running' ORDER BY id FOR UPDATE");
		for (const { id } of rows.rows) {
			await interruptDeliveries(client, id);
			await client.query(
				`UPDATE runs SET status='interrupted',phase='completed',completed_at=now(),
        error='Previous worker ownership was lost; run was not replayed' WHERE id=$1 AND status='running'`,
				[id],
			);
			await client.query(
				"UPDATE jobs SET status='interrupted', completed_at=now() WHERE run_id=$1 AND status='running'",
				[id],
			);
			await appendRunEvent(client, id, "run.completed", {
				status: "interrupted",
				phase: "completed",
			});
		}
	});
}
export async function claimNext(
	client: ApplicationSession,
	workerId: string,
): Promise<ClaimedRun | undefined> {
	return transaction(client, async () => {
		const result = await client.query<{
			id: string;
			scenario_snapshot: ScenarioV1;
			target_snapshot: PublicTarget;
		}>(`
      SELECT r.id,r.scenario_snapshot,r.target_snapshot FROM jobs j JOIN runs r ON r.id=j.run_id
      WHERE j.status='queued' AND r.status='queued' ORDER BY j.created_at,j.run_id
      FOR UPDATE OF r SKIP LOCKED LIMIT 1`);
		const row = result.rows[0];
		if (!row) return undefined;
		await client.query(
			"UPDATE jobs SET status='running', worker_id=$2, started_at=now() WHERE run_id=$1",
			[row.id, workerId],
		);
		await client.query(
			"UPDATE runs SET status='running', phase='setup', started_at=now() WHERE id=$1",
			[row.id],
		);
		await appendRunEvent(client, row.id, "run.started", {
			status: "running",
			phase: "setup",
		});
		return {
			id: row.id,
			scenario: row.scenario_snapshot,
			target: row.target_snapshot,
		};
	});
}
export async function stillAssigned(
	client: ApplicationSession,
	id: string,
	workerId: string,
): Promise<boolean> {
	const result = await client.query(
		`SELECT 1 FROM jobs j JOIN runs r ON r.id=j.run_id
    WHERE j.run_id=$1 AND j.worker_id=$2 AND j.status='running' AND r.status='running'`,
		[id, workerId],
	);
	return result.rowCount === 1;
}
export async function phase(
	client: ApplicationSession,
	id: string,
	value: string,
) {
	await transaction(client, async () => {
		if (!(await lockRunning(client, id))) return;
		const result = await client.query(
			"UPDATE runs SET phase=$2 WHERE id=$1 AND status='running' AND phase IS DISTINCT FROM $2",
			[id, value],
		);
		if (result.rowCount)
			await appendRunEvent(client, id, "run.phase", { phase: value });
	});
}
export async function schedule(
	client: ApplicationSession,
	id: string,
	deliveryId: string,
	at: Date,
) {
	await transaction(client, async () => {
		if (!(await lockRunning(client, id))) return;
		const result = await client.query(
			"UPDATE deliveries SET scheduled_at=$3 WHERE run_id=$1 AND delivery_id=$2 AND outcome='pending' AND scheduled_at IS NULL",
			[id, deliveryId, at],
		);
		if (result.rowCount)
			await appendRunEvent(client, id, "delivery.scheduled", { deliveryId });
	});
}
export async function startDelivery(
	client: ApplicationSession,
	id: string,
	deliveryId: string,
) {
	await transaction(client, async () => {
		if (!(await lockRunning(client, id))) return;
		const result = await client.query(
			"UPDATE deliveries SET started_at=now() WHERE run_id=$1 AND delivery_id=$2 AND outcome='pending' AND started_at IS NULL",
			[id, deliveryId],
		);
		if (result.rowCount)
			await appendRunEvent(client, id, "delivery.started", { deliveryId });
	});
}
export async function completeDelivery(
	client: ApplicationSession,
	id: string,
	deliveryId: string,
	result: DeliveryCompletion,
) {
	await transaction(client, async () => {
		if (!(await lockRunning(client, id))) return;
		const updated = await client.query(
			`UPDATE deliveries SET completed_at=now(),http_status=$3,duration_ms=$4,
    response_excerpt=$5,response_truncated=$6,outcome=$7,error=$8 WHERE run_id=$1 AND delivery_id=$2 AND outcome='pending' AND completed_at IS NULL`,
			[
				id,
				deliveryId,
				result.httpStatus,
				result.durationMs,
				result.responseExcerpt,
				result.responseTruncated,
				result.outcome,
				result.error,
			],
		);
		if (updated.rowCount)
			await appendRunEvent(client, id, "delivery.completed", {
				deliveryId,
				outcome: result.outcome,
				httpStatus: result.httpStatus,
			});
	});
}
export async function completeAssertion(
	client: ApplicationSession,
	id: string,
	assertionId: string,
	result: Pick<AssertionResult, "actual" | "status" | "error">,
) {
	await transaction(client, async () => {
		if (!(await lockRunning(client, id))) return;
		const updated = await client.query<{ name: string; expected: JsonScalar }>(
			"UPDATE assertions SET actual=$3::jsonb,status=$4,error=$5 WHERE run_id=$1 AND assertion_id=$2 AND status='pending' RETURNING name,expected",
			[
				id,
				assertionId,
				JSON.stringify(result.actual),
				result.status,
				result.error,
			],
		);
		const row = updated.rows[0];
		if (row)
			await appendRunEvent(client, id, "assertion.completed", {
				assertionId,
				assertionName: row.name,
				expected: row.expected,
				actual: result.actual,
				assertionStatus: result.status,
			});
	});
}
async function lockRunning(
	client: ApplicationSession,
	id: string,
): Promise<boolean> {
	return (
		(
			await client.query(
				"SELECT id FROM runs WHERE id=$1 AND status='running' FOR UPDATE",
				[id],
			)
		).rowCount === 1
	);
}
async function interruptDeliveries(client: ApplicationSession, id: string) {
	// The interruption is known; the target's completion time and response remain unknown.
	const deliveries = await client.query<{ delivery_id: string }>(
		`UPDATE deliveries SET outcome='interrupted',
    error=CASE WHEN started_at IS NULL THEN 'Worker ownership lost before dispatch' ELSE 'Worker ownership lost after dispatch; target completion is unknown' END
    WHERE run_id=$1 AND outcome='pending' AND completed_at IS NULL RETURNING delivery_id`,
		[id],
	);
	for (const row of deliveries.rows)
		await appendRunEvent(client, id, "delivery.interrupted", {
			deliveryId: row.delivery_id,
			outcome: "interrupted",
		});
}
async function finishOnClient(
	client: ApplicationSession,
	id: string,
	workerId: string,
	status: "passed" | "failed" | "error" | "interrupted",
	error: string | null,
) {
	if (!(await lockRunning(client, id))) return;
	const assigned = await client.query(
		"SELECT 1 FROM jobs WHERE run_id=$1 AND worker_id=$2 AND status='running'",
		[id, workerId],
	);
	if (!assigned.rowCount) return;
	if (status === "interrupted") await interruptDeliveries(client, id);
	const result = await client.query(
		`UPDATE runs SET status=$3,phase='completed',completed_at=now(),error=$4
    WHERE id=$1 AND status='running' AND EXISTS(SELECT 1 FROM jobs WHERE run_id=$1 AND worker_id=$2 AND status='running') RETURNING id`,
		[id, workerId, status, error],
	);
	if (!result.rowCount) return;
	await client.query(
		"UPDATE jobs SET status=$3,completed_at=now() WHERE run_id=$1 AND worker_id=$2",
		[id, workerId, status === "interrupted" ? "interrupted" : "completed"],
	);
	await appendRunEvent(client, id, "run.completed", {
		status,
		phase: "completed",
	});
}
export async function finishOwned(
	client: ApplicationSession,
	id: string,
	workerId: string,
	status: "passed" | "failed" | "error",
	error: string | null,
) {
	await transaction(client, () =>
		finishOnClient(client, id, workerId, status, error),
	);
}
export async function finishInterrupted(
	pool: Pool,
	id: string,
	workerId: string,
	error: string | null,
) {
	// This fenced update may run after losing the session; it cannot change a new owner's job.
	const deadline = performance.now() + 2000;
	const client = await connectWithTimeout(pool, deadline - performance.now());
	// A terminated pg client can report a second error while being discarded.
	client.on("error", () => {});
	const finalization = budgetSession(client, () => deadline);
	try {
		await transaction(finalization, () =>
			finishOnClient(finalization, id, workerId, "interrupted", error),
		);
	} finally {
		client.release(true);
	}
}
