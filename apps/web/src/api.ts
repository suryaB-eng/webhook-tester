import type {
	PublicTarget,
	RunEvent,
	RunResponse,
	RunHistoryPage,
	ScenarioSummary,
	ScenarioV1,
	SavedScenario,
} from "@webhook-tester/contracts";
import type { StreamCallbacks } from "./run-stream";

export class ApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
		public readonly currentRevision?: number,
		public readonly issues?: unknown[],
	) {
		super(message);
		this.name = "ApiError";
	}
}

async function request<T>(
	path: string,
	signal?: AbortSignal,
	base = "",
	body?: unknown,
	method = "POST",
): Promise<T> {
	const timeout = AbortSignal.timeout(5000);
	const response = await fetch(`${base}${path}`, {
		cache: "no-store",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		...(body === undefined
			? {}
			: {
					method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	if (!response.ok) {
		let message = `Request failed (HTTP ${response.status}).`;
		let currentRevision: number | undefined;
		let issues: unknown[] | undefined;
		try {
			const error: unknown = await response.json();
			if (error && typeof error === "object") {
				if ("error" in error && typeof error.error === "string")
					message = error.error;
				else if ("message" in error && typeof error.message === "string")
					message = error.message;
				if (
					"currentRevision" in error &&
					typeof error.currentRevision === "number"
				)
					currentRevision = error.currentRevision;
				if ("issues" in error && Array.isArray(error.issues))
					issues = error.issues;
			}
		} catch {
			/* Keep the HTTP status if the response is not JSON. */
		}
		throw new ApiError(message, response.status, currentRevision, issues);
	}
	return response.json() as Promise<T>;
}

export function loadScenario(
	id: string,
	signal?: AbortSignal,
	base = "",
): Promise<SavedScenario> {
	return request(`/api/scenarios/${encodeURIComponent(id)}`, signal, base);
}
export function createScenario(
	document: ScenarioV1,
	signal?: AbortSignal,
	base = "",
): Promise<SavedScenario> {
	return request("/api/scenarios", signal, base, { document });
}
export function updateScenario(
	id: string,
	revision: number,
	document: ScenarioV1,
	signal?: AbortSignal,
	base = "",
): Promise<SavedScenario> {
	return request(
		`/api/scenarios/${encodeURIComponent(id)}`,
		signal,
		base,
		{ revision, document },
		"PUT",
	);
}
export function duplicateScenario(
	id: string,
	signal?: AbortSignal,
	base = "",
): Promise<SavedScenario> {
	return request(
		`/api/scenarios/${encodeURIComponent(id)}/duplicate`,
		signal,
		base,
		{},
	);
}

export function loadScenarios(
	signal?: AbortSignal,
	base = "",
): Promise<ScenarioSummary[]> {
	return request("/api/scenarios", signal, base);
}
export function loadTargets(
	signal?: AbortSignal,
	base = "",
): Promise<PublicTarget[]> {
	return request("/api/targets", signal, base);
}
export async function launchRun(
	scenarioId: string,
	targetId: string,
	signal?: AbortSignal,
	base = "",
): Promise<string> {
	const result = await request<{ runId: string }>("/api/runs", signal, base, {
		scenarioId,
		targetId,
	});
	return result.runId;
}

export function loadRun(
	runId: string,
	signal?: AbortSignal,
	base = "",
): Promise<RunResponse> {
	return request(`/api/runs/${encodeURIComponent(runId)}`, signal, base);
}

export function loadRunHistory(
	before?: string,
	signal?: AbortSignal,
	base = "",
): Promise<RunHistoryPage> {
	return request(`/api/runs?limit=20${before ? `&before=${encodeURIComponent(before)}` : ""}`, signal, base);
}

export async function rerunRun(
	runId: string,
	targetId: string,
	signal?: AbortSignal,
	base = "",
): Promise<string> {
	const result = await request<{ runId: string }>(`/api/runs/${encodeURIComponent(runId)}/rerun`, signal, base, { targetId });
	return result.runId;
}

type RunEventSource = {
	onopen: ((event: Event) => unknown) | null;
	onerror: ((event: Event) => unknown) | null;
	onmessage: ((event: MessageEvent) => unknown) | null;
	close(): void;
};
const eventTypes = new Set([
	"run.queued", "run.started", "run.phase", "run.completed",
	"delivery.scheduled", "delivery.started", "delivery.completed", "delivery.interrupted", "assertion.completed",
]);
export function subscribeRun(
	runId: string,
	after: string,
	callbacks: StreamCallbacks,
	base = "",
	createSource: (url: string) => RunEventSource = (url) => new EventSource(url),
): () => void {
	const source = createSource(`${base}/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(after)}`);
	source.onopen = () => callbacks.open();
	source.onerror = () => callbacks.error();
	source.onmessage = (message) => {
		try {
			const value: unknown = JSON.parse(message.data);
			if (!value || typeof value !== "object" ||
				!("cursor" in value) || typeof value.cursor !== "string" || !/^\d+$/.test(value.cursor) ||
				!("runId" in value) || value.runId !== runId ||
				!("type" in value) || typeof value.type !== "string" || !eventTypes.has(value.type) ||
				!("payload" in value) || !value.payload || typeof value.payload !== "object" || Array.isArray(value.payload) ||
				!("createdAt" in value) || typeof value.createdAt !== "string") return;
			callbacks.event(value as RunEvent);
		} catch {
			callbacks.error();
		}
	};
	// Keep one native EventSource so reconnects preserve Last-Event-ID.
	return () => { source.onopen = null; source.onerror = null; source.onmessage = null; source.close(); };
}
