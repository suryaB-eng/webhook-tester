import type { DemoStatus } from "@webhook-tester/contracts";
import { withTransaction } from "@webhook-tester/db";
import type { Pool } from "pg";
import { FixtureStateError } from "./payments.js";

// This profile deliberately lets each arrival overwrite a newer status.
export async function processFlawedStatus(
	pool: Pool,
	runId: string,
	event: DemoStatus,
) {
	const updated = await pool.query(
		`UPDATE orders SET status = $3, version = $4::bigint
      WHERE run_id = $1 AND order_id = $2 RETURNING order_id`,
		[runId, event.data.orderId, event.data.status, event.data.version],
	);
	if (updated.rowCount !== 1) {
		throw new FixtureStateError("Run-scoped order fixture is missing");
	}
}

export async function processCorrectedStatus(
	pool: Pool,
	runId: string,
	event: DemoStatus,
) {
	await withTransaction(pool, async (client) => {
		const updated = await client.query(
			`UPDATE orders SET status = $3, version = $4::bigint
        WHERE run_id = $1 AND order_id = $2 AND version < $4::bigint RETURNING order_id`,
			[runId, event.data.orderId, event.data.status, event.data.version],
		);
		if (updated.rowCount === 1) return;
		const existing = await client.query(
			"SELECT order_id FROM orders WHERE run_id = $1 AND order_id = $2",
			[runId, event.data.orderId],
		);
		if (existing.rowCount !== 1) {
			throw new FixtureStateError("Run-scoped order fixture is missing");
		}
	});
}
