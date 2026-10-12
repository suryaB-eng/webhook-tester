import type { RunEvent, RunResponse } from "@webhook-tester/contracts";

export type StreamConnection = "loading" | "connecting" | "live" | "reconnecting" | "complete";
export interface RunStreamState {
	run: RunResponse | null;
	error: string | null;
	connection: StreamConnection;
	refreshing: boolean;
}
export interface StreamCallbacks {
	event(event: RunEvent): void;
	open(): void;
	error(): void;
}
export interface RunStreamDependencies {
	load(runId: string, signal: AbortSignal): Promise<RunResponse>;
	subscribe(runId: string, after: string, callbacks: StreamCallbacks): () => void;
	retryMs?: number;
}
export class RunStreamController {
	state: RunStreamState = { run: null, error: null, connection: "loading", refreshing: false };
	private readonly abort = new AbortController();
	private unsubscribe: (() => void) | undefined;
	private retry: ReturnType<typeof setTimeout> | undefined;
	private received = 0n;
	private pending = false;
	private loading = false;
	private stopped = false;
	constructor(
		private readonly runId: string,
		private readonly dependencies: RunStreamDependencies,
		private readonly change: (state: RunStreamState) => void,
	) {}
	start() { this.refresh(); }
	refresh() {
		if (this.stopped) return;
		clearTimeout(this.retry);
		this.retry = undefined;
		this.pending = true;
		if (!this.loading) void this.reload();
	}
	stop() {
		this.stopped = true;
		clearTimeout(this.retry);
		this.abort.abort();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}
	private update(patch: Partial<RunStreamState>) {
		this.state = { ...this.state, ...patch };
		this.change(this.state);
	}
	private async reload() {
		this.loading = true;
		this.pending = false;
		this.update({ refreshing: true });
		try {
			const run = await this.dependencies.load(this.runId, this.abort.signal);
			if (this.stopped) return;
			const cursor = BigInt(run.eventCursor);
			this.update({ run, error: null });
			if (cursor < this.received) this.pending = true;
			else {
				this.received = cursor;
				if (["passed", "failed", "error", "interrupted"].includes(run.status)) {
					this.pending = false;
					this.unsubscribe?.();
					this.unsubscribe = undefined;
					this.update({ connection: "complete" });
				} else if (!this.unsubscribe) {
					this.update({ connection: "connecting" });
					this.unsubscribe = this.dependencies.subscribe(this.runId, run.eventCursor, {
						open: () => {
							if (this.stopped) return;
							this.update({ connection: "live" });
							this.refresh();
						},
						error: () => {
							if (this.stopped) return;
							this.update({ connection: "reconnecting" });
							this.refresh();
						},
						event: (event) => {
							if (this.stopped || event.runId !== this.runId || !/^\d+$/.test(event.cursor)) return;
							const next = BigInt(event.cursor);
							if (next <= this.received) return;
							this.received = next;
							this.refresh();
						},
					});
				}
			}
		} catch (reason) {
			if (this.stopped) return;
			this.update({ error: reason instanceof Error ? reason.message : "Unable to load run." });
			// Receiving a cursor does not imply that its coherent snapshot loaded.
			// Retain the invalidation and retry even if SSE replays only duplicates.
			this.pending = true;
			this.retry = setTimeout(() => {
				this.retry = undefined;
				if (!this.stopped) void this.reload();
			}, this.dependencies.retryMs ?? 1000);
		} finally {
			this.loading = false;
			if (!this.stopped) {
				this.update({ refreshing: false });
				if (this.pending && !this.retry) this.refresh();
			}
		}
	}
}
