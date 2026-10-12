import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { deliverWebhook } from "./target.js";

test("dispatch captures bounded HTTP responses without redirects and classifies timeouts", async (t) => {
	let redirected = 0;
	const server = createServer(async (request, response) => {
		if (request.url === "/redirect") {
			response.writeHead(302, { location: "/followed" });
			response.end();
			return;
		}
		if (request.url === "/followed") redirected++;
		if (request.url === "/slow") await delay(250);
		if (request.url === "/nul") {
			response.end(Buffer.from([65, 0, 66]));
			return;
		}
		if (request.url === "/binary") {
			response.end(Buffer.alloc(20000, 255));
			return;
		}
		if (request.url === "/large") response.end("é".repeat(20000));
		else
			response.end(
				JSON.stringify({
					transportId: request.headers["x-webhook-lab-delivery-id"],
				}),
			);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const port = address.port;
	function dispatch(path: string, timeout = 1000) {
		return deliverWebhook({
			profile: {
				id: "demo-corrected",
				name: "With deduplication",
				endpoint: `http://127.0.0.1:${port}${path}`,
				completion: { kind: "synchronous" },
			},
			runId: "00000000-0000-0000-0000-000000000001",
			deliveryId: "transport_a",
			payload: { id: "logical_b" },
			requestTimeoutMs: timeout,
			runSignal: new AbortController().signal,
		});
	}
	const success = await dispatch("/");
	assert.equal(success.httpStatus, 200);
	assert.equal(success.outcome, "ok");
	assert.equal(
		JSON.parse(success.responseExcerpt ?? "").transportId,
		"transport_a",
	);
	assert.equal(success.uncertain, false);
	const large = await dispatch("/large");
	assert.equal(large.outcome, "ok");
	assert.equal(large.responseTruncated, true);
	assert.ok(Buffer.byteLength(large.responseExcerpt ?? "") <= 16384);
	assert.ok(!(large.responseExcerpt ?? "").includes("�"));
	const binary = await dispatch("/binary");
	assert.ok(Buffer.byteLength(binary.responseExcerpt ?? "") <= 16384);
	assert.equal(binary.responseTruncated, true);
	const nul = await dispatch("/nul");
	assert.equal(nul.httpStatus, 200);
	assert.ok(!(nul.responseExcerpt ?? "").includes("\u0000"));
	const redirect = await dispatch("/redirect");
	assert.equal(redirect.httpStatus, 302);
	assert.equal(redirect.outcome, "failed");
	assert.equal(redirected, 0);
	const timeout = await dispatch("/slow", 100);
	assert.equal(timeout.outcome, "error");
	assert.match(timeout.error ?? "", /timeout|timed out/i);
	assert.equal(timeout.uncertain, true);
});
