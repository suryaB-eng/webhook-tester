import { listScenarios } from "@webhook-tester/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

export function registerScenarioRoutes(app: FastifyInstance, pool: Pool): void {
	app.get("/api/scenarios", async () => listScenarios(pool));
}
