import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createPool, databaseUrls } from "@webhook-tester/db";
import { targetProfiles } from "./config.js";
import { runWorkerOnce } from "./worker.js";

const urls = databaseUrls();
const options = {
	appPool: createPool(urls.app),
	fixturePool: createPool(urls.targetFixture),
	queryPool: createPool(urls.targetQuery),
	targetProfiles: targetProfiles(),
	workerId: randomUUID(),
};
for (const pool of [options.appPool, options.fixturePool, options.queryPool]) {
	pool.on("error", (error) =>
		console.error("Database connection error:", error.message),
	);
}
const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => stop.abort());
try {
	while (!stop.signal.aborted) {
		const result = await runWorkerOnce(options);
		if (result !== "processed") {
			try {
				await delay(250, undefined, { signal: stop.signal });
			} catch {
				break;
			}
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : "Worker failed");
	process.exitCode = 1;
} finally {
	await Promise.all([
		options.appPool.end(),
		options.fixturePool.end(),
		options.queryPool.end(),
	]);
}
