import assert from "node:assert/strict";
import test from "node:test";
import type {
	AssertionResult,
	DeliveryResult,
	RunResponse,
} from "@webhook-tester/contracts";
import { compareRuns } from "./run-comparison.js";

function run(id: string): RunResponse {
	return {
		id,
		status: "passed",
		phase: "completed",
		sourceRunId: null,
		targetOverride: null,
		createdAt: "2026-10-12T12:00:00Z",
		startedAt: null,
		completedAt: null,
		error: null,
		eventCursor: "0",
		events: [],
		deliveries: [],
		assertions: [],
		targetSnapshot: { id: "demo", name: "Demo target" },
		scenarioSnapshot: {
			schemaVersion: 1,
			name: "Orders",
			description: "One order",
			targetId: "demo",
			events: [
				{
					id: "event",
					payload: {
						id: "order",
						nested: { first: 1, second: 2 },
						items: [1, 2],
					},
				},
			],
			steps: [
				{
					id: "first",
					mode: "sequential",
					delayBeforeMs: 0,
					deliveries: [{ deliveryId: "delivery", eventId: "event" }],
				},
			],
			limits: {
				maxConcurrency: 1,
				requestTimeoutMs: 1000,
				runTimeoutMs: 10000,
			},
			assertions: [
				{ id: "check", name: "Count", query: "SELECT 1", expected: 1 },
			],
		},
	};
}

function delivery(deliveryId: string, httpStatus: number): DeliveryResult {
	return {
		deliveryId,
		stepId: "first",
		eventId: "event",
		ordinal: 1,
		scheduledAt: null,
		startedAt: null,
		completedAt: null,
		requestPayload: { id: "order" },
		httpStatus,
		durationMs: 0,
		responseExcerpt: null,
		responseTruncated: false,
		outcome: "ok",
		error: null,
	};
}

function assertion(id: string, actual: number | null): AssertionResult {
	return {
		id,
		name: id,
		query: "SELECT 1",
		expected: 1,
		actual,
		status: "passed",
		error: null,
	};
}

test("configuration ignores nested object key order while retaining array order", () => {
	const left = run("left");
	const right = run("right");
	const event = right.scenarioSnapshot.events[0];
	assert.ok(event);
	event.payload = {
		items: [1, 2],
		nested: { second: 2, first: 1 },
		id: "order",
	};
	assert.equal(
		compareRuns(left, right).configuration.every((row) => row.same),
		true,
	);
	event.payload.items = [2, 1];
	assert.equal(
		compareRuns(left, right).configuration.find(
			(row) => row.label === "Events and payloads",
		)?.same,
		false,
	);
});

test("unrelated runs expose changed configuration including steps limits assertion definitions and target", () => {
	const left = run("left");
	const right = run("right");
	right.scenarioSnapshot.name = "Changed orders";
	right.scenarioSnapshot.description = "Different description";
	right.scenarioSnapshot.targetId = "configured-target";
	right.targetSnapshot = { id: "other", name: "Other target" };
	right.targetOverride = "other";
	const step = right.scenarioSnapshot.steps[0];
	assert.ok(step);
	step.mode = "concurrent";
	step.delayBeforeMs = 10;
	right.scenarioSnapshot.limits.maxConcurrency = 2;
	right.scenarioSnapshot.assertions[0] = {
		id: "check",
		name: "Other count",
		query: "SELECT 2",
		expected: 2,
	};
	const comparison = compareRuns(left, right);
	assert.equal(comparison.isSnapshotRerun, false);
	assert.deepEqual(
		comparison.configuration.filter((row) => !row.same).map((row) => row.label),
		[
			"Scenario",
			"Description",
			"Scenario target ID",
			"Target ID",
			"Target name",
			"Target override",
			"Delivery plan",
			"Limits",
			"Assertion definitions",
		],
	);
});

test("delivery plan preserves step order and delivery order", () => {
	const left = run("left");
	left.scenarioSnapshot.steps.push({
		id: "second",
		mode: "concurrent",
		delayBeforeMs: 0,
		deliveries: [],
	});
	const right = structuredClone(left);
	right.scenarioSnapshot.steps.reverse();
	assert.equal(
		compareRuns(left, right).configuration.find(
			(row) => row.label === "Delivery plan",
		)?.same,
		false,
	);
	right.scenarioSnapshot.steps = structuredClone(left.scenarioSnapshot.steps);
	const leftStep = left.scenarioSnapshot.steps[0];
	assert.ok(leftStep);
	leftStep.deliveries.push({ deliveryId: "another", eventId: "event" });
	right.scenarioSnapshot.steps = structuredClone(left.scenarioSnapshot.steps);
	const rightStep = right.scenarioSnapshot.steps[0];
	assert.ok(rightStep);
	rightStep.deliveries.reverse();
	assert.equal(
		compareRuns(left, right).configuration.find(
			(row) => row.label === "Delivery plan",
		)?.same,
		false,
	);
});

test("deliveries align by identity across reordered and one-sided records", () => {
	const left = run("left");
	const right = run("right");
	left.deliveries = [delivery("shared", 200), delivery("left-only", 400)];
	right.deliveries = [delivery("right-only", 503), delivery("shared", 201)];
	const rows = compareRuns(left, right).deliveries;
	assert.deepEqual(
		rows.map((row) => row.deliveryId),
		["shared", "left-only", "right-only"],
	);
	const [shared, leftOnly, rightOnly] = rows;
	assert.ok(shared && leftOnly && rightOnly);
	assert.equal(shared.left?.httpStatus, 200);
	assert.equal(shared.right?.httpStatus, 201);
	assert.equal(shared.left?.durationMs, 0);
	assert.equal(leftOnly.right, null);
	assert.equal(rightOnly.left, null);
});

test("assertions align by id and retain errors unknown actuals and recorded SQL null", () => {
	const left = run("left");
	const right = run("right");
	left.assertions = [
		assertion("nullable", null),
		{ ...assertion("error", null), status: "error", error: "Query failed" },
	];
	right.assertions = [
		{ ...assertion("pending", null), status: "pending" },
		assertion("nullable", 2),
	];
	const rows = compareRuns(left, right).assertions;
	assert.deepEqual(
		rows.map((row) => row.assertionId),
		["nullable", "error", "pending"],
	);
	const [nullable, error, pending] = rows;
	assert.ok(nullable && error && pending);
	assert.equal(nullable.left?.actual, null);
	assert.equal(nullable.left?.status, "passed");
	assert.equal(nullable.right?.actual, 2);
	assert.equal(error.left?.error, "Query failed");
	assert.equal(error.right, null);
	assert.equal(pending.left, null);
	assert.equal(pending.right?.status, "pending");
});

test("snapshot rerun relationship is recognized in either comparison direction", () => {
	const original = run("original");
	const rerun = run("rerun");
	rerun.sourceRunId = original.id;
	assert.equal(compareRuns(original, rerun).isSnapshotRerun, true);
	assert.equal(compareRuns(rerun, original).isSnapshotRerun, true);
	assert.equal(compareRuns(original, run("unrelated")).isSnapshotRerun, false);
});

test("empty result unions stay empty without modifying either saved response", () => {
	const left = run("left");
	const right = run("right");
	const before = JSON.stringify([left, right]);
	const result = compareRuns(left, right);
	assert.deepEqual(result.deliveries, []);
	assert.deepEqual(result.assertions, []);
	assert.equal(JSON.stringify([left, right]), before);
});
