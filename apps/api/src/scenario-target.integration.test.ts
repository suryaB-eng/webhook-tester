import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { RunResponse, SavedScenario } from "@webhook-tester/contracts";
import { createPool, runMigrations, seedScenarios } from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { buildApp } from "./app.js";

test("default target and scenario snapshot come from the same locked revision during an edit", {
	timeout: 15_000,
}, async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const appPool = createPool(urls.app);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = new URL(urls.app).pathname;
	const adminPool = createPool(adminUrl.toString());
	const editor = await adminPool.connect();
	const api = buildApp({ appPool, logger: false });
	let scenarioId: string | undefined;
	let runId: string | undefined;
	t.after(async () => {
		try {
			await editor.query("ROLLBACK");
			editor.release();
			await api.close();
			if (runId) await adminPool.query("DELETE FROM runs WHERE id=$1", [runId]);
			if (scenarioId)
				await adminPool.query("DELETE FROM scenarios WHERE id=$1", [
					scenarioId,
				]);
		} finally {
			await Promise.all([appPool.end(), adminPool.end()]);
		}
	});
	await seedScenarios(appPool);
	const base = await api.listen({ host: "127.0.0.1", port: 0 });
	const preset = await fetch(`${base}/api/scenarios/one-payment`);
	const source = (await preset.json()) as SavedScenario;
	const headers = {
		Origin: "http://127.0.0.1:4173",
		"Content-Type": "application/json",
	};
	const created = await fetch(`${base}/api/scenarios`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			document: { ...source.document, targetId: "demo-flawed" },
		}),
	});
	assert.equal(created.status, 201);
	const saved = (await created.json()) as SavedScenario;
	scenarioId = saved.id;
	await editor.query("BEGIN");
	const owner = await editor.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = owner.rows[0]?.pid;
	assert.ok(pid);
	const edited = {
		...saved.document,
		name: "Edited default target",
		targetId: "demo-corrected",
	};
	await editor.query(
		"UPDATE scenarios SET definition=$2::jsonb,revision=revision+1 WHERE id=$1",
		[scenarioId, JSON.stringify(edited)],
	);
	const launch = fetch(`${base}/api/runs`, {
		method: "POST",
		headers,
		body: JSON.stringify({ scenarioId }),
	});
	const deadline = Date.now() + 5000;
	while (true) {
		const blocked = await adminPool.query(
			"SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE '%SELECT definition FROM scenarios%FOR SHARE%'",
			[pid],
		);
		if (blocked.rowCount) break;
		assert.ok(
			Date.now() < deadline,
			"enqueue did not reach the controlled row lock",
		);
		await setImmediate();
	}
	await editor.query("COMMIT");
	const queued = await launch;
	assert.equal(queued.status, 202);
	runId = ((await queued.json()) as { runId: string }).runId;
	const result = await fetch(`${base}/api/runs/${runId}`);
	const run = (await result.json()) as RunResponse;
	assert.equal(run.scenarioSnapshot.name, edited.name);
	assert.equal(run.scenarioSnapshot.targetId, "demo-corrected");
	assert.equal(run.targetSnapshot.id, "demo-corrected");
});
