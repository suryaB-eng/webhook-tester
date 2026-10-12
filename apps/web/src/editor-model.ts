import {
	parseScenarioV1,
	validateDemoScenario,
	type ScenarioV1,
} from "@webhook-tester/contracts";

export interface DraftEvent {
	readonly localKey: string;
	id: string;
	payloadText: string;
}
export interface DraftAssertion {
	readonly localKey: string;
	id: string;
	name: string;
	query: string;
	expectedText: string;
}
export interface DraftDelivery {
	readonly localKey: string;
	deliveryId: string;
	eventId: string;
}
export interface DraftStep {
	readonly localKey: string;
	id: string;
	mode: ScenarioV1["steps"][number]["mode"];
	delayBeforeMs: string;
	deliveries: DraftDelivery[];
}
export interface ScenarioDraft {
	schemaVersion: 1;
	name: string;
	description: string;
	targetId: string;
	events: DraftEvent[];
	steps: DraftStep[];
	limits: {
		maxConcurrency: string;
		requestTimeoutMs: string;
		runTimeoutMs: string;
	};
	assertions: DraftAssertion[];
}
export interface DraftIssue {
	path: string;
	message: string;
}
export type DraftValidation =
	| { success: true; document: ScenarioV1; issues: DraftIssue[] }
	| { success: false; issues: DraftIssue[] };

export function createDefaultDraft(targetId = "demo-corrected"): ScenarioDraft {
	return scenarioToDraft({
		schemaVersion: 1,
		name: "New payment scenario",
		description:
			"A payment creates one fulfillment and decrements inventory once.",
		targetId,
		events: [
			{
				id: "payment",
				payload: {
					id: "evt_payment_001",
					type: "payment.succeeded",
					data: { orderId: "order_001", quantity: 1 },
				},
			},
		],
		steps: [
			{
				id: "step_1",
				mode: "sequential",
				delayBeforeMs: 0,
				deliveries: [{ deliveryId: "delivery_1", eventId: "payment" }],
			},
		],
		limits: { maxConcurrency: 2, requestTimeoutMs: 3000, runTimeoutMs: 30000 },
		assertions: [
			{
				id: "fulfillments_once",
				name: "Exactly one fulfillment",
				query:
					"SELECT count(*)::int AS value FROM fulfillments WHERE run_id = $1 AND order_id = 'order_001'",
				expected: 1,
			},
			{
				id: "inventory_once",
				name: "Inventory decreased once",
				query:
					"SELECT quantity::int AS value FROM inventory WHERE run_id = $1 AND sku = 'sku_001'",
				expected: 9,
			},
		],
	});
}

export function scenarioToDraft(document: ScenarioV1): ScenarioDraft {
	return {
		schemaVersion: document.schemaVersion,
		name: document.name,
		description: document.description,
		targetId: document.targetId,
		events: document.events.map((event, index) => ({
			localKey: `event_${index + 1}`,
			id: event.id,
			payloadText: JSON.stringify(event.payload, null, 2),
		})),
		steps: document.steps.map((step, stepIndex) => ({
			...step,
			localKey: `step_${stepIndex + 1}`,
			delayBeforeMs: String(step.delayBeforeMs),
			deliveries: step.deliveries.map((delivery, index) => ({
				...delivery,
				localKey: `delivery_${stepIndex + 1}_${index + 1}`,
			})),
		})),
		limits: {
			maxConcurrency: String(document.limits.maxConcurrency),
			requestTimeoutMs: String(document.limits.requestTimeoutMs),
			runTimeoutMs: String(document.limits.runTimeoutMs),
		},
		assertions: document.assertions.map((assertion, index) => ({
			localKey: `assertion_${index + 1}`,
			id: assertion.id,
			name: assertion.name,
			query: assertion.query,
			expectedText: JSON.stringify(assertion.expected),
		})),
	};
}

function draftIssuePath(path: readonly PropertyKey[]): string {
	if (path[0] === "events" && path[2] === "payload")
		return `events.${String(path[1])}.payloadText`;
	return path
		.map((part) => (part === "expected" ? "expectedText" : String(part)))
		.join(".");
}

