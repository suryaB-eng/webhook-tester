import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { DemoPayment } from "@webhook-tester/contracts";
import {
	cleanupDemoFixtures,
	createPool,
	prepareDemoFixtures,
	runMigrations,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { buildDemoTarget } from "./app.js";

test("payment profiles preserve their run-scoped transactional behavior", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const application = createPool(urls.targetApp);
	const fixture = createPool(urls.targetFixture);
	const query = createPool(urls.targetQuery);
	const app = buildDemoTarget(application);
	const runIds: string[] = [];
	t.after(async () => {
		try {
			await app.close();
		} finally {
			try {
				for (const runId of runIds) await cleanupDemoFixtures(fixture, runId);
			} finally {
				await Promise.all([application.end(), fixture.end(), query.end()]);
			}
		}
	});

	const base = await app.listen({ host: "127.0.0.1", port: 0 });

	function payment(
		orderId = "order_001",
		quantity = 1,
		id = "payment_001",
	): DemoPayment {
		return { id, type: "payment.succeeded", data: { orderId, quantity } };
	}
	async function prepare(orderId = "order_001", quantity = 1) {
		const runId = randomUUID();
		runIds.push(runId);
		await prepareDemoFixtures(fixture, runId, [{ orderId, quantity }]);
		return runId;
	}
	async function send(
		profile: "flawed" | "corrected",
		runId: string | undefined,
		event: unknown,
		deliveryId = "delivery_001",
	) {
		return fetch(`${base}/webhooks/${profile}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-webhook-lab-delivery-id": deliveryId,
				...(runId === undefined ? {} : { "x-webhook-lab-run-id": runId }),
			},
			body: JSON.stringify(event),
		});
	}
	async function state(runId: string) {
		const result = await query.query<{
			fulfillments: number;
			stock: number;
			claims: number;
			paid: boolean;
		}>(
			`SELECT
        (SELECT count(*)::int FROM fulfillments WHERE run_id = $1) AS fulfillments,
        (SELECT quantity FROM inventory WHERE run_id = $1 AND sku = 'sku_001') AS stock,
        (SELECT count(*)::int FROM processed_business_events WHERE run_id = $1) AS claims,
        (SELECT bool_and(paid) FROM orders WHERE run_id = $1) AS paid`,
			[runId],
		);
		return result.rows[0];
	}

	for (const profile of ["flawed", "corrected"] as const) {
		await t.test(
			`${profile}: one payment fulfills once and consumes one stock unit`,
			async () => {
				const runId = await prepare();
				assert.equal((await send(profile, runId, payment())).status, 200);
				assert.deepEqual(await state(runId), {
					fulfillments: 1,
					stock: 9,
					claims: profile === "corrected" ? 1 : 0,
					paid: true,
				});
			},
		);
		await t.test(
			`${profile}: sequential duplicate demonstrates the profile's idempotency`,
			async () => {
				const runId = await prepare();
				assert.equal((await send(profile, runId, payment())).status, 200);
				assert.equal((await send(profile, runId, payment())).status, 200);
				assert.deepEqual(
					await state(runId),
					profile === "flawed"
						? { fulfillments: 2, stock: 8, claims: 0, paid: true }
						: { fulfillments: 1, stock: 9, claims: 1, paid: true },
				);
			},
		);
		await t.test(
			`${profile}: custom order quantity two consumes two stock units`,
			async () => {
				const runId = await prepare("order_custom", 2);
				assert.equal(
					(await send(profile, runId, payment("order_custom", 2))).status,
					200,
				);
				assert.deepEqual(await state(runId), {
					fulfillments: 1,
					stock: 8,
					claims: profile === "corrected" ? 1 : 0,
					paid: true,
				});
			},
		);
	}
	await t.test(
		"corrected deduplicates by logical event even when the transport ID changes",
		async () => {
			const runId = await prepare();
			assert.equal(
				(await send("corrected", runId, payment(), "transport_a")).status,
				200,
			);
			assert.equal(
				(await send("corrected", runId, payment(), "transport_b")).status,
				200,
			);
			assert.deepEqual(await state(runId), {
				fulfillments: 1,
				stock: 9,
				claims: 1,
				paid: true,
			});
		},
	);
	await t.test(
		"a second logical payment for an already paid order cannot repeat fulfillment",
		async () => {
			const runId = await prepare();
			assert.equal((await send("corrected", runId, payment())).status, 200);
			assert.equal(
				(await send("corrected", runId, payment("order_001", 1, "payment_002")))
					.status,
				200,
			);
			assert.deepEqual(await state(runId), {
				fulfillments: 1,
				stock: 9,
				claims: 2,
				paid: true,
			});
		},
	);
	await t.test(
		"insufficient stock rolls back the claim, paid transition, and all effects",
		async () => {
			const runId = await prepare();
			await fixture.query("DELETE FROM inventory WHERE run_id = $1", [runId]);
			await fixture.query(
				"INSERT INTO inventory (run_id, sku, quantity) VALUES ($1, 'sku_001', 0)",
				[runId],
			);
			const failure = await send("corrected", runId, payment());
			assert.equal(failure.status, 409);
			assert.match(
				(await failure.json()).error,
				/inventory.*missing|insufficient/i,
			);
			assert.deepEqual(await state(runId), {
				fulfillments: 0,
				stock: 0,
				claims: 0,
				paid: false,
			});
			await fixture.query("DELETE FROM inventory WHERE run_id = $1", [runId]);
			await fixture.query(
				"INSERT INTO inventory (run_id, sku, quantity) VALUES ($1, 'sku_001', 10)",
				[runId],
			);
			assert.equal((await send("corrected", runId, payment())).status, 200);
			assert.deepEqual(await state(runId), {
				fulfillments: 1,
				stock: 9,
				claims: 1,
				paid: true,
			});
		},
	);
	await t.test(
		"conflicting logical event payloads fail without modifying the other order",
		async () => {
			const runId = randomUUID();
			runIds.push(runId);
			await prepareDemoFixtures(fixture, runId, [
				{ orderId: "order_a", quantity: 1 },
				{ orderId: "order_b", quantity: 2 },
			]);
			assert.equal(
				(await send("corrected", runId, payment("order_a", 1))).status,
				200,
			);
			assert.equal(
				(await send("corrected", runId, payment("order_b", 2))).status,
				409,
			);
			const result = await query.query(
				"SELECT paid FROM orders WHERE run_id = $1 AND order_id = 'order_b'",
				[runId],
			);
			assert.equal(result.rows[0].paid, false);
			assert.equal((await state(runId))?.fulfillments, 1);
			assert.equal((await state(runId))?.stock, 9);
		},
	);
	await t.test(
		"invalid requests and missing or mismatched fixtures fail clearly",
		async () => {
			for (const profile of ["flawed", "corrected"] as const) {
				assert.equal((await send(profile, undefined, payment())).status, 400);
				assert.equal((await send(profile, "not-a-run", payment())).status, 400);
				assert.equal(
					(await send(profile, randomUUID(), payment())).status,
					409,
				);
				const runId = await prepare();
				const mismatch = await send(profile, runId, payment("order_001", 2));
				assert.equal(mismatch.status, 409);
				assert.match((await mismatch.json()).error, /quantity/i);
				assert.equal(
					(
						await send(profile, runId, {
							...payment(),
							type: "order.status_changed",
						})
					).status,
					400,
				);
				assert.equal(
					(await send(profile, runId, payment("order_001", 11))).status,
					400,
				);
				assert.deepEqual(await state(runId), {
					fulfillments: 0,
					stock: 10,
					claims: 0,
					paid: false,
				});
				await fixture.query("DELETE FROM inventory WHERE run_id = $1", [runId]);
				const missing = await send(profile, runId, payment());
				assert.equal(missing.status, 409);
				assert.match((await missing.json()).error, /inventory/i);
			}
		},
	);
	await t.test("oversized webhook bodies retain a 413 response", async () => {
		const runId = await prepare();
		const response = await send("corrected", runId, {
			extra: "x".repeat(1024 * 1024),
		});
		assert.equal(response.status, 413);
	});
	await t.test(
		"fixture cleanup leaves another run's payment effects intact",
		async () => {
			const first = await prepare();
			const second = await prepare();
			assert.equal((await send("corrected", first, payment())).status, 200);
			assert.equal((await send("corrected", second, payment())).status, 200);
			await cleanupDemoFixtures(fixture, first);
			assert.deepEqual(await state(second), {
				fulfillments: 1,
				stock: 9,
				claims: 1,
				paid: true,
			});
			const result = await query.query(
				"SELECT count(*)::int AS remaining FROM orders WHERE run_id = $1",
				[first],
			);
			assert.equal(result.rows[0].remaining, 0);
		},
	);
});

