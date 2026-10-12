import { MAX_BODY_BYTES, type PublicTarget } from "@webhook-tester/contracts";
import {
	ScenarioNotFoundError,
	ScenarioRevisionConflictError,
} from "@webhook-tester/db";
import type { Pool } from "pg";
import Fastify from "fastify";
import { registerRunRoutes } from "./runs.js";
import { registerRunEventRoutes, type EventStreamOptions } from "./events.js";
import { registerScenarioRoutes } from "./scenarios.js";

export interface ApiOptions {
	appPool?: Pool;
	targets?: ReadonlyMap<string, PublicTarget>;
	allowedOrigin?: string;
	logger?: boolean;
	eventStream?: EventStreamOptions;
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
		const allowedOrigin = options.allowedOrigin ?? "http://127.0.0.1:4173";
		registerScenarioRoutes(app, options.appPool, targets, allowedOrigin);
		registerRunRoutes(app, options.appPool, targets, allowedOrigin);
		registerRunEventRoutes(app, options.appPool, options.eventStream);
	}
	app.setErrorHandler((error, request, reply) => {
		if (error instanceof ScenarioRevisionConflictError)
			return reply
				.code(409)
				.send({ error: error.message, currentRevision: error.currentRevision });
		if (error instanceof ScenarioNotFoundError)
			return reply.code(404).send({ error: error.message });
		if (
			typeof error === "object" &&
			error !== null &&
			"name" in error &&
			error.name === "ZodError" &&
			"issues" in error &&
			Array.isArray(error.issues)
		)
			return reply.code(400).send({
				error: "Scenario is invalid",
				issues: "issues" in error ? error.issues : [],
			});
		if (
			error instanceof Error &&
			"statusCode" in error &&
			typeof error.statusCode === "number" &&
			error.statusCode >= 400 &&
			error.statusCode < 500
		) {
			return reply.code(error.statusCode).send({
				error: error.message,
				...("issues" in error ? { issues: error.issues } : {}),
			});
		}
		request.log.error(error);
		return reply
			.code(500)
			.send({ error: "The request could not be completed" });
	});
	return app;
}
