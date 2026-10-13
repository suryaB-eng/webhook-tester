import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { get as httpGet } from "node:http";
import test from "node:test";
import type { RunEvent, RunEventPayload } from "@webhook-tester/contracts";
import {
	appendRunEvent,
	createPool,
	getRun,
	getRunEventPage,
	runMigrations,
	seedScenarios,
	withTransaction,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { buildApp } from "./app.js";

function decodeStream(text: string): RunEvent[] {
	return text
		.split("\n\n")
		.filter((frame) => frame.includes("data: "))
		.map((frame) => {
			assert.ok(!frame.includes("event:"));
			const event = JSON.parse(
				frame
					.split("\n")
					.find((line) => line.startsWith("data: "))
					?.slice(6) ?? "",
			) as RunEvent;
			assert.ok(frame.includes(`id: ${event.cursor}`));
			return event;
		});
}

test("event streams replay persisted pages and close cleanly", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const pool = createPool(urls.app);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = new URL(urls.app).pathname;
	const admin = createPool(adminUrl.toString());
	const app = buildApp({
		appPool: pool,
		logger: false,
		eventStream: { pollIntervalMs: 20, heartbeatIntervalMs: 40, batchSize: 50 },
	});
	const ids: string[] = [];
	t.after(async () => {
		await app.close();
		for (const id of ids)
			await admin.query("DELETE FROM runs WHERE id=$1", [id]);
		await Promise.all([pool.end(), admin.end()]);
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	await seedScenarios(pool);
	// No jobs: these runs cannot be claimed or interrupted by worker tests on the same server.
	const makeRun = async () => {
		const id = randomUUID();
		ids.push(id);
		await admin.query(
			`INSERT INTO runs(id,status,phase,scenario_snapshot,target_snapshot)
      SELECT $1,'queued','queued',definition,'{"id":"demo-flawed","name":"Demo"}'::jsonb FROM scenarios WHERE id='one-payment'`,
			[id],
		);
		await withTransaction(pool, (client) =>
			appendRunEvent(client, id, "run.queued", {
				status: "queued",
				phase: "queued",
			}),
		);
		return id;
	};
	const finish = async (id: string) =>
		withTransaction(pool, async (client) => {
			await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [id]);
			await client.query(
				"UPDATE runs SET status='passed',phase='completed',completed_at=now() WHERE id=$1",
				[id],
			);
			await appendRunEvent(client, id, "run.completed", {
				status: "passed",
				phase: "completed",
			});
		});
	const jsonEvents = async (id: string, after = "0") =>
		(await (
			await fetch(`${address}/api/runs/${id}/events?after=${after}`)
		).json()) as RunEvent[];
	const stream = async (
		id: string,
		after = "0",
		headers: Record<string, string> = {},
	) => {
		const response = await fetch(
			`${address}/api/runs/${id}/events?after=${after}`,
			{
				headers: { Accept: "text/event-stream", ...headers },
				signal: AbortSignal.timeout(5000),
			},
		);
		assert.equal(response.status, 200);
		assert.match(
			response.headers.get("content-type") ?? "",
			/^text\/event-stream/,
		);
		return decodeStream(await response.text());
	};
	await t.test(
		"JSON rejects noncanonical/out-of-range explicit cursors and missing runs return 404",
		async () => {
			const id = await makeRun();
			for (const after of [
				"",
				"01",
				"-1",
				"+1",
				"1.0",
				"1e2",
				" 1",
				"9223372036854775808",
				"9".repeat(200),
			]) {
				assert.equal(
					(
						await fetch(
							`${address}/api/runs/${id}/events?after=${encodeURIComponent(after)}`,
						)
					).status,
					400,
					after,
				);
			}
			assert.deepEqual(await jsonEvents(id, "9223372036854775807"), []);
			for (const accept of ["application/json", "text/event-stream"]) {
				assert.equal(
					(
						await fetch(`${address}/api/runs/${randomUUID()}/events`, {
							headers: { Accept: accept },
						})
					).status,
					404,
				);
			}
		},
	);
	await t.test(
		"SSE replays same saved events as JSON and resumes from the greater explicit/header cursor",
		async () => {
			const id = await makeRun();
			await withTransaction(pool, (client) =>
				appendRunEvent(client, id, "run.phase", { phase: "asserting" }),
			);
			await finish(id);
			const events = await jsonEvents(id);
			assert.equal(events.length, 3);
			assert.deepEqual(await stream(id), events);
			assert.deepEqual(
				await stream(id, events[0]?.cursor, {
					"Last-Event-ID": events[1]?.cursor ?? "0",
				}),
				[events[2]],
			);
			assert.deepEqual(
				await stream(id, events[1]?.cursor, {
					"Last-Event-ID": events[0]?.cursor ?? "0",
				}),
				[events[2]],
			);
			for (const value of ["bad", "01", "-1", "9223372036854775808"]) {
				assert.deepEqual(
					await stream(id, events[1]?.cursor, { "Last-Event-ID": value }),
					[events[2]],
				);
			}
			const unacceptable = await fetch(`${address}/api/runs/${id}/events`, {
				headers: { Accept: "text/event-stream;q=0, application/json" },
			});
			assert.match(
				unacceptable.headers.get("content-type") ?? "",
				/^application\/json/,
			);
		},
	);
	await t.test(
		"late completed subscription drains every page and refresh retains its event history",
		async () => {
			const id = await makeRun();
			await withTransaction(pool, async (client) => {
				for (let i = 0; i < 251; i++)
					await appendRunEvent(client, id, "run.phase", { phase: `step-${i}` });
			});
			await finish(id);
			const events = await jsonEvents(id);
			assert.equal(events.length, 253);
			for (let i = 1; i < events.length; i++) {
				assert.ok(
					BigInt(events[i - 1]?.cursor ?? "0") <
						BigInt(events[i]?.cursor ?? "0"),
					"JSON event cursors must increase numerically",
				);
			}
			assert.deepEqual(await stream(id), events);
			const response = (await (
				await fetch(`${address}/api/runs/${id}`)
			).json()) as { eventCursor: string; events: RunEvent[]; status: string };
			assert.equal(response.status, "passed");
			assert.equal(response.eventCursor, events.at(-1)?.cursor);
			assert.deepEqual(response.events, events);
			assert.deepEqual(await stream(id, response.eventCursor), []);
		},
	);
	await t.test(
		"JSON, snapshot and paginated SSE sort cursors numerically across decimal digit boundaries",
		async () => {
			const id = await makeRun();
			const initial = (await jsonEvents(id))[0];
			assert.ok(initial);
			// Explicit identity overrides affect only this run's fixtures, never the global sequence.
			const cursors = [
				...Array.from({ length: 30 }, (_, index) =>
					(999999999999999970n + BigInt(index)).toString(),
				),
				...Array.from({ length: 30 }, (_, index) =>
					(1000000000000000000n + BigInt(index)).toString(),
				),
			];
			await withTransaction(admin, async (client) => {
				await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [id]);
				await client.query(
					`INSERT INTO run_events(cursor,run_id,type,payload) OVERRIDING SYSTEM VALUE
        SELECT cursor,$1,CASE WHEN cursor=$3::bigint THEN 'run.completed' ELSE 'run.phase' END,
          CASE WHEN cursor=$3::bigint THEN '{"status":"passed","phase":"completed"}'::jsonb
          ELSE jsonb_build_object('phase','boundary-' || cursor::text) END
        FROM unnest($2::bigint[]) AS fixtures(cursor)`,
					[id, cursors, cursors.at(-1)],
				);
				await client.query(
					"UPDATE runs SET status='passed',phase='completed',completed_at=now() WHERE id=$1",
					[id],
				);
			});
			const expected = [initial.cursor, ...cursors];
			const events = await jsonEvents(id);
			for (let i = 1; i < events.length; i++) {
				assert.ok(
					BigInt(events[i - 1]?.cursor ?? "0") <
						BigInt(events[i]?.cursor ?? "0"),
					"JSON event cursors must increase numerically",
				);
			}
			assert.deepEqual(
				events.map((event) => event.cursor),
				expected,
			);
			assert.deepEqual(
				(await stream(id)).map((event) => event.cursor),
				expected,
			);
			const snapshot = await getRun(pool, id);
			assert.deepEqual(
				snapshot?.events.map((event) => event.cursor),
				expected,
			);
			assert.equal(snapshot?.eventCursor, "1000000000000000029");
		},
	);
	await t.test(
		"results and events roll back together, uncommitted events stay hidden, payload fields are allowlisted",
		async () => {
			const id = await makeRun();
			const before = await getRun(pool, id);
			await assert.rejects(
				withTransaction(pool, async (client) => {
					await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [
						id,
					]);
					await client.query("UPDATE runs SET phase='asserting' WHERE id=$1", [
						id,
					]);
					await appendRunEvent(client, id, "run.phase", { phase: "asserting" });
					throw new Error("rollback");
				}),
			);
			assert.deepEqual(await getRun(pool, id), before);
			const client = await pool.connect();
			try {
				await client.query("BEGIN");
				await client.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [id]);
				await client.query("UPDATE runs SET phase='asserting' WHERE id=$1", [
					id,
				]);
				await appendRunEvent(client, id, "run.phase", {
					phase: "asserting",
					error: "secret",
					endpoint: "https://private.invalid",
					actual: 1,
				} as RunEventPayload);
				assert.deepEqual(await getRun(pool, id), before);
				assert.deepEqual(
					(await getRunEventPage(pool, id, "0"))?.events,
					before?.events,
				);
				await client.query("COMMIT");
				const after = await getRun(pool, id);
				assert.equal(after?.phase, "asserting");
				assert.deepEqual(after?.events.at(-1)?.payload, {
					phase: "asserting",
					actual: 1,
				});
			} finally {
				await client.query("ROLLBACK");
				client.release();
			}
		},
	);
	await t.test(
		"concurrent writers allocate cursors after run lock so a paused transaction cannot be skipped",
		async () => {
			const id = await makeRun();
			const first = await pool.connect();
			const second = await pool.connect();
			try {
				await first.query("BEGIN");
				await second.query("BEGIN");
				const firstPid = (
					await first.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
				).rows[0]?.pid;
				const secondPid = (
					await second.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
				).rows[0]?.pid;
				await first.query("SELECT id FROM runs WHERE id=$1 FOR UPDATE", [id]);
				const sequenceBefore = (
					await admin.query(
						"SELECT last_value::text FROM run_events_cursor_seq",
					)
				).rows[0]?.last_value;
				let committed = false;
				const pending = appendRunEvent(second, id, "run.phase", {
					phase: "second",
				}).then(async () => {
					await second.query("COMMIT");
					committed = true;
				});
				let blockers: number[] = [];
				for (let i = 0; i < 50 && !blockers.includes(firstPid ?? 0); i++) {
					blockers =
						(
							await admin.query<{ blockers: number[] }>(
								"SELECT pg_blocking_pids($1) AS blockers",
								[secondPid],
							)
						).rows[0]?.blockers ?? [];
					if (!blockers.includes(firstPid ?? 0))
						await new Promise((resolve) => setTimeout(resolve, 10));
				}
				assert.ok(
					blockers.includes(firstPid ?? 0),
					"second append must wait on the first run row lock",
				);
				assert.equal(committed, false);
				assert.equal(
					(
						await admin.query(
							"SELECT last_value::text FROM run_events_cursor_seq",
						)
					).rows[0]?.last_value,
					sequenceBefore,
				);
				assert.equal((await jsonEvents(id)).length, 1);
				await appendRunEvent(first, id, "run.phase", { phase: "first" });
				await first.query("COMMIT");
				await pending;
				const events = await jsonEvents(id);
				assert.deepEqual(
					events.map((event) => event.payload.phase),
					["queued", "first", "second"],
				);
				assert.ok(
					BigInt(events[1]?.cursor ?? "0") < BigInt(events[2]?.cursor ?? "0"),
				);
			} finally {
				await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
				first.release();
				second.release();
			}
		},
	);
	await t.test(
		"terminated event and refresh readers reject safely and return healthy sessions to the pool",
		async () => {
			const id = await makeRun();
			for (const reader of [
				(faultPool: typeof pool) => getRunEventPage(faultPool, id, "0"),
				(faultPool: typeof pool) => getRun(faultPool, id),
			]) {
				const faultUrl = new URL(urls.app);
				const name = `event-reader-${randomUUID()}`;
				faultUrl.searchParams.set("application_name", name);
				const faultPool = createPool(faultUrl.toString());
				const locker = await admin.connect();
				try {
					await locker.query("BEGIN");
					await locker.query("LOCK TABLE runs IN ACCESS EXCLUSIVE MODE");
					const pending = reader(faultPool);
					const rejecting = assert.rejects(
						pending,
						/terminating connection|Connection terminated/,
					);
					let pid: number | undefined;
					for (let i = 0; i < 50 && pid === undefined; i++) {
						pid = (
							await admin.query<{ pid: number }>(
								"SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
								[name],
							)
						).rows[0]?.pid;
						if (pid === undefined)
							await new Promise((resolve) => setTimeout(resolve, 10));
					}
					assert.ok(
						pid,
						"reader must be blocked before terminating its backend",
					);
					await admin.query("SELECT pg_terminate_backend($1)", [pid]);
					await rejecting;
					await locker.query("ROLLBACK");
					assert.equal(
						(await getRunEventPage(faultPool, id, "0"))?.events.length,
						1,
					);
				} finally {
					await locker.query("ROLLBACK");
					locker.release();
					await faultPool.end();
				}
			}
		},
	);
	await t.test(
		"idle heartbeats contain comments and a completion committed after subscription is delivered",
		async () => {
			const id = await makeRun();
			const events = await jsonEvents(id);
			const response = await fetch(
				`${address}/api/runs/${id}/events?after=${events[0]?.cursor}`,
				{
					headers: { Accept: "text/event-stream" },
					signal: AbortSignal.timeout(5000),
				},
			);
			assert.match(
				response.headers.get("content-type") ?? "",
				/^text\/event-stream/,
			);
			assert.ok(response.body);
			const reader = response.body.getReader();
			let text = "";
			while (!text.includes(": heartbeat")) {
				const chunk = await reader.read();
				assert.equal(chunk.done, false);
				text += new TextDecoder().decode(chunk.value);
			}
			assert.deepEqual(decodeStream(text), []);
			await finish(id);
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += new TextDecoder().decode(chunk.value);
			}
			assert.deepEqual(decodeStream(text), (await jsonEvents(id)).slice(1));
		},
	);
	await t.test(
		"completion committed between snapshot status and event reads is delivered on the next page",
		async () => {
			const id = await makeRun();
			const initial = await jsonEvents(id);
			const connect = pool.connect.bind(pool);
			let intercepted = false;
			let release!: () => void;
			let entered!: () => void;
			const entering = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			pool.connect = (async () => {
				const client = await connect();
				if (!intercepted) {
					intercepted = true;
					const query = client.query.bind(client);
					const releaseClient = client.release;
					client.query = (async (text: string, values?: unknown[]) => {
						const result = await query(text, values);
						if (text === "SELECT status FROM runs WHERE id=$1") {
							entered();
							await gate;
						}
						return result;
					}) as typeof client.query;
					client.release = (error) => {
						client.query = query;
						client.release = releaseClient;
						releaseClient(error);
					};
				}
				return client;
			}) as typeof pool.connect;
			try {
				const response = stream(id, initial[0]?.cursor);
				await entering;
				await finish(id);
				release();
				assert.deepEqual(await response, (await jsonEvents(id)).slice(1));
			} finally {
				release();
				pool.connect = connect;
			}
		},
	);
	await t.test(
		"disconnect during initial database acquisition leaves no polling stream",
		async () => {
			const id = await makeRun();
			const connect = pool.connect.bind(pool);
			let acquired = 0;
			let release!: () => void;
			let entered!: () => void;
			const entering = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			pool.connect = (async () => {
				acquired++;
				entered();
				await gate;
				return connect();
			}) as typeof pool.connect;
			try {
				const request = httpGet(`${address}/api/runs/${id}/events`, {
					headers: { Accept: "text/event-stream" },
				});
				request.on("error", () => {});
				const closed = new Promise<void>((resolve) =>
					request.once("close", resolve),
				);
				await entering;
				request.destroy();
				await closed;
				await new Promise((resolve) => setTimeout(resolve, 50));
				release();
				await new Promise((resolve) => setTimeout(resolve, 150));
				assert.equal(
					acquired,
					1,
					"disconnected requests must not start another database page",
				);
			} finally {
				release();
				pool.connect = connect;
			}
		},
	);
	await t.test(
		"disconnect and app shutdown stop idle stream work promptly",
		async () => {
			const id = await makeRun();
			const abort = new AbortController();
			const response = await fetch(`${address}/api/runs/${id}/events`, {
				headers: { Accept: "text/event-stream" },
				signal: abort.signal,
			});
			assert.match(
				response.headers.get("content-type") ?? "",
				/^text\/event-stream/,
			);
			abort.abort();
			const second = await fetch(`${address}/api/runs/${id}/events`, {
				headers: { Accept: "text/event-stream" },
			});
			const closing = app.close();
			await Promise.race([
				second.text(),
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("shutdown stalled on SSE")), 1000),
				),
			]);
			await closing;
		},
	);
});
