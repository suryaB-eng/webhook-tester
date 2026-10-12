import assert from "node:assert/strict";
import test from "node:test";
import {
	parseScenarioV1,
	parseScenarioImport,
	serializeScenarioExport,
	validateDemoScenario,
} from "@webhook-tester/contracts";
import {
	addAssertion,
	addDelivery,
	addEvent,
	addStep,
	createDefaultDraft,
	duplicateDelivery,
	moveItem,
	removeAssertion,
	removeDelivery,
	removeEvent,
	removeStep,
	scenarioToDraft,
	validateDraft,
	type ScenarioDraft,
} from "./editor-model.js";

test("a new draft produces a supported single payment with usable scalar assertions", () => {
	const draft = createDefaultDraft();
	const result = validateDraft(draft);
	assert.equal(result.success, true);
	if (!result.success) return;
	const document = parseScenarioV1(result.document);
	validateDemoScenario(document);
	assert.equal(document.targetId, "demo-corrected");
	assert.deepEqual(document.events, [
		{
			id: "payment",
			payload: {
				id: "evt_payment_001",
				type: "payment.succeeded",
				data: { orderId: "order_001", quantity: 1 },
			},
		},
	]);
	assert.deepEqual(document.steps[0]?.deliveries, [
		{ deliveryId: "delivery_1", eventId: "payment" },
	]);
	assert.equal(document.assertions[0]?.expected, 1);
	assert.match(document.assertions[0]?.query ?? "", /count\(\*\)::int/i);
	assert.match(document.assertions[1]?.query ?? "", /quantity::int/i);
	assert.equal(document.assertions[1]?.expected, 9);
	assert.deepEqual(validateDraft(scenarioToDraft(document)), result);
});

function at<T>(items: readonly T[], index: number): T {
	const item = items[index];
	assert.ok(item !== undefined);
	return item;
}

function hasIssue(draft: ScenarioDraft, path: string): void {
	const before = structuredClone(draft);
	const result = validateDraft(draft);
	assert.equal(result.success, false);
	assert.ok(
		result.issues.some((issue) => issue.path === path),
		JSON.stringify(result.issues),
	);
	assert.deepEqual(draft, before, "invalid text must remain editable");
}

test("payload syntax and expected scalar syntax remain in the draft with field errors", () => {
	const draft = createDefaultDraft();
	at(draft.events, 0).payloadText = "{";
	at(draft.assertions, 0).expectedText = "unfinished";
	const result = validateDraft(draft);
	assert.equal(result.success, false);
	assert.ok(
		result.issues.some((issue) => issue.path === "events.0.payloadText"),
	);
	assert.ok(
		result.issues.some((issue) => issue.path === "assertions.0.expectedText"),
	);
	assert.equal(at(draft.events, 0).payloadText, "{");
	assert.equal(at(draft.assertions, 0).expectedText, "unfinished");
});

test("expected text accepts every JSON scalar but rejects arrays and objects", () => {
	for (const [source, expected] of [
		["null", null],
		["true", true],
		["false", false],
		["12.5", 12.5],
		['"done"', "done"],
	] as const) {
		const draft = createDefaultDraft();
		at(draft.assertions, 0).expectedText = source;
		const result = validateDraft(draft);
		assert.equal(result.success, true);
		if (result.success)
			assert.equal(at(result.document.assertions, 0).expected, expected);
	}
	for (const source of ["{}", "[]", "NaN", ""]) {
		const draft = createDefaultDraft();
		at(draft.assertions, 0).expectedText = source;
		hasIssue(draft, "assertions.0.expectedText");
	}
});

