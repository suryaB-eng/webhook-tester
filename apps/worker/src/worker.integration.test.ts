import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import test from "node:test";
import type { ScenarioV1 } from "@webhook-tester/contracts";
import {
	cleanupDemoFixtures,
	createPool,
	enqueueRun,
	getRun,
	prepareDemoFixtures,
	runMigrations,
	seedScenarios,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { Pool } from "pg";
import {
	runWorkerOnce,
	type WorkerOptions,
	type WorkerTargetProfile,
} from "./index.js";

import { finishInterrupted } from "./repository.js";

type DemoServer = {
	listen(options: { host: string; port: number }): Promise<string>;
	close(): Promise<void>;
};

function signal() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function withHttpServer<T>(
	handler: (
		request: IncomingMessage,
		response: ServerResponse,
	) => Promise<void> | void,
	operation: (endpoint: string) => Promise<T>,
): Promise<T> {
	const server = createServer((request, response) => {
		Promise.resolve(handler(request, response)).catch((error: unknown) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		return await operation(`http://127.0.0.1:${address.port}`);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

test("sequential worker persists real HTTP and PostgreSQL run results", {
	timeout: 90_000,
}, async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = "/webhook_tester";
	const appPool = createPool(urls.app);
	const fixturePool = createPool(urls.targetFixture);
	const queryPool = createPool(urls.targetQuery);
	const targetPool = createPool(urls.targetApp);
	const adminPool = createPool(adminUrl.toString());
	const runIds: string[] = [];
	const scenarioIds: string[] = [];
	const moduleUrl = new URL("../../demo-target/src/app.ts", import.meta.url)
		.href;
	const { buildDemoTarget } = (await import(moduleUrl)) as {
		buildDemoTarget(pool: Pool): DemoServer;
	};
	const demo = buildDemoTarget(targetPool);
	t.after(async () => {
		try {
			await demo.close();
		} finally {
			try {
				for (const id of runIds) await cleanupDemoFixtures(fixturePool, id);
				if (runIds.length)
					await adminPool.query("DELETE FROM runs WHERE id = ANY($1::uuid[])", [
						runIds,
					]);
				if (scenarioIds.length)
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
	const base = await demo.listen({ host: "127.0.0.1", port: 0 });
	await seedScenarios(appPool);
	const profiles = new Map<string, WorkerTargetProfile>([
		[
			"demo-flawed",
			{
				id: "demo-flawed",
				name: "Without deduplication",
				endpoint: `${base}/webhooks/flawed`,
				completion: { kind: "synchronous" },
			},
		],
		[
			"demo-corrected",
			{
				id: "demo-corrected",
				name: "With deduplication",
				endpoint: `${base}/webhooks/corrected`,
				completion: { kind: "synchronous" },
			},
		],
	]);
	function options(
		targetProfiles = profiles,
		workerId = `test-${randomUUID()}`,
	): WorkerOptions {
		return { appPool, fixturePool, queryPool, targetProfiles, workerId };
	}
	async function enqueue(scenarioId: string, targetId = "demo-corrected") {
		const target = profiles.get(targetId);
		assert.ok(target);
		const runId = await enqueueRun(appPool, scenarioId, {
			id: target.id,
			name: target.name,
		});
		runIds.push(runId);
		return runId;
	}
	async function read(runId: string) {
		const result = await getRun(appPool, runId);
		assert.ok(result);
		return result;
	}
	async function seedDefinition(): Promise<ScenarioV1> {
		const result = await appPool.query<{ definition: ScenarioV1 }>(
			"SELECT definition FROM scenarios WHERE id = 'one-payment'",
		);
		assert.ok(result.rows[0]);
		return structuredClone(result.rows[0].definition);
	}
	async function save(definition: ScenarioV1) {
		const id = `test-${randomUUID()}`;
		scenarioIds.push(id);
		await appPool.query("INSERT INTO scenarios(id,definition) VALUES($1,$2)", [
			id,
			definition,
		]);
		return id;
	}
	async function process(runId: string, workerOptions = options()) {
		assert.equal(await runWorkerOnce(workerOptions), "processed");
		return read(runId);
	}
	function alternate(endpoint: string) {
		const profile = profiles.get("demo-corrected");
		assert.ok(profile);
		return new Map([["demo-corrected", { ...profile, endpoint }]]);
	}

	for (const scenarioId of ["one-payment", "sequential-duplicate-payment"]) {
		for (const targetId of ["demo-flawed", "demo-corrected"]) {
			await t.test(
				`${scenarioId} against ${targetId} stores delivery responses and scalar assertions`,
				async () => {
					const runId = await enqueue(scenarioId, targetId);
					const run = await process(runId);
					const duplicated = scenarioId === "sequential-duplicate-payment";
					const flawedDuplicate = duplicated && targetId === "demo-flawed";
					assert.equal(run.status, flawedDuplicate ? "failed" : "passed");
					assert.ok(run.startedAt && run.completedAt);
					assert.deepEqual(run.targetSnapshot, {
						id: targetId,
						name:
							targetId === "demo-flawed"
								? "Without deduplication"
								: "With deduplication",
					});
					assert.equal(run.deliveries.length, duplicated ? 2 : 1);
					for (const delivery of run.deliveries) {
						assert.equal(delivery.httpStatus, 200);
						assert.equal(delivery.outcome, "ok");
						assert.ok(
							delivery.scheduledAt &&
								delivery.startedAt &&
								delivery.completedAt,
						);
						assert.deepEqual(
							delivery.requestPayload,
							run.scenarioSnapshot.events[0]?.payload,
						);
						assert.match(delivery.responseExcerpt ?? "", /received/);
					}
					assert.deepEqual(
						run.assertions.map((entry) => entry.actual),
						flawedDuplicate ? [2, 8] : [1, 9],
					);
					assert.deepEqual(
						await read(runId),
						run,
						"refresh reads the same saved result",
					);
					const remaining = await queryPool.query(
						"SELECT count(*)::int AS count FROM inventory WHERE run_id=$1",
						[runId],
					);
					assert.equal(
						remaining.rows[0].count,
						0,
						"results were saved before normal fixture cleanup",
					);
				},
			);
		}
	}

	await t.test(
		"enqueue freezes the full validated scenario and sanitized target",
		async () => {
			const original = await seedDefinition();
			const scenarioId = await save(original);
			const runId = await enqueue(scenarioId);
			const queued = await read(runId);
			assert.equal(queued.status, "queued");
			assert.deepEqual(queued.scenarioSnapshot, {
				...original,
				targetId: "demo-corrected",
			});
			assert.deepEqual(Object.keys(queued.targetSnapshot).sort(), [
				"id",
				"name",
			]);
			const edited = structuredClone(original);
			edited.name = "Edited after enqueue";
			assert.ok(edited.events[0]);
			edited.events[0].payload.data = { orderId: "order_changed", quantity: 2 };
			await appPool.query("UPDATE scenarios SET definition=$2 WHERE id=$1", [
				scenarioId,
				edited,
			]);
			const run = await process(runId);
			assert.deepEqual(run.scenarioSnapshot, queued.scenarioSnapshot);
			assert.equal(run.status, "passed");
			assert.deepEqual(
				run.assertions.map((entry) => entry.actual),
				[1, 9],
			);
		},
	);

	const sqlFailures = [
		["malformed SQL", "SELEC 1 AS value WHERE $1::uuid IS NOT NULL"],
		["no scalar row", "SELECT 1 AS value WHERE $1::uuid IS NULL"],
		[
			"multiple rows",
			"SELECT n AS value FROM generate_series(1,2) AS n WHERE $1::uuid IS NOT NULL",
		],
		[
			"multiple columns",
			"SELECT 1 AS value, 2 AS other WHERE $1::uuid IS NOT NULL",
		],
		["wrong column", "SELECT 1 AS other WHERE $1::uuid IS NOT NULL"],
		[
			"non-scalar JSON",
			"SELECT json_build_object('a',1) AS value WHERE $1::uuid IS NOT NULL",
		],
		[
			"write denied",
			"INSERT INTO inventory(run_id,sku,quantity) VALUES($1,'not_allowed',1) RETURNING quantity AS value",
		],
	] as const;
	for (const [label, query] of sqlFailures) {
		await t.test(`assertion ${label} is a persisted error`, async () => {
			const scenario = await seedDefinition();
			scenario.assertions = [
				{ id: "test_assertion", name: label, query, expected: 1 },
			];
			const runId = await enqueue(await save(scenario));
			const run = await process(runId);
			assert.equal(run.status, "error");
			assert.equal(run.assertions[0]?.status, "error");
			assert.ok(run.assertions[0]?.error);
			assert.equal(run.deliveries[0]?.httpStatus, 200);
		});
	}
	await t.test(
		"scalar equality preserves number-versus-string and null semantics",
		async () => {
			const scenario = await seedDefinition();
			scenario.assertions = [
				{
					id: "number_string",
					name: "Number is not a string",
					query: "SELECT 1 AS value WHERE $1::uuid IS NOT NULL",
					expected: "1",
				},
				{
					id: "null",
					name: "Null scalar",
					query: "SELECT NULL::text AS value WHERE $1::uuid IS NOT NULL",
					expected: null,
				},
			];
			const run = await process(await enqueue(await save(scenario)));
			assert.equal(run.status, "failed");
			assert.equal(run.assertions[0]?.actual, 1);
			assert.equal(run.assertions[0]?.status, "failed");
			assert.equal(run.assertions[1]?.actual, null);
			assert.equal(run.assertions[1]?.status, "passed");
		},
	);
	await t.test(
		"assertion statement timeout is an error, not a false assertion",
		async () => {
			const scenario = await seedDefinition();
			scenario.limits.runTimeoutMs = 6000;
			scenario.assertions = [
				{
					id: "slow_sql",
					name: "Slow query",
					query: "SELECT pg_sleep(3) AS value WHERE $1::uuid IS NOT NULL",
					expected: null,
				},
			];
			const run = await process(await enqueue(await save(scenario)));
			assert.equal(run.status, "error");
			assert.equal(run.assertions[0]?.status, "error");
			assert.match(run.assertions[0]?.error ?? "", /timeout|cancel/i);
		},
	);
	for (const kind of ["request", "overall"] as const) {
		await t.test(`${kind} delivery timeout is a persisted error`, async () => {
			await withHttpServer(
				(_request, response) => {
					const timer = setTimeout(() => response.end("late response"), 2500);
					response.once("close", () => clearTimeout(timer));
				},
				async (endpoint) => {
					const scenario = await seedDefinition();
					scenario.limits.requestTimeoutMs = kind === "request" ? 100 : 3000;
					scenario.limits.runTimeoutMs = kind === "request" ? 5000 : 1000;
					const run = await process(
						await enqueue(await save(scenario)),
						options(alternate(endpoint)),
					);
					assert.equal(run.status, "error");
					assert.match(run.error ?? "", /timeout|timed out/i);
					assert.equal(run.deliveries[0]?.outcome, "error");
					assert.ok(run.deliveries[0]?.completedAt);
				},
			);
		});
	}
	await t.test(
		"overall timeout includes sequential step delay and prevents late dispatch",
		async () => {
			let deliveries = 0;
			await withHttpServer(
				(_request, response) => {
					deliveries++;
					response.end("unexpected");
				},
				async (endpoint) => {
					const scenario = await seedDefinition();
					assert.ok(scenario.steps[0]);
					scenario.steps[0].delayBeforeMs = 1200;
					scenario.limits.runTimeoutMs = 1000;
					const run = await process(
						await enqueue(await save(scenario)),
						options(alternate(endpoint)),
					);
					assert.equal(run.status, "error");
					assert.equal(deliveries, 0);
				},
			);
		},
	);
	await t.test(
		"HTTP non-success is failed and redirect destinations are not followed",
		async () => {
			let redirected = 0;
			await withHttpServer(
				(request, response) => {
					if (request.url === "/destination") {
						redirected++;
						response.end("destination");
					} else {
						response.writeHead(302, { location: "/destination" });
						response.end("redirect");
					}
				},
				async (endpoint) => {
					const run = await process(
						await enqueue("one-payment"),
						options(alternate(endpoint)),
					);
					assert.equal(run.status, "failed");
					assert.equal(run.deliveries[0]?.httpStatus, 302);
					assert.equal(run.deliveries[0]?.outcome, "failed");
					assert.equal(redirected, 0);
				},
			);
		},
	);
	await t.test("response capture is bounded to 16 KiB", async () => {
		await withHttpServer(
			(_request, response) => {
				response.end("x".repeat(64 * 1024));
			},
			async (endpoint) => {
				const scenario = await seedDefinition();
				scenario.assertions = [
					{
						id: "accepted",
						name: "Accepted",
						query: "SELECT true AS value WHERE $1::uuid IS NOT NULL",
						expected: true,
					},
				];
				const run = await process(
					await enqueue(await save(scenario)),
					options(alternate(endpoint)),
				);
				assert.equal(run.status, "passed");
				assert.equal(
					Buffer.byteLength(run.deliveries[0]?.responseExcerpt ?? "", "utf8"),
					16 * 1024,
				);
				assert.equal(run.deliveries[0]?.responseTruncated, true);
			},
		);
	});
	await t.test("transport connection failure is error", async () => {
		await withHttpServer(
			(request) => {
				request.socket.destroy();
			},
			async (endpoint) => {
				const run = await process(
					await enqueue("one-payment"),
					options(alternate(endpoint)),
				);
				assert.equal(run.status, "error");
				assert.equal(run.deliveries[0]?.outcome, "error");
				assert.ok(run.deliveries[0]?.error);
			},
		);
	});
	await t.test(
		"two workers cannot own or dispatch the same queued work",
		async () => {
			const entered = signal();
			const release = signal();
			let dispatched = 0;
			await withHttpServer(
				async (_request, response) => {
					dispatched++;
					entered.resolve();
					await release.promise;
					response.end("ok");
				},
				async (endpoint) => {
					const scenario = await seedDefinition();
					scenario.assertions = [
						{
							id: "accepted",
							name: "Accepted",
							query: "SELECT true AS value WHERE $1::uuid IS NOT NULL",
							expected: true,
						},
					];
					const first = await enqueue(await save(scenario));
					const second = await enqueue(await save(scenario));
					const targets = alternate(endpoint);
					const processing = runWorkerOnce(options(targets, "owner-first"));
					try {
						await Promise.race([
							entered.promise,
							processing.then(() => {
								throw new Error(
									"Worker finished before reaching the HTTP barrier",
								);
							}),
						]);
						assert.equal((await read(first)).status, "running");
						assert.equal(
							await runWorkerOnce(options(targets, "owner-second")),
							"not-owner",
						);
						assert.equal((await read(second)).status, "queued");
						assert.equal(dispatched, 1);
					} finally {
						release.resolve();
					}
					assert.equal(await processing, "processed");
					assert.equal((await read(first)).status, "passed");
					assert.equal(
						await runWorkerOnce(options(targets, "owner-second")),
						"processed",
					);
					assert.equal((await read(second)).status, "passed");
					assert.equal(dispatched, 2);
				},
			);
		},
	);
	await t.test(
		"losing the dedicated ownership session interrupts in-flight work without replay or cleanup",
		async () => {
			const entered = signal();
			const release = signal();
			let dispatched = 0;
			await withHttpServer(
				async (request, response) => {
					const body: Buffer[] = [];
					for await (const chunk of request) body.push(Buffer.from(chunk));
					dispatched++;
					entered.resolve();
					await release.promise;
					const target = await fetch(`${base}/webhooks/corrected`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-webhook-lab-run-id": String(
								request.headers["x-webhook-lab-run-id"],
							),
						},
						body: Buffer.concat(body).toString("utf8"),
					});
					response.writeHead(target.status);
					response.end(await target.text());
				},
				async (endpoint) => {
					const runId = await enqueue("one-payment");
					const processing = runWorkerOnce(
						options(alternate(endpoint), "terminated-owner"),
					);
					try {
						await Promise.race([
							entered.promise,
							processing.then(() => {
								throw new Error(
									"Worker finished before reaching the HTTP barrier",
								);
							}),
						]);
						const killed = await adminPool.query<{ terminated: boolean }>(
							"SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=716053 AND granted",
						);
						assert.equal(killed.rows.length, 1);
						assert.equal(killed.rows[0]?.terminated, true);
					} finally {
						release.resolve();
					}
					assert.equal(await processing, "processed");
					const run = await read(runId);
					assert.equal(run.status, "interrupted");
					assert.ok(run.error);
					const fixture = await queryPool.query(
						"SELECT quantity FROM inventory WHERE run_id=$1",
						[runId],
					);
					assert.equal(
						fixture.rows[0]?.quantity,
						9,
						"an aborted or lost worker does not prove target HTTP work stopped",
					);
					assert.equal(
						await runWorkerOnce(
							options(alternate(endpoint), "replacement-owner"),
						),
						"idle",
					);
					assert.equal(dispatched, 1);
					assert.equal((await read(runId)).status, "interrupted");
				},
			);
		},
	);
	await t.test(
		"fixture rows for another run survive an independent completed run",
		async () => {
			const held = randomUUID();
			runIds.push(held);
			await fixturePool.query(
				"INSERT INTO inventory(run_id,sku,quantity) VALUES($1,'sku_001',7)",
				[held],
			);
			const run = await process(await enqueue("one-payment"));
			assert.equal(run.status, "passed");
			const result = await queryPool.query(
				"SELECT quantity FROM inventory WHERE run_id=$1",
				[held],
			);
			assert.equal(result.rows[0]?.quantity, 7);
		},
	);
	await t.test(
		"step delay follows the previous completed step and request timeout starts at dispatch",
		async () => {
			await withHttpServer(
				(_request, response) => {
					const timer = setTimeout(() => response.end("ok"), 120);
					response.once("close", () => clearTimeout(timer));
				},
				async (endpoint) => {
					const scenario = await seedDefinition();
					assert.ok(scenario.events[0]);
					scenario.steps = [
						{
							id: "first",
							mode: "sequential",
							delayBeforeMs: 70,
							deliveries: [
								{
									deliveryId: "first_delivery",
									eventId: scenario.events[0].id,
								},
							],
						},
						{
							id: "second",
							mode: "sequential",
							delayBeforeMs: 70,
							deliveries: [
								{
									deliveryId: "second_delivery",
									eventId: scenario.events[0].id,
								},
							],
						},
					];
					scenario.limits.requestTimeoutMs = 200;
					scenario.assertions = [
						{
							id: "accepted",
							name: "Accepted",
							query: "SELECT true AS value WHERE $1::uuid IS NOT NULL",
							expected: true,
						},
					];
					const run = await process(
						await enqueue(await save(scenario)),
						options(alternate(endpoint)),
					);
					assert.equal(
						run.status,
						"passed",
						"each dispatch gets its own timeout despite total scheduling time",
					);
					const first = run.deliveries[0];
					const second = run.deliveries[1];
					assert.ok(first?.completedAt && second?.startedAt);
					assert.ok(
						Date.parse(second.startedAt) - Date.parse(first.completedAt) >= 60,
						"delay is measured after the previous step completes",
					);
				},
			);
		},
	);
	await t.test(
		"a new owner interrupts abandoned running jobs without replaying uncertain work",
		async () => {
			let dispatched = 0;
			await withHttpServer(
				(_request, response) => {
					dispatched++;
					response.end("unexpected");
				},
				async (endpoint) => {
					const runId = await enqueue("one-payment");
					await prepareDemoFixtures(fixturePool, runId, [
						{ orderId: "order_001", quantity: 1 },
					]);
					await adminPool.query(
						"UPDATE runs SET status='running',phase='delivery',started_at=now() WHERE id=$1",
						[runId],
					);
					await adminPool.query(
						"UPDATE jobs SET status='running',worker_id='abandoned-owner',started_at=now() WHERE run_id=$1",
						[runId],
					);
					assert.equal(
						await runWorkerOnce(
							options(alternate(endpoint), "replacement-owner"),
						),
						"idle",
					);
					const run = await read(runId);
					assert.equal(run.status, "interrupted");
					assert.ok(run.completedAt && run.error);
					assert.equal(dispatched, 0);
					const fixture = await queryPool.query(
						"SELECT quantity FROM inventory WHERE run_id=$1",
						[runId],
					);
					assert.equal(
						fixture.rows[0]?.quantity,
						10,
						"uncertain target work retains its isolated fixtures",
					);
				},
			);
		},
	);
	await t.test(
		"fixture setup failure is persisted as error before any webhook dispatch",
		async () => {
			let dispatched = 0;
			await withHttpServer(
				(_request, response) => {
					dispatched++;
					response.end("unexpected");
				},
				async (endpoint) => {
					const runId = await enqueue("one-payment");
					const run = await process(runId, {
						...options(alternate(endpoint)),
						fixturePool: targetPool,
					});
					assert.equal(run.status, "error");
					assert.ok(run.error);
					assert.equal(dispatched, 0);
					assert.equal(run.deliveries[0]?.startedAt, null);
				},
			);
		},
	);
	await t.test(
		"worker derives a custom order and quantity from the validated scenario",
		async () => {
			const scenario = await seedDefinition();
			assert.ok(scenario.events[0]);
			scenario.events[0].payload.data = {
				orderId: "order_custom",
				quantity: 2,
			};
			scenario.assertions = [
				{
					id: "one_fulfillment",
					name: "One fulfillment",
					query:
						"SELECT count(*)::int AS value FROM fulfillments WHERE run_id=$1 AND order_id='order_custom'",
					expected: 1,
				},
				{
					id: "stock",
					name: "Stock is eight",
					query:
						"SELECT quantity AS value FROM inventory WHERE run_id=$1 AND sku='sku_001'",
					expected: 8,
				},
			];
			const run = await process(await enqueue(await save(scenario)));
			assert.equal(run.status, "passed");
			assert.deepEqual(
				run.assertions.map((entry) => entry.actual),
				[1, 8],
			);
		},
	);
	await t.test(
		"cleanup failure is error after results are saved and rolls back scoped cleanup",
		async () => {
			const targetAdminUrl = new URL(urls.admin);
			targetAdminUrl.pathname = new URL(urls.targetApp).pathname;
			const targetAdmin = createPool(targetAdminUrl.toString());
			let revoked = false;
			try {
				const privilege = await targetAdmin.query<{ allowed: boolean }>(
					"SELECT has_table_privilege('demo_target_fixture','orders','DELETE') AS allowed",
				);
				assert.equal(privilege.rows[0]?.allowed, true);
				await withHttpServer(
					async (request, response) => {
						const chunks: Buffer[] = [];
						for await (const chunk of request) chunks.push(Buffer.from(chunk));
						const target = await fetch(`${base}/webhooks/corrected`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"x-webhook-lab-run-id": String(
									request.headers["x-webhook-lab-run-id"],
								),
							},
							body: Buffer.concat(chunks).toString("utf8"),
						});
						const body = await target.text();
						assert.equal(target.status, 200);
						await targetAdmin.query(
							"REVOKE DELETE ON orders FROM demo_target_fixture",
						);
						revoked = true;
						response.writeHead(target.status);
						response.end(body);
					},
					async (endpoint) => {
						const runId = await enqueue("one-payment");
						const run = await process(runId, options(alternate(endpoint)));
						assert.equal(run.status, "error");
						assert.match(run.error ?? "", /cleanup|permission/i);
						assert.equal(run.deliveries[0]?.httpStatus, 200);
						assert.deepEqual(
							run.assertions.map((entry) => entry.status),
							["passed", "passed"],
						);
						assert.deepEqual(
							run.assertions.map((entry) => entry.actual),
							[1, 9],
						);
						const effects = await queryPool.query(
							"SELECT (SELECT count(*)::int FROM fulfillments WHERE run_id=$1) AS fulfillments, (SELECT quantity FROM inventory WHERE run_id=$1) AS stock, (SELECT count(*)::int FROM processed_business_events WHERE run_id=$1) AS claims",
							[runId],
						);
						assert.deepEqual(effects.rows[0], {
							fulfillments: 1,
							stock: 9,
							claims: 1,
						});
					},
				);
			} finally {
				try {
					if (revoked)
						await targetAdmin.query(
							"GRANT DELETE ON orders TO demo_target_fixture",
						);
				} finally {
					await targetAdmin.end();
				}
			}
		},
	);
	await t.test(
		"a single-connection application pool owns and processes a complete run",
		async () => {
			const singleConnection = new Pool({
				connectionString: urls.app,
				max: 1,
				connectionTimeoutMillis: 3000,
			});
			try {
				const runId = await enqueue("one-payment");
				const run = await process(runId, {
					...options(),
					appPool: singleConnection,
				});
				assert.equal(run.status, "passed");
				assert.deepEqual(
					run.assertions.map((entry) => entry.actual),
					[1, 9],
				);
			} finally {
				await singleConnection.end();
			}
		},
	);
	await t.test(
		"ownership lost during blocked recovery leaves the queued job unclaimed",
		async () => {
			const runId = await enqueue("one-payment");
			const barrier = await adminPool.connect();
			let processing: ReturnType<typeof runWorkerOnce> | undefined;
			let unlocked = false;
			try {
				await barrier.query("BEGIN");
				await barrier.query("LOCK TABLE runs IN ACCESS EXCLUSIVE MODE");
				processing = runWorkerOnce(options(profiles, "lost-before-claim"));
				const deadline = Date.now() + 10000;
				let waiting = false;
				while (Date.now() < deadline) {
					const blocked = await adminPool.query<{ waiting: boolean }>(
						"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='webhook_tester_app' AND wait_event_type='Lock' AND query LIKE '%runs%') AS waiting",
					);
					if (blocked.rows[0]?.waiting) {
						waiting = true;
						break;
					}
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.equal(
					waiting,
					true,
					"worker recovery is blocked by the controlled table lock",
				);
				const killed = await adminPool.query<{ terminated: boolean }>(
					"SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=716053 AND granted",
				);
				assert.equal(killed.rows.length, 1);
				assert.equal(killed.rows[0]?.terminated, true);
				await barrier.query("COMMIT");
				unlocked = true;
				assert.equal(await processing, "not-owner");
				const run = await read(runId);
				assert.equal(run.status, "queued");
				assert.equal(run.startedAt, null);
				const job = await appPool.query(
					"SELECT status,worker_id FROM jobs WHERE run_id=$1",
					[runId],
				);
				assert.deepEqual(job.rows[0], { status: "queued", worker_id: null });
			} finally {
				try {
					if (!unlocked) await barrier.query("ROLLBACK");
					await processing?.catch(() => {});
				} finally {
					barrier.release();
				}
			}
			assert.equal(
				(await process(runId)).status,
				"passed",
				"a new owner can process the untouched queued job",
			);
		},
	);
	await t.test(
		"NUL bytes in an HTTP response are captured safely in PostgreSQL text",
		async () => {
			await withHttpServer(
				(_request, response) => {
					response.end("before\0after");
				},
				async (endpoint) => {
					const scenario = await seedDefinition();
					scenario.assertions = [
						{
							id: "accepted",
							name: "Accepted",
							query: "SELECT 1 AS value WHERE $1::uuid IS NOT NULL",
							expected: 1,
						},
					];
					const run = await process(
						await enqueue(await save(scenario)),
						options(alternate(endpoint)),
					);
					assert.equal(run.status, "passed");
					assert.equal(run.deliveries[0]?.httpStatus, 200);
					assert.equal(run.deliveries[0]?.outcome, "ok");
					assert.equal(
						run.deliveries[0]?.responseExcerpt,
						"before\\u0000after",
					);
					assert.ok(!run.deliveries[0]?.responseExcerpt?.includes("\0"));
				},
			);
		},
	);
	await t.test(
		"overall deadline bounds blocked application SQL before webhook dispatch",
		async () => {
			let dispatched = 0;
			await withHttpServer(
				(_request, response) => {
					dispatched++;
					response.end("unexpected");
				},
				async (endpoint) => {
					const scenario = await seedDefinition();
					scenario.limits.runTimeoutMs = 1000;
					const runId = await enqueue(await save(scenario));
					const barrier = await adminPool.connect();
					let unlocked = false;
					let releasePromise: Promise<void> | undefined;
					const unlock = () => {
						releasePromise ??= barrier.query("COMMIT").then(() => {
							unlocked = true;
						});
						return releasePromise;
					};
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await barrier.query("BEGIN");
						await barrier.query(
							"LOCK TABLE deliveries IN ACCESS EXCLUSIVE MODE",
						);
						// Release even a broken implementation so this regression cannot strand the suite.
						timer = setTimeout(() => {
							void unlock().catch(() => {});
						}, 1800);
						const result = await runWorkerOnce(options(alternate(endpoint)));
						assert.equal(result, "processed");
						assert.equal(
							unlocked,
							false,
							"execution returns at its deadline while the SQL lock is still held",
						);
						clearTimeout(timer);
						await unlock();
						const run = await read(runId);
						assert.equal(run.status, "error");
						assert.match(run.error ?? "", /timeout|timed out/i);
						assert.equal(dispatched, 0);
						assert.equal(run.deliveries[0]?.startedAt, null);
					} finally {
						if (timer) clearTimeout(timer);
						try {
							await unlock();
						} finally {
							barrier.release();
						}
					}
				},
			);
		},
	);
	await t.test(
		"delivery observations blocked after HTTP completion retain the target fixtures",
		async () => {
			const barrier = await adminPool.connect();
			let transactionStarted = false;
			let unlocked = false;
			let releasePromise: Promise<void> | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const unlock = () => {
				releasePromise ??= (
					transactionStarted ? barrier.query("COMMIT") : Promise.resolve()
				).then(() => {
					unlocked = true;
				});
				return releasePromise;
			};
			try {
				await withHttpServer(
					async (request, response) => {
						const chunks: Buffer[] = [];
						for await (const chunk of request) chunks.push(Buffer.from(chunk));
						const target = await fetch(`${base}/webhooks/corrected`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"x-webhook-lab-run-id": String(
									request.headers["x-webhook-lab-run-id"],
								),
							},
							body: Buffer.concat(chunks).toString("utf8"),
						});
						const body = await target.text();
						assert.equal(target.status, 200);
						await barrier.query("BEGIN");
						transactionStarted = true;
						await barrier.query("LOCK TABLE deliveries IN SHARE MODE");
						timer = setTimeout(() => {
							void unlock().catch(() => {});
						}, 3500);
						response.writeHead(200);
						response.end(body);
					},
					async (endpoint) => {
						const scenario = await seedDefinition();
						scenario.limits.runTimeoutMs = 1000;
						const runId = await enqueue(await save(scenario));
						assert.equal(
							await runWorkerOnce(options(alternate(endpoint))),
							"processed",
						);
						assert.equal(
							unlocked,
							false,
							"the failed observation write returns before the controlled lock release",
						);
						if (timer) clearTimeout(timer);
						await unlock();
						const run = await read(runId);
						assert.equal(run.status, "error");
						assert.match(run.error ?? "", /timeout|persist|observation/i);
						assert.equal(
							run.deliveries[0]?.httpStatus,
							null,
							"the unsuccessful observation write must not pretend HTTP was saved",
						);
						const effects = await queryPool.query(
							"SELECT (SELECT count(*)::int FROM fulfillments WHERE run_id=$1) AS fulfillments, (SELECT quantity FROM inventory WHERE run_id=$1) AS stock, (SELECT count(*)::int FROM processed_business_events WHERE run_id=$1) AS claims, (SELECT paid FROM orders WHERE run_id=$1) AS paid",
							[runId],
						);
						assert.deepEqual(
							effects.rows[0],
							{ fulfillments: 1, stock: 9, claims: 1, paid: true },
							"target effects remain inspectable when their delivery observation was not saved",
						);
					},
				);
			} finally {
				if (timer) clearTimeout(timer);
				try {
					await unlock();
				} finally {
					barrier.release();
				}
			}
		},
	);

	await t.test(
		"interrupted finalization is bounded when its run row is locked",
		async () => {
			const runId = await enqueue(await save(await seedDefinition()));
			const workerId = randomUUID();
			await adminPool.query(
				"UPDATE runs SET status='running',started_at=now() WHERE id=$1",
				[runId],
			);
			await adminPool.query(
				"UPDATE jobs SET status='running',worker_id=$2 WHERE run_id=$1",
				[runId, workerId],
			);
			const barrier = await adminPool.connect();
			let unlocked = false;
			let releasePromise: Promise<void> | undefined;
			const unlock = () => {
				releasePromise ??= barrier.query("COMMIT").then(() => {
					unlocked = true;
				});
				return releasePromise;
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await barrier.query("BEGIN");
				await barrier.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [
					runId,
				]);
				timer = setTimeout(() => {
					void unlock().catch(() => {});
				}, 3500);
				await assert.rejects(
					finishInterrupted(appPool, runId, workerId, "Ownership lost"),
					/timeout|timed out/i,
				);
				assert.equal(
					unlocked,
					false,
					"finalization must return without waiting indefinitely on the row lock",
				);
				clearTimeout(timer);
				await unlock();
				assert.equal(await runWorkerOnce(options()), "idle");
				assert.equal((await read(runId)).status, "interrupted");
			} finally {
				if (timer) clearTimeout(timer);
				try {
					await unlock();
				} finally {
					barrier.release();
				}
			}
		},
	);
	await t.test(
		"an ownership probe timeout retains the returned but unsaved response fixtures",
		async () => {
			const barrier = await adminPool.connect();
			let timer: ReturnType<typeof setTimeout> | undefined;
			let began = false;
			let released: Promise<void> | undefined;
			const unlock = () => {
				released ??= (began ? barrier.query("COMMIT") : Promise.resolve()).then(
					() => {},
				);
				return released;
			};
			try {
				await withHttpServer(
					async (request, response) => {
						const chunks: Buffer[] = [];
						for await (const chunk of request) chunks.push(Buffer.from(chunk));
						const target = await fetch(`${base}/webhooks/corrected`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								"x-webhook-lab-run-id": String(
									request.headers["x-webhook-lab-run-id"],
								),
							},
							body: Buffer.concat(chunks).toString("utf8"),
						});
						const body = await target.text();
						assert.equal(target.status, 200);
						await barrier.query("BEGIN");
						began = true;
						await barrier.query("LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE");
						timer = setTimeout(() => {
							void unlock().catch(() => {});
						}, 3500);
						response.writeHead(200);
						response.end(body);
					},
					async (endpoint) => {
						const runId = await enqueue(await save(await seedDefinition()));
						assert.equal(
							await runWorkerOnce(options(alternate(endpoint))),
							"processed",
						);
						await unlock();
						const run = await read(runId);
						assert.equal(run.status, "error");
						assert.match(run.error ?? "", /ownership probe|timeout/i);
						assert.equal(run.deliveries[0]?.httpStatus, null);
						const effects = await queryPool.query(
							"SELECT (SELECT count(*)::int FROM fulfillments WHERE run_id=$1) AS fulfillments,(SELECT quantity FROM inventory WHERE run_id=$1) AS stock",
							[runId],
						);
						assert.deepEqual(effects.rows[0], { fulfillments: 1, stock: 9 });
					},
				);
			} finally {
				if (timer) clearTimeout(timer);
				try {
					await unlock();
				} finally {
					barrier.release();
				}
			}
		},
	);
	await t.test("idle worker does not create or dispatch a run", async () => {
		assert.equal(await runWorkerOnce(options()), "idle");
	});
});
