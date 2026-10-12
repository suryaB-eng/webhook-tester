import { createPool, databaseUrls, type DatabaseUrls } from "./index.js";

export function testDatabaseUrls(): DatabaseUrls {
	const defaults = databaseUrls({});
	const keys = {
		admin: "TEST_ADMIN_DATABASE_URL",
		app: "TEST_APP_DATABASE_URL",
		targetOwner: "TEST_TARGET_OWNER_DATABASE_URL",
		targetApp: "TEST_TARGET_APP_DATABASE_URL",
		targetFixture: "TEST_TARGET_FIXTURE_DATABASE_URL",
		targetQuery: "TEST_TARGET_QUERY_DATABASE_URL",
	} as const;
	const result = { ...defaults };
	for (const key of Object.keys(keys) as (keyof DatabaseUrls)[]) {
		const url = new URL(defaults[key]);
		url.port = "55433";
		if (key === "admin") url.pathname = "/webhook_tester_test_admin";
		result[key] = process.env[keys[key]] ?? url.toString();
	}
	return result;
}

export async function assertTestDatabase(urls: DatabaseUrls): Promise<void> {
	const admin = new URL(urls.admin);
	const pool = createPool(urls.admin);
	try {
		const result = await pool.query<{ name: string }>(
			"SELECT current_database() AS name",
		);
		if (result.rows[0]?.name !== "webhook_tester_test_admin") {
			throw new Error(
				"Refusing mutations: admin connection is not the dedicated test database",
			);
		}
		for (const [key, value] of Object.entries(urls)) {
			const url = new URL(value);
			if (url.hostname !== admin.hostname || url.port !== admin.port) {
				throw new Error(
					`Refusing mutations: ${key} does not use the test database server`,
				);
			}
		}
	} finally {
		await pool.end();
	}
}
