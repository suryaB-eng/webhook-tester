import { randomUUID } from "node:crypto";
import {
	parseScenarioV1,
	validateDemoScenario,
	type AssertionResult,
	type DeliveryResult,
	type JsonScalar,
	type JsonValue,
	type PublicTarget,
	type RunResponse,
	type RunStatus,
	type ScenarioV1,
} from "@webhook-tester/contracts";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "./index.js";
import { appendRunEvent, readRunEvents } from "./events.js";

export class ScenarioNotFoundError extends Error {}

async function insertEvidence(
	client: PoolClient,
	runId: string,
	scenario: ScenarioV1,
): Promise<void> {
	const events = new Map(scenario.events.map((event) => [event.id, event]));
	let ordinal = 0;
	for (const step of scenario.steps) {
		for (const delivery of step.deliveries) {
			const event = events.get(delivery.eventId);
			if (!event) throw new Error("Validated event reference is missing");
			await client.query(
				`INSERT INTO deliveries(run_id,delivery_id,step_id,event_id,ordinal,request_payload)
        VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
				[
					runId,
					delivery.deliveryId,
					step.id,
					delivery.eventId,
					ordinal,
					JSON.stringify(event.payload),
				],
			);
			ordinal++;
		}
	}
	for (const [index, assertion] of scenario.assertions.entries()) {
		await client.query(
			`INSERT INTO assertions(run_id,assertion_id,ordinal,name,query,expected)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`,
			[
				runId,
				assertion.id,
				index,
				assertion.name,
				assertion.query,
				JSON.stringify(assertion.expected),
			],
		);
	}
}

export async function enqueueRun(
	pool: Pool,
	scenarioId: string,
	targetSelection: PublicTarget | ((scenario: ScenarioV1) => PublicTarget),
): Promise<string> {
	return withTransaction(pool, async (client) => {
		const result = await client.query<{ definition: unknown }>(
			"SELECT definition FROM scenarios WHERE id=$1 FOR SHARE",
			[scenarioId],
		);
		const row = result.rows[0];
		if (!row) throw new ScenarioNotFoundError("Scenario not found");
		const stored = parseScenarioV1(row.definition);
		const target =
			typeof targetSelection === "function"
				? targetSelection(stored)
				: targetSelection;
		const scenario = parseScenarioV1({ ...stored, targetId: target.id });
		validateDemoScenario(scenario);
		if (!target.name.trim()) throw new Error("Target name is required");
		// Copy only the public identity, even when server configuration also holds an endpoint.
		const snapshot: PublicTarget = { id: target.id, name: target.name };
		const id = randomUUID();
		await client.query(
			`INSERT INTO runs(id,status,phase,scenario_snapshot,target_snapshot)
      VALUES($1,'queued','queued',$2::jsonb,$3::jsonb)`,
			[id, JSON.stringify(scenario), JSON.stringify(snapshot)],
		);
		await client.query("INSERT INTO jobs(run_id,status) VALUES($1,'queued')", [
			id,
		]);
		await insertEvidence(client, id, scenario);
		await appendRunEvent(client, id, "run.queued", { status: "queued", phase: "queued" });
		return id;
	});
}

interface RunRow {
	id: string;
	status: RunStatus;
	phase: string;
	scenario_snapshot: ScenarioV1;
	target_snapshot: PublicTarget;
	created_at: Date;
	started_at: Date | null;
	completed_at: Date | null;
	error: string | null;
}
interface DeliveryRow {
	delivery_id: string;
	step_id: string;
	event_id: string;
	ordinal: number;
	request_payload: JsonValue;
	scheduled_at: Date | null;
	started_at: Date | null;
	completed_at: Date | null;
	http_status: number | null;
	duration_ms: number | null;
	response_excerpt: string | null;
	response_truncated: boolean;
	outcome: DeliveryResult["outcome"];
	error: string | null;
}
interface AssertionRow {
	assertion_id: string;
	name: string;
	query: string;
	expected: JsonScalar;
	actual: JsonScalar | null;
	status: AssertionResult["status"];
	error: string | null;
}
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export async function getRun(
	pool: Pool,
	id: string,
): Promise<RunResponse | null> {
	// One database snapshot keeps a polling response consistent while the worker writes results.
	const client = await pool.connect();
	let discard = false;
	const markBroken = () => { discard = true; };
	client.on("error", markBroken);
	try {
		await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
		const result = await client.query<RunRow>(
			"SELECT * FROM runs WHERE id=$1",
			[id],
		);
		const run = result.rows[0];
		if (!run) {
			await client.query("COMMIT");
			return null;
		}
		const deliveries = await client.query<DeliveryRow>(
			"SELECT * FROM deliveries WHERE run_id=$1 ORDER BY ordinal",
			[id],
		);
		const assertions = await client.query<AssertionRow>(
			"SELECT * FROM assertions WHERE run_id=$1 ORDER BY ordinal",
			[id],
		);
		const events = await readRunEvents(client, id);
		await client.query("COMMIT");
		return {
			id: run.id,
			status: run.status,
			phase: run.phase,
			scenarioSnapshot: parseScenarioV1(run.scenario_snapshot),
			targetSnapshot: {
				id: run.target_snapshot.id,
				name: run.target_snapshot.name,
			},
			createdAt: run.created_at.toISOString(),
			startedAt: iso(run.started_at),
			completedAt: iso(run.completed_at),
			error: run.error,
			events,
			eventCursor: events.at(-1)?.cursor ?? "0",
			deliveries: deliveries.rows.map((delivery) => ({
				deliveryId: delivery.delivery_id,
				stepId: delivery.step_id,
				eventId: delivery.event_id,
				ordinal: delivery.ordinal,
				scheduledAt: iso(delivery.scheduled_at),
				startedAt: iso(delivery.started_at),
				completedAt: iso(delivery.completed_at),
				requestPayload: delivery.request_payload,
				httpStatus: delivery.http_status,
				durationMs: delivery.duration_ms,
				responseExcerpt: delivery.response_excerpt,
				responseTruncated: delivery.response_truncated,
				outcome: delivery.outcome,
				error: delivery.error,
			})),
			assertions: assertions.rows.map((assertion) => ({
				id: assertion.assertion_id,
				name: assertion.name,
				query: assertion.query,
				expected: assertion.expected,
				actual: assertion.actual,
				status: assertion.status,
				error: assertion.error,
			})),
		};
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