test("status profiles apply run-scoped arrival and version behavior", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const application = createPool(urls.targetApp);
	const fixture = createPool(urls.targetFixture);
	const query = createPool(urls.targetQuery);
	const app = buildDemoTarget(application);
	const runIds: string[] = [];
	t.after(async () => {
		try {
			await app.close();
			for (const runId of runIds) await cleanupDemoFixtures(fixture, runId);
		} finally {
			await Promise.all([application.end(), fixture.end(), query.end()]);
		}
	});
	const base = await app.listen({ host: "127.0.0.1", port: 0 });
	async function prepare() {
		const runId = randomUUID();
		runIds.push(runId);
		await prepareDemoFixtures(fixture, runId, [
			{ orderId: "order_001", quantity: 2 },
			{ orderId: "other_order", quantity: 1 },
		]);
		return runId;
	}
	function event(status = "processing", version = 1, orderId = "order_001") {
		return {
			id: `status_${version}`,
			type: "order.status_changed",
			data: { orderId, status, version },
		};
	}
	async function send(
		profile: "flawed" | "corrected",
		runId: string | undefined,
		payload: unknown,
	) {
		return fetch(`${base}/webhooks/${profile}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(runId === undefined ? {} : { "x-webhook-lab-run-id": runId }),
			},
			body: JSON.stringify(payload),
		});
	}
	async function state(runId: string, orderId = "order_001") {
		const result = await query.query(
			`SELECT status, version::text AS version, paid, quantity,
        (SELECT quantity FROM inventory WHERE run_id = $1 AND sku = 'sku_001') AS stock,
        (SELECT count(*)::int FROM fulfillments WHERE run_id = $1) AS fulfillments,
        (SELECT count(*)::int FROM processed_business_events WHERE run_id = $1) AS claims
        FROM orders WHERE run_id = $1 AND order_id = $2`,
			[runId, orderId],
		);
		return result.rows[0];
	}
	for (const profile of ["flawed", "corrected"] as const) {
		await t.test(`${profile}: status delivery is acknowledged`, async () => {
			const runId = await prepare();
			const response = await send(profile, runId, event());
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), {
				received: true,
				businessEventId: "status_1",
			});
		});
		await t.test(
			`${profile}: arbitrary one-character statuses remain valid`,
			async () => {
				const runId = await prepare();
				assert.equal((await send(profile, runId, event("v", 1))).status, 200);
				assert.equal((await state(runId)).status, "v");
			},
		);
		await t.test(
			`${profile}: fixtures begin at created version zero and status does not cause payment effects`,
			async () => {
				const runId = await prepare();
				assert.deepEqual(await state(runId), {
					status: "created",
					version: "0",
					paid: false,
					quantity: 2,
					stock: 10,
					fulfillments: 0,
					claims: 0,
				});
				assert.equal(
					(await send(profile, runId, event("packed", 3))).status,
					200,
				);
				assert.deepEqual(await state(runId), {
					status: "packed",
					version: "3",
					paid: false,
					quantity: 2,
					stock: 10,
					fulfillments: 0,
					claims: 0,
				});
				assert.deepEqual(await state(runId, "other_order"), {
					status: "created",
					version: "0",
					paid: false,
					quantity: 1,
					stock: 10,
					fulfillments: 0,
					claims: 0,
				});
			},
		);
		await t.test(
			`${profile}: stale and equal versions are accepted with the profile's mutation behavior`,
			async () => {
				const runId = await prepare();
				assert.equal(
					(await send(profile, runId, event("shipped", 3))).status,
					200,
				);
				assert.equal(
					(await send(profile, runId, event("processing", 1))).status,
					200,
				);
				assert.equal(
					(await state(runId)).status,
					profile === "flawed" ? "processing" : "shipped",
				);
				assert.equal(
					(await state(runId)).version,
					profile === "flawed" ? "1" : "3",
				);
				assert.equal(
					(
						await send(
							profile,
							runId,
							event("equal-version", profile === "flawed" ? 1 : 3),
						)
					).status,
					200,
				);
				assert.equal(
					(await state(runId)).status,
					profile === "flawed" ? "equal-version" : "shipped",
				);
			},
		);
		await t.test(
			`${profile}: updates and cleanup remain isolated between runs`,
			async () => {
				const first = await prepare();
				const second = await prepare();
				assert.equal(
					(await send(profile, first, event("shipped", 3))).status,
					200,
				);
				assert.deepEqual(await state(second), {
					status: "created",
					version: "0",
					paid: false,
					quantity: 2,
					stock: 10,
					fulfillments: 0,
					claims: 0,
				});
				assert.equal(
					(await send(profile, second, event("processing", 1))).status,
					200,
				);
				await cleanupDemoFixtures(fixture, first);
				assert.equal(await state(first), undefined);
				assert.equal((await state(second)).status, "processing");
				assert.equal((await state(second)).version, "1");
			},
		);
		await t.test(
			`${profile}: absent orders fail and malformed status inputs cannot mutate fixtures`,
			async () => {
				const runId = await prepare();
				for (const payload of [
					event("", 1),
					event(" \t", 1),
					event("x".repeat(101), 1),
					event("processing", 0),
					event("processing", 1.5),
					event("processing", Number.MAX_SAFE_INTEGER + 1),
					{ ...event(), extra: true },
					{ ...event(), data: { ...event().data, quantity: 2 } },
				]) {
					assert.equal((await send(profile, runId, payload)).status, 400);
				}
				for (const invalidRunId of [undefined, "invalid"])
					assert.equal(
						(await send(profile, invalidRunId, event())).status,
						400,
					);
				for (const [missingRun, orderId] of [
					[randomUUID(), "order_001"],
					[runId, "missing-order"],
				]) {
					assert.ok(missingRun && orderId);
					const response = await send(
						profile,
						missingRun,
						event("processing", 1, orderId),
					);
					assert.equal(response.status, 409);
					assert.match((await response.json()).error, /fixture.*missing/i);
				}
				assert.equal((await state(runId)).status, "created");
				assert.equal((await state(runId)).version, "0");
			},
		);
		await t.test(
			`${profile}: a payment after status updates preserves status and stock behavior`,
			async () => {
				const runId = await prepare();
				assert.equal(
					(await send(profile, runId, event("shipped", 3))).status,
					200,
				);
				const payment = {
					id: "payment_1",
					type: "payment.succeeded",
					data: { orderId: "order_001", quantity: 2 },
				};
				assert.equal((await send(profile, runId, payment)).status, 200);
				assert.deepEqual(await state(runId), {
					status: "shipped",
					version: "3",
					paid: true,
					quantity: 2,
					stock: 8,
					fulfillments: 1,
					claims: profile === "corrected" ? 1 : 0,
				});
			},
		);
	}
	await t.test(
		"corrected simultaneous updates retain the highest version",
		async () => {
			const runId = await prepare();
			const responses = await Promise.all(
				[1, 5, 2, 4, 3].map((version) =>
					send("corrected", runId, event(`status-${version}`, version)),
				),
			);
			for (const response of responses) assert.equal(response.status, 200);
			assert.equal((await state(runId)).status, "status-5");
			assert.equal((await state(runId)).version, "5");
		},
	);
	await t.test(
		"corrected binds versions beyond PostgreSQL integer range without precision loss",
		async () => {
			const runId = await prepare();
			assert.equal(
				(
					await send(
						"corrected",
						runId,
						event("final", Number.MAX_SAFE_INTEGER),
					)
				).status,
				200,
			);
			assert.equal(
				(
					await send(
						"corrected",
						runId,
						event("older", Number.MAX_SAFE_INTEGER - 1),
					)
				).status,
				200,
			);
			assert.equal((await state(runId)).version, "9007199254740991");
			assert.equal((await state(runId)).status, "final");
		},
	);
});
