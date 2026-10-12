import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ScenarioV1 } from "@webhook-tester/contracts";
import {
	cleanupDemoFixtures,
	createPool,
	enqueueRun,
	getRun,
	runMigrations,
	seedScenarios,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import type { Pool } from "pg";
import * as repository from "./repository.js";
import { runWorkerOnce, type WorkerOptions } from "./worker.js";

function gate() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function until(predicate: () => Promise<boolean>, message: string) {
	const deadline = performance.now() + 5000;
	while (performance.now() < deadline) {
		if (await predicate()) return;
		await delay(10);
	}
	assert.fail(message);
}

test("worker recovery preserves saved evidence and fences terminal writes", {
	timeout: 60_000,
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
		buildDemoTarget(pool: Pool): {
			listen(options: { host: string; port: number }): Promise<string>;
			close(): Promise<void>;
		};
	};
	const demo = buildDemoTarget(targetPool);
	const base = await demo.listen({ host: "127.0.0.1", port: 0 });
	t.after(async () => {
		await demo.close();
		try {
			for (const id of runIds) await cleanupDemoFixtures(fixturePool, id);
			if (runIds.length)
				await adminPool.query("DELETE FROM runs WHERE id=ANY($1::uuid[])", [
					runIds,
				]);
			if (scenarioIds.length)
				await adminPool.query(
					"DELETE FROM scenarios WHERE id=ANY($1::text[])",
					[scenarioIds],
				);
		} finally {
			await Promise.all(
				[appPool, fixturePool, queryPool, targetPool, adminPool].map((pool) =>
					pool.end(),
				),
			);
		}
	});
	await seedScenarios(appPool);
	const target = { id: "demo-corrected", name: "With deduplication" };
	function options(endpoint = `${base}/webhooks/corrected`): WorkerOptions {
		return {
			appPool,
			fixturePool,
			queryPool,
			workerId: randomUUID(),
			targetProfiles: new Map([
				[
					target.id,
					{ ...target, endpoint, completion: { kind: "synchronous" } },
				],
			]),
		};
	}
	async function enqueue(scenarioId = "one-payment") {
		const id = await enqueueRun(appPool, scenarioId, target);
		runIds.push(id);
		return id;
	}
	async function read(id: string) {
		const run = await getRun(appPool, id);
		assert.ok(run);
		return run;
	}
	async function save(scenario: ScenarioV1) {
		const id = `recovery-${randomUUID()}`;
		scenarioIds.push(id);
		await appPool.query("INSERT INTO scenarios(id,definition) VALUES($1,$2)", [
			id,
			scenario,
		]);
		return id;
	}

	await t.test(
		"late phase, delivery and assertion writes cannot mutate an interrupted run",
		async () => {
			const id = await enqueue();
			const workerId = randomUUID();
			const owner = await appPool.connect();
			try {
				assert.equal((await repository.claimNext(owner, workerId))?.id, id);
				const deliveryId = (await read(id)).deliveries[0]?.deliveryId;
				assert.ok(deliveryId);
				await repository.schedule(owner, id, deliveryId, new Date());
				await repository.startDelivery(owner, id, deliveryId);
				await repository.finishInterrupted(
					appPool,
					id,
					workerId,
					"Ownership lost",
				);
				const before = await read(id);
				const jobBefore = (
					await appPool.query(
						"SELECT status,worker_id,started_at,completed_at FROM jobs WHERE run_id=$1",
						[id],
					)
				).rows;
				await repository.phase(owner, id, "cleanup");
				await repository.schedule(owner, id, deliveryId, new Date(0));
				await repository.startDelivery(owner, id, deliveryId);
				await repository.completeDelivery(owner, id, deliveryId, {
					httpStatus: 200,
					durationMs: 1,
					responseExcerpt: "late",
					responseTruncated: false,
					outcome: "ok",
					error: null,
					uncertain: false,
				});
				await repository.completeAssertion(
					owner,
					id,
					before.assertions[0]?.id ?? "missing",
					{ actual: 42, status: "passed", error: null },
				);
				await repository.finishOwned(owner, id, workerId, "passed", null);
				assert.deepEqual(
					await read(id),
					before,
					"all evidence and terminal event identity must be immutable",
				);
				assert.deepEqual(
					(
						await appPool.query(
							"SELECT status,worker_id,started_at,completed_at FROM jobs WHERE run_id=$1",
							[id],
						)
					).rows,
					jobBefore,
				);
			} finally {
				owner.release();
			}
		},
	);

	await t.test(
		"state changes roll back when their saved event cannot be inserted",
		async () => {
			await adminPool.query(`CREATE FUNCTION worker_recovery_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.run_id::text = TG_ARGV[0] AND NEW.type = TG_ARGV[1] THEN
		RAISE EXCEPTION 'Controlled saved event failure'; END IF; RETURN NEW; END $$`);
			try {
				for (const type of [
					"run.started",
					"run.phase",
					"delivery.scheduled",
					"delivery.started",
					"delivery.completed",
					"assertion.completed",
					"run.completed",
					"delivery.interrupted",
				]) {
					const id = await enqueue();
					const workerId = randomUUID();
					const client = await appPool.connect();
					try {
						if (type !== "run.started")
							await repository.claimNext(client, workerId);
						const queued = await read(id);
						const deliveryId = queued.deliveries[0]?.deliveryId;
						assert.ok(deliveryId);
						if (["delivery.completed", "delivery.interrupted"].includes(type))
							await repository.startDelivery(client, id, deliveryId);
						const before = await read(id);
						const jobBefore = (
							await appPool.query(
								"SELECT status,worker_id,started_at,completed_at FROM jobs WHERE run_id=$1",
								[id],
							)
						).rows;
						await adminPool.query(
							`CREATE TRIGGER worker_recovery_event_guard BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION worker_recovery_reject_event('${id}', '${type}')`,
						);
						const operation = () => {
							switch (type) {
								case "run.started":
									return repository.claimNext(client, workerId);
								case "run.phase":
									return repository.phase(client, id, "assertions");
								case "delivery.scheduled":
									return repository.schedule(
										client,
										id,
										deliveryId,
										new Date(),
									);
								case "delivery.started":
									return repository.startDelivery(client, id, deliveryId);
								case "delivery.completed":
									return repository.completeDelivery(client, id, deliveryId, {
										httpStatus: 200,
										durationMs: 1,
										responseExcerpt: "private-response",
										responseTruncated: false,
										outcome: "ok",
										error: null,
										uncertain: false,
									});
								case "assertion.completed":
									return repository.completeAssertion(
										client,
										id,
										"fulfillment_once",
										{ actual: 1, status: "passed", error: null },
									);
								case "run.completed":
									return repository.finishOwned(
										client,
										id,
										workerId,
										"passed",
										null,
									);
								default:
									return repository.interruptAbandoned(client);
							}
						};
						await assert.rejects(
							operation,
							/Controlled saved event failure/,
							type,
						);
						assert.deepEqual(
							await read(id),
							before,
							`${type} must be atomic with state and child writes`,
						);
						assert.deepEqual(
							(
								await appPool.query(
									"SELECT status,worker_id,started_at,completed_at FROM jobs WHERE run_id=$1",
									[id],
								)
							).rows,
							jobBefore,
							`${type} must roll back job state too`,
						);
					} finally {
						await adminPool.query(
							"DROP TRIGGER IF EXISTS worker_recovery_event_guard ON run_events",
						);
						client.release();
						await adminPool.query(
							"UPDATE jobs SET status='interrupted' WHERE run_id=$1",
							[id],
						);
						await adminPool.query(
							"UPDATE runs SET status='interrupted' WHERE id=$1",
							[id],
						);
					}
				}
			} finally {
				await adminPool.query("DROP FUNCTION worker_recovery_reject_event()");
			}
		},
	);

	await t.test(
		"a completed run saves ordered safe phase, delivery, assertion and terminal events",
		async () => {
			const id = await enqueue();
			assert.equal(await runWorkerOnce(options()), "processed");
			const run = await read(id);
			assert.equal(run.status, "passed");
			assert.deepEqual(
				run.events.map((event) => event.type),
				[
					"run.queued",
					"run.started",
					"run.phase",
					"delivery.scheduled",
					"delivery.started",
					"delivery.completed",
					"run.phase",
					"assertion.completed",
					"assertion.completed",
					"run.phase",
					"run.completed",
				],
			);
			assert.deepEqual(
				run.events
					.filter((event) => event.type === "run.phase")
					.map((event) => event.payload.phase),
				["delivery", "assertions", "cleanup"],
			);
			assert.deepEqual(
				run.events
					.filter((event) => event.type === "assertion.completed")
					.map((event) => event.payload.actual),
				[1, 9],
			);
			assert.deepEqual(run.events.at(-1)?.payload, {
				status: "passed",
				phase: "completed",
			});
			assert.equal(run.eventCursor, run.events.at(-1)?.cursor);
			for (let index = 1; index < run.events.length; index++)
				assert.ok(
					BigInt(run.events[index]?.cursor ?? "0") >
						BigInt(run.events[index - 1]?.cursor ?? "0"),
				);
			const allowed = new Set([
				"status",
				"phase",
				"deliveryId",
				"outcome",
				"httpStatus",
				"assertionId",
				"assertionName",
				"expected",
				"actual",
				"assertionStatus",
			]);
			for (const event of run.events)
				for (const key of Object.keys(event.payload))
					assert.ok(allowed.has(key), `private event field ${key}`);
		},
	);

	await t.test(
		"successor interrupts uncertain HTTP once, keeps fixtures, and processes a new queued run",
		async () => {
			const entered = gate();
			const release = gate();
			const handled = gate();
			const requests: string[] = [];
			const handlerErrors: unknown[] = [];
			let processing: Promise<unknown> | undefined;
			const server = createServer((request, response) => {
				void (async () => {
					const chunks: Buffer[] = [];
					for await (const chunk of request) chunks.push(Buffer.from(chunk));
					const id = String(request.headers["x-webhook-lab-run-id"]);
					requests.push(id);
					entered.resolve();
					await release.promise;
					const targetResponse = await fetch(`${base}/webhooks/corrected`, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-webhook-lab-run-id": id,
						},
						body: Buffer.concat(chunks),
						signal: AbortSignal.timeout(5000),
					});
					assert.equal(targetResponse.status, 200);
					response.writeHead(targetResponse.status);
					response.end(await targetResponse.text());
				})()
					.catch((error: unknown) => {
						handlerErrors.push(error);
						response.destroy();
					})
					.finally(handled.resolve);
			});
			await new Promise<void>((resolve) =>
				server.listen(0, "127.0.0.1", resolve),
			);
			const address = server.address();
			assert.ok(address && typeof address !== "string");
			try {
				const scenario = (
					await appPool.query<{ definition: ScenarioV1 }>(
						"SELECT definition FROM scenarios WHERE id='sequential-duplicate-payment'",
					)
				).rows[0]?.definition;
				assert.ok(scenario);
				scenario.limits.requestTimeoutMs = 5000;
				scenario.limits.runTimeoutMs = 10_000;
				const id = await enqueue(await save(scenario));
				processing = runWorkerOnce(options(`http://127.0.0.1:${address.port}`));
				await Promise.race([
					entered.promise,
					processing.then(() => {
						throw new Error("owner ended before HTTP gate");
					}),
				]);
				const killed = await adminPool.query<{ terminated: boolean }>(
					"SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=716053 AND granted",
				);
				assert.deepEqual(killed.rows, [{ terminated: true }]);
				await until(
					async () =>
						(
							await adminPool.query(
								"SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=716053 AND granted",
							)
						).rowCount === 0,
					"owner lock did not release",
				);
				const freshId = await enqueue();
				assert.equal(await runWorkerOnce(options()), "processed");
				assert.equal((await read(freshId)).status, "passed");
				const interrupted = await read(id);
				assert.equal(interrupted.status, "interrupted");
				assert.equal(interrupted.deliveries[0]?.outcome, "interrupted");
				assert.ok(interrupted.deliveries[0]?.startedAt);
				assert.equal(interrupted.deliveries[0]?.httpStatus, null);
				assert.equal(
					interrupted.deliveries[0]?.completedAt,
					null,
					"unknown HTTP completion retains its incomplete evidence",
				);
				assert.equal(interrupted.deliveries[1]?.startedAt, null);
				assert.equal(
					interrupted.events.filter(
						(event) => event.type === "delivery.interrupted",
					).length,
					2,
				);
				assert.equal(
					interrupted.events.filter((event) => event.type === "run.completed")
						.length,
					1,
				);
				release.resolve();
				assert.equal(await processing, "processed");
				await handled.promise;
				assert.deepEqual(handlerErrors, []);
				assert.deepEqual(
					await read(id),
					interrupted,
					"late target response must not overwrite successor evidence",
				);
				assert.deepEqual(
					requests,
					[id],
					"old run must never be replayed or continue dispatching",
				);
				const fixtures = await queryPool.query(
					"SELECT quantity FROM inventory WHERE run_id=$1",
					[id],
				);
				assert.equal(
					fixtures.rows[0]?.quantity,
					9,
					"target continues after session loss and retained fixtures show its effect",
				);
				assert.equal(await runWorkerOnce(options()), "idle");
				assert.deepEqual(await read(id), interrupted);
			} finally {
				release.resolve();
				await processing?.catch(() => {});
				server.closeAllConnections();
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);

	await t.test(
		"ownership loss during a step delay stops scheduling before any HTTP starts",
		async () => {
			const scenario = (
				await appPool.query<{ definition: ScenarioV1 }>(
					"SELECT definition FROM scenarios WHERE id='one-payment'",
				)
			).rows[0]?.definition;
			assert.ok(scenario?.steps[0]);
			scenario.steps[0].delayBeforeMs = 1500;
			const id = await enqueue(await save(scenario));
			const processing = runWorkerOnce(options());
			await until(
				async () => (await read(id)).phase === "delivery",
				"worker did not reach delivery phase",
			);
			const killed = await adminPool.query<{ terminated: boolean }>(
				"SELECT pg_terminate_backend(pid) AS terminated FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=716053 AND granted",
			);
			assert.deepEqual(killed.rows, [{ terminated: true }]);
			const stoppedAt = performance.now();
			assert.equal(await processing, "processed");
			assert.ok(
				performance.now() - stoppedAt < 750,
				"session error must abort the remaining step delay immediately",
			);
			const run = await read(id);
			assert.equal(run.status, "interrupted");
			assert.equal(run.deliveries[0]?.scheduledAt, null);
			assert.equal(run.deliveries[0]?.startedAt, null);
		},
	);

	await t.test(
		"scheduling verifies the owning session lock even when its connection and job remain healthy",
		async () => {
			const id = await enqueue();
			await adminPool.query(`CREATE FUNCTION worker_recovery_drop_lock() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_advisory_unlock(716053); RETURN NEW; END $$`);
			try {
				// This runs inside the worker's real PostgreSQL backend, without an error event.
				await adminPool.query(`CREATE TRIGGER worker_recovery_lock_guard AFTER UPDATE ON runs FOR EACH ROW
			WHEN (NEW.id='${id}'::uuid AND NEW.phase='delivery' AND OLD.phase IS DISTINCT FROM NEW.phase)
			EXECUTE FUNCTION worker_recovery_drop_lock()`);
				assert.equal(await runWorkerOnce(options()), "processed");
				const run = await read(id);
				assert.equal(run.status, "interrupted");
				assert.equal(
					run.deliveries[0]?.scheduledAt,
					null,
					"a healthy connection and assigned job do not prove advisory ownership",
				);
				assert.equal(run.deliveries[0]?.startedAt, null);
				assert.equal(
					run.events.some((event) => event.type === "delivery.scheduled"),
					false,
				);
			} finally {
				await adminPool.query(
					"DROP TRIGGER IF EXISTS worker_recovery_lock_guard ON runs",
				);
				await adminPool.query("DROP FUNCTION worker_recovery_drop_lock()");
			}
		},
	);

	await t.test(
		"ownership loss after saving cleanup phase retains the completed target fixtures",
		async () => {
			const id = await enqueue();
			await adminPool.query(`CREATE FUNCTION worker_recovery_cleanup_lock() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN PERFORM pg_advisory_unlock(716053); RETURN NEW; END $$`);
			try {
				await adminPool.query(`CREATE TRIGGER worker_recovery_cleanup_guard AFTER UPDATE ON runs FOR EACH ROW
			WHEN (NEW.id='${id}'::uuid AND NEW.phase='cleanup' AND OLD.phase IS DISTINCT FROM NEW.phase)
			EXECUTE FUNCTION worker_recovery_cleanup_lock()`);
				assert.equal(await runWorkerOnce(options()), "processed");
				const run = await read(id);
				assert.equal(run.status, "interrupted");
				assert.equal(
					run.deliveries[0]?.outcome,
					"ok",
					"already saved HTTP evidence remains intact",
				);
				assert.equal(
					(
						await queryPool.query(
							"SELECT quantity FROM inventory WHERE run_id=$1",
							[id],
						)
					).rows[0]?.quantity,
					9,
					"fixture cleanup must check ownership after the saved phase boundary",
				);
			} finally {
				await adminPool.query(
					"DROP TRIGGER IF EXISTS worker_recovery_cleanup_guard ON runs",
				);
				await adminPool.query("DROP FUNCTION worker_recovery_cleanup_lock()");
			}
		},
	);
});
