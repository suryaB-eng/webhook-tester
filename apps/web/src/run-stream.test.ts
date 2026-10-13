import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { RunEvent, RunResponse } from "@webhook-tester/contracts";
import { RunStreamController, type RunStreamDependencies, type StreamCallbacks } from "./run-stream.js";
import { loadRun } from "./api.js";

function event(cursor: string, type: RunEvent["type"] = "run.phase"): RunEvent {
	return { cursor, runId: "saved-run", type, payload: { phase: "delivering" }, createdAt: "2026-10-12T12:00:00.000Z" };
}
function snapshot(cursor: string, status: RunResponse["status"] = "running"): RunResponse {
	return {
		id: "saved-run", status, phase: status === "passed" ? "completed" : "delivering", sourceRunId: null, targetOverride: null,
		scenarioSnapshot: { schemaVersion: 1, name: "Saved scenario", description: "", targetId: "demo", events: [], steps: [], limits: { maxConcurrency: 1, requestTimeoutMs: 1000, runTimeoutMs: 5000 }, assertions: [] },
		targetSnapshot: { id: "demo", name: "Demo" }, createdAt: "2026-10-12T12:00:00.000Z", startedAt: null, completedAt: status === "passed" ? "2026-10-12T12:00:01.000Z" : null,
		error: null, deliveries: [], assertions: [], eventCursor: cursor, events: cursor === "0" ? [] : [event(cursor)],
	};
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!check()) {
		assert.ok(Date.now() < deadline, "controller did not reach expected state");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
function harness(load: RunStreamDependencies["load"], retryMs = 1) {
	let callbacks: StreamCallbacks | undefined;
	let closed = 0;
	const subscriptions: string[] = [];
	const controller = new RunStreamController("saved-run", {
		load, retryMs,
		subscribe(_id, after, handlers) { subscriptions.push(after); callbacks = handlers; return () => { closed++; }; },
	}, () => {});
	return { controller, subscriptions, get callbacks() { assert.ok(callbacks); return callbacks; }, get closed() { return closed; } };
}

test("initial saved snapshot subscribes after its exact database cursor and deduplicates replay", async (t) => {
	let loads = 0;
	const h = harness(async () => { loads++; return snapshot("9007199254740993"); });
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	assert.deepEqual(h.subscriptions, ["9007199254740993"]);
	h.callbacks.event(event("9007199254740993"));
	h.callbacks.event(event("9007199254740992"));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(loads, 1);
	assert.deepEqual(h.controller.state.run?.events.map((item) => item.cursor), ["9007199254740993"]);
});

test("events arriving during a snapshot fetch trigger another coherent reload", async (t) => {
	let loads = 0;
	let resolveReload: ((value: RunResponse) => void) | undefined;
	const h = harness(async () => {
		loads++;
		if (loads === 2) return new Promise<RunResponse>((resolve) => { resolveReload = resolve; });
		return snapshot(loads === 1 ? "1" : "3");
	});
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	h.callbacks.event(event("2"));
	await until(() => Boolean(resolveReload));
	h.callbacks.event(event("3"));
	assert.equal(h.controller.state.run?.eventCursor, "1", "live events must not be merged into an older result");
	resolveReload?.(snapshot("2"));
	await until(() => h.controller.state.run?.eventCursor === "3");
	assert.equal(loads, 3);
	assert.deepEqual(h.controller.state.run?.events.map((item) => item.cursor), ["3"]);
});

test("failed event reload retries even when the same event is replayed", async (t) => {
	let loads = 0;
	const h = harness(async () => {
		loads++;
		if (loads === 2) throw new Error("Snapshot unavailable");
		return snapshot(loads === 1 ? "1" : "2");
	}, 20);
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	h.callbacks.event(event("2"));
	await until(() => h.controller.state.error !== null);
	assert.equal(h.controller.state.run?.eventCursor, "1");
	h.callbacks.event(event("2"));
	await until(() => h.controller.state.run?.eventCursor === "2");
	assert.equal(h.controller.state.error, null);
	assert.equal(loads, 3);
});

test("reconnection reloads saved completion before closing the stream", async (t) => {
	let loads = 0;
	let completed = false;
	const h = harness(async () => { loads++; return snapshot(completed ? "4" : "1", completed ? "passed" : "running"); });
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	h.callbacks.open();
	await until(() => loads === 2 && !h.controller.state.refreshing);
	h.callbacks.error();
	assert.equal(h.controller.state.connection, "reconnecting");
	assert.equal(h.closed, 0);
	completed = true;
	h.callbacks.open();
	await until(() => h.controller.state.connection === "complete");
	assert.equal(h.controller.state.run?.status, "passed");
	assert.equal(h.closed, 1);
});

test("a late subscriber and a refreshed page load persisted completion without opening a stream", async () => {
	for (let visit = 0; visit < 2; visit++) {
		const h = harness(async () => snapshot("5", "passed"));
		h.controller.start();
		await until(() => h.controller.state.connection === "complete");
		assert.equal(h.controller.state.run?.eventCursor, "5");
		assert.deepEqual(h.subscriptions, []);
		h.controller.stop();
	}
});

test("terminal event closes only after terminal saved results and refresh retains prior data", async (t) => {
	let loads = 0;
	let resolveReload: ((value: RunResponse) => void) | undefined;
	const h = harness(async () => {
		loads++;
		if (loads === 2) return new Promise<RunResponse>((resolve) => { resolveReload = resolve; });
		return snapshot("1");
	});
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	h.callbacks.event(event("2", "run.completed"));
	await until(() => Boolean(resolveReload));
	assert.equal(h.closed, 0);
	assert.equal(h.controller.state.run?.status, "running");
	resolveReload?.(snapshot("2", "passed"));
	await until(() => h.controller.state.connection === "complete");
	assert.equal(h.closed, 1);
	h.controller.refresh();
	assert.equal(h.controller.state.run?.status, "passed");
});

test("closing the view unsubscribes and aborts only the browser snapshot request", async () => {
	let signal: AbortSignal | undefined;
	const h = harness(async (_id, requestSignal) => { signal = requestSignal; return snapshot("1"); });
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	h.controller.stop();
	assert.equal(h.closed, 1);
	assert.equal(signal?.aborted, true);
});

test("initial snapshot failure remains retryable without subscribing before a coherent load", async (t) => {
	let unavailable = true;
	const h = harness(async () => {
		if (unavailable) throw new Error("Run unavailable");
		return snapshot("0", "queued");
	}, 1000);
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.controller.state.error !== null);
	assert.equal(h.controller.state.run, null);
	assert.deepEqual(h.subscriptions, []);
	unavailable = false;
	h.controller.refresh();
	await until(() => h.subscriptions.length === 1);
	assert.equal(h.controller.state.error, null);
	assert.deepEqual(h.subscriptions, ["0"]);
});

