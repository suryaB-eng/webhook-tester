import {
	parseScenarioV1,
	validateDemoScenario,
	type ScenarioSummary,
	type ScenarioV1,
} from "@webhook-tester/contracts";
import type { Pool } from "pg";
import { withTransaction } from "./index.js";

function preset(duplicate: boolean): ScenarioV1 {
	return {
		schemaVersion: 1,
		name: duplicate ? "Sequential duplicate payment" : "One payment",
		description: duplicate
			? "Deliver the same payment twice and check that its effect happens once."
			: "Deliver one payment and check fulfillment and inventory.",
		targetId: "demo-flawed",
		events: [
			{
				id: "payment",
				payload: {
					id: "payment_001",
					type: "payment.succeeded",
					data: { orderId: "order_001", quantity: 1 },
				},
			},
		],
		steps: [
			{
				id: "payments",
				mode: "sequential",
				delayBeforeMs: 0,
				deliveries: [
					{ deliveryId: "delivery_1", eventId: "payment" },
					...(duplicate
						? [{ deliveryId: "delivery_2", eventId: "payment" }]
						: []),
				],
			},
		],
		limits: { maxConcurrency: 1, requestTimeoutMs: 3000, runTimeoutMs: 30000 },
		assertions: [
			{
				id: "fulfillment_once",
				name: "One fulfillment",
				query:
					"SELECT count(*)::int AS value FROM fulfillments WHERE run_id=$1 AND order_id='order_001'",
				expected: 1,
			},
			{
				id: "inventory_once",
				name: "Inventory is 9",
				query:
					"SELECT quantity::int AS value FROM inventory WHERE run_id=$1 AND sku='sku_001'",
				expected: 9,
			},
		],
	};
}

function concurrentPaymentPreset(): ScenarioV1 {
	const scenario = preset(true);
	scenario.name = "Concurrent duplicate payment";
	scenario.description =
		"Deliver the same payment concurrently and check that its effect happens once.";
	scenario.steps = scenario.steps.map((step) => ({
		...step,
		mode: "concurrent",
	}));
	scenario.limits.maxConcurrency = 2;
	return scenario;
}

function statusPreset(): ScenarioV1 {
	return {
		schemaVersion: 1,
		name: "Status version 2 before version 1",
		description:
			"Deliver a newer status before an older one and check that the newer state remains.",
		targetId: "demo-flawed",
		events: [
			{
				id: "status_v2",
				payload: {
					id: "status_002",
					type: "order.status_changed",
					data: { orderId: "order_001", status: "shipped", version: 2 },
				},
			},
			{
				id: "status_v1",
				payload: {
					id: "status_001",
					type: "order.status_changed",
					data: { orderId: "order_001", status: "processing", version: 1 },
				},
			},
		],
		steps: [
			{
				id: "statuses",
				mode: "sequential",
				delayBeforeMs: 0,
				deliveries: [
					{ deliveryId: "delivery_1", eventId: "status_v2" },
					{ deliveryId: "delivery_2", eventId: "status_v1" },
				],
			},
		],
		limits: { maxConcurrency: 1, requestTimeoutMs: 3000, runTimeoutMs: 30000 },
		assertions: [
			{
				id: "latest_status",
				name: "Latest status is shipped",
				query:
					"SELECT status AS value FROM orders WHERE run_id=$1 AND order_id='order_001'",
				expected: "shipped",
			},
			{
				id: "latest_version",
				name: "Latest version is 2",
				query:
					"SELECT version::int AS value FROM orders WHERE run_id=$1 AND order_id='order_001'",
				expected: 2,
			},
		],
	};
}

export async function seedScenarios(pool: Pool): Promise<void> {
	await withTransaction(pool, async (client) => {
		for (const [id, scenario] of [
			["one-payment", preset(false)],
			["sequential-duplicate-payment", preset(true)],
			["concurrent-duplicate-payment", concurrentPaymentPreset()],
			["status-version-out-of-order", statusPreset()],
		] as const) {
			const definition = parseScenarioV1(scenario);
			validateDemoScenario(definition);
			await client.query(
				"INSERT INTO scenarios(id,definition) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING",
				[id, JSON.stringify(definition)],
			);
		}
	});
}

export async function listScenarios(pool: Pool): Promise<ScenarioSummary[]> {
	const result = await pool.query<{ id: string; definition: unknown }>(
		"SELECT id, definition FROM scenarios ORDER BY created_at,id",
	);
	return result.rows.map((row) => {
		const scenario = parseScenarioV1(row.definition);
		validateDemoScenario(scenario);
		return {
			id: row.id,
			name: scenario.name,
			description: scenario.description,
			scenario,
		};
	});
}
