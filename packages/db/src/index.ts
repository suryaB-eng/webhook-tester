import { Pool, type PoolClient } from "pg";

export interface DatabaseUrls {
	admin: string;
	app: string;
	targetOwner: string;
	targetApp: string;
	targetFixture: string;
	targetQuery: string;
}

export function createPool(url: string): Pool {
	return new Pool({ connectionString: url, connectionTimeoutMillis: 5_000 });
}

export function databaseUrls(
	env: NodeJS.ProcessEnv = process.env,
): DatabaseUrls {
	return {
		admin:
			env.ADMIN_DATABASE_URL ??
			"postgres://postgres:superuser_local_only@127.0.0.1:55432/postgres",
		app:
			env.APP_DATABASE_URL ??
			"postgres://webhook_tester_app:app_local_only@127.0.0.1:55432/webhook_tester",
		targetOwner:
			env.TARGET_OWNER_DATABASE_URL ??
			"postgres://demo_target_owner:target_owner_local_only@127.0.0.1:55432/demo_target",
		targetApp:
			env.TARGET_APP_DATABASE_URL ??
			"postgres://demo_target_app:target_app_local_only@127.0.0.1:55432/demo_target",
		targetFixture:
			env.TARGET_FIXTURE_DATABASE_URL ??
			"postgres://demo_target_fixture:fixture_local_only@127.0.0.1:55432/demo_target",
		targetQuery:
			env.TARGET_QUERY_DATABASE_URL ??
			"postgres://demo_target_query:query_local_only@127.0.0.1:55432/demo_target",
	};
}

export async function withTransaction<T>(
	pool: Pool,
	operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	let discard = false;
	try {
		await client.query("BEGIN");
		const result = await operation(client);
		await client.query("COMMIT");
		return result;
	} catch (error) {
		try {
			await client.query("ROLLBACK");
		} catch {
			// The original operation error is more useful than a disconnected rollback.
			discard = true;
			throw error;
		}
		throw error;
	} finally {
		client.release(discard);
	}
}

function validateRunId(runId: string): void {
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			runId,
		)
	) {
		throw new Error("runId must be a UUID");
	}
}

async function deleteRun(client: PoolClient, runId: string): Promise<void> {
	await client.query("DELETE FROM processed_business_events WHERE run_id=$1", [
		runId,
	]);
	await client.query("DELETE FROM fulfillments WHERE run_id=$1", [runId]);
	await client.query("DELETE FROM orders WHERE run_id=$1", [runId]);
	await client.query("DELETE FROM inventory WHERE run_id=$1", [runId]);
}

export async function prepareDemoFixtures(
	pool: Pool,
	runId: string,
	orders: readonly { orderId: string; quantity: number }[],
): Promise<void> {
	validateRunId(runId);
	const unique = new Map<string, number>();
	for (const { orderId, quantity } of orders) {
		if (
			typeof orderId !== "string" ||
			!orderId.trim() ||
			orderId.length > 200
		) {
			throw new Error("orderId must be nonblank and at most 200 characters");
		}
		if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
			throw new Error("quantity must be an integer from 1 to 10");
		}
		if (unique.has(orderId) && unique.get(orderId) !== quantity) {
			throw new Error("Repeated orderId must have consistent quantity");
		}
		unique.set(orderId, quantity);
	}
	await withTransaction(pool, async (client) => {
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
			runId.toLowerCase(),
		]);
		await deleteRun(client, runId);
		for (const [orderId, quantity] of unique) {
			await client.query(
				"INSERT INTO orders(run_id,order_id,quantity) VALUES($1,$2,$3)",
				[runId, orderId, quantity],
			);
		}
		await client.query(
			"INSERT INTO inventory(run_id,sku,quantity) VALUES($1,$2,$3)",
			[runId, "sku_001", 10],
		);
	});
}

export async function cleanupDemoFixtures(
	pool: Pool,
	runId: string,
): Promise<void> {
	validateRunId(runId);
	await withTransaction(pool, async (client) => {
		await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
			runId.toLowerCase(),
		]);
		await deleteRun(client, runId);
	});
}

export { runMigrations } from "./migrations.js";