test("refresh reloads the persisted timeline while preserving the current stream subscription", async (t) => {
	let refreshed = false;
	const h = harness(async () => snapshot(refreshed ? "7" : "1"));
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	refreshed = true;
	h.controller.refresh();
	assert.equal(h.controller.state.run?.eventCursor, "1");
	await until(() => h.controller.state.run?.eventCursor === "7");
	assert.deepEqual(h.controller.state.run?.events.map((item) => item.cursor), ["7"]);
	assert.deepEqual(h.subscriptions, ["1"]);
	assert.equal(h.closed, 0);
});

test("events for another run and malformed cursors cannot invalidate this run", async (t) => {
	let loads = 0;
	const h = harness(async () => { loads++; return snapshot("1"); });
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	h.callbacks.event({ ...event("2"), runId: "another" });
	h.callbacks.event(event("2.5"));
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(loads, 1);
	assert.equal(h.controller.state.run?.eventCursor, "1");
});

test("HTTP snapshot reload keeps persisted assertion and timeline results coherent", async (t) => {
	let saved = snapshot("1");
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(`${request.method} ${request.url}`);
		response.setHeader("Content-Type", "application/json");
		if (request.url !== "/api/runs/saved-run") {
			response.writeHead(404).end(JSON.stringify({ error: "Run missing" }));
			return;
		}
		response.end(JSON.stringify(saved));
	});
	t.after(() => new Promise<void>((resolve, reject) => {
		server.close((error) => error ? reject(error) : resolve());
		server.closeAllConnections();
	}));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	const h = harness((id, signal) => loadRun(id, signal, base));
	t.after(() => h.controller.stop());
	h.controller.start();
	await until(() => h.subscriptions.length === 1);
	saved = {
		...snapshot("3", "passed"),
		events: [event("1", "run.started"), { ...event("2", "assertion.completed"), payload: { assertionId: "assertion-1", assertionName: "Count", expected: 1, actual: 1, assertionStatus: "passed" } }, { ...event("3", "run.completed"), payload: { status: "passed" } }],
		assertions: [{ id: "assertion-1", name: "Count", query: "SELECT 1", expected: 1, actual: 1, status: "passed", error: null }],
	};
	h.callbacks.event(event("3", "run.completed"));
	assert.equal(h.controller.state.run?.assertions.length, 0);
	await until(() => h.controller.state.connection === "complete");
	assert.deepEqual(h.controller.state.run, saved);
	assert.deepEqual(requests, ["GET /api/runs/saved-run", "GET /api/runs/saved-run"]);
	assert.equal(h.closed, 1);
});
