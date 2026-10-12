import { performance } from "node:perf_hooks";
import type { PoolClient, QueryResult, QueryResultRow } from "pg";

export interface ApplicationSession {
	query<R extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: unknown[],
	): Promise<QueryResult<R>>;
}
export function budgetSession(
	client: PoolClient,
	deadline: () => number,
): ApplicationSession {
	return {
		async query<R extends QueryResultRow = QueryResultRow>(
			text: string,
			values?: unknown[],
		): Promise<QueryResult<R>> {
			// Rollback must remain available after a deadline so the owning session stays usable.
			if (text !== "ROLLBACK") {
				const remaining = Math.floor(deadline() - performance.now());
				if (remaining <= 0)
					throw new Error(
						"Overall run timeout during application database work",
					);
				await client.query("SELECT set_config('statement_timeout',$1,false)", [
					String(Math.max(1, Math.min(2000, remaining))),
				]);
			}
			return client.query<R>(text, values);
		},
	};
}
