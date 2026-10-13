import type { AssertionResult, DeliveryResult, RunResponse } from "@webhook-tester/contracts";

export interface RunComparison {
	isSnapshotRerun: boolean;
	configuration: Array<{ label: string; values: [string, string]; same: boolean }>;
	deliveries: Array<{ deliveryId: string; left: DeliveryResult | null; right: DeliveryResult | null }>;
	assertions: Array<{ assertionId: string; left: AssertionResult | null; right: AssertionResult | null }>;
}

// JSON object key order is not configuration; array order is, especially for steps.
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function display(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";
}

export function compareRuns(left: RunResponse, right: RunResponse): RunComparison {
	const configuration: Array<[string, unknown, unknown]> = [
		["Scenario", left.scenarioSnapshot.name, right.scenarioSnapshot.name],
		["Description", left.scenarioSnapshot.description, right.scenarioSnapshot.description],
		["Schema version", left.scenarioSnapshot.schemaVersion, right.scenarioSnapshot.schemaVersion],
		["Scenario target ID", left.scenarioSnapshot.targetId, right.scenarioSnapshot.targetId],
		["Target ID", left.targetSnapshot.id, right.targetSnapshot.id],
		["Target name", left.targetSnapshot.name, right.targetSnapshot.name],
		["Target override", left.targetOverride, right.targetOverride],
		["Events and payloads", left.scenarioSnapshot.events, right.scenarioSnapshot.events],
		["Delivery plan", left.scenarioSnapshot.steps, right.scenarioSnapshot.steps],
		["Limits", left.scenarioSnapshot.limits, right.scenarioSnapshot.limits],
		["Assertion definitions", left.scenarioSnapshot.assertions, right.scenarioSnapshot.assertions],
	];
	const leftDeliveries = new Map(left.deliveries.map((delivery) => [delivery.deliveryId, delivery]));
	const rightDeliveries = new Map(right.deliveries.map((delivery) => [delivery.deliveryId, delivery]));
	const leftAssertions = new Map(left.assertions.map((assertion) => [assertion.id, assertion]));
	const rightAssertions = new Map(right.assertions.map((assertion) => [assertion.id, assertion]));
	return {
		isSnapshotRerun: right.sourceRunId === left.id || left.sourceRunId === right.id,
		configuration: configuration.map(([label, leftValue, rightValue]) => ({
			label, values: [display(leftValue), display(rightValue)], same: canonicalJson(leftValue) === canonicalJson(rightValue),
		})),
		deliveries: [...new Set([...leftDeliveries.keys(), ...rightDeliveries.keys()])].map((deliveryId) => ({
			deliveryId, left: leftDeliveries.get(deliveryId) ?? null, right: rightDeliveries.get(deliveryId) ?? null,
		})),
		assertions: [...new Set([...leftAssertions.keys(), ...rightAssertions.keys()])].map((assertionId) => ({
			assertionId, left: leftAssertions.get(assertionId) ?? null, right: rightAssertions.get(assertionId) ?? null,
		})),
	};
}
