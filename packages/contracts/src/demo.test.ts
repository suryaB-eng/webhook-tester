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

function status(
	id = "status_1",
	orderId = "custom-order",
	value = "processing",
	version = 1,
) {
	return {
		id,
		type: "order.status_changed",
		data: { orderId, status: value, version },
	};
}

test("accepts status events with arbitrary bounded statuses and positive safe versions", () => {
	for (const [value, version] of [
		["packed", 1],
		["x".repeat(100), Number.MAX_SAFE_INTEGER],
		["  meaningful  ", 2],
	] as const) {
		const scenario = fixture();
		const [event] = scenario.events;
		assert.ok(event);
		event.payload = status("status_1", "custom-order", value, version);
		assert.doesNotThrow(() => validateDemoScenario(scenario));
		assert.deepEqual(demoOrders(scenario), [
			{ orderId: "custom-order", quantity: 1 },
		]);
	}
});

test("rejects invalid status payload fields, blank statuses, and unsafe or nonpositive versions", () => {
	const invalid = [
		{ ...status(), extra: true },
		{ ...status(), data: { ...status().data, extra: true } },
		{ id: "status_1", type: "order.status_changed" },
		...["", " \t\n", "x".repeat(101), null, 1].map((value) => ({
			...status(),
			data: { ...status().data, status: value },
		})),
		...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1", null, NaN, Infinity].map(
			(version) => ({ ...status(), data: { ...status().data, version } }),
		),
		...["", " \t", "x".repeat(201)].flatMap((value) => [
			{ ...status(), id: value },
			{ ...status(), data: { ...status().data, orderId: value } },
		]),
	];
	for (const payload of invalid) {
		const scenario = fixture();
		const [event] = scenario.events;
		assert.ok(event);
		Reflect.set(event, "payload", payload);
		assert.throws(() => validateDemoScenario(scenario));
	}
});

test("rejects reuse of logical event IDs across types or conflicting status fields", () => {
	for (const payload of [
		status("payment_1"),
		status("status_1", "other-order"),
		status("status_1", "custom-order", "shipped"),
		status("status_1", "custom-order", "processing", 2),
	]) {
		const scenario = fixture();
		scenario.events.push(
			{ id: "status", payload: status() },
			{ id: "conflict", payload },
		);
		assert.throws(() => validateDemoScenario(scenario), /conflict/i);
	}
});

test("accepts identical status logical events and differing versions for the same order", () => {
	const scenario = fixture();
	scenario.events.push(
		{ id: "status", payload: status() },
		{ id: "duplicate", payload: status() },
		{ id: "newer", payload: status("status_2", "custom-order", "shipped", 3) },
	);
	assert.doesNotThrow(() => validateDemoScenario(scenario));
});

test("derives delivered mixed-event fixtures with payment quantities regardless of arrival order", () => {
	for (const reverse of [false, true]) {
		const scenario = fixture();
		scenario.events.push(
			{ id: "status", payload: status() },
			{ id: "status_only", payload: status("only", "status-only") },
			{ id: "unused", payload: status("unused", "unused-order") },
		);
		const [step] = scenario.steps;
		assert.ok(step);
		step.deliveries = [
			{ deliveryId: "status", eventId: "status" },
			{ deliveryId: "payment", eventId: "event_1" },
			{ deliveryId: "only", eventId: "status_only" },
		];
		if (reverse) step.deliveries.reverse();
		assert.deepEqual(
			demoOrders(scenario).sort((a, b) => a.orderId.localeCompare(b.orderId)),
			[
				{ orderId: "custom-order", quantity: 2 },
				{ orderId: "status-only", quantity: 1 },
			],
		);
	}
});

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
	Reflect.set(step, "mode", "parallel");
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

test("demo validation reports full field paths for payload, target and consistency errors", () => {
	for (const [modify, expectedPath] of [
		[
			(scenario: ScenarioV1) => {
				scenario.targetId = "external";
			},
			["targetId"],
		],
		[
			(scenario: ScenarioV1) => {
				const event = scenario.events[0];
				assert.ok(event);
				event.payload.type = "unsupported";
			},
			["events", 0, "payload", "type"],
		],
		[
			(scenario: ScenarioV1) => {
				scenario.events.push({
					id: "another",
					payload: payment("payment_1", "other", 2),
				});
			},
			["events", 1, "payload", "id"],
		],
		[
			(scenario: ScenarioV1) => {
				scenario.events.push({
					id: "another",
					payload: payment("payment_2", "custom-order", 1),
				});
			},
			["events", 1, "payload", "data", "quantity"],
		],
	] as const) {
		const scenario = fixture();
		modify(scenario);
		assert.throws(
			() => validateDemoScenario(scenario),
			(error: unknown) => {
				assert.ok(error && typeof error === "object" && "issues" in error);
				const issues = error.issues as { path: (string | number)[] }[];
				assert.deepEqual(issues[0]?.path, expectedPath);
				return true;
			},
		);
	}
});
