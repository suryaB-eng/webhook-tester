import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import {
	cleanupDemoFixtures,
	createPool,
	databaseUrls,
	prepareDemoFixtures,
	runMigrations,
	withTransaction,
} from "./index.js";
import { assertTestDatabase, testDatabaseUrls } from "./testing.js";

it("uses separate URLs for every login and honors explicit environment URLs", () => {
	const urls = databaseUrls({ APP_DATABASE_URL: "postgres://custom/app" });
	assert.equal(urls.app, "postgres://custom/app");
	assert.equal(new URL(urls.targetApp).username, "demo_target_app");
	assert.equal(new URL(urls.targetQuery).username, "demo_target_query");
	assert.equal(
		new URL(testDatabaseUrls().admin).pathname,
		"/webhook_tester_test_admin",
	);
	assert.equal(new URL(testDatabaseUrls().targetOwner).port, "55433");
});

describe("isolated PostgreSQL database contracts", {
	concurrency: false,
}, () => {
	const runs = new Set<string>();
	let pools: Record<
		"admin" | "app" | "owner" | "targetApp" | "fixture" | "query",
		Pool
	>;
	let urls: ReturnType<typeof testDatabaseUrls>;
	const run = () => {
		const id = randomUUID();
		runs.add(id);
		return id;
	};

	before(async () => {
		urls = testDatabaseUrls();
		await assertTestDatabase(urls);
		await runMigrations(urls);
		pools = {
			admin: createPool(urls.admin),
			app: createPool(urls.app),
			owner: createPool(urls.targetOwner),
			targetApp: createPool(urls.targetApp),
			fixture: createPool(urls.targetFixture),
			query: createPool(urls.targetQuery),
		};
	});

	after(async () => {
		if (!pools) return;
		try {
			for (const id of runs) await cleanupDemoFixtures(pools.fixture, id);
		} finally {
			await Promise.all(Object.values(pools).map((pool) => pool.end()));
		}
	});

	it("refuses a database without the dedicated test marker before migrations", async () => {
		const unsafe = {
			...urls,
			admin: urls.admin.replace("/webhook_tester_test_admin", "/postgres"),
		};
		await assert.rejects(assertTestDatabase(unsafe), /test database/i);
	});

	it("applies migrations twice without changing the ledger or existing role passwords", async () => {
		const adminLedger = await pools.admin.query(
			"SELECT name, checksum FROM public.schema_migrations ORDER BY name",
		);
		const targetLedger = await pools.owner.query(
			"SELECT name, checksum FROM public.schema_migrations ORDER BY name",
		);
		assert.ok(adminLedger.rowCount && targetLedger.rowCount);
		const passwords = await pools.admin.query(
			"SELECT rolname, rolpassword FROM pg_authid WHERE rolname LIKE 'demo_target_%' ORDER BY rolname",
		);
		await runMigrations(urls);
		assert.deepEqual(
			(
				await pools.admin.query(
					"SELECT name, checksum FROM public.schema_migrations ORDER BY name",
				)
			).rows,
			adminLedger.rows,
		);
		assert.deepEqual(
			(
				await pools.owner.query(
					"SELECT name, checksum FROM public.schema_migrations ORDER BY name",
				)
			).rows,
			targetLedger.rows,
		);
		assert.deepEqual(
			(
				await pools.admin.query(
					"SELECT rolname, rolpassword FROM pg_authid WHERE rolname LIKE 'demo_target_%' ORDER BY rolname",
				)
			).rows,
			passwords.rows,
		);
		for (const table of [
			"orders",
			"inventory",
			"fulfillments",
			"processed_business_events",
		]) {
			assert.equal(
				(await pools.query.query(`SELECT count(*)::int AS count FROM ${table}`))
					.rows[0].count,
				0,
			);
		}
		const owners = await pools.owner.query(
			"SELECT tableowner FROM pg_tables WHERE schemaname='public'",
		);
		assert.ok(owners.rowCount);
		assert.ok(
			owners.rows.every(
				(row: { tableowner: string }) => row.tableowner === "demo_target_owner",
			),
		);
	});

	it("accepts copied LF and CRLF migrations while rejecting actual SQL changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "webhook-db-migrations-"));
		assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
		const copiedDirectory = pathToFileURL(`${directory}${sep}`);
		const copies: { path: string; sql: string }[] = [];
		try {
			for (const scope of ["admin", "target"]) {
				await mkdir(join(directory, scope));
				const source = new URL(`../migrations/${scope}/`, import.meta.url);
				for (const name of (await readdir(source)).filter((name) => name.endsWith(".sql"))) {
					const sql = (await readFile(new URL(name, source), "utf8")).replace(/\r\n/g, "\n");
					const path = join(directory, scope, name);
					copies.push({ path, sql });
					await writeFile(path, sql);
				}
			}
			await runMigrations(urls, copiedDirectory);
			for (const { path, sql } of copies) await writeFile(path, sql.replace(/\n/g, "\r\n"));
			await runMigrations(urls, copiedDirectory);
			for (const { path, sql } of copies) {
				await writeFile(path, `${sql}\nSELECT 1;\n`);
				await assert.rejects(runMigrations(urls, copiedDirectory), /Applied migration has changed/);
				await writeFile(path, sql);
			}
			await runMigrations(urls);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("replaces only one run, deduplicates orders, and cleans dependent rows first", async () => {
		const first = run();
		const other = run();
		await prepareDemoFixtures(pools.fixture, first, [
			{ orderId: "old", quantity: 2 },
		]);
		await prepareDemoFixtures(pools.fixture, other, [
			{ orderId: "other", quantity: 3 },
		]);
		await pools.targetApp.query(
			"INSERT INTO processed_business_events(run_id,business_event_id,order_id,quantity) VALUES($1,$2,$3,$4)",
			[first, "evt-old", "old", 2],
		);
		await pools.targetApp.query(
			"INSERT INTO fulfillments(id,run_id,order_id,business_event_id) VALUES($1,$2,$3,$4)",
			[randomUUID(), first, "old", "evt-old"],
		);
		await prepareDemoFixtures(pools.fixture, first, [
			{ orderId: "new", quantity: 1 },
			{ orderId: "new", quantity: 1 },
		]);
		assert.deepEqual(
			(
				await pools.query.query(
					"SELECT order_id, paid, quantity FROM orders WHERE run_id=$1",
					[first],
				)
			).rows,
			[{ order_id: "new", paid: false, quantity: 1 }],
		);
		assert.deepEqual(
			(
				await pools.query.query(
					"SELECT sku, quantity FROM inventory WHERE run_id=$1",
					[first],
				)
			).rows,
			[{ sku: "sku_001", quantity: 10 }],
		);
		await cleanupDemoFixtures(pools.fixture, first);
		assert.equal(
			(
				await pools.query.query(
					"SELECT count(*)::int AS count FROM orders WHERE run_id=$1",
					[first],
				)
			).rows[0].count,
			0,
		);
		assert.equal(
			(
				await pools.query.query(
					"SELECT count(*)::int AS count FROM orders WHERE run_id=$1",
					[other],
				)
			).rows[0].count,
			1,
		);
	});

	it("rejects invalid fixture inputs before deleting an existing run", async () => {
		const id = run();
		await prepareDemoFixtures(pools.fixture, id, [
			{ orderId: "keep", quantity: 1 },
		]);
		for (const orders of [
			[{ orderId: " ", quantity: 1 }],
			[{ orderId: "x".repeat(201), quantity: 1 }],
			[{ orderId: "x", quantity: 0 }],
			[{ orderId: "x", quantity: 11 }],
			[{ orderId: "x", quantity: 1.5 }],
			[
				{ orderId: "x", quantity: 1 },
				{ orderId: "x", quantity: 2 },
			],
		])
			await assert.rejects(prepareDemoFixtures(pools.fixture, id, orders));
		await assert.rejects(prepareDemoFixtures(pools.fixture, "not-a-uuid", []));
		await assert.rejects(cleanupDemoFixtures(pools.fixture, "not-a-uuid"));
		assert.equal(
			(
				await pools.query.query(
					"SELECT count(*)::int AS count FROM orders WHERE run_id=$1",
					[id],
				)
			).rows[0].count,
			1,
		);
	});

	it("rolls back failed preparation and releases failed transactions", async () => {
		const id = run();
		await prepareDemoFixtures(pools.fixture, id, [
			{ orderId: "keep", quantity: 1 },
		]);
		const limit = `reject_test_${id.replaceAll("-", "")}`;
		await pools.owner.query(
			`ALTER TABLE orders ADD CONSTRAINT ${limit} CHECK(order_id <> 'reject')`,
		);
		try {
			await assert.rejects(
				prepareDemoFixtures(pools.fixture, id, [
					{ orderId: "reject", quantity: 1 },
				]),
			);
			assert.equal(
				(
					await pools.query.query(
						"SELECT order_id FROM orders WHERE run_id=$1",
						[id],
					)
				).rows[0].order_id,
				"keep",
			);
		} finally {
			await pools.owner.query(`ALTER TABLE orders DROP CONSTRAINT ${limit}`);
		}
		await assert.rejects(
			withTransaction(pools.fixture, async (client) => {
				await client.query("DELETE FROM orders WHERE run_id=$1", [id]);
				throw new Error("rollback sentinel");
			}),
			/rollback sentinel/,
		);
		assert.equal(
			(
				await pools.query.query(
					"SELECT count(*)::int AS count FROM orders WHERE run_id=$1",
					[id],
				)
			).rows[0].count,
			1,
		);
		assert.equal(await withTransaction(pools.fixture, async () => 42), 42);
	});

	it("restricts the application login to CONNECT without table or creation rights", async () => {
		assert.equal(
			(await pools.app.query("SELECT current_database() AS name")).rows[0].name,
			"webhook_tester",
		);
		await assert.rejects(
			pools.app.query("CREATE TABLE public.forbidden(id int)"),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.app.query("CREATE TEMP TABLE forbidden(id int)"),
			{ code: "42501" },
		);
		await assert.rejects(pools.app.query("CREATE SCHEMA forbidden"), {
			code: "42501",
		});
		const owner = await pools.admin.query(
			"SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='webhook_tester'",
		);
		assert.equal(owner.rows[0].owner, "postgres");
		assert.equal(
			(
				await pools.app.query(
					"SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'",
				)
			).rows[0].count,
			0,
		);
		const cross = new URL(urls.app);
		cross.pathname = "/demo_target";
		const crossPool = createPool(cross.toString());
		try {
			await assert.rejects(crossPool.query("SELECT 1"), { code: "42501" });
		} finally {
			await crossPool.end();
		}
	});

	it("allows the target application only the payment mutations", async () => {
		const id = run();
		await prepareDemoFixtures(pools.fixture, id, [
			{ orderId: "pay", quantity: 2 },
		]);
		await withTransaction(pools.targetApp, async (client) => {
			await client.query("UPDATE orders SET paid=true WHERE run_id=$1", [id]);
			await client.query(
				"UPDATE inventory SET quantity=quantity-2 WHERE run_id=$1",
				[id],
			);
			await client.query(
				"INSERT INTO processed_business_events(run_id,business_event_id,order_id,quantity) VALUES($1,$2,$3,$4)",
				[id, "evt", "pay", 2],
			);
			await client.query(
				"INSERT INTO fulfillments(id,run_id,order_id,business_event_id) VALUES($1,$2,$3,$4)",
				[randomUUID(), id, "pay", "evt"],
			);
		});
		for (const table of [
			"orders",
			"inventory",
			"fulfillments",
			"processed_business_events",
		]) {
			assert.equal(
				(
					await pools.targetApp.query(
						`SELECT count(*)::int AS count FROM ${table} WHERE run_id=$1`,
						[id],
					)
				).rows[0].count,
				1,
			);
			await assert.rejects(
				pools.targetApp.query(`DELETE FROM ${table} WHERE run_id=$1`, [id]),
				{ code: "42501" },
			);
		}
		await assert.rejects(
			pools.targetApp.query("UPDATE orders SET quantity=3 WHERE run_id=$1", [
				id,
			]),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.targetApp.query(
				"INSERT INTO orders(run_id,order_id,quantity) VALUES($1,'forbidden',1)",
				[id],
			),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.targetApp.query(
				"INSERT INTO inventory(run_id,sku,quantity) VALUES($1,'forbidden',1)",
				[id],
			),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.targetApp.query(
				"UPDATE processed_business_events SET quantity=3 WHERE run_id=$1",
				[id],
			),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.targetApp.query("CREATE TABLE forbidden(id int)"),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.targetApp.query("CREATE TEMP TABLE forbidden(id int)"),
			{ code: "42501" },
		);
		await assert.rejects(
			pools.fixture.query("UPDATE inventory SET quantity=9 WHERE run_id=$1", [
				id,
			]),
			{ code: "42501" },
		);
	});

	it("denies query login writes even after disabling the read-only session default", async () => {
		const id = run();
		await prepareDemoFixtures(pools.fixture, id, [
			{ orderId: "read", quantity: 1 },
		]);
		const client = await pools.query.connect();
		try {
			assert.equal(
				(await client.query("SHOW default_transaction_read_only")).rows[0]
					.default_transaction_read_only,
				"on",
			);
			assert.equal(
				(await client.query("SHOW statement_timeout")).rows[0]
					.statement_timeout,
				"2s",
			);
			await client.query("SET default_transaction_read_only=off");
			const inserts = [
				["orders", "run_id,order_id,quantity", "$1,'forbidden',1"],
				["inventory", "run_id,sku,quantity", "$1,'forbidden',1"],
				[
					"fulfillments",
					"id,run_id,order_id,business_event_id",
					"gen_random_uuid(),$1,'read','forbidden'",
				],
				[
					"processed_business_events",
					"run_id,business_event_id,order_id,quantity",
					"$1,'forbidden','read',1",
				],
			];
			const updates: Record<string, string> = {
				orders: "paid=true",
				inventory: "quantity=1",
				fulfillments: "business_event_id='forbidden'",
				processed_business_events: "quantity=1",
			};
			for (const [table, columns, values] of inserts) {
				await assert.rejects(
					client.query(`INSERT INTO ${table}(${columns}) VALUES(${values})`, [
						id,
					]),
					{ code: "42501" },
				);
				await assert.rejects(
					client.query(
						`UPDATE ${table} SET ${updates[table as string]} WHERE run_id=$1`,
						[id],
					),
					{ code: "42501" },
				);
				await assert.rejects(
					client.query(`DELETE FROM ${table} WHERE run_id=$1`, [id]),
					{ code: "42501" },
				);
			}
			await assert.rejects(client.query("CREATE TABLE forbidden(id int)"), {
				code: "42501",
			});
			await assert.rejects(
				client.query("CREATE TEMP TABLE forbidden(id int)"),
				{ code: "42501" },
			);
		} finally {
			try {
				await client.query("RESET default_transaction_read_only");
			} finally {
				client.release();
			}
		}
	});
});
