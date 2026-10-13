import { performance } from "node:perf_hooks";
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

export async function connectWithTimeout(
	pool: Pool,
	timeoutMs: number,
): Promise<PoolClient> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Database connection timeout");
	}
	return new Promise<PoolClient>((resolve, reject) => {
		let expired = false;
		const timer = setTimeout(() => {
			expired = true;
			reject(new Error("Database connection timeout"));
		}, timeoutMs);
		Promise.resolve()
			.then(() => pool.connect())
			.then(
				(client) => {
					clearTimeout(timer);
					// pg cannot remove a pending acquisition; return a late session immediately.
					if (expired) client.release();
					else resolve(client);
				},
				(error: unknown) => {
					clearTimeout(timer);
					if (!expired) reject(error);
				},
			);
	});
}
export async function withTransaction<T>(
	pool: Pool,
	operation: (client: PoolClient) => Promise<T>,
	options?: { deadline: number },
): Promise<T> {
	const client = options
		? await connectWithTimeout(pool, options.deadline - performance.now())
		: await pool.connect();
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

export interface FixtureOptions {
	timeoutMs: number;
}

function fixtureDeadline(options?: FixtureOptions): number | undefined {
	if (!options) return undefined;
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
		throw new Error("Fixture timeout must be a positive number");
	}
	// Include connection acquisition in the budget rather than starting it after BEGIN.
	return performance.now() + options.timeoutMs;
}

async function setFixtureBudget(
	client: PoolClient,
	deadline?: number,
): Promise<void> {
	if (deadline === undefined) return;
	const remaining = Math.floor(deadline - performance.now());
	if (remaining <= 0) throw new Error("Fixture timeout exceeded");
	await client.query("SELECT set_config('statement_timeout',$1,true)", [
		`${remaining}ms`,
	]);
}

async function deleteRun(
	client: PoolClient,
	runId: string,
	deadline?: number,
): Promise<void> {
	for (const table of [
		"processed_business_events",
		"fulfillments",
		"orders",
		"inventory",
	]) {
		await setFixtureBudget(client, deadline);
		await client.query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
	}
}
export async function prepareDemoFixtures(
	pool: Pool,
	runId: string,
	orders: readonly { orderId: string; quantity: number }[],
	options?: FixtureOptions,
): Promise<void> {
	const deadline = fixtureDeadline(options);
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
	await withTransaction(
		pool,
		async (client) => {
			await setFixtureBudget(client, deadline);
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[runId.toLowerCase()],
			);
			await deleteRun(client, runId, deadline);
			for (const [orderId, quantity] of unique) {
				await setFixtureBudget(client, deadline);
				await client.query(
					"INSERT INTO orders(run_id,order_id,quantity,status,version) VALUES($1,$2,$3,'created',0)",
					[runId, orderId, quantity],
				);
			}
			await setFixtureBudget(client, deadline);
			await client.query(
				"INSERT INTO inventory(run_id,sku,quantity) VALUES($1,$2,$3)",
				[runId, "sku_001", 10],
			);
			await setFixtureBudget(client, deadline);
		},
		deadline === undefined ? undefined : { deadline },
	);
}

export async function cleanupDemoFixtures(
	pool: Pool,
	runId: string,
	options?: FixtureOptions,
): Promise<void> {
	const deadline = fixtureDeadline(options);
	validateRunId(runId);
	await withTransaction(
		pool,
		async (client) => {
			await setFixtureBudget(client, deadline);
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[runId.toLowerCase()],
			);
			await deleteRun(client, runId, deadline);
			await setFixtureBudget(client, deadline);
		},
		deadline === undefined ? undefined : { deadline },
	);
}

export { runMigrations } from "./migrations.js";
export * from "./scenarios.js";
export * from "./runs.js";
export * from "./events.js";
export * from "./history.js";
