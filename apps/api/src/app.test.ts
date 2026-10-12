import { createPool } from "@webhook-tester/db";
import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("the HTTP health endpoint returns the public JSON contract", async (t) => {
	const app = buildApp();
	t.after(() => app.close());
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	const response = await fetch(`${address}/health`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /application\/json/);
	assert.deepEqual(await response.json(), { status: "ok" });
});

test("targets expose only the two public payment profiles and no endpoints", async (t) => {
	const app = buildApp();
	t.after(() => app.close());
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	const response = await fetch(`${address}/api/targets`);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), [
		{ id: "demo-flawed", name: "Without deduplication" },
		{ id: "demo-corrected", name: "With deduplication" },
	]);
});

test("mutation validation rejects coercion and unknown fields before database access", async (t) => {
	const pool = createPool("postgres://unused:unused@127.0.0.1:1/unused");
	const app = buildApp({ appPool: pool, logger: false });
	t.after(async () => {
		try {
			await app.close();
		} finally {
			await pool.end();
		}
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	for (const body of [
		{ scenarioId: 7 },
		{ scenarioId: "one-payment", endpoint: "https://outside.invalid" },
	]) {
		const response = await fetch(`${address}/api/runs`, {
			method: "POST",
			headers: {
				Origin: "http://127.0.0.1:4173",
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
		assert.equal(response.status, 400);
	}
});
