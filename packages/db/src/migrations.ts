import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import {
	createPool,
	databaseUrls,
	type DatabaseUrls,
	withTransaction,
} from "./index.js";

async function applyFiles(
	client: PoolClient,
	scope: "admin" | "app" | "target",
	migrationsDirectory: URL,
): Promise<void> {
	await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
	await client.query("REVOKE ALL ON public.schema_migrations FROM PUBLIC");
	const directory = new URL(`${scope}/`, migrationsDirectory);
	const files = (await readdir(directory))
		.filter((name) => name.endsWith(".sql"))
		.sort();
	for (const name of files) {
		const sql = await readFile(new URL(name, directory), "utf8");
		// Windows checkouts may use CRLF; line endings do not change a migration's identity.
		const checksum = createHash("sha256")
			.update(sql.replace(/\r\n/g, "\n"))
			.digest("hex");
		await client.query("BEGIN");
		try {
			const previous = await client.query<{ checksum: string }>(
				"SELECT checksum FROM public.schema_migrations WHERE name=$1",
				[name],
			);
			if (previous.rows.length) {
				if (previous.rows[0]?.checksum !== checksum)
					throw new Error(`Applied migration has changed: ${scope}/${name}`);
			} else {
				await client.query(sql);
				await client.query(
					"INSERT INTO public.schema_migrations(name,checksum) VALUES($1,$2)",
					[name, checksum],
				);
			}
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
	}
}

export async function runMigrations(
	urls: DatabaseUrls = databaseUrls(),
	migrationsDirectory = new URL("../migrations/", import.meta.url),
): Promise<void> {
	const admin = createPool(urls.admin);
	const target = createPool(urls.targetOwner);
	const applicationAdminUrl = new URL(urls.admin);
	applicationAdminUrl.pathname = new URL(urls.app).pathname;
	const applicationAdmin = createPool(applicationAdminUrl.toString());
	let lock: PoolClient | undefined;
	let locked = false;
	try {
		lock = await admin.connect();
		await lock.query("SELECT pg_advisory_lock(837472910)");
		locked = true;
		await applyFiles(lock, "admin", migrationsDirectory);
		await withTransaction(applicationAdmin, async (client) => {
			await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
		});
		const appAdmin = await applicationAdmin.connect();
		try {
			await applyFiles(appAdmin, "app", migrationsDirectory);
		} finally {
			appAdmin.release();
		}
		const owner = await target.connect();
		try {
			await applyFiles(owner, "target", migrationsDirectory);
		} finally {
			owner.release();
		}
	} finally {
		try {
			if (locked && lock)
				await lock.query("SELECT pg_advisory_unlock(837472910)");
		} finally {
			lock?.release();
			await Promise.all([admin.end(), target.end(), applicationAdmin.end()]);
		}
	}
}
