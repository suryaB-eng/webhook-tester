import { createPool, databaseUrls, seedScenarios } from "@webhook-tester/db";
import { buildApp } from "./app.js";

const pool = createPool(databaseUrls().app);
const app = buildApp({
	appPool: pool,
	allowedOrigin: process.env.LOCAL_ORIGIN ?? "http://127.0.0.1:4173",
});
app.addHook("onClose", async () => {
	await pool.end();
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close().catch((error: unknown) => {
			app.log.error(error);
			process.exitCode = 1;
		});
	});
}

try {
	await seedScenarios(pool);
	await app.listen({
		host: process.env.API_HOST ?? "127.0.0.1",
		port: Number(process.env.API_PORT ?? 4000),
	});
} catch (error) {
	app.log.error(error);
	await app.close();
	process.exitCode = 1;
}