export function validateDraft(draft: ScenarioDraft): DraftValidation {
	const issues: DraftIssue[] = [];
	const addIssue = (path: string, message: string) => {
		if (!issues.some((issue) => issue.path === path))
			issues.push({ path, message });
	};
	const parseJson = (source: string, path: string) => {
		try {
			return JSON.parse(source) as unknown;
		} catch {
			addIssue(path, "Must be valid JSON.");
			return undefined;
		}
	};
	const input = {
		schemaVersion: draft.schemaVersion,
		name: draft.name,
		description: draft.description,
		targetId: draft.targetId,
		events: draft.events.map((event, index) => ({
			id: event.id,
			payload: parseJson(event.payloadText, `events.${index}.payloadText`),
		})),
		steps: draft.steps.map((step) => ({
			id: step.id,
			mode: step.mode,
			delayBeforeMs:
				step.delayBeforeMs.trim() === ""
					? Number.NaN
					: Number(step.delayBeforeMs),
			deliveries: step.deliveries.map((delivery) => ({
				deliveryId: delivery.deliveryId,
				eventId: delivery.eventId,
			})),
		})),
		limits: Object.fromEntries(
			Object.entries(draft.limits).map(([key, value]) => [
				key,
				value.trim() === "" ? Number.NaN : Number(value),
			]),
		),
		assertions: draft.assertions.map((assertion, index) => ({
			id: assertion.id,
			name: assertion.name,
			query: assertion.query,
			expected: parseJson(
				assertion.expectedText,
				`assertions.${index}.expectedText`,
			),
		})),
	};
	try {
		const document = parseScenarioV1(input);
		validateDemoScenario(document);
		return issues.length === 0
			? { success: true, document, issues }
			: { success: false, issues };
	} catch (error) {
		if (
			error !== null &&
			typeof error === "object" &&
			"issues" in error &&
			Array.isArray(error.issues)
		) {
			for (const issue of error.issues as {
				path: PropertyKey[];
				message: string;
			}[])
				addIssue(
					draftIssuePath(issue.path),
					issue.path[0] === "events" &&
						issue.path[2] === "payload" &&
						issue.path.length > 3
						? `${issue.path.slice(3).join(".")}: ${issue.message}`
						: issue.message,
				);
		} else
			addIssue(
				"",
				error instanceof Error ? error.message : "Invalid scenario.",
			);
		return { success: false, issues };
	}
}

export function moveItem<T>(
	items: readonly T[],
	fromIndex: number,
	toIndex: number,
): T[] {
	const moved = [...items];
	if (
		!Number.isInteger(fromIndex) ||
		!Number.isInteger(toIndex) ||
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= items.length ||
		toIndex >= items.length
	)
		return moved;
	const [item] = moved.splice(fromIndex, 1);
	moved.splice(toIndex, 0, item as T);
	return moved;
}

function configurationIds(draft: ScenarioDraft): string[] {
	return [
		...draft.events.map((event) => event.id),
		...draft.steps.map((step) => step.id),
		...draft.assertions.map((assertion) => assertion.id),
		...draft.steps.flatMap((step) =>
			step.deliveries.map((delivery) => delivery.deliveryId),
		),
	];
}

function nextId(prefix: string, usedIds: Iterable<string>): string {
	const used = new Set(usedIds);
	let suffix = 1;
	while (used.has(`${prefix}_${suffix}`)) suffix++;
	return `${prefix}_${suffix}`;
}

function nextLocalKey(draft: ScenarioDraft, prefix: string): string {
	return nextId(prefix, [
		...draft.events.map((event) => event.localKey),
		...draft.steps.map((step) => step.localKey),
		...draft.assertions.map((assertion) => assertion.localKey),
		...draft.steps.flatMap((step) =>
			step.deliveries.map((delivery) => delivery.localKey),
		),
	]);
}

