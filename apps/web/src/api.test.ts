import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { launchRun, loadScenarios, loadTargets } from "./api.js";
import * as api from "./api.js";

test("scenario CRUD uses JSON requests and preserves revision conflict details", async (t) => {
	assert.equal(
		typeof api.createScenario,
		"function",
		"scenario creation is available",
	);
	const document = {
		schemaVersion: 1 as const,
		name: "Editable",
		description: "",
		targetId: "demo-corrected",
		events: [
			{
				id: "event-1",
				payload: {
					id: "payment-1",
					type: "payment.succeeded",
					data: { orderId: "order-1", quantity: 1 },
				},
			},
		],
		steps: [
			{
				id: "step-1",
				mode: "sequential" as const,
				delayBeforeMs: 0,
				deliveries: [{ deliveryId: "delivery-1", eventId: "event-1" }],
			},
		],
		limits: { maxConcurrency: 2, requestTimeoutMs: 1000, runTimeoutMs: 5000 },
		assertions: [
			{ id: "assertion-1", name: "Count", query: "SELECT 1::int", expected: 1 },
		],
	};
	const seen: {
		method: string | undefined;
		url: string | undefined;
		body: unknown;
		contentType: string | undefined;
	}[] = [];
	const server = createServer(async (request, response) => {
		let source = "";
		for await (const chunk of request) source += chunk;
		const body: unknown = source ? JSON.parse(source) : undefined;
		seen.push({
			method: request.method,
			url: request.url,
			body,
			contentType: request.headers["content-type"],
		});
		response.setHeader("Content-Type", "application/json");
		if (
			request.method === "PUT" &&
			seen.filter((entry) => entry.method === "PUT").length === 2
		) {
			response
				.writeHead(409)
				.end(
					JSON.stringify({
						error: "Scenario has changed",
						currentRevision: 3,
						issues: [{ path: "name", message: "Review name" }],
					}),
				);
		} else {
			response
				.writeHead(request.method === "POST" ? 201 : 200)
				.end(
					JSON.stringify({
						id: request.url?.endsWith("duplicate") ? "copy" : "saved",
						revision: request.method === "PUT" ? 2 : 1,
						document,
					}),
				);
		}
	});
	t.after(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	assert.equal(
		(await api.createScenario(document, undefined, base)).revision,
		1,
	);
	assert.equal(
		(await api.loadScenario("saved", undefined, base)).document.name,
		"Editable",
	);
	assert.equal(
		(await api.updateScenario("saved", 1, document, undefined, base)).revision,
		2,
	);
	assert.equal(
		(await api.duplicateScenario("saved", undefined, base)).id,
		"copy",
	);
	await assert.rejects(
		api.updateScenario("saved", 1, document, undefined, base),
		(error: unknown) => {
			assert.ok(error instanceof api.ApiError);
			assert.equal(error.status, 409);
			assert.equal(error.currentRevision, 3);
			assert.equal(error.message, "Scenario has changed");
			assert.deepEqual(error.issues, [
				{ path: "name", message: "Review name" },
			]);
			return true;
		},
	);
	assert.deepEqual(
		seen.map(({ method, url, body }) => ({ method, url, body })),
		[
			{ method: "POST", url: "/api/scenarios", body: { document } },
			{ method: "GET", url: "/api/scenarios/saved", body: undefined },
			{
				method: "PUT",
				url: "/api/scenarios/saved",
				body: { revision: 1, document },
			},
			{ method: "POST", url: "/api/scenarios/saved/duplicate", body: {} },
			{
				method: "PUT",
				url: "/api/scenarios/saved",
				body: { revision: 1, document },
			},
		],
	);
	assert.ok(
		seen
			.filter((request) => request.method !== "GET")
			.every((request) => request.contentType === "application/json"),
	);
});

test("scenario launch sends JSON and saved run reads support refresh and HTTP errors", async (t) => {
	assert.equal(typeof api.loadRun, "function", "saved run snapshots can be loaded independently of the stream");
	let reads = 0;
	const requests: {
		method: string | undefined;
		url: string | undefined;
		contentType: string | undefined;
		body: string;
	}[] = [];
	const server = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk;
		requests.push({
			method: request.method,
			url: request.url,
			contentType: request.headers["content-type"],
			body,
		});
		response.setHeader("Content-Type", "application/json");
		switch (request.url) {
			case "/api/scenarios":
				response.end(
					JSON.stringify([
						{ id: "duplicate", name: "Sequential duplicate payment" },
					]),
				);
				break;
			case "/api/targets":
				response.end(
					JSON.stringify([
						{ id: "demo-corrected", name: "With deduplication" },
					]),
				);
				break;
			case "/api/runs":
				response.writeHead(202).end(JSON.stringify({ runId: "saved-run" }));
				break;
			case "/api/runs/saved-run": {
				const status = ["queued", "running", "passed"][Math.min(reads++, 2)];
				response.end(JSON.stringify({ id: "saved-run", status }));
				break;
			}
			default:
				response
					.writeHead(404)
					.end(JSON.stringify({ message: "Run not found" }));
		}
	});
	t.after(
		() =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
				server.closeAllConnections();
			}),
	);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const base = `http://127.0.0.1:${address.port}`;
	assert.equal((await loadScenarios(undefined, base))[0]?.id, "duplicate");
	assert.equal(
		(await loadTargets(undefined, base))[0]?.name,
		"With deduplication",
	);
	const id = await launchRun("duplicate", "demo-corrected", undefined, base);
	assert.equal(id, "saved-run");
	const statuses = [];
	for (let read = 0; read < 3; read++) statuses.push((await api.loadRun(id, undefined, base)).status);
	assert.deepEqual(statuses, ["queued", "running", "passed"]);
	assert.equal(reads, 3);
	assert.deepEqual(
		requests.find((request) => request.method === "POST"),
		{
			method: "POST",
			url: "/api/runs",
			contentType: "application/json",
			body: JSON.stringify({
				scenarioId: "duplicate",
				targetId: "demo-corrected",
			}),
		},
	);
	assert.equal((await api.loadRun(id, undefined, base)).id, "saved-run");
	await assert.rejects(api.loadRun("missing", undefined, base), /Run not found/);
	await assert.rejects(api.loadRun(id, AbortSignal.abort(), base));
});

