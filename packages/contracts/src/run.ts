import type { JsonScalar, JsonValue, ScenarioV1 } from "./scenario.js";

export type RunStatus =
	| "queued"
	| "running"
	| "passed"
	| "failed"
	| "error"
	| "interrupted";
export interface PublicTarget {
	id: string;
	name: string;
}
export interface SavedScenario {
	id: string;
	revision: number;
	document: ScenarioV1;
}
export interface ScenarioSummary {
	revision: number;
	id: string;
	name: string;
	description: string;
	scenario: ScenarioV1;
}
export interface DeliveryResult {
	deliveryId: string;
	stepId: string;
	eventId: string;
	ordinal: number;
	scheduledAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	requestPayload: JsonValue;
	httpStatus: number | null;
	durationMs: number | null;
	responseExcerpt: string | null;
	responseTruncated: boolean;
	outcome: "pending" | "ok" | "failed" | "error" | "interrupted";
	error: string | null;
}
export interface AssertionResult {
	id: string;
	name: string;
	query: string;
	expected: JsonScalar;
	actual: JsonScalar | null;
	status: "pending" | "passed" | "failed" | "error";
	error: string | null;
}
export interface RunResponse {
	id: string;
	status: RunStatus;
	phase: string;
	scenarioSnapshot: ScenarioV1;
	targetSnapshot: PublicTarget;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	deliveries: DeliveryResult[];
	assertions: AssertionResult[];
}
