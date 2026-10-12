import { createPool, databaseUrls } from "@webhook-tester/db";
import { buildDemoTarget } from "./app.js";

const pool = createPool(databaseUrls().targetApp);
const app = buildDemoTarget(pool, { logger: true });
app.addHook("onClose", async () => pool.end());

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close().catch((error: unknown) => {
			app.log.error(error);
			process.exitCode = 1;
		});
	});
}
try {
	await app.listen({
		host: process.env.DEMO_TARGET_HOST ?? "127.0.0.1",
		port: Number(process.env.DEMO_TARGET_PORT ?? 4010),
	});
} catch (error) {
	app.log.error(error);
	await app.close();
	process.exitCode = 1;
}