export function addEvent(
	draft: ScenarioDraft,
	type: "payment.succeeded" | "order.status_changed" = "payment.succeeded",
): ScenarioDraft {
	const logicalIds: string[] = [];
	for (const event of draft.events) {
		try {
			const payload: unknown = JSON.parse(event.payloadText);
			if (
				payload &&
				typeof payload === "object" &&
				"id" in payload &&
				typeof payload.id === "string"
			)
				logicalIds.push(payload.id);
		} catch {
			/* Incomplete payload text stays in the draft. */
		}
	}
	const event: DraftEvent = {
		localKey: nextLocalKey(draft, "event"),
		id: nextId("event", configurationIds(draft)),
		payloadText: JSON.stringify(
			{
				id: nextId("evt", logicalIds),
				type,
				data:
					type === "payment.succeeded"
						? { orderId: "order_001", quantity: 1 }
						: { orderId: "order_001", status: "paid", version: 1 },
			},
			null,
			2,
		),
	};
	return { ...draft, events: [...draft.events, event] };
}

export function removeEvent(
	draft: ScenarioDraft,
	index: number,
): ScenarioDraft {
	return {
		...draft,
		events: draft.events.filter((_, current) => current !== index),
	};
}

export function addStep(draft: ScenarioDraft): ScenarioDraft {
	return {
		...draft,
		steps: [
			...draft.steps,
			{
				localKey: nextLocalKey(draft, "step"),
				id: nextId("step", configurationIds(draft)),
				mode: "sequential",
				delayBeforeMs: "0",
				deliveries: [],
			},
		],
	};
}

export function removeStep(draft: ScenarioDraft, index: number): ScenarioDraft {
	return {
		...draft,
		steps: draft.steps.filter((_, current) => current !== index),
	};
}

export function addAssertion(draft: ScenarioDraft): ScenarioDraft {
	return {
		...draft,
		assertions: [
			...draft.assertions,
			{
				localKey: nextLocalKey(draft, "assertion"),
				id: nextId("assertion", configurationIds(draft)),
				name: "New assertion",
				query:
					"SELECT count(*)::int AS value FROM fulfillments WHERE run_id = $1",
				expectedText: "1",
			},
		],
	};
}

export function removeAssertion(
	draft: ScenarioDraft,
	index: number,
): ScenarioDraft {
	return {
		...draft,
		assertions: draft.assertions.filter((_, current) => current !== index),
	};
}

function updateStep(
	draft: ScenarioDraft,
	stepIndex: number,
	update: (step: DraftStep) => DraftStep,
): ScenarioDraft {
	if (!Number.isInteger(stepIndex) || !draft.steps[stepIndex]) return draft;
	return {
		...draft,
		steps: draft.steps.map((step, index) =>
			index === stepIndex ? update(step) : step,
		),
	};
}

export function addDelivery(
	draft: ScenarioDraft,
	stepIndex: number,
	eventId: string,
): ScenarioDraft {
	return updateStep(draft, stepIndex, (step) => ({
		...step,
		deliveries: [
			...step.deliveries,
			{
				localKey: nextLocalKey(draft, "delivery"),
				deliveryId: nextId("delivery", configurationIds(draft)),
				eventId,
			},
		],
	}));
}

export function duplicateDelivery(
	draft: ScenarioDraft,
	stepIndex: number,
	deliveryIndex: number,
): ScenarioDraft {
	const delivery = Number.isInteger(deliveryIndex)
		? draft.steps[stepIndex]?.deliveries[deliveryIndex]
		: undefined;
	if (!delivery) return draft;
	return updateStep(draft, stepIndex, (step) => ({
		...step,
		deliveries: [
			...step.deliveries.slice(0, deliveryIndex + 1),
			{
				localKey: nextLocalKey(draft, "delivery"),
				deliveryId: nextId("delivery", configurationIds(draft)),
				eventId: delivery.eventId,
			},
			...step.deliveries.slice(deliveryIndex + 1),
		],
	}));
}

export function removeDelivery(
	draft: ScenarioDraft,
	stepIndex: number,
	deliveryIndex: number,
): ScenarioDraft {
	return updateStep(draft, stepIndex, (step) => ({
		...step,
		deliveries: step.deliveries.filter((_, index) => index !== deliveryIndex),
	}));
}
