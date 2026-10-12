import { pathToFileURL } from "node:url";
import { runMigrations } from "./index.js";

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	runMigrations().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "Database migrations failed",
		);
		process.exitCode = 1;
	});
}
