import { MAX_BODY_BYTES, type PublicTarget } from "@webhook-tester/contracts";
import { ScenarioNotFoundError } from "@webhook-tester/db";
import type { Pool } from "pg";
import Fastify from "fastify";
import { registerRunRoutes } from "./runs.js";
import { registerScenarioRoutes } from "./scenarios.js";

export interface ApiOptions {
	appPool?: Pool;
	targets?: ReadonlyMap<string, PublicTarget>;
	allowedOrigin?: string;
	logger?: boolean;
}
export const defaultTargets: ReadonlyMap<string, PublicTarget> = new Map([
	["demo-flawed", { id: "demo-flawed", name: "Without deduplication" }],
	["demo-corrected", { id: "demo-corrected", name: "With deduplication" }],
]);

export function buildApp(options: ApiOptions = {}) {
	const app = Fastify({
		logger: options.logger ?? true,
		bodyLimit: MAX_BODY_BYTES,
		ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
	});
	app.get("/health", async () => {
		if (options.appPool) await options.appPool.query("SELECT 1");
		return { status: "ok" };
	});
	const targets = options.targets ?? defaultTargets;
	app.get("/api/targets", async () =>
		[...targets.values()].map(({ id, name }) => ({ id, name })),
	);
	if (options.appPool) {
		registerScenarioRoutes(app, options.appPool);
		registerRunRoutes(
			app,
			options.appPool,
			targets,
			options.allowedOrigin ?? "http://127.0.0.1:4173",
		);
	}
	app.setErrorHandler((error, request, reply) => {
		if (error instanceof ScenarioNotFoundError)
			return reply.code(404).send({ error: error.message });
		if (error instanceof Error && error.name === "ZodError")
			return reply.code(400).send({ error: "Saved scenario is invalid" });
		if (
			error instanceof Error &&
			"statusCode" in error &&
			typeof error.statusCode === "number" &&
			error.statusCode >= 400 &&
			error.statusCode < 500
		) {
			return reply.code(error.statusCode).send({ error: error.message });
		}
		request.log.error(error);
		return reply
			.code(500)
			.send({ error: "The request could not be completed" });
	});
	return app;
}