test("run SSE uses the saved decimal cursor and delivers only valid events for this run", () => {
	assert.equal(typeof api.subscribeRun, "function", "run events are subscribed through native EventSource");
	let url = "";
	let closed = false;
	const source = {
		onopen: null as ((event: Event) => unknown) | null,
		onerror: null as ((event: Event) => unknown) | null,
		onmessage: null as ((event: MessageEvent) => unknown) | null,
		close() { closed = true; },
	};
	const events: string[] = [];
	let opens = 0;
	let errors = 0;
	const unsubscribe = api.subscribeRun("run/id", "9007199254740993", {
		event: (event) => events.push(event.cursor), open: () => { opens++; }, error: () => { errors++; },
	}, "", (value) => { url = value; return source; });
	assert.equal(url, "/api/runs/run%2Fid/events?after=9007199254740993");
	source.onopen?.(new Event("open"));
	source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ cursor: "9007199254740994", runId: "run/id", type: "run.phase", payload: { phase: "asserting" }, createdAt: "2026-10-12T12:00:00.000Z" }) }));
	source.onmessage?.(new MessageEvent("message", { data: "invalid json" }));
	source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ cursor: 4, runId: "run/id", type: "run.phase" }) }));
	source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ cursor: "5", runId: "other", type: "run.phase", payload: {}, createdAt: "2026-10-12T12:00:00.000Z" }) }));
	source.onerror?.(new Event("error"));
	assert.deepEqual(events, ["9007199254740994"]);
	assert.equal(opens, 1);
	assert.ok(errors >= 1);
	assert.equal(closed, false, "native reconnect must retain this EventSource and its Last-Event-ID");
	unsubscribe();
	assert.equal(closed, true);
});
