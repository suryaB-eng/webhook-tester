import assert from "node:assert/strict";
import test from "node:test";
import {
	demoOrders,
	demoPaymentSchema,
	parseScenarioV1,
	validateDemoScenario,
	type ScenarioV1,
} from "./index.js";

function fixture(): ScenarioV1 {
	return parseScenarioV1({
		schemaVersion: 1,
		name: "Payment demo",
		description: "",
		targetId: "demo-corrected",
		events: [
			{
				id: "event_1",
				payload: {
					id: "payment_1",
					type: "payment.succeeded",
					data: { orderId: "custom-order", quantity: 2 },
				},
			},
		],
		steps: [
			{
				id: "step_1",
				mode: "sequential",
				delayBeforeMs: 0,
				deliveries: [{ deliveryId: "delivery_1", eventId: "event_1" }],
			},
		],
		limits: { maxConcurrency: 1, requestTimeoutMs: 1000, runTimeoutMs: 10000 },
		assertions: [
			{
				id: "assertion_1",
				name: "Quantity",
				query: "SELECT quantity FROM orders",
				expected: 2,
			},
		],
	});
}

function payment(id = "payment_1", orderId = "custom-order", quantity = 2) {
	return {
		id,
		type: "payment.succeeded",
		data: { orderId, quantity },
	} as const;
}

test("accepts both supported demo targets and custom order IDs", () => {
	for (const targetId of ["demo-flawed", "demo-corrected"]) {
		const scenario = fixture();
		scenario.targetId = targetId;
		assert.doesNotThrow(() => validateDemoScenario(scenario));
		assert.deepEqual(demoOrders(scenario), [
			{ orderId: "custom-order", quantity: 2 },
		]);
	}
});

test("rejects arbitrary targets from both demo validation and order derivation", () => {
	const scenario = fixture();
	scenario.targetId = "custom-target";
	assert.throws(() => validateDemoScenario(scenario));
	assert.throws(() => demoOrders(scenario));
});

test("revalidates scenario shape at the runtime boundary", () => {
	const scenario = fixture();
	const [step] = scenario.steps;
	assert.ok(step);
	Reflect.set(step, "mode", "concurrent");
	assert.throws(() => validateDemoScenario(scenario));
	assert.throws(() => demoOrders(scenario));
});

test("validates all events including undelivered unsupported payloads", () => {
	const scenario = fixture();
	scenario.events.push({
		id: "unused",
		payload: { id: "unsupported", type: "refund.created" },
	});
	assert.throws(() => validateDemoScenario(scenario));
});

test("payment payloads reject unsupported types, unknown fields, and invalid quantities", () => {
	const invalid = [
		{ ...payment(), type: "refund.created" },
		{ ...payment(), extra: true },
		{
			...payment(),
			data: { orderId: "custom-order", quantity: 2, extra: true },
		},
		{ id: "payment_1", type: "payment.succeeded" },
		...[0, 11, 1.5, "2", null, NaN].map((quantity) => ({
			...payment(),
			data: { orderId: "custom-order", quantity },
		})),
	];
	for (const payload of invalid) {
		assert.equal(demoPaymentSchema.safeParse(payload).success, false);
		const scenario = fixture();
		const [event] = scenario.events;
		assert.ok(event);
		Reflect.set(event, "payload", payload);
		assert.throws(() => validateDemoScenario(scenario));
	}
	for (const quantity of [1, 10])
		assert.equal(
			demoPaymentSchema.parse(payment("payment_1", "custom-order", quantity))
				.data.quantity,
			quantity,
		);
});

test("payment and order IDs reject empty and oversized values and preserve valid IDs", () => {
	for (const key of ["id", "orderId"]) {
		for (const id of ["", " \t ", "x".repeat(201), null, 1]) {
			const payload = payment();
			Reflect.set(key === "id" ? payload : payload.data, key, id);
			assert.equal(demoPaymentSchema.safeParse(payload).success, false);
		}
		for (const id of ["x".repeat(200), "  meaningful id  "]) {
			const payload = payment();
			Reflect.set(key === "id" ? payload : payload.data, key, id);
			const parsed = demoPaymentSchema.parse(payload);
			assert.equal(key === "id" ? parsed.id : parsed.data.orderId, id);
		}
	}
});

test("rejects inconsistent quantities for the same order across logical events", () => {
	const scenario = fixture();
	scenario.events.push({
		id: "event_2",
		payload: payment("payment_2", "custom-order", 3),
	});
	assert.throws(() => validateDemoScenario(scenario), /quantity/i);
});

test("rejects conflicting payloads for one logical payment event ID", () => {
	for (const payload of [
		payment("payment_1", "other-order", 2),
		payment("payment_1", "custom-order", 3),
	]) {
		const scenario = fixture();
		scenario.events.push({ id: "event_2", payload });
		assert.throws(
			() => validateDemoScenario(scenario),
			/event|payload|conflict/i,
		);
	}
});

test("accepts identical logical-event duplicates and returns only unique delivered orders", () => {
	const scenario = fixture();
	scenario.events.push(
		{ id: "event_2", payload: payment() },
		{ id: "unused", payload: payment("unused", "unused-order", 4) },
		{ id: "event_3", payload: payment("payment_3", "second-order", 5) },
	);
	const [step] = scenario.steps;
	assert.ok(step);
	step.deliveries.push(
		{ deliveryId: "delivery_2", eventId: "event_2" },
		{ deliveryId: "delivery_3", eventId: "event_3" },
		{ deliveryId: "delivery_4", eventId: "event_1" },
	);
	assert.doesNotThrow(() => validateDemoScenario(scenario));
	assert.deepEqual(demoOrders(scenario), [
		{ orderId: "custom-order", quantity: 2 },
		{ orderId: "second-order", quantity: 5 },
	]);
});
