import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
	demoOrders,
	type RunResponse,
	type ScenarioV1,
} from "@webhook-tester/contracts";
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
import type { Pool } from "pg";
import {
	runWorkerOnce,
	type WorkerOptions,
	type WorkerTargetProfile,
} from "./index.js";

function signal() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function guarded<T>(
	promise: Promise<T>,
	message: string,
	timeoutMs = 5000,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function withHttpServer<T>(
	handler: (
		request: IncomingMessage,
		response: ServerResponse,
	) => Promise<void>,
	operation: (endpoint: string) => Promise<T>,
): Promise<T> {
	const errors: unknown[] = [];
	const handlers = new Set<Promise<void>>();
	const server = createServer((request, response) => {
		const pending = handler(request, response).catch((error: unknown) => {
			errors.push(error);
			if (!response.headersSent) response.writeHead(500);
			response.end(String(error));
		});
		handlers.add(pending);
		void pending.finally(() => handlers.delete(pending));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		const result = await operation(`http://127.0.0.1:${address.port}`);
		await guarded(
			Promise.all(handlers).then(() => {}),
			"HTTP test handlers did not settle",
		);
		assert.deepEqual(
			errors,
			[],
			"the proxy must not hide target or barrier failures",
		);
		return result;
	} catch (error) {
		if (errors.length)
			throw new AggregateError(
				[error, ...errors],
				errors.map(String).join("; "),
			);
		throw error;
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}
}

async function body(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function waitForDatabase(
	predicate: () => Promise<boolean>,
	message: string,
) {
	const deadline = performance.now() + 5000;
	while (performance.now() < deadline) {
		if (await predicate()) return;
	}
	assert.fail(message);
}

async function forward(
	request: IncomingMessage,
	source: string,
	endpoint: string,
) {
	const target = await fetch(endpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-webhook-lab-run-id": String(request.headers["x-webhook-lab-run-id"]),
			"x-webhook-lab-delivery-id": String(
				request.headers["x-webhook-lab-delivery-id"],
			),
		},
		body: source,
		signal: AbortSignal.timeout(5000),
	});
	return { status: target.status, body: await target.text() };
}

function successfulDeliveries(run: RunResponse, count: number) {
	assert.ok(run.startedAt && run.completedAt);
	assert.equal(run.deliveries.length, count);
	for (const delivery of run.deliveries) {
		assert.equal(delivery.httpStatus, 200);
		assert.equal(delivery.outcome, "ok");
		assert.ok(
			delivery.scheduledAt && delivery.startedAt && delivery.completedAt,
		);
		assert.match(delivery.responseExcerpt ?? "", /received/);
	}
}

test("concurrent and status presets persist real HTTP and PostgreSQL evidence", {
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
	const fixtureIds: string[] = [];
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
	t.after(async () => {
		try {
			await demo.close();
			for (const id of [...runIds, ...fixtureIds])
				await cleanupDemoFixtures(fixturePool, id);
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
	const base = await demo.listen({ host: "127.0.0.1", port: 0 });
	await seedScenarios(appPool);
	const profiles = new Map<string, WorkerTargetProfile>(
		["flawed", "corrected"].map((profile) => [
			`demo-${profile}`,
			{
				id: `demo-${profile}`,
				name:
					profile === "flawed" ? "Without deduplication" : "With deduplication",
				endpoint: `${base}/webhooks/${profile}`,
				completion: { kind: "synchronous" },
			},
		]),
	);
	function options(
		targetId = "demo-corrected",
		endpoint?: string,
		workerId: string = randomUUID(),
	): WorkerOptions {
		const target = profiles.get(targetId);
		assert.ok(target);
		return {
			appPool,
			fixturePool,
			queryPool,
			workerId,
			targetProfiles: endpoint
				? new Map([[targetId, { ...target, endpoint }]])
				: profiles,
		};
	}
	async function definition(id: string): Promise<ScenarioV1> {
		const result = await appPool.query<{ definition: ScenarioV1 }>(
			"SELECT definition FROM scenarios WHERE id=$1",
			[id],
		);
		assert.ok(result.rows[0], `missing seeded scenario ${id}`);
		return structuredClone(result.rows[0].definition);
	}
	async function save(scenario: ScenarioV1) {
		const id = `test-${randomUUID()}`;
		scenarioIds.push(id);
		await appPool.query(
			"INSERT INTO scenarios(id,definition) VALUES($1,$2::jsonb)",
			[id, JSON.stringify(scenario)],
		);
		return id;
	}
	async function enqueue(scenarioId: string, targetId = "demo-corrected") {
		const target = profiles.get(targetId);
		assert.ok(target);
		const id = await enqueueRun(appPool, scenarioId, {
			id: target.id,
			name: target.name,
		});
		runIds.push(id);
		return id;
	}
	async function read(id: string) {
		const run = await getRun(appPool, id);
		assert.ok(run);
		return run;
	}
	async function process(id: string, workerOptions = options()) {
		assert.equal(await runWorkerOnce(workerOptions), "processed");
		return read(id);
	}
	async function effects(id: string) {
		return (
			await queryPool.query(
				"SELECT (SELECT count(*)::int FROM fulfillments WHERE run_id=$1) AS fulfillments, (SELECT quantity FROM inventory WHERE run_id=$1) AS stock, (SELECT count(*)::int FROM processed_business_events WHERE run_id=$1) AS claims, (SELECT paid FROM orders WHERE run_id=$1) AS paid",
				[id],
			)
		).rows[0];
	}

	for (const targetId of ["demo-flawed", "demo-corrected"]) {
		await t.test(
			`concurrent duplicate payment against ${targetId} reaches a two-request rendezvous`,
			async () => {
				const target = profiles.get(targetId);
				assert.ok(target);
				const rendezvous = signal();
				let arrivals = 0;
				let active = 0;
				let peak = 0;
				await withHttpServer(
					async (request, response) => {
						const source = await body(request);
						arrivals++;
						active++;
						peak = Math.max(peak, active);
						try {
							assert.ok(
								arrivals <= 2,
								"there must be exactly two HTTP deliveries",
							);
							if (arrivals === 2) rendezvous.resolve();
							await guarded(
								rendezvous.promise,
								"both duplicate requests must arrive before either is forwarded",
								2000,
							);
							const result = await forward(request, source, target.endpoint);
							response.writeHead(result.status);
							response.end(result.body);
						} finally {
							active--;
						}
					},
					async (endpoint) => {
						const id = await enqueue("concurrent-duplicate-payment", targetId);
						const run = await process(id, options(targetId, endpoint));
						assert.equal(
							run.scenarioSnapshot.name,
							"Concurrent duplicate payment",
						);
						assert.equal(run.scenarioSnapshot.steps[0]?.mode, "concurrent");
						assert.equal(
							run.status,
							targetId === "demo-flawed" ? "failed" : "passed",
						);
						assert.deepEqual(
							run.assertions.map((entry) => entry.actual),
							targetId === "demo-flawed" ? [2, 8] : [1, 9],
						);
						successfulDeliveries(run, 2);
						assert.equal(
							run.deliveries[0]?.scheduledAt,
							run.deliveries[1]?.scheduledAt,
						);
						assert.deepEqual(
							run.deliveries[0]?.requestPayload,
							run.deliveries[1]?.requestPayload,
						);
						assert.deepEqual(
							await read(id),
							run,
							"refresh returns the saved evidence",
						);
						assert.equal(arrivals, 2);
						assert.equal(
							peak,
							2,
							"two HTTP requests were pending together before target forwarding",
						);
					},
				);
			},
		);
	}

	for (const targetId of ["demo-flawed", "demo-corrected"]) {
		await t.test(
			`status version 2 completes before version 1 processing against ${targetId}`,
			async () => {
				const target = profiles.get(targetId);
				assert.ok(target);
				const order: string[] = [];
				await withHttpServer(
					async (request, response) => {
						const source = await body(request);
						const payload = JSON.parse(source) as {
							data: { status: string; version: number };
						};
						if (payload.data.version === 1)
							assert.deepEqual(order, ["v2:shipped:responded"]);
						const result = await forward(request, source, target.endpoint);
						assert.equal(result.status, 200);
						order.push(
							`v${payload.data.version}:${payload.data.status}:responded`,
						);
						response.writeHead(result.status);
						response.end(result.body);
					},
					async (endpoint) => {
						const run = await process(
							await enqueue("status-version-out-of-order", targetId),
							options(targetId, endpoint),
						);
						assert.equal(
							run.scenarioSnapshot.name,
							"Status version 2 before version 1",
						);
						assert.equal(
							run.status,
							targetId === "demo-flawed" ? "failed" : "passed",
						);
						assert.deepEqual(
							run.assertions.map((entry) => entry.actual),
							targetId === "demo-flawed" ? ["processing", 1] : ["shipped", 2],
						);
						assert.match(
							run.assertions[1]?.query ?? "",
							/version\s*::\s*int\s+AS\s+value/i,
						);
						successfulDeliveries(run, 2);
						assert.deepEqual(order, [
							"v2:shipped:responded",
							"v1:processing:responded",
						]);
					},
				);
			},
		);
	}

	await t.test(
		"corrected status ignores equal versions with different logical event IDs and statuses",
		async () => {
			const scenario = await definition("status-version-out-of-order");
			for (const event of scenario.events) {
				const payload = event.payload as {
					id: string;
					type: string;
					data: { orderId: string; status: string; version: number };
				};
				payload.id = `equal_version_${event.id}`;
				payload.data.version = 2;
			}
			assert.equal(
				new Set(scenario.events.map((event) => event.payload.id)).size,
				2,
			);
			assert.equal(
				new Set(
					scenario.events.map(
						(event) => (event.payload.data as { status: string }).status,
					),
				).size,
				2,
			);
			const run = await process(await enqueue(await save(scenario)));
			assert.equal(run.status, "passed");
			successfulDeliveries(run, 2);
			assert.deepEqual(
				run.assertions.map((entry) => entry.actual),
				["shipped", 2],
			);
		},
	);

	await t.test(
		"concurrent setup, target effects and cleanup leave another run's fixtures intact",
		async () => {
			const scenario = await definition("concurrent-duplicate-payment");
			const foreignId = randomUUID();
			fixtureIds.push(foreignId);
			await prepareDemoFixtures(fixturePool, foreignId, demoOrders(scenario));
			const sent = await fetch(`${base}/webhooks/corrected`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-webhook-lab-run-id": foreignId,
				},
				body: JSON.stringify(scenario.events[0]?.payload),
				signal: AbortSignal.timeout(5000),
			});
			assert.equal(sent.status, 200);
			await sent.text();
			const before = await effects(foreignId);
			assert.deepEqual(before, {
				fulfillments: 1,
				stock: 9,
				claims: 1,
				paid: true,
			});
			const id = await enqueue("concurrent-duplicate-payment");
			assert.equal((await process(id)).status, "passed");
			assert.deepEqual(await effects(foreignId), before);
			assert.deepEqual(await effects(id), {
				fulfillments: 0,
				stock: null,
				claims: 0,
				paid: null,
			});
		},
	);

	await t.test(
		"concurrent transport failure drains a live sibling, prevents queued dispatch and retains uncertain fixtures",
		async () => {
			const scenario = await definition("concurrent-duplicate-payment");
			const step = scenario.steps[0];
			assert.ok(step?.deliveries[0]);
			step.deliveries.push({
				deliveryId: "delivery_3",
				eventId: step.deliveries[0].eventId,
			});
			scenario.limits = {
				maxConcurrency: 2,
				requestTimeoutMs: 10000,
				runTimeoutMs: 15000,
			};
			const id = await enqueue(await save(scenario));
			const bothEntered = signal();
			const siblingProcessed = signal();
			const releaseSibling = signal();
			const arrived: string[] = [];
			await withHttpServer(
				async (request, response) => {
					const source = await body(request);
					const deliveryId = String(
						request.headers["x-webhook-lab-delivery-id"],
					);
					arrived.push(deliveryId);
					assert.ok(
						arrived.length <= 2,
						"transport failure must prevent the queued third HTTP request",
					);
					if (arrived.length === 2) bothEntered.resolve();
					await guarded(
						bothEntered.promise,
						"both concurrent requests must start before transport failure",
					);
					if (deliveryId === "delivery_1") {
						request.socket.destroy();
						return;
					}
					assert.equal(deliveryId, "delivery_2");
					const result = await forward(
						request,
						source,
						`${base}/webhooks/corrected`,
					);
					assert.equal(result.status, 200);
					siblingProcessed.resolve();
					await guarded(
						releaseSibling.promise,
						"live sibling response was not released",
					);
					response.writeHead(result.status);
					response.end(result.body);
				},
				async (endpoint) => {
					let settled = false;
					const processing = runWorkerOnce(
						options("demo-corrected", endpoint),
					).then(
						(result) => {
							settled = true;
							return result;
						},
						(error: unknown) => {
							settled = true;
							throw error;
						},
					);
					try {
						await guarded(
							siblingProcessed.promise,
							"successful live sibling did not finish target processing",
						);
						await waitForDatabase(async () => {
							const result = await appPool.query<{ outcome: string }>(
								"SELECT outcome FROM deliveries WHERE run_id=$1 AND delivery_id='delivery_1'",
								[id],
							);
							return result.rows[0]?.outcome === "error";
						}, "the transport failure observation must be persisted while the live sibling is gated");
						const running = await read(id);
						assert.equal(
							settled,
							false,
							"the worker promise must await its already started sibling",
						);
						assert.equal(running.status, "running");
						assert.equal(running.completedAt, null);
						assert.equal(running.deliveries[0]?.outcome, "error");
						assert.ok(running.deliveries[1]?.startedAt);
						assert.equal(running.deliveries[1]?.completedAt, null);
						assert.equal(running.deliveries[2]?.startedAt, null);
						assert.deepEqual(arrived.toSorted(), ["delivery_1", "delivery_2"]);
						assert.deepEqual(
							await effects(id),
							{ fulfillments: 1, stock: 9, claims: 1, paid: true },
							"fixtures remain present while a started response is gated",
						);
					} finally {
						releaseSibling.resolve();
						assert.equal(
							await guarded(
								processing,
								"worker did not drain its released sibling",
								10000,
							),
							"processed",
						);
					}
					const run = await read(id);
					assert.equal(run.status, "error");
					assert.match(run.error ?? "", /transport.*fixtures retained/i);
					assert.deepEqual(
						run.deliveries.map((entry) => entry.outcome),
						["error", "ok", "pending"],
					);
					assert.deepEqual(
						run.deliveries.map((entry) => entry.httpStatus),
						[null, 200, null],
					);
					assert.ok(
						run.deliveries[0]?.completedAt && run.deliveries[1]?.completedAt,
					);
					assert.match(run.deliveries[1]?.responseExcerpt ?? "", /received/);
					assert.equal(run.deliveries[2]?.startedAt, null);
					assert.equal(run.deliveries[2]?.completedAt, null);
					assert.deepEqual(await effects(id), {
						fulfillments: 1,
						stock: 9,
						claims: 1,
						paid: true,
					});
					assert.equal(
						await runWorkerOnce(options("demo-corrected", endpoint)),
						"idle",
						"failed concurrent work is not queued for replay",
					);
					assert.equal(arrived.length, 2);
				},
			);
		},
	);

	await t.test(
		"a failed concurrent observation remains pending after its sibling is saved and retains fixtures",
		async () => {
			const scenario = await definition("concurrent-duplicate-payment");
			scenario.limits = {
				maxConcurrency: 2,
				requestTimeoutMs: 10000,
				runTimeoutMs: 15000,
			};
			const id = await enqueue(await save(scenario));
			const objectId = randomUUID().replaceAll("-", "");
			const marker = `test_observation_marker_${objectId}`;
			const trigger = `test_observation_failure_${objectId}`;
			const bothEntered = signal();
			const bothTargetResponses = signal();
			const releaseSibling = signal();
			let arrivals = 0;
			let targetResponses = 0;
			let processing: ReturnType<typeof runWorkerOnce> | undefined;
			try {
				await adminPool.query(`CREATE SEQUENCE "${marker}"`);
				await adminPool.query(
					`GRANT USAGE ON SEQUENCE "${marker}" TO webhook_tester_app`,
				);
				// Sequence increments survive the raised exception, giving the test a
				// deterministic signal that this particular observation write was tried.
				await adminPool.query(`CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $body$
				BEGIN
					IF NEW.run_id='${id}'::uuid AND NEW.delivery_id='delivery_1'
						AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL THEN
						PERFORM nextval('"${marker}"'::regclass);
						RAISE EXCEPTION 'controlled observation persistence failure';
					END IF;
					RETURN NEW;
				END
			$body$`);
				await adminPool.query(
					`CREATE TRIGGER "${trigger}" BEFORE UPDATE ON deliveries FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`,
				);
				await withHttpServer(
					async (request, response) => {
						const source = await body(request);
						const deliveryId = String(
							request.headers["x-webhook-lab-delivery-id"],
						);
						arrivals++;
						assert.ok(
							arrivals <= 2,
							"observation failure must never resend a delivery",
						);
						if (arrivals === 2) bothEntered.resolve();
						await guarded(
							bothEntered.promise,
							"both observation-test HTTP requests must arrive",
						);
						const result = await forward(
							request,
							source,
							`${base}/webhooks/corrected`,
						);
						assert.equal(result.status, 200);
						targetResponses++;
						if (targetResponses === 2) bothTargetResponses.resolve();
						await guarded(
							bothTargetResponses.promise,
							"both actual target responses must complete before persistence failure",
						);
						if (deliveryId === "delivery_2")
							await guarded(
								releaseSibling.promise,
								"successful sibling observation response was not released",
							);
						else assert.equal(deliveryId, "delivery_1");
						response.writeHead(result.status);
						response.end(result.body);
					},
					async (endpoint) => {
						let settled = false;
						processing = runWorkerOnce(
							options("demo-corrected", endpoint),
						).then(
							(result) => {
								settled = true;
								return result;
							},
							(error: unknown) => {
								settled = true;
								throw error;
							},
						);
						try {
							await guarded(
								bothTargetResponses.promise,
								"two concurrent target responses did not complete",
							);
							await waitForDatabase(async () => {
								const result = await adminPool.query<{ is_called: boolean }>(
									`SELECT is_called FROM "${marker}"`,
								);
								return result.rows[0]?.is_called === true;
							}, "the test trigger must raise on delivery_1 before the sibling response is released");
							const running = await read(id);
							assert.equal(settled, false);
							assert.equal(running.status, "running");
							assert.ok(running.deliveries.every((entry) => entry.startedAt));
							assert.ok(
								running.deliveries.every((entry) => entry.completedAt === null),
							);
							assert.equal(
								targetResponses,
								2,
								"both real target requests returned HTTP 200",
							);
						} finally {
							releaseSibling.resolve();
							assert.equal(
								await guarded(
									processing,
									"worker did not settle after its successful sibling response",
									10000,
								),
								"processed",
							);
						}
						const run = await read(id);
						assert.equal(run.status, "error");
						assert.match(
							run.error ?? "",
							/controlled observation persistence failure.*fixtures retained/i,
						);
						assert.equal(
							run.deliveries[0]?.httpStatus,
							null,
							"failed observation must not invent saved HTTP evidence",
						);
						assert.equal(run.deliveries[0]?.completedAt, null);
						assert.equal(run.deliveries[0]?.outcome, "pending");
						assert.equal(run.deliveries[1]?.httpStatus, 200);
						assert.equal(run.deliveries[1]?.outcome, "ok");
						assert.ok(run.deliveries[1]?.completedAt);
						assert.match(run.deliveries[1]?.responseExcerpt ?? "", /received/);
						assert.deepEqual(
							await effects(id),
							{ fulfillments: 1, stock: 9, claims: 1, paid: true },
							"a later saved sibling must not clear another pending observation",
						);
						assert.equal(
							await runWorkerOnce(options("demo-corrected", endpoint)),
							"idle",
						);
						assert.equal(arrivals, 2);
					},
				);
			} finally {
				releaseSibling.resolve();
				try {
					await processing;
				} finally {
					try {
						await adminPool.query(
							`DROP TRIGGER IF EXISTS "${trigger}" ON deliveries`,
						);
					} finally {
						try {
							await adminPool.query(`DROP FUNCTION IF EXISTS "${trigger}"()`);
						} finally {
							await adminPool.query(`DROP SEQUENCE IF EXISTS "${marker}"`);
						}
					}
				}
			}
		},
	);

	await t.test(
		"global worker ownership fences a second worker during concurrent HTTP dispatch",
		async () => {
			const entered = signal();
			const release = signal();
			let arrivals = 0;
			await withHttpServer(
				async (request, response) => {
					const source = await body(request);
					arrivals++;
					if (arrivals === 2) entered.resolve();
					await guarded(
						release.promise,
						"concurrent ownership gate was not released",
					);
					const result = await forward(
						request,
						source,
						`${base}/webhooks/corrected`,
					);
					response.writeHead(result.status);
					response.end(result.body);
				},
				async (endpoint) => {
					const first = await enqueue("concurrent-duplicate-payment");
					const second = await enqueue("one-payment");
					const processing = runWorkerOnce(
						options("demo-corrected", endpoint, "concurrent-owner-first"),
					);
					try {
						await guarded(
							Promise.race([
								entered.promise,
								processing.then(() => {
									throw new Error(
										"worker finished before both HTTP requests reached the gate",
									);
								}),
							]),
							"concurrent requests did not reach the ownership gate",
						);
						assert.equal((await read(first)).status, "running");
						assert.equal(
							await runWorkerOnce(
								options("demo-corrected", endpoint, "concurrent-owner-second"),
							),
							"not-owner",
						);
						assert.equal((await read(second)).status, "queued");
						assert.equal(arrivals, 2);
					} finally {
						release.resolve();
						await processing;
					}
					assert.equal((await read(first)).status, "passed");
					assert.equal(
						(
							await process(
								second,
								options("demo-corrected", endpoint, "concurrent-owner-second"),
							)
						).status,
						"passed",
					);
					assert.equal(arrivals, 3);
				},
			);
		},
	);

	await t.test(
		"waiting for a concurrency slot and response persistence does not consume the next request timeout",
		async () => {
			const scenario = await definition("concurrent-duplicate-payment");
			scenario.limits.maxConcurrency = 1;
			scenario.limits.requestTimeoutMs = 500;
			scenario.limits.runTimeoutMs = 10000;
			const id = await enqueue(await save(scenario));
			const barrier = await adminPool.connect();
			const firstResponded = signal();
			let began = false;
			let unlocked: Promise<void> | undefined;
			const unlock = () => {
				unlocked ??= (began ? barrier.query("COMMIT") : Promise.resolve()).then(
					() => {},
				);
				return unlocked;
			};
			let firstResponseAt = 0;
			let arrivals = 0;
			let processing: ReturnType<typeof runWorkerOnce> | undefined;
			try {
				await withHttpServer(
					async (request, response) => {
						const source = await body(request);
						arrivals++;
						assert.ok(arrivals <= 2);
						const result = await forward(
							request,
							source,
							`${base}/webhooks/corrected`,
						);
						assert.equal(result.status, 200);
						if (arrivals === 1) {
							await barrier.query("BEGIN");
							began = true;
							await barrier.query("LOCK TABLE deliveries IN SHARE MODE");
							firstResponseAt = performance.now();
						}
						response.writeHead(result.status);
						response.end(result.body);
						if (arrivals === 1) firstResponded.resolve();
					},
					async (endpoint) => {
						processing = runWorkerOnce(options("demo-corrected", endpoint));
						try {
							await guarded(
								firstResponded.promise,
								"first HTTP response did not reach the SQL persistence gate",
							);
							const deadline = performance.now() + 1500;
							let blocked = false;
							while (performance.now() < deadline) {
								const result = await adminPool.query<{ blocked: boolean }>(
									"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename='webhook_tester_app' AND wait_event_type='Lock' AND query LIKE '%UPDATE deliveries SET completed_at%') AS blocked",
								);
								if (result.rows[0]?.blocked) {
									blocked = true;
									break;
								}
								await new Promise((resolve) => setTimeout(resolve, 10));
							}
							assert.equal(
								blocked,
								true,
								"a real delivery observation write must be waiting on the controlled PostgreSQL lock",
							);
							// Deliberately exceed the request budget while the completed first
							// response is blocked in SQL, rather than delaying any HTTP response.
							await new Promise((resolve) =>
								setTimeout(
									resolve,
									Math.max(0, 750 - (performance.now() - firstResponseAt)),
								),
							);
							assert.ok(
								performance.now() - firstResponseAt >
									scenario.limits.requestTimeoutMs,
							);
							assert.equal(
								arrivals,
								1,
								"the second delivery still waits for its occupied slot",
							);
						} finally {
							await unlock();
						}
						assert.equal(await processing, "processed");
						const run = await read(id);
						assert.equal(run.status, "passed");
						successfulDeliveries(run, 2);
						assert.equal(arrivals, 2);
						assert.equal(
							run.deliveries[0]?.scheduledAt,
							run.deliveries[1]?.scheduledAt,
						);
						const second = run.deliveries[1];
						assert.ok(second?.startedAt && second.scheduledAt);
						assert.ok(
							Date.parse(second.startedAt) - Date.parse(second.scheduledAt) >
								scenario.limits.requestTimeoutMs,
						);
						for (const delivery of run.deliveries)
							assert.ok(
								(delivery.durationMs ?? Infinity) <
									scenario.limits.requestTimeoutMs,
							);
						assert.deepEqual(
							run.assertions.map((entry) => entry.actual),
							[1, 9],
						);
					},
				);
			} finally {
				try {
					await unlock();
					await processing;
				} finally {
					barrier.release();
				}
			}
		},
	);
});
