import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { launchRun, loadScenarios, loadTargets, watchRun } from "./api.js";

test("scenario launch sends JSON and polls saved results until completion", async (t) => {
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
	for await (const run of watchRun(id, new AbortController().signal, 1, base))
		statuses.push(run.status);
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
	const refreshed = [];
	for await (const run of watchRun(id, new AbortController().signal, 1, base))
		refreshed.push(run.id);
	assert.deepEqual(refreshed, ["saved-run"]);
	await assert.rejects(async () => {
		for await (const _run of watchRun(
			"missing",
			new AbortController().signal,
			1,
			base,
		)) {
			/* consume */
		}
	}, /Run not found/);
	await assert.rejects(async () => {
		for await (const _run of watchRun(id, AbortSignal.abort(), 1, base)) {
			/* consume */
		}
	});
});