test("numeric input strings and step mode use shared limits without replacing invalid text", () => {
	for (const value of ["", "-1", "5001", "1.5", "later"]) {
		const draft = createDefaultDraft();
		at(draft.steps, 0).delayBeforeMs = value;
		hasIssue(draft, "steps.0.delayBeforeMs");
	}
	for (const [key, value] of [
		["maxConcurrency", "11"],
		["requestTimeoutMs", "99"],
		["runTimeoutMs", "60001"],
	] as const) {
		const draft = createDefaultDraft();
		draft.limits[key] = value;
		hasIssue(draft, `limits.${key}`);
	}
	const draft = createDefaultDraft();
	at(draft.steps, 0).mode = "parallel" as (typeof draft.steps)[number]["mode"];
	hasIssue(draft, "steps.0.mode");
	at(draft.steps, 0).mode = "concurrent";
	at(draft.steps, 0).delayBeforeMs = "5000";
	const result = validateDraft(draft);
	assert.equal(result.success, true);
	if (result.success)
		assert.equal(at(result.document.steps, 0).delayBeforeMs, 5000);
});

test("the supported target and payload validators report the edited field", () => {
	const target = createDefaultDraft();
	target.targetId = "user-url";
	hasIssue(target, "targetId");
	for (const payload of [
		{ id: "evt", type: "unsupported", data: {} },
		{
			id: "evt",
			type: "payment.succeeded",
			data: { orderId: "order_001", quantity: 11 },
		},
		{
			id: "evt",
			type: "payment.succeeded",
			data: { orderId: "order_001", quantity: 1 },
			extra: true,
		},
	]) {
		const draft = createDefaultDraft();
		at(draft.events, 0).payloadText = JSON.stringify(payload);
		hasIssue(draft, "events.0.payloadText");
	}
});

test("configuration collisions, conflicting logical payloads and order quantities are rejected", () => {
	const duplicate = createDefaultDraft();
	duplicate.events.push({ ...at(duplicate.events, 0) });
	hasIssue(duplicate, "events.1.id");
	const delivery = createDefaultDraft();
	at(delivery.steps, 0).deliveries.push({
		...at(at(delivery.steps, 0).deliveries, 0),
	});
	hasIssue(delivery, "steps.0.deliveries.1.deliveryId");
	const conflict = createDefaultDraft();
	conflict.events.push({
		localKey: "other",
		id: "other",
		payloadText: JSON.stringify({
			id: "evt_payment_001",
			type: "payment.succeeded",
			data: { orderId: "order_001", quantity: 2 },
		}),
	});
	hasIssue(conflict, "events.1.payloadText");
	const quantity = createDefaultDraft();
	quantity.events.push({
		localKey: "other",
		id: "other",
		payloadText: JSON.stringify({
			id: "evt_other",
			type: "payment.succeeded",
			data: { orderId: "order_001", quantity: 2 },
		}),
	});
	hasIssue(quantity, "events.1.payloadText");
});

test("deleting referenced events preserves a visible dangling reference error", () => {
	const original = addEvent(createDefaultDraft());
	const changed = removeEvent(original, 0);
	assert.equal(original.events.length, 2);
	assert.equal(changed.events.length, 1);
	assert.equal(at(at(changed.steps, 0).deliveries, 0).eventId, "payment");
	hasIssue(changed, "steps.0.deliveries.0.eventId");
});

test("new and duplicated deliveries allocate distinct transport ids across every step", () => {
	const original = createDefaultDraft();
	const otherStep = addStep(original);
	const withSecond = addDelivery(otherStep, 1, "payment");
	const duplicated = duplicateDelivery(withSecond, 0, 0);
	const added = addDelivery(duplicated, 0, "payment");
	const deliveries = added.steps.flatMap((step) => step.deliveries);
	assert.equal(
		new Set(deliveries.map((delivery) => delivery.deliveryId)).size,
		4,
	);
	assert.ok(deliveries.every((delivery) => delivery.eventId === "payment"));
	assert.equal(
		at(added.events, 0).payloadText,
		at(original.events, 0).payloadText,
	);
	assert.equal(
		JSON.parse(at(added.events, 0).payloadText).id,
		"evt_payment_001",
	);
	assert.equal(at(original.steps, 0).deliveries.length, 1);
	assert.equal(validateDraft(added).success, true);
	assert.equal(at(removeDelivery(added, 0, 1).steps, 0).deliveries.length, 2);
});

