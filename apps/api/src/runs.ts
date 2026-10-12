import type { PublicTarget } from "@webhook-tester/contracts";
import { enqueueRun, getRun } from "@webhook-tester/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { localJsonMutation } from "./mutation.js";

interface LaunchBody {
	scenarioId: string;
	targetId?: string;
}
const uuidPattern =
	"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

export function registerRunRoutes(
	app: FastifyInstance,
	pool: Pool,
	targets: ReadonlyMap<string, PublicTarget>,
	allowedOrigin: string,
): void {
	app.post<{ Body: LaunchBody }>(
		"/api/runs",
		{
			onRequest: localJsonMutation(allowedOrigin),
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["scenarioId"],
					properties: {
						scenarioId: { type: "string", minLength: 1, maxLength: 100 },
						targetId: { type: "string", minLength: 1, maxLength: 100 },
					},
				},
			},
		},
		async (request, reply) => {
			const runId = await enqueueRun(
				pool,
				request.body.scenarioId,
				(scenario) => {
					const target = targets.get(
						request.body.targetId ?? scenario.targetId,
					);
					if (!target)
						throw Object.assign(new Error("Target is not configured"), {
							statusCode: 400,
						});
					return target;
				},
			);
			return reply.code(202).send({ runId });
		},
	);

	app.get<{ Params: { id: string } }>(
		"/api/runs/:id",
		{
			schema: {
				params: {
					type: "object",
					required: ["id"],
					properties: { id: { type: "string", pattern: uuidPattern } },
				},
			},
		},
		async (request, reply) => {
			const run = await getRun(pool, request.params.id);
			if (!run) return reply.code(404).send({ error: "Run not found" });
			return run;
		},
	);
}
