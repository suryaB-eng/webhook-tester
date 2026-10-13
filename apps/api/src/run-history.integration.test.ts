import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { RunResponse, SavedScenario } from "@webhook-tester/contracts";
import { createPool, runMigrations, seedScenarios } from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { buildApp } from "./app.js";

test("history pagination and frozen snapshot reruns through real HTTP", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const appPool = createPool(urls.app);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = new URL(urls.app).pathname;
	const admin = createPool(adminUrl.toString());
	const targets = new Map([
		[
			"demo-flawed",
			{
				id: "demo-flawed",
				name: "Flawed",
				endpoint: "http://secret.test",
				credential: "private-key",
			},
		],
		[
			"demo-corrected",
			{
				id: "demo-corrected",
				name: "Current corrected",
				endpoint: "http://fresh-secret.test",
				credential: "new-private-key",
			},
		],
	]);
	const api = buildApp({ appPool, targets, logger: false });
	const runIds: string[] = [];
	let scenarioId: string | undefined;
	t.after(async () => {
		await api.close();
		try {
			await admin.query(
				"DROP TRIGGER IF EXISTS reject_history_rerun ON run_events",
			);
			await admin.query("DROP FUNCTION IF EXISTS reject_history_rerun_event()");
			await admin.query("DELETE FROM runs WHERE id=ANY($1::uuid[])", [runIds]);
			if (scenarioId)
				await admin.query("DELETE FROM scenarios WHERE id=$1", [scenarioId]);
		} finally {
			await Promise.all([appPool.end(), admin.end()]);
		}
	});
	await seedScenarios(appPool);
	const base = await api.listen({ host: "127.0.0.1", port: 0 });
	const headers = {
		Origin: "http://127.0.0.1:4173",
		"Content-Type": "application/json",
	};
	const mutate = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
	const source = (await (
		await fetch(`${base}/api/scenarios/one-payment`)
	).json()) as SavedScenario;
	const created = await mutate("/api/scenarios", {
		document: {
			...source.document,
			name: "Frozen run",
			description: "secret-payload-marker",
		},
	});
	assert.equal(created.status, 201);
	const saved = (await created.json()) as SavedScenario;
	scenarioId = saved.id;
	const launched = await mutate("/api/runs", { scenarioId });
	assert.equal(launched.status, 202);
	const sourceId = ((await launched.json()) as { runId: string }).runId;
	runIds.push(sourceId);
	const original = (await (
		await fetch(`${base}/api/runs/${sourceId}`)
	).json()) as RunResponse;

	await t.test(
		"bounded history pages preserve timestamp ties and submillisecond order without payloads",
		async () => {
			const ids = [
				"ffffffff-ffff-ffff-ffff-fffffffffff1",
				"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1",
				"dddddddd-dddd-dddd-dddd-ddddddddddd1",
				"cccccccc-cccc-cccc-cccc-ccccccccccc1",
			];
			for (const [index, id] of ids.entries()) {
				runIds.push(id);
				await admin.query(
					"INSERT INTO runs(id,status,phase,scenario_snapshot,target_snapshot,created_at) VALUES($1,'failed','completed',$2::jsonb,$3::jsonb,$4::timestamptz)",
					[
						id,
						JSON.stringify(saved.document),
						JSON.stringify(targets.get("demo-flawed")),
						index < 2
							? "2099-01-01T00:00:00.123999Z"
							: index === 2
								? "2099-01-01T00:00:00.123998Z"
								: "2099-01-01T00:00:00.123001Z",
					],
				);
			}
			for (let index = 0; index < 51; index++) {
				const id = randomUUID();
				runIds.push(id);
				await admin.query(
					"INSERT INTO runs(id,status,phase,scenario_snapshot,target_snapshot,created_at) VALUES($1,'failed','completed',$2::jsonb,$3::jsonb,'2000-01-01T00:00:00Z')",
					[
						id,
						JSON.stringify(saved.document),
						JSON.stringify(targets.get("demo-flawed")),
					],
				);
			}
			const firstResponse = await fetch(`${base}/api/runs?limit=1`);
			assert.equal(firstResponse.status, 200);
			const first = (await firstResponse.json()) as {
				runs: {
					id: string;
					targetSnapshot: unknown;
					sourceRunId: string | null;
					targetOverride: string | null;
				}[];
				nextCursor: string | null;
			};
			assert.deepEqual(
				first.runs.map((run) => run.id),
				[ids[0]],
			);
			assert.ok(first.nextCursor);
			assert.equal(first.runs[0]?.sourceRunId, null);
			assert.equal(first.runs[0]?.targetOverride, null);
			assert.deepEqual(first.runs[0]?.targetSnapshot, {
				id: "demo-flawed",
				name: "Flawed",
			});
			assert.doesNotMatch(
				JSON.stringify(first),
				/secret-payload-marker|private-key|endpoint|scenarioSnapshot|requestPayload|assertions|deliveries/,
			);
			let cursor = first.nextCursor;
			const seen = [ids[0]];
			for (let index = 0; index < 3; index++) {
				const response = await fetch(
					`${base}/api/runs?limit=1&before=${encodeURIComponent(cursor)}`,
				);
				assert.equal(response.status, 200);
				const page = (await response.json()) as {
					runs: { id: string }[];
					nextCursor: string | null;
				};
				seen.push(page.runs[0]?.id);
				assert.ok(page.nextCursor);
				cursor = page.nextCursor;
			}
			assert.deepEqual(seen, ids);
			const bounded = (await (
				await fetch(
					`${base}/api/runs?limit=50&before=${encodeURIComponent(cursor)}`,
				)
			).json()) as { runs: unknown[]; nextCursor: string | null };
			assert.equal(bounded.runs.length, 50);
			assert.ok(bounded.nextCursor);
			const final = (await (
				await fetch(
					`${base}/api/runs?limit=50&before=${encodeURIComponent(bounded.nextCursor)}`,
				)
			).json()) as { runs: unknown[]; nextCursor: string | null };
			assert.equal(final.nextCursor, null);
			const defaults = (await (await fetch(`${base}/api/runs`)).json()) as {
				runs: unknown[];
			};
			assert.equal(defaults.runs.length, 20);
			for (const query of [
				"limit=0",
				"limit=51",
				"limit=-1",
				"limit=1.5",
				"limit=abc",
				"before=garbage",
				"before=",
				"limit=1&limit=2",
				"unexpected=1",
			]) {
				assert.equal(
					(await fetch(`${base}/api/runs?${query}`)).status,
					400,
					query,
				);
			}
		},
	);

	await t.test(
		"opaque cursor validation rejects malformed database timestamps before issuing a query",
		async () => {
			for (const value of [
				[1, "0000-01-01T00:00:00.000000Z", sourceId],
				[1, "2099-02-30T00:00:00.000000Z", sourceId],
				[1, "2099-01-01T24:00:00.000000Z", sourceId],
				[1, "2099-01-01T00:00:00.000000Z", "not-a-uuid"],
				[2, "2099-01-01T00:00:00.000000Z", sourceId],
				{ timestamp: "2099-01-01T00:00:00.000000Z", id: sourceId },
			]) {
				const before = Buffer.from(JSON.stringify(value)).toString("base64url");
				assert.equal(
					(await fetch(`${base}/api/runs?before=${before}`)).status,
					400,
					JSON.stringify(value),
				);
			}
		},
	);

	await t.test(
		"only terminal sources can rerun and target/mutation validation creates nothing",
		async () => {
			for (const status of ["queued", "running"]) {
				await admin.query("UPDATE runs SET status=$2 WHERE id=$1", [
					sourceId,
					status,
				]);
				assert.equal(
					(
						await mutate(`/api/runs/${sourceId}/rerun`, {
							targetId: "demo-corrected",
						})
					).status,
					409,
				);
			}
			await admin.query("UPDATE runs SET status='failed' WHERE id=$1", [
				sourceId,
			]);
			assert.equal(
				(
					await mutate(`/api/runs/${randomUUID()}/rerun`, {
						targetId: "demo-corrected",
					})
				).status,
				404,
			);
			for (const body of [
				{},
				{ targetId: "unknown" },
				{ targetId: "demo-corrected", endpoint: "http://evil.test" },
				{ targetId: 3 },
			]) {
				assert.equal(
					(await mutate(`/api/runs/${sourceId}/rerun`, body)).status,
					400,
				);
			}
			assert.equal(
				(
					await fetch(`${base}/api/runs/${sourceId}/rerun`, {
						method: "POST",
						headers: { ...headers, Origin: "http://evil.test" },
						body: '{"targetId":"demo-corrected"}',
					})
				).status,
				403,
			);
			assert.equal(
				(
					await fetch(`${base}/api/runs/${sourceId}/rerun`, {
						method: "POST",
						headers: { Origin: headers.Origin, "Content-Type": "text/plain" },
						body: "{}",
					})
				).status,
				415,
			);
			const children = await admin.query(
				"SELECT id FROM runs WHERE source_run_id=$1",
				[sourceId],
			);
			assert.equal(children.rowCount, 0);
		},
	);

	await t.test(
		"terminal reruns copy frozen evidence and only replace the target with current public configuration",
		async () => {
			const edit = await fetch(`${base}/api/scenarios/${scenarioId}`, {
				method: "PUT",
				headers,
				body: JSON.stringify({
					revision: saved.revision,
					document: {
						...saved.document,
						name: "Later editor change",
						events: saved.document.events.map((event) => ({
							...event,
							payload: {
								id: "changed",
								type: "payment.succeeded",
								data: { orderId: "changed-order", quantity: 2 },
							},
						})),
					},
				}),
			});
			assert.equal(edit.status, 200);
			for (const status of ["passed", "failed", "error", "interrupted"]) {
				await admin.query("UPDATE runs SET status=$2 WHERE id=$1", [
					sourceId,
					status,
				]);
				const response = await mutate(`/api/runs/${sourceId}/rerun`, {
					targetId: "demo-corrected",
				});
				assert.equal(response.status, 202);
				const id = ((await response.json()) as { runId: string }).runId;
				runIds.push(id);
				assert.notEqual(id, sourceId);
				const run = (await (
					await fetch(`${base}/api/runs/${id}`)
				).json()) as RunResponse & {
					sourceRunId: string;
					targetOverride: string;
				};
				assert.equal(run.sourceRunId, sourceId);
				assert.equal(run.targetOverride, "demo-corrected");
				assert.deepEqual(run.scenarioSnapshot, {
					...original.scenarioSnapshot,
					targetId: "demo-corrected",
				});
				assert.deepEqual(run.targetSnapshot, {
					id: "demo-corrected",
					name: "Current corrected",
				});
				assert.equal(run.status, "queued");
				assert.equal(run.startedAt, null);
				assert.equal(run.completedAt, null);
				assert.equal(run.deliveries.length, 1);
				assert.deepEqual(
					run.deliveries[0]?.requestPayload,
					original.deliveries[0]?.requestPayload,
				);
				assert.equal(run.deliveries[0]?.outcome, "pending");
				assert.equal(run.assertions.length, 2);
				assert.ok(
					run.assertions.every((assertion) => assertion.status === "pending"),
				);
				assert.deepEqual(
					run.events.map((event) => event.type),
					["run.queued"],
				);
				const jobs = await admin.query(
					"SELECT status FROM jobs WHERE run_id=$1",
					[id],
				);
				assert.equal(jobs.rows[0]?.status, "queued");
				const history = (await (
					await fetch(`${base}/api/runs?limit=50`)
				).json()) as {
					runs: { id: string; sourceRunId: string; targetOverride: string }[];
				};
				assert.equal(
					history.runs.find((item) => item.id === id)?.sourceRunId,
					sourceId,
				);
				assert.equal(
					history.runs.find((item) => item.id === id)?.targetOverride,
					"demo-corrected",
				);
			}
			const sourceAfter = (await (
				await fetch(`${base}/api/runs/${sourceId}`)
			).json()) as RunResponse;
			assert.deepEqual(sourceAfter.scenarioSnapshot, original.scenarioSnapshot);
			assert.deepEqual(sourceAfter.targetSnapshot, original.targetSnapshot);
			assert.equal(
				(sourceAfter as RunResponse & { sourceRunId: null }).sourceRunId,
				null,
			);
		},
	);

	await t.test(
		"a queued event insertion failure rolls back lineage, job and planned evidence",
		async () => {
			const before = await admin.query(
				"SELECT count(*)::int AS count FROM runs WHERE source_run_id=$1",
				[sourceId],
			);
			await admin.query(
				"CREATE FUNCTION reject_history_rerun_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM runs WHERE id=NEW.run_id AND source_run_id IS NOT NULL) THEN RAISE EXCEPTION 'controlled queued event failure'; END IF; RETURN NEW; END $$",
			);
			await admin.query(
				"CREATE TRIGGER reject_history_rerun BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_history_rerun_event()",
			);
			assert.equal(
				(
					await mutate(`/api/runs/${sourceId}/rerun`, {
						targetId: "demo-corrected",
					})
				).status,
				500,
			);
			await admin.query("DROP TRIGGER reject_history_rerun ON run_events");
			await admin.query("DROP FUNCTION reject_history_rerun_event()");
			const after = await admin.query(
				"SELECT count(*)::int AS count FROM runs WHERE source_run_id=$1",
				[sourceId],
			);
			assert.equal(after.rows[0]?.count, before.rows[0]?.count);
		},
	);

	await t.test(
		"the application role cannot rewrite lineage or frozen snapshots",
		async () => {
			for (const assignment of [
				"source_run_id=NULL",
				"target_override=NULL",
				"scenario_snapshot='{}'::jsonb",
				"target_snapshot='{}'::jsonb",
			]) {
				await assert.rejects(
					appPool.query(`UPDATE runs SET ${assignment} WHERE id=$1`, [
						sourceId,
					]),
					/permission denied/,
				);
			}
		},
	);
});