test("event step and assertion additions use bounded collision-free ids and immutable deletions", () => {
	const original = createDefaultDraft();
	const payment = addEvent(original);
	const status = addEvent(payment, "order.status_changed");
	const steps = addStep(addStep(status));
	const assertions = addAssertion(addAssertion(steps));
	for (const items of [
		assertions.events,
		assertions.steps,
		assertions.assertions,
	]) {
		assert.equal(new Set(items.map((item) => item.id)).size, items.length);
		assert.ok(
			items.every((item) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item.id)),
		);
	}
	assert.equal(
		JSON.parse(at(status.events, 2).payloadText).type,
		"order.status_changed",
	);
	assert.equal(validateDraft(assertions).success, true);
	assert.equal(removeStep(assertions, 2).steps.length, 2);
	assert.equal(removeAssertion(assertions, 3).assertions.length, 3);
	assert.equal(original.events.length, 1);
	assert.equal(original.steps.length, 1);
	assert.equal(original.assertions.length, 2);
});

test("reordering uses absolute array positions and ignores invalid indices without mutation", () => {
	const items = ["first", "second", "third"];
	assert.deepEqual(moveItem(items, 2, 0), ["third", "first", "second"]);
	assert.deepEqual(items, ["first", "second", "third"]);
	for (const [from, to] of [
		[-1, 0],
		[0, -1],
		[3, 0],
		[0, 3],
		[0.5, 1],
		[0, Number.NaN],
	] as const)
		assert.deepEqual(moveItem(items, from, to), items);
	const draft = addAssertion(addStep(addEvent(createDefaultDraft())));
	draft.events = moveItem(draft.events, 1, 0);
	draft.steps = moveItem(draft.steps, 1, 0);
	draft.assertions = moveItem(draft.assertions, 2, 0);
	assert.equal(validateDraft(draft).success, true);
});

test("draft rows keep local keys through edits and reorders without exporting them", () => {
	const draft = createDefaultDraft();
	assert.equal(typeof at(draft.events, 0).localKey, "string");
	assert.equal(typeof at(draft.steps, 0).localKey, "string");
	assert.equal(typeof at(at(draft.steps, 0).deliveries, 0).localKey, "string");
	assert.equal(typeof at(draft.assertions, 0).localKey, "string");
	const originalKey = at(draft.events, 0).localKey;
	at(draft.events, 0).id = "renamed";
	at(at(draft.steps, 0).deliveries, 0).eventId = "renamed";
	const added = addEvent(draft);
	added.events = moveItem(added.events, 0, 1);
	assert.equal(at(added.events, 1).localKey, originalKey);
	assert.notEqual(at(added.events, 0).localKey, originalKey);
	const result = validateDraft(duplicateDelivery(added, 0, 0));
	assert.equal(result.success, true);
	if (result.success) {
		const exported = serializeScenarioExport(result.document);
		assert.equal(exported.includes("localKey"), false);
		assert.deepEqual(parseScenarioImport(exported), result.document);
	}
});

test("payload field errors identify the nested JSON property and preserve its text", () => {
	const draft = createDefaultDraft();
	const event = at(draft.events, 0);
	event.payloadText = JSON.stringify({
		id: "payment",
		type: "payment.succeeded",
		data: { orderId: "alternate", quantity: 11 },
	});
	const before = event.payloadText;
	const result = validateDraft(draft);
	assert.equal(result.success, false);
	const issue = result.issues.find(
		(issue) => issue.path === "events.0.payloadText",
	);
	assert.ok(issue);
	assert.match(issue.message, /data.quantity/);
	assert.equal(event.payloadText, before);
});
