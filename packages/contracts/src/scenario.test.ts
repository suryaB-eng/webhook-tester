import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_BODY_BYTES,
	MAX_IMPORT_BYTES,
	parseScenarioImport,
	parseScenarioV1,
	scenarioV1Schema,
} from "./index.js";

function fixture() {
	return {
		schemaVersion: 1,
		name: "Sequential payment",
		description: "A sample",
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
		limits: { maxConcurrency: 1, requestTimeoutMs: 100, runTimeoutMs: 1000 },
		assertions: [
			{
				id: "assertion_1",
				name: "Quantity",
				query: "SELECT quantity FROM orders",
				expected: 2,
			},
		],
	};
}

function first<T>(items: T[]): T {
	const item = items[0];
	assert.ok(item !== undefined);
	return item;
}

type Fixture = ReturnType<typeof fixture>;

test("preserves valid fields, JSON payloads and scalar expectations", () => {
	for (const expected of [null, true, false, 0, 1.5, "two"]) {
		const input = fixture();
		Reflect.set(first(input.assertions), "expected", expected);
		Object.assign(first(input.events).payload, {
			extra: { nested: [null, true, 1.5, "é"] },
		});
		assert.deepEqual(parseScenarioV1(input), input);
		assert.deepEqual(scenarioV1Schema.parse(input), input);
		assert.deepEqual(parseScenarioImport(JSON.stringify(input)), input);
	}
});

for (const namespace of ["events", "steps", "assertions"] as const) {
	test(`rejects duplicate ${namespace} IDs`, () => {
		const input = fixture();
		const duplicate = structuredClone(first(input[namespace] as unknown[]));
		if (namespace === "steps")
			Reflect.set(
				first((duplicate as Fixture["steps"][number]).deliveries),
				"deliveryId",
				"delivery_2",
			);
		(input[namespace] as unknown[]).push(duplicate);
		assert.throws(() => parseScenarioV1(input));
	});
}

test("rejects duplicate delivery IDs across steps", () => {
	const input = fixture();
	input.steps.push({ ...structuredClone(first(input.steps)), id: "step_2" });
	assert.throws(() => parseScenarioV1(input));
});

test("configuration namespaces may reuse an ID", () => {
	const input = fixture();
	first(input.events).id =
		first(input.steps).id =
		first(first(input.steps).deliveries).deliveryId =
		first(input.assertions).id =
			"same";
	first(first(input.steps).deliveries).eventId = "same";
	assert.doesNotThrow(() => parseScenarioV1(input));
});

test("rejects unresolved event references", () => {
	const input = fixture();
	first(first(input.steps).deliveries).eventId = "missing";
	assert.throws(() => parseScenarioV1(input));
});

for (const field of ["events", "steps", "assertions", "deliveries"]) {
	test(`rejects empty ${field}`, () => {
		const input = fixture();
		if (field === "deliveries") first(input.steps).deliveries = [];
		else Reflect.set(input, field, []);
		assert.throws(() => parseScenarioV1(input));
	});
}

test("accepts an empty delay step when another step delivers an event", () => {
	const input = fixture();
	input.steps.unshift({
		id: "delay_only",
		mode: "sequential",
		delayBeforeMs: 100,
		deliveries: [],
	});
	assert.doesNotThrow(() => parseScenarioV1(input));
});

test("permits 100 deliveries but rejects 101 across steps", () => {
	const input = fixture();
	first(input.steps).deliveries = Array.from({ length: 100 }, (_, i) => ({
		deliveryId: `delivery_${i}`,
		eventId: "event_1",
	}));
	assert.doesNotThrow(() => parseScenarioV1(input));
	input.steps.push({
		id: "step_2",
		mode: "sequential",
		delayBeforeMs: 0,
		deliveries: [{ deliveryId: "extra", eventId: "event_1" }],
	});
	assert.throws(() => parseScenarioV1(input));
});

for (const [field, min, max] of [
	["maxConcurrency", 1, 10],
	["requestTimeoutMs", 100, 10000],
	["runTimeoutMs", 1000, 60000],
	["delayBeforeMs", 0, 5000],
] as const) {
	test(`${field} accepts endpoints and rejects out-of-range or fractional values`, () => {
		for (const value of [min, max, min - 1, max + 1, min + 0.5]) {
			const input = fixture();
			Reflect.set(
				field === "delayBeforeMs" ? first(input.steps) : input.limits,
				field,
				value,
			);
			if (value === min || value === max)
				assert.doesNotThrow(() => parseScenarioV1(input));
			else assert.throws(() => parseScenarioV1(input));
		}
	});
}

test("accepts concurrent steps alongside sequential steps", () => {
	const input = fixture();
	first(input.steps).mode = "concurrent";
	assert.deepEqual(parseScenarioV1(input), input);
	input.steps.push({
		id: "delay",
		mode: "sequential",
		delayBeforeMs: 0,
		deliveries: [],
	});
	assert.deepEqual(parseScenarioV1(input), input);
});

