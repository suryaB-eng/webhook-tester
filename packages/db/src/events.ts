import { jsonScalarSchema, type RunEvent, type RunEventPayload, type RunEventType, type RunStatus } from "@webhook-tester/contracts";
import type { Pool, PoolClient } from "pg";
import { connectWithTimeout } from "./index.js";

export interface RunEventClient {
	query(text: string, values?: unknown[]): Promise<unknown>;
}

const payloadKeys = [
	"status", "phase", "deliveryId", "outcome", "httpStatus", "assertionId",
	"assertionName", "expected", "actual", "assertionStatus",
] as const;
const eventTypes: ReadonlySet<string> = new Set([
	"run.queued", "run.started", "run.phase", "run.completed", "delivery.scheduled",
	"delivery.started", "delivery.completed", "delivery.interrupted", "assertion.completed",
]);
const enums: Record<string, readonly string[]> = {
	status: ["queued", "running", "passed", "failed", "error", "interrupted"],
	outcome: ["pending", "ok", "failed", "error", "interrupted"],
	assertionStatus: ["pending", "passed", "failed", "error"],
};

function validatePayloadValue(key: typeof payloadKeys[number], value: unknown): void {
	if (key === "expected" || key === "actual") {
		jsonScalarSchema.parse(value);
		return;
	}
	if (key === "httpStatus") {
		if (value === null || (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599)) return;
	} else if (enums[key]) {
		if (typeof value === "string" && enums[key]?.includes(value)) return;
	} else {
		const isId = key === "deliveryId" || key === "assertionId";
		if (typeof value === "string" && value.trim().length > 0 && value.length <= (isId ? 100 : 200)
			&& (!isId || /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value))) {
			jsonScalarSchema.parse(value);
			return;
		}
	}
	throw new Error(`Invalid run event ${key}`);
}

/** Caller must use a transaction and lock the run before changing its evidence. */
export async function appendRunEvent(
	client: RunEventClient,
	runId: string,
	type: RunEventType,
	payload: RunEventPayload,
): Promise<void> {
	if (!eventTypes.has(type)) throw new Error("Invalid run event type");
	const safePayload: RunEventPayload = {};
	for (const key of payloadKeys) {
		if (payload[key] !== undefined) {
			validatePayloadValue(key, payload[key]);
			Object.assign(safePayload, { [key]: payload[key] });
		}
	}
	// Allocate the identity only after the lock: concurrent writers commit in cursor order per run.
	await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [runId]);
	await client.query("INSERT INTO run_events(run_id,type,payload) VALUES($1,$2,$3::jsonb)",
		[runId, type, JSON.stringify(safePayload)]);
}

interface EventRow {
	cursor: string;
	run_id: string;
	type: RunEventType;
	payload: RunEventPayload;
	created_at: Date;
}
export async function readRunEvents(
	client: PoolClient,
	runId: string,
	after = "0",
	limit?: number,
): Promise<RunEvent[]> {
	const result = await client.query<EventRow>(
		`SELECT cursor::text,run_id,type,payload,created_at FROM run_events
      WHERE run_id=$1 AND cursor>$2::bigint ORDER BY run_events.cursor${limit === undefined ? "" : " LIMIT $3"}`,
		limit === undefined ? [runId, after] : [runId, after, limit],
	);
	return result.rows.map((row) => ({ cursor: row.cursor, runId: row.run_id, type: row.type,
		payload: row.payload, createdAt: row.created_at.toISOString() }));
}

/** Status and events share a snapshot so a terminal status cannot close a stream before its events. */
export async function getRunEventPage(pool: Pool, runId: string, after: string, limit?: number):
	Promise<{ status: RunStatus; events: RunEvent[] } | null> {
	const client = await connectWithTimeout(pool, 1000);
	let discard = false;
	const markBroken = () => { discard = true; };
	client.on("error", markBroken);
	try {
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		await client.query("SET LOCAL statement_timeout='1000ms'");
		const run = await client.query<{ status: RunStatus }>("SELECT status FROM runs WHERE id=$1", [runId]);
		if (!run.rows[0]) {
			await client.query("COMMIT");
			return null;
		}
		const events = await readRunEvents(client, runId, after, limit);
		await client.query("COMMIT");
		return { status: run.rows[0].status, events };
	} catch (error) {
		if (!discard) {
			try { await client.query("ROLLBACK"); } catch { discard = true; }
		}
		throw error;
	} finally {
		client.release(discard);
		if (discard) client.once("end", () => client.off("error", markBroken));
		else client.off("error", markBroken);
	}
}
