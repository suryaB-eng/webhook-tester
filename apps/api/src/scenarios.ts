import {
	MAX_BODY_BYTES,
	parseScenarioV1,
	validateDemoScenario,
	type PublicTarget,
} from "@webhook-tester/contracts";
import {
	createScenario,
	getScenario,
	listScenarios,
	ScenarioNotFoundError,
	updateScenario,
} from "@webhook-tester/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { localJsonMutation } from "./mutation.js";

// The document limit stays 1 MiB; reserve bounded space for its JSON envelope.
const scenarioRequestBodyLimit = MAX_BODY_BYTES + 64;

const scenarioParams = {
	type: "object",
	additionalProperties: false,
	required: ["id"],
	properties: { id: { type: "string", minLength: 1, maxLength: 100 } },
};

export function registerScenarioRoutes(
	app: FastifyInstance,
	pool: Pool,
	targets: ReadonlyMap<string, PublicTarget>,
	allowedOrigin: string,
): void {
	const onRequest = localJsonMutation(allowedOrigin);
	const validateInput = (input: unknown) => {
		const document = parseScenarioV1(input);
		validateDemoScenario(document);
		if (!targets.has(document.targetId)) {
			throw Object.assign(new Error("Target is not configured"), {
				statusCode: 400,
				issues: [{ path: ["targetId"], message: "Target is not configured" }],
			});
		}
		return document;
	};
	app.get("/api/scenarios", async () => listScenarios(pool));
	app.get<{ Params: { id: string } }>(
		"/api/scenarios/:id",
		{
			schema: { params: scenarioParams },
		},
		async (request) => {
			const saved = await getScenario(pool, request.params.id);
			if (!saved) throw new ScenarioNotFoundError("Scenario not found");
			return saved;
		},
	);
	app.post<{ Body: { document: unknown } }>(
		"/api/scenarios",
		{
			onRequest,
			bodyLimit: scenarioRequestBodyLimit,
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["document"],
					properties: { document: {} },
				},
			},
		},
		async (request, reply) => {
			const saved = await createScenario(
				pool,
				validateInput(request.body.document),
			);
			return reply.code(201).send(saved);
		},
	);
	app.put<{
		Params: { id: string };
		Body: { revision: number; document: unknown };
	}>(
		"/api/scenarios/:id",
		{
			onRequest,
			bodyLimit: scenarioRequestBodyLimit,
			schema: {
				params: scenarioParams,
				body: {
					type: "object",
					additionalProperties: false,
					required: ["revision", "document"],
					properties: {
						revision: { type: "integer", minimum: 1, maximum: 2147483647 },
						document: {},
					},
				},
			},
		},
		async (request) =>
			updateScenario(
				pool,
				request.params.id,
				request.body.revision,
				validateInput(request.body.document),
			),
	);
	app.post<{ Params: { id: string } }>(
		"/api/scenarios/:id/duplicate",
		{
			onRequest,
			schema: {
				params: scenarioParams,
				body: { type: "object", additionalProperties: false, maxProperties: 0 },
			},
		},
		async (request, reply) => {
			const source = await getScenario(pool, request.params.id);
			if (!source) throw new ScenarioNotFoundError("Scenario not found");
			let name = source.document.name;
			while (name.length > 195) name = Array.from(name).slice(0, -1).join("");
			const copy = { ...source.document, name: `${name.trimEnd()} copy` };
			// Duplication must still work for a document already at the byte limit.
			if (
				new TextEncoder().encode(JSON.stringify(copy)).byteLength >
				MAX_BODY_BYTES
			)
				copy.name = source.document.name;
			const document = validateInput(copy);
			return reply.code(201).send(await createScenario(pool, document));
		},
	);
}
