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
export type RunEventType =
	| "run.queued"
	| "run.started"
	| "run.phase"
	| "run.completed"
	| "delivery.scheduled"
	| "delivery.started"
	| "delivery.completed"
	| "delivery.interrupted"
	| "assertion.completed";
export interface RunEventPayload {
	status?: RunStatus;
	phase?: string;
	deliveryId?: string;
	outcome?: DeliveryResult["outcome"];
	httpStatus?: number | null;
	assertionId?: string;
	assertionName?: string;
	expected?: JsonScalar;
	actual?: JsonScalar | null;
	assertionStatus?: AssertionResult["status"];
}
export interface RunEvent {
	/** Canonical nonnegative decimal bigint; zero is the replay sentinel. */
	cursor: string;
	runId: string;
	type: RunEventType;
	payload: RunEventPayload;
	createdAt: string;
}
export interface RunResponse {
	id: string;
	status: RunStatus;
	phase: string;
	scenarioSnapshot: ScenarioV1;
	targetSnapshot: PublicTarget;
	sourceRunId: string | null;
	targetOverride: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	error: string | null;
	deliveries: DeliveryResult[];
	assertions: AssertionResult[];
	eventCursor: string;
	events: RunEvent[];
}

export interface RunSummary {
	id: string;
	status: RunStatus;
	phase: string;
	scenarioName: string;
	targetSnapshot: PublicTarget;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
	sourceRunId: string | null;
	targetOverride: string | null;
}

export interface RunHistoryPage {
	runs: RunSummary[];
	nextCursor: string | null;
}
