import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
	parseScenarioImport,
	serializeScenarioExport,
	type PublicTarget,
	type RunResponse,
	type SavedScenario,
	type ScenarioV1,
} from "@webhook-tester/contracts";
import {
	cleanupDemoFixtures,
	createPool,
	runMigrations,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import type { Pool } from "pg";
import { runWorkerOnce, type WorkerTargetProfile } from "./index.js";

type Server = {
	listen(options: { host: string; port: number }): Promise<string>;
	close(): Promise<void>;
};

test("edited scenarios run derived quantity fixtures while old HTTP run results retain their snapshot", {
	timeout: 90_000,
}, async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = "/webhook_tester";
	const appPool = createPool(urls.app),
		fixturePool = createPool(urls.targetFixture),
		queryPool = createPool(urls.targetQuery),
		targetPool = createPool(urls.targetApp),
		adminPool = createPool(adminUrl.toString());
	const runIds: string[] = [],
		scenarioIds: string[] = [];
	const demoModuleUrl = new URL("../../demo-target/src/app.ts", import.meta.url)
		.href;
	const apiModuleUrl = new URL("../../api/src/app.ts", import.meta.url).href;
	const { buildDemoTarget } = (await import(demoModuleUrl)) as {
		buildDemoTarget(pool: Pool): Server;
	};
	const { buildApp } = (await import(apiModuleUrl)) as {
		buildApp(options: {
			appPool: Pool;
			allowedOrigin: string;
			targets: ReadonlyMap<string, PublicTarget>;
			logger: boolean;
		}): Server;
	};
	const target: PublicTarget = {
		id: "demo-corrected",
		name: "With deduplication",
	};
	const origin = "http://127.0.0.1:4173";
	const demo = buildDemoTarget(targetPool),
		api = buildApp({
			appPool,
			allowedOrigin: origin,
			targets: new Map([[target.id, target]]),
			logger: false,
		});
	t.after(async () => {
		try {
			await Promise.all([api.close(), demo.close()]);
		} finally {
			try {
				for (const id of runIds) await cleanupDemoFixtures(fixturePool, id);
				await adminPool.query("DELETE FROM runs WHERE id = ANY($1::uuid[])", [
					runIds,
				]);
				await adminPool.query(
					"DELETE FROM scenarios WHERE id = ANY($1::text[])",
					[scenarioIds],
				);
			} finally {
				await Promise.all(
					[appPool, fixturePool, queryPool, targetPool, adminPool].map((pool) =>
						pool.end(),
					),
				);
			}
		}
	});
	const demoBase = await demo.listen({ host: "127.0.0.1", port: 0 }),
		apiBase = await api.listen({ host: "127.0.0.1", port: 0 });
	const targetProfiles = new Map<string, WorkerTargetProfile>([
		[
			target.id,
			{
				...target,
				endpoint: `${demoBase}/webhooks/corrected`,
				completion: { kind: "synchronous" },
			},
		],
	]);
	const orderId = `alternate_${randomUUID()}`;
	const document: ScenarioV1 = {
		schemaVersion: 1,
		name: "Alternate order quantity",
		description: "",
		targetId: target.id,
		events: [
			{
				id: "payment",
				payload: {
					id: "business-payment",
					type: "payment.succeeded",
					data: { orderId, quantity: 2 },
				},
			},
		],
		steps: [
			{
				id: "payments",
				mode: "sequential",
				delayBeforeMs: 0,
				deliveries: [{ deliveryId: "transport-payment", eventId: "payment" }],
			},
		],
		limits: { maxConcurrency: 1, requestTimeoutMs: 3000, runTimeoutMs: 30000 },
		assertions: [
			{
				id: "fulfilled",
				name: "One fulfillment",
				query:
					"SELECT count(*)::int AS value FROM fulfillments WHERE run_id=$1 AND order_id='" +
					orderId +
					"'",
				expected: 1,
			},
			{
				id: "stock",
				name: "Inventory",
				query:
					"SELECT quantity::int AS value FROM inventory WHERE run_id=$1 AND sku='sku_001'",
				expected: 8,
			},
		],
	};
	async function mutate(
		path: string,
		body: unknown,
		method = "POST",
		expectedStatus = 201,
	) {
		const response = await fetch(apiBase + path, {
			method,
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const result: unknown = await response.json();
		assert.equal(response.status, expectedStatus, JSON.stringify(result));
		return result;
	}
	const saved = (await mutate("/api/scenarios", {
		document: parseScenarioImport(serializeScenarioExport(document)),
	})) as SavedScenario;
	scenarioIds.push(saved.id);
	async function enqueue() {
		const queued = (await mutate(
			"/api/runs",
			{ scenarioId: saved.id },
			"POST",
			202,
		)) as { runId: string };
		runIds.push(queued.runId);
		return queued.runId;
	}
	const oldRunId = await enqueue();
	const edited = structuredClone(document);
	const event = edited.events[0];
	assert.ok(event);
	event.payload.data = { orderId, quantity: 1 };
	const inventory = edited.assertions[1];
	assert.ok(inventory);
	inventory.expected = 9;
	const updated = (await mutate(
		`/api/scenarios/${saved.id}`,
		{ revision: saved.revision, document: edited },
		"PUT",
		200,
	)) as SavedScenario;
	assert.equal(updated.revision, 2);
	async function process(
		runId: string,
		expectedQuantity: number,
		expectedStock: number,
	) {
		assert.equal(
			await runWorkerOnce({
				appPool,
				fixturePool,
				queryPool,
				targetProfiles,
				workerId: `editing-${randomUUID()}`,
			}),
			"processed",
		);
		const response = await fetch(`${apiBase}/api/runs/${runId}`);
		assert.equal(response.status, 200);
		const run = (await response.json()) as RunResponse;
		assert.equal(run.status, "passed");
		assert.deepEqual(
			run.assertions.map((item) => item.actual),
			[1, expectedStock],
		);
		assert.equal(run.deliveries[0]?.httpStatus, 200);
		assert.deepEqual(run.deliveries[0]?.requestPayload, {
			id: "business-payment",
			type: "payment.succeeded",
			data: { orderId, quantity: expectedQuantity },
		});
		return run;
	}
	const oldRun = await process(oldRunId, 2, 8);
	const newRunId = await enqueue();
	await process(newRunId, 1, 9);
	const refreshed = await fetch(`${apiBase}/api/runs/${oldRunId}`);
	assert.deepEqual(await refreshed.json(), oldRun);
	const fixtures = await queryPool.query(
		"SELECT count(*)::int AS value FROM orders WHERE run_id=ANY($1::uuid[])",
		[runIds],
	);
	assert.equal(fixtures.rows[0]?.value, 0);
});
