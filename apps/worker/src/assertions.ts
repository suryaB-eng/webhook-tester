import { performance } from "node:perf_hooks";
import type {
	AssertionResult,
	JsonScalar,
	ScenarioV1,
} from "@webhook-tester/contracts";
import { connectWithTimeout } from "@webhook-tester/db";
import type { Pool, PoolClient } from "pg";

function isScalar(value: unknown): value is JsonScalar {
	return (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	);
}
export async function executeAssertion(
	pool: Pool,
	runId: string,
	assertion: ScenarioV1["assertions"][number],
	remainingMs: number,
): Promise<Pick<AssertionResult, "actual" | "status" | "error">> {
	const deadline = performance.now() + remainingMs;
	let client: PoolClient | undefined;
	let began = false;
	let discard = false;
	try {
		client = await connectWithTimeout(pool, deadline - performance.now());
		const remaining = Math.floor(deadline - performance.now());
		if (remaining <= 0)
			throw new Error("Overall run timeout before assertion query");
		await client.query("BEGIN READ ONLY");
		began = true;
		await client.query("SELECT set_config('statement_timeout', $1, true)", [
			String(
				Math.max(1, Math.min(2000, Math.floor(deadline - performance.now()))),
			),
		]);
		const result = await client.query({
			text: assertion.query,
			values: [runId],
			rowMode: "array",
		});
		if (
			result.rowCount !== 1 ||
			result.fields.length !== 1 ||
			result.fields[0]?.name !== "value"
		) {
			throw new Error(
				"Assertion must return one row and one column named value",
			);
		}
		const row: unknown[] | undefined = result.rows[0];
		const actual = row?.[0];
		if (row?.length !== 1 || !isScalar(actual))
			throw new Error("Assertion value must be a JSON scalar");
		await client.query("COMMIT");
		return {
			actual,
			status: actual === assertion.expected ? "passed" : "failed",
			error: null,
		};
	} catch (error) {
		try {
			if (began) await client?.query("ROLLBACK");
		} catch {
			discard = true;
		}
		const detail = error instanceof Error ? error.message : "Query failed";
		return {
			actual: null,
			status: "error",
			error: `Assertion query error: ${detail}`,
		};
	} finally {
		client?.release(discard);
	}
}
