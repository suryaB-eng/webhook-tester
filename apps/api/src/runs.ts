import type { PublicTarget } from "@webhook-tester/contracts";
import { enqueueRun, getRun } from "@webhook-tester/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

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
			onRequest: async (request, reply) => {
				if (request.headers.origin !== allowedOrigin)
					return reply
						.code(403)
						.send({ error: "A configured local Origin is required" });
				if (
					request.headers["content-type"]
						?.split(";")[0]
						?.trim()
						.toLowerCase() !== "application/json"
				) {
					return reply
						.code(415)
						.send({ error: "Content-Type must be application/json" });
				}
			},
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
			let targetId = request.body.targetId;
			if (!targetId) {
				const result = await pool.query<{ definition: { targetId?: unknown } }>(
					"SELECT definition FROM scenarios WHERE id=$1",
					[request.body.scenarioId],
				);
				if (!result.rows[0])
					return reply.code(404).send({ error: "Scenario not found" });
				const savedTarget = result.rows[0].definition.targetId;
				if (typeof savedTarget !== "string")
					return reply
						.code(400)
						.send({ error: "Saved scenario target is invalid" });
				targetId = savedTarget;
			}
			const target = targets.get(targetId);
			if (!target)
				return reply.code(400).send({ error: "Target is not configured" });
			const runId = await enqueueRun(pool, request.body.scenarioId, target);
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
