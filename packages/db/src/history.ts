import type {
	PublicTarget,
	RunHistoryPage,
	RunStatus,
} from "@webhook-tester/contracts";
import type { Pool } from "pg";

interface HistoryRow {
	id: string;
	status: RunStatus;
	phase: string;
	scenario_name: string;
	target_snapshot: PublicTarget;
	created_at: Date;
	created_at_exact: string;
	started_at: Date | null;
	completed_at: Date | null;
	source_run_id: string | null;
	target_override: string | null;
}

type HistoryCursor = [number, string, string];
const invalidCursor = () =>
	Object.assign(new Error("Invalid history cursor"), { statusCode: 400 });

function decodeCursor(value: string): HistoryCursor {
	if (!/^[A-Za-z0-9_-]{1,300}$/.test(value)) throw invalidCursor();
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
	} catch {
		throw invalidCursor();
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== 3 ||
		parsed[0] !== 1 ||
		typeof parsed[1] !== "string" ||
		typeof parsed[2] !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(parsed[1]) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
			parsed[2],
		) ||
		Buffer.from(JSON.stringify(parsed)).toString("base64url") !== value
	)
		throw invalidCursor();
	const date = new Date(parsed[1]);
	if (
		!Number.isFinite(date.valueOf()) ||
		date.getUTCFullYear() < 1 ||
		date.toISOString() !== `${parsed[1].slice(0, 23)}Z`
	)
		throw invalidCursor();
	return parsed as HistoryCursor;
}

export async function listRunHistory(
	pool: Pool,
	limit = 20,
	before?: string,
): Promise<RunHistoryPage> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 50)
		throw Object.assign(new Error("History limit must be between 1 and 50"), {
			statusCode: 400,
		});
	const cursor = before === undefined ? undefined : decodeCursor(before);
	const result = await pool.query<HistoryRow>(
		`SELECT id,status,phase,scenario_snapshot->>'name' AS scenario_name,target_snapshot,
       created_at,to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact,
       started_at,completed_at,source_run_id,target_override
     FROM runs
     ${cursor ? "WHERE (created_at,id) < ($2::timestamptz,$3::uuid)" : ""}
     ORDER BY created_at DESC,id DESC LIMIT $1`,
		cursor ? [limit + 1, cursor[1], cursor[2]] : [limit + 1],
	);
	const rows = result.rows.slice(0, limit);
	const last = rows.at(-1);
	return {
		runs: rows.map((row) => ({
			id: row.id,
			status: row.status,
			phase: row.phase,
			scenarioName: row.scenario_name,
			targetSnapshot: {
				id: row.target_snapshot.id,
				name: row.target_snapshot.name,
			},
			createdAt: row.created_at.toISOString(),
			startedAt: row.started_at?.toISOString() ?? null,
			completedAt: row.completed_at?.toISOString() ?? null,
			sourceRunId: row.source_run_id,
			targetOverride: row.target_override,
		})),
		nextCursor:
			result.rows.length > limit && last
				? Buffer.from(
						JSON.stringify([1, last.created_at_exact, last.id]),
					).toString("base64url")
				: null,
	};
}
