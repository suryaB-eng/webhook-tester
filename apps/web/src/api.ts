import type {
	PublicTarget,
	RunResponse,
	RunStatus,
	ScenarioSummary,
	ScenarioV1,
	SavedScenario,
} from "@webhook-tester/contracts";

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

const terminal: ReadonlySet<RunStatus> = new Set([
	"passed",
	"failed",
	"error",
	"interrupted",
]);
export async function* watchRun(
	runId: string,
	signal: AbortSignal,
	intervalMs = 750,
	base = "",
): AsyncGenerator<RunResponse> {
	while (!signal.aborted) {
		const run = await request<RunResponse>(
			`/api/runs/${encodeURIComponent(runId)}`,
			signal,
			base,
		);
		yield run;
		if (terminal.has(run.status)) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, intervalMs);
			function abort() {
				clearTimeout(timer);
				reject(signal.reason);
			}
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		});
	}
	signal.throwIfAborted();
}
