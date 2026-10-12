import { randomUUID } from "node:crypto";
import type { DemoPayment } from "@webhook-tester/contracts";
import { withTransaction } from "@webhook-tester/db";
import type { Pool, PoolClient } from "pg";

export class FixtureStateError extends Error {}

async function requireMatchingOrder(
	client: PoolClient,
	runId: string,
	event: DemoPayment,
) {
	const order = await client.query<{ quantity: number }>(
		"SELECT quantity FROM orders WHERE run_id = $1 AND order_id = $2 FOR UPDATE",
		[runId, event.data.orderId],
	);
	const row = order.rows[0];
	if (!row) throw new FixtureStateError("Run-scoped order fixture is missing");
	if (row.quantity !== event.data.quantity) {
		throw new FixtureStateError(
			"Payment quantity does not match the fixture order",
		);
	}
}

async function applyPaymentEffects(
	client: PoolClient,
	runId: string,
	event: DemoPayment,
) {
	const stock = await client.query(
		`UPDATE inventory SET quantity = quantity - $3
      WHERE run_id = $1 AND sku = $2 AND quantity >= $3 RETURNING quantity`,
		[runId, "sku_001", event.data.quantity],
	);
	if (stock.rowCount !== 1) {
		throw new FixtureStateError(
			"Run-scoped inventory is missing or insufficient",
		);
	}
	await client.query(
		`INSERT INTO fulfillments (id, run_id, order_id, business_event_id)
      VALUES ($1, $2, $3, $4)`,
		[randomUUID(), runId, event.data.orderId, event.id],
	);
}

// This profile deliberately repeats the business effect on every delivery.
export async function processFlawedPayment(
	pool: Pool,
	runId: string,
	event: DemoPayment,
) {
	await withTransaction(pool, async (client) => {
		await requireMatchingOrder(client, runId, event);
		await client.query(
			"UPDATE orders SET paid = true WHERE run_id = $1 AND order_id = $2",
			[runId, event.data.orderId],
		);
		await applyPaymentEffects(client, runId, event);
	});
}

export async function processCorrectedPayment(
	pool: Pool,
	runId: string,
	event: DemoPayment,
) {
	await withTransaction(pool, async (client) => {
		await requireMatchingOrder(client, runId, event);
		const claim = await client.query(
			`INSERT INTO processed_business_events (run_id, business_event_id, order_id, quantity)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (run_id, business_event_id) DO NOTHING
        RETURNING business_event_id`,
			[runId, event.id, event.data.orderId, event.data.quantity],
		);
		if (claim.rowCount !== 1) {
			const existing = await client.query<{
				order_id: string;
				quantity: number;
			}>(
				"SELECT order_id, quantity FROM processed_business_events WHERE run_id = $1 AND business_event_id = $2",
				[runId, event.id],
			);
			const row = existing.rows[0];
			if (
				!row ||
				row.order_id !== event.data.orderId ||
				row.quantity !== event.data.quantity
			) {
				throw new FixtureStateError(
					"Business event ID already belongs to a different payment",
				);
			}
			return;
		}
		const transition = await client.query(
			`UPDATE orders SET paid = true
        WHERE run_id = $1 AND order_id = $2 AND paid = false RETURNING order_id`,
			[runId, event.data.orderId],
		);
		if (transition.rowCount !== 1) return;
		await applyPaymentEffects(client, runId, event);
	});
}
