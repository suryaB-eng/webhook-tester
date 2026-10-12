import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
	PublicTarget,
	RunResponse,
	ScenarioSummary,
} from "@webhook-tester/contracts";
import {
	createPool,
	runMigrations,
	seedScenarios,
	listScenarios,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { buildApp } from "./app.js";

test("real HTTP scenario enqueue stores immutable evidence and enforces the local mutation boundary", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const pool = createPool(urls.app);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = new URL(urls.app).pathname;
	const admin = createPool(adminUrl.toString());
	const targets = new Map<string, PublicTarget>([
		["demo-flawed", { id: "demo-flawed", name: "Without deduplication" }],
		["demo-corrected", { id: "demo-corrected", name: "With deduplication" }],
	]);
	const app = buildApp({
		appPool: pool,
		targets,
		allowedOrigin: "http://127.0.0.1:4173",
		logger: false,
	});
	const ids: string[] = [];
	const scenarioId = `test-${randomUUID()}`;
	t.after(async () => {
		try {
			await app.close();
		} finally {
			try {
				for (const id of ids)
					await admin.query("DELETE FROM runs WHERE id=$1", [id]);
				await admin.query("DELETE FROM scenarios WHERE id=$1", [scenarioId]);
			} finally {
				await Promise.all([pool.end(), admin.end()]);
			}
		}
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	await seedScenarios(pool);
	const first = (await listScenarios(pool)).find(
		(item) => item.id === "one-payment",
	);
	assert.ok(first);
	await pool.query("INSERT INTO scenarios(id,definition) VALUES($1,$2)", [
		scenarioId,
		JSON.stringify(first.scenario),
	]);
	const post = (body: unknown, headers: Record<string, string> = {}) =>
		fetch(`${address}/api/runs`, {
			method: "POST",
			headers: {
				Origin: "http://127.0.0.1:4173",
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify(body),
		});
	await t.test(
		"GET lists payment and status plans and valid public targets",
		async () => {
			const result = await fetch(`${address}/api/scenarios`);
			assert.equal(result.status, 200);
			const scenarios = (await result.json()) as ScenarioSummary[];
			assert.ok(scenarios.some((scenario) => scenario.id === "one-payment"));
			assert.ok(
				scenarios.some(
					(scenario) => scenario.id === "sequential-duplicate-payment",
				),
			);
			const concurrent = scenarios.find(
				(scenario) => scenario.id === "concurrent-duplicate-payment",
			);
			assert.equal(concurrent?.scenario.steps[0]?.mode, "concurrent");
			assert.equal(concurrent?.scenario.steps[0]?.deliveries.length, 2);
			assert.equal(concurrent?.scenario.limits.maxConcurrency, 2);
			const statuses = scenarios.find(
				(scenario) => scenario.id === "status-version-out-of-order",
			);
			assert.deepEqual(
				statuses?.scenario.assertions.map((assertion) => assertion.expected),
				["shipped", 2],
			);
			const resultTargets = await fetch(`${address}/api/targets`);
			assert.deepEqual(await resultTargets.json(), [...targets.values()]);
		},
	);
	await t.test(
		"enqueue is atomic, snapshots validated data, and refresh reads the same persisted result",
		async () => {
			const result = await post({ scenarioId, targetId: "demo-corrected" });
			assert.equal(result.status, 202);
			const { runId } = (await result.json()) as { runId: string };
			ids.push(runId);
			const initialResponse = await fetch(`${address}/api/runs/${runId}`);
			assert.equal(initialResponse.status, 200);
			const initial = (await initialResponse.json()) as RunResponse;
			assert.equal(initial.status, "queued");
			assert.equal(initial.scenarioSnapshot.targetId, "demo-corrected");
			assert.deepEqual(initial.targetSnapshot, targets.get("demo-corrected"));
			assert.equal(initial.deliveries.length, 1);
			assert.equal(initial.deliveries[0]?.outcome, "pending");
			assert.deepEqual(
				initial.deliveries[0]?.requestPayload,
				first.scenario.events[0]?.payload,
			);
			assert.equal(initial.assertions.length, 2);
			assert.deepEqual(
				(await pool.query("SELECT status FROM jobs WHERE run_id=$1", [runId]))
					.rows,
				[{ status: "queued" }],
			);
			await pool.query("UPDATE scenarios SET definition=$2 WHERE id=$1", [
				scenarioId,
				JSON.stringify({ ...first.scenario, name: "Edited after enqueue" }),
			]);
			targets.set("demo-corrected", {
				id: "demo-corrected",
				name: "Changed server name",
			});
			assert.deepEqual(
				await (await fetch(`${address}/api/runs/${runId}`)).json(),
				initial,
			);
		},
	);
	await t.test(
		"restart seeding preserves stored user edits in old and new presets",
		async () => {
			for (const id of [
				"one-payment",
				"concurrent-duplicate-payment",
				"status-version-out-of-order",
			]) {
				const seed = (
					await pool.query("SELECT definition FROM scenarios WHERE id=$1", [id])
				).rows[0]?.definition;
				assert.ok(seed);
				try {
					await pool.query("UPDATE scenarios SET definition=$2 WHERE id=$1", [
						id,
						JSON.stringify({ ...seed, name: "User edit survives restart" }),
					]);
					await seedScenarios(pool);
					assert.equal(
						(await listScenarios(pool)).find((scenario) => scenario.id === id)
							?.name,
						"User edit survives restart",
					);
				} finally {
					await pool.query("UPDATE scenarios SET definition=$2 WHERE id=$1", [
						id,
						JSON.stringify(seed),
					]);
				}
			}
		},
	);
	await t.test(
		"enforces exact configured Origin, JSON, strict body, configured targets and existing scenarios",
		async () => {
			for (const origin of [
				"http://localhost:4173",
				"https://outside.invalid",
				"null",
				"",
			]) {
				assert.equal(
					(await post({ scenarioId }, { Origin: origin })).status,
					403,
				);
			}
			assert.equal(
				(await post({ scenarioId }, { "Content-Type": "text/plain" })).status,
				415,
			);
			assert.equal(
				(await post({ scenarioId, endpoint: "https://outside.invalid" }))
					.status,
				400,
			);
			assert.equal(
				(await post({ scenarioId, targetId: "external" })).status,
				400,
			);
			assert.equal((await post({ scenarioId: "missing" })).status, 404);
			assert.equal((await post({ scenarioId: 7 })).status, 400);
			assert.equal((await fetch(`${address}/api/runs/not-a-uuid`)).status, 400);
			assert.equal(
				(await fetch(`${address}/api/runs/${randomUUID()}`)).status,
				404,
			);
		},
	);
	await t.test(
		"invalid persisted scenarios cannot enqueue partial jobs or evidence",
		async () => {
			await pool.query("UPDATE scenarios SET definition=$2 WHERE id=$1", [
				scenarioId,
				JSON.stringify({ ...first.scenario, steps: [] }),
			]);
			assert.equal((await post({ scenarioId })).status, 400);
			const runs = await pool.query(
				"SELECT id FROM runs WHERE scenario_snapshot->>'name'='Edited after enqueue'",
			);
			assert.equal(runs.rowCount, 0);
		},
	);
});
