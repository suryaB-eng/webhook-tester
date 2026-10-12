import assert from "node:assert/strict";
import test from "node:test";
import * as db from "@webhook-tester/db";
import { assertTestDatabase, testDatabaseUrls } from "@webhook-tester/db/testing";
import { buildApp } from "./app.js";

test("saved events are committed evidence with JSON and SSE replay", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await db.runMigrations(urls);
	const pool = db.createPool(urls.app);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = new URL(urls.app).pathname;
	const admin = db.createPool(adminUrl.toString());
	const app = buildApp({ appPool: pool, logger: false });
	const ids: string[] = [];
	t.after(async () => {
		await app.close();
		for (const id of ids) await admin.query("DELETE FROM runs WHERE id=$1", [id]);
		await Promise.all([pool.end(), admin.end()]);
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	await db.seedScenarios(pool);
	const launch = async () => {
		const result = await fetch(`${address}/api/runs`, {
			method: "POST",
			headers: { Origin: "http://127.0.0.1:4173", "Content-Type": "application/json" },
			body: JSON.stringify({ scenarioId: "one-payment" }),
		});
		assert.equal(result.status, 202);
		const { runId } = await result.json() as { runId: string };
		ids.push(runId);
		return runId;
	};
	await t.test("enqueue saves queued event and refresh snapshot includes matching cursor", async () => {
		const id = await launch();
		const response = await fetch(`${address}/api/runs/${id}/events`);
		assert.equal(response.status, 200);
		const events = await response.json() as { cursor: string; type: string; runId: string; payload: unknown }[];
		assert.equal(events.length, 1);
		assert.equal(events[0]?.type, "run.queued");
		assert.equal(events[0]?.runId, id);
		assert.deepEqual(events[0]?.payload, { status: "queued", phase: "queued" });
		assert.match(events[0]?.cursor ?? "", /^[1-9][0-9]*$/);
		const snapshot = await (await fetch(`${address}/api/runs/${id}`)).json() as { events: unknown[]; eventCursor: string };
		assert.deepEqual(snapshot.events, events);
		assert.equal(snapshot.eventCursor, events[0]?.cursor);
	});
});
