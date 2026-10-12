import type {
	PublicTarget,
	RunResponse,
	RunStatus,
	ScenarioSummary,
} from "@webhook-tester/contracts";

async function request<T>(
	path: string,
	signal?: AbortSignal,
	base = "",
	body?: unknown,
): Promise<T> {
	const timeout = AbortSignal.timeout(5000);
	const response = await fetch(`${base}${path}`, {
		cache: "no-store",
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		...(body === undefined
			? {}
			: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
	});
	if (!response.ok) {
		let message = `Request failed (HTTP ${response.status}).`;
		try {
			const error: unknown = await response.json();
			if (
				error &&
				typeof error === "object" &&
				"message" in error &&
				typeof error.message === "string"
			) {
				message = error.message;
			}
		} catch {
			/* Keep the HTTP status if the response is not JSON. */
		}
		throw new Error(message);
	}
	return response.json() as Promise<T>;
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