test("rejects unsupported step modes", () => {
	const input = fixture();
	first(input.steps).mode = "parallel";
	assert.throws(() => parseScenarioV1(input));
});

test("rejects structural unknown keys at every level", () => {
	for (const select of [
		(x: Fixture) => x,
		(x: Fixture) => first(x.events),
		(x: Fixture) => first(x.steps),
		(x: Fixture) => first(first(x.steps).deliveries),
		(x: Fixture) => x.limits,
		(x: Fixture) => first(x.assertions),
	]) {
		const input = fixture();
		Reflect.set(select(input), "unexpected", true);
		assert.throws(() => parseScenarioV1(input));
	}
});

test("rejects non-scalar and non-finite expectations", () => {
	for (const expected of [{ a: 1 }, [1], undefined, NaN, Infinity, -Infinity]) {
		const input = fixture();
		Reflect.set(first(input.assertions), "expected", expected);
		assert.throws(() => parseScenarioV1(input));
	}
});

test("rejects invalid JSON payload values and non-object payloads", () => {
	for (const payload of [
		[],
		null,
		"value",
		{ id: "ok", nested: { bad: undefined } },
		{ id: "ok", bad: NaN },
		{ id: "ok", bad: Infinity },
		{ id: "ok", bad: BigInt(1) },
	]) {
		const input = fixture();
		Reflect.set(first(input.events), "payload", payload);
		assert.throws(() => parseScenarioV1(input));
	}
});

test("bounds configuration IDs to 100 characters", () => {
	for (const select of [
		(x: Fixture) => first(x.events),
		(x: Fixture) => first(x.steps),
		(x: Fixture) => first(x.assertions),
		(x: Fixture) => first(first(x.steps).deliveries),
	]) {
		for (const id of ["", " ", "x".repeat(101)]) {
			const input = fixture();
			const object = select(input);
			Reflect.set(object, "deliveryId" in object ? "deliveryId" : "id", id);
			assert.throws(() => parseScenarioV1(input));
		}
	}
	const input = fixture();
	first(input.events).id = "x".repeat(100);
	first(first(input.steps).deliveries).eventId = first(input.events).id;
	assert.doesNotThrow(() => parseScenarioV1(input));
});

test("business event IDs accept 200 characters and preserve meaningful whitespace", () => {
	for (const id of ["x".repeat(200), "  payment id  "]) {
		const input = fixture();
		first(input.events).payload.id = id;
		assert.equal(first(parseScenarioV1(input).events).payload.id, id);
	}
	for (const id of ["", " \t\n ", "x".repeat(201), 1, null]) {
		const input = fixture();
		Reflect.set(first(input.events).payload, "id", id);
		assert.throws(() => parseScenarioV1(input));
	}
});

test("requires schema version 1 and required fields", () => {
	for (const schemaVersion of [0, 2, "1", undefined]) {
		const input = fixture();
		Reflect.set(input, "schemaVersion", schemaVersion);
		assert.throws(() => parseScenarioV1(input));
	}
	for (const key of Object.keys(fixture())) {
		const input = fixture();
		Reflect.deleteProperty(input, key);
		assert.throws(() => parseScenarioV1(input));
	}
});

test("enforces UTF-8 import boundary before parsing, including whitespace", () => {
	const serialized = JSON.stringify(fixture());
	const source =
		serialized + " ".repeat(1048576 - Buffer.byteLength(serialized));
	assert.equal(Buffer.byteLength(source), MAX_IMPORT_BYTES);
	assert.doesNotThrow(() => parseScenarioImport(source));
	assert.throws(
		() => parseScenarioImport(`${source} `),
		/size|byte|MiB|large/i,
	);
	const multibyte = JSON.stringify({
		...fixture(),
		description: "é".repeat(524288),
	});
	assert.ok(multibyte.length < MAX_IMPORT_BYTES);
	assert.throws(() => parseScenarioImport(multibyte), /size|byte|MiB|large/i);
});

test("enforces serialized body UTF-8 boundary for object and schema entry points", () => {
	const input = fixture();
	const payload = Object.assign(first(input.events).payload, { padding: "" });
	const remaining = 1048576 - Buffer.byteLength(JSON.stringify(input));
	payload.padding =
		"é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
	assert.equal(Buffer.byteLength(JSON.stringify(input)), MAX_BODY_BYTES);
	assert.doesNotThrow(() => parseScenarioV1(input));
	payload.padding += "x";
	assert.throws(() => parseScenarioV1(input), /size|byte|MiB|large/i);
	assert.throws(() => scenarioV1Schema.parse(input), /size|byte|MiB|large/i);
});

test("rejects malformed JSON imports and non-scenario JSON values", () => {
	for (const source of [
		"{",
		"",
		"undefined",
		"null",
		"[]",
		'"text"',
		'{"schemaVersion":1,}',
	]) {
		assert.throws(() => parseScenarioImport(source));
	}
});
