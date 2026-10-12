import { demoEventSchema, MAX_BODY_BYTES } from "@webhook-tester/contracts";
import Fastify, { type FastifyError } from "fastify";
import type { Pool } from "pg";
import {
	FixtureStateError,
	processCorrectedPayment,
	processFlawedPayment,
} from "./payments.js";
import { processCorrectedStatus, processFlawedStatus } from "./statuses.js";

const runIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildDemoTarget(
	pool: Pool,
	options: { logger?: boolean } = {},
) {
	const app = Fastify({
		logger: options.logger ?? false,
		bodyLimit: MAX_BODY_BYTES,
	});
	app.setErrorHandler((error: FastifyError, request, reply) => {
		if (error instanceof FixtureStateError) {
			return reply.code(409).send({ error: error.message });
		}
		if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
			return reply.code(error.statusCode).send({ error: error.message });
		}
		request.log.error(error);
		return reply.code(500).send({ error: "Target processing failed" });
	});
	app.get("/health", async () => {
		await pool.query("SELECT 1");
		return { status: "ok" };
	});

	for (const profile of ["flawed", "corrected"] as const) {
		app.post(`/webhooks/${profile}`, async (request, reply) => {
			const runId = request.headers["x-webhook-lab-run-id"];
			if (typeof runId !== "string" || !runIdPattern.test(runId)) {
				return reply
					.code(400)
					.send({ error: "X-Webhook-Lab-Run-Id must be a UUID" });
			}
			const parsed = demoEventSchema.safeParse(request.body);
			if (!parsed.success) {
				return reply.code(400).send({
					error: "Invalid demo event payload",
					issues: parsed.error.issues.map((issue) => ({
						path: issue.path,
						message: issue.message,
					})),
				});
			}
			if (parsed.data.type === "payment.succeeded") {
				if (profile === "flawed")
					await processFlawedPayment(pool, runId, parsed.data);
				else await processCorrectedPayment(pool, runId, parsed.data);
			} else {
				if (profile === "flawed")
					await processFlawedStatus(pool, runId, parsed.data);
				else await processCorrectedStatus(pool, runId, parsed.data);
			}
			return { received: true, businessEventId: parsed.data.id };
		});
	}
	return app;
}
