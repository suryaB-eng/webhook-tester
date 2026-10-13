import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import test from "node:test";
import type {
	PublicTarget,
	RunHistoryPage,
	RunResponse,
	SavedScenario,
} from "@webhook-tester/contracts";
import {
	cleanupDemoFixtures,
	createPool,
	prepareDemoFixtures,
	runMigrations,
	seedScenarios,
} from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import type { Pool } from "pg";
import { runWorkerOnce, type WorkerTargetProfile } from "./index.js";

type Server = {
	listen(options: { host: string; port: number }): Promise<string>;
	close(): Promise<void>;
};

function gate() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function guarded<T>(promise: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(message)), 10_000);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

test("reruns keep frozen payment evidence and independently scoped fixtures through real HTTP", {
	timeout: 90_000,
}, async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = "/webhook_tester";
	const appPool = createPool(urls.app),
		fixturePool = createPool(urls.targetFixture),
		queryPool = createPool(urls.targetQuery),
		targetPool = createPool(urls.targetApp),
		adminPool = createPool(adminUrl.toString());
	const runIds: string[] = [],
		scenarioIds: string[] = [];
	const independentRun = randomUUID();
	const origin = "http://127.0.0.1:4173";
	const demoUrl = new URL("../../demo-target/src/app.ts", import.meta.url).href;
	const apiUrl = new URL("../../api/src/app.ts", import.meta.url).href;
	const { buildDemoTarget } = (await import(demoUrl)) as {
		buildDemoTarget(pool: Pool): Server;
	};
	const { buildApp } = (await import(apiUrl)) as {
		buildApp(options: {
			appPool: Pool;
			allowedOrigin: string;
			targets: ReadonlyMap<string, PublicTarget>;
			logger: boolean;
		}): Server;
	};
	const demo = buildDemoTarget(targetPool);
	const publicTargets: ReadonlyMap<string, PublicTarget> = new Map([
		["demo-flawed", { id: "demo-flawed", name: "Without deduplication" }],
		["demo-corrected", { id: "demo-corrected", name: "With deduplication" }],
	]);
	const api = buildApp({
		appPool,
		allowedOrigin: origin,
		targets: publicTargets,
		logger: false,
	});
	const requests: { runId: string; deliveryId: string; payload: unknown }[] =
		[];
	const proxyErrors: unknown[] = [];
	const active = new Set<Promise<void>>();
	const releases: (() => void)[] = [];
	let held:
		| {
				runId: string;
				arrived: ReturnType<typeof gate>;
				release: ReturnType<typeof gate>;
		  }
		| undefined;
	let demoBase = "";
	async function forward(request: IncomingMessage, response: ServerResponse) {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const source = Buffer.concat(chunks).toString("utf8");
		const runId = String(request.headers["x-webhook-lab-run-id"]);
		requests.push({
			runId,
			deliveryId: String(request.headers["x-webhook-lab-delivery-id"]),
			payload: JSON.parse(source),
		});
		const result = await fetch(demoBase + request.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Webhook-Lab-Run-Id": runId,
			},
			body: source,
			signal: AbortSignal.timeout(5000),
		});
		const text = await result.text();
		const currentGate = held;
		if (currentGate?.runId === runId) {
			held = undefined;
			currentGate.arrived.resolve();
			await currentGate.release.promise;
		}
		response.writeHead(result.status, { "Content-Type": "application/json" });
		response.end(text);
	}
	const proxy = createServer((request, response) => {
		const pending = forward(request, response).catch((error: unknown) => {
			proxyErrors.push(error);
			if (!response.headersSent) response.writeHead(500);
			response.end("Test proxy failed");
		});
		active.add(pending);
		void pending.finally(() => active.delete(pending));
	});
	t.after(async () => {
		for (const release of releases) release();
		try {
			await guarded(Promise.all(active), "Proxy requests did not settle");
			proxy.closeAllConnections();
			await new Promise<void>((resolve) => proxy.close(() => resolve()));
			await Promise.all([api.close(), demo.close()]);
			for (const id of [...runIds, independentRun])
				await cleanupDemoFixtures(fixturePool, id);
			await adminPool.query("DELETE FROM runs WHERE id=ANY($1::uuid[])", [
				runIds,
			]);
			await adminPool.query("DELETE FROM scenarios WHERE id=ANY($1::text[])", [
				scenarioIds,
			]);
		} finally {
			await Promise.all(
				[appPool, fixturePool, queryPool, targetPool, adminPool].map((pool) =>
					pool.end(),
				),
			);
		}
	});
	demoBase = await demo.listen({ host: "127.0.0.1", port: 0 });
	const apiBase = await api.listen({ host: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve, reject) => {
		proxy.once("error", reject);
		proxy.listen(0, "127.0.0.1", resolve);
	});
	const address = proxy.address();
	assert.ok(address && typeof address !== "string");
	const proxyBase = `http://127.0.0.1:${address.port}`;
	const profiles: ReadonlyMap<string, WorkerTargetProfile> = new Map(
		[...publicTargets].map(([id, target]) => [
			id,
			{
				...target,
				endpoint: `${proxyBase}/webhooks/${id === "demo-flawed" ? "flawed" : "corrected"}`,
				completion: { kind: "synchronous" },
			},
		]),
	);
	async function mutate<T>(
		path: string,
		body: unknown,
		expectedStatus: number,
		method = "POST",
	): Promise<T> {
		const response = await fetch(apiBase + path, {
			method,
			headers: { Origin: origin, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const result: unknown = await response.json();
		assert.equal(response.status, expectedStatus, JSON.stringify(result));
		return result as T;
	}
	async function read(id: string): Promise<RunResponse> {
		const response = await fetch(`${apiBase}/api/runs/${id}`);
		assert.equal(response.status, 200);
		return response.json() as Promise<RunResponse>;
	}
	async function process(id: string) {
		assert.equal(
			await runWorkerOnce({
				appPool,
				fixturePool,
				queryPool,
				targetProfiles: profiles,
				workerId: `rerun-${randomUUID()}`,
			}),
			"processed",
		);
		return read(id);
	}
	async function rerun(source: string, targetId: string) {
		const { runId } = await mutate<{ runId: string }>(
			`/api/runs/${source}/rerun`,
			{ targetId },
			202,
		);
		runIds.push(runId);
		return runId;
	}
	await seedScenarios(appPool);
	const preset = await fetch(
		`${apiBase}/api/scenarios/sequential-duplicate-payment`,
	);
	assert.equal(preset.status, 200);
	const presetDocument = ((await preset.json()) as SavedScenario).document;
	const saved = await mutate<SavedScenario>(
		"/api/scenarios",
		{ document: presetDocument },
		201,
	);
	scenarioIds.push(saved.id);
	const { runId: sourceId } = await mutate<{ runId: string }>(
		"/api/runs",
		{ scenarioId: saved.id, targetId: "demo-flawed" },
		202,
	);
	runIds.push(sourceId);
	const source = await process(sourceId);
	assert.equal(source.status, "failed");
	assert.deepEqual(
		source.assertions.map((item) => item.actual),
		[2, 8],
	);
	assert.deepEqual(
		source.deliveries.map((item) => item.httpStatus),
		[200, 200],
	);
	assert.equal(source.sourceRunId, null);
	assert.equal(source.targetOverride, null);
	const edited = structuredClone(saved.document);
	edited.name = "Edited after the saved run";
	const event = edited.events[0];
	assert.ok(event);
	event.payload.data = { orderId: "alternate_edited_order", quantity: 2 };
	const stock = edited.assertions[1];
	assert.ok(stock);
	stock.expected = 8;
	await mutate(
		`/api/scenarios/${saved.id}`,
		{ revision: saved.revision, document: edited },
		200,
		"PUT",
	);
	const firstId = await rerun(sourceId, "demo-corrected");
	const secondId = await rerun(sourceId, "demo-corrected");
	assert.notEqual(firstId, secondId);
	for (const id of [firstId, secondId]) {
		const queued = await read(id);
		assert.equal(queued.status, "queued");
		assert.equal(queued.sourceRunId, sourceId);
		assert.equal(queued.targetOverride, "demo-corrected");
		assert.deepEqual(queued.scenarioSnapshot, {
			...source.scenarioSnapshot,
			targetId: "demo-corrected",
		});
		assert.deepEqual(queued.targetSnapshot, {
			id: "demo-corrected",
			name: "With deduplication",
		});
	}
	await prepareDemoFixtures(fixturePool, independentRun, [
		{ orderId: "independent_order", quantity: 2 },
	]);
	const independentPayment = await fetch(`${demoBase}/webhooks/corrected`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Webhook-Lab-Run-Id": independentRun,
		},
		body: JSON.stringify({
			id: "independent_payment",
			type: "payment.succeeded",
			data: { orderId: "independent_order", quantity: 2 },
		}),
	});
	assert.equal(independentPayment.status, 200);
	await independentPayment.text();
	for (const [index, id] of [firstId, secondId].entries()) {
		const arrived = gate(),
			release = gate();
		releases.push(release.resolve);
		held = { runId: id, arrived, release };
		const processing = process(id);
		try {
			await guarded(
				arrived.promise,
				"Rerun did not reach the controlled HTTP response gate",
			);
			const running = await read(id);
			assert.equal(running.status, "running");
			assert.ok(running.deliveries[0]?.startedAt);
			assert.equal(running.deliveries[0]?.completedAt, null);
			const fixtures = await queryPool.query<{
				run_id: string;
				quantity: number;
			}>(
				"SELECT run_id,quantity::int FROM inventory WHERE run_id=ANY($1::uuid[]) ORDER BY run_id",
				[[firstId, secondId, independentRun]],
			);
			assert.deepEqual(
				new Map(fixtures.rows.map((row) => [row.run_id, row.quantity])),
				new Map([
					[id, 9],
					[independentRun, 8],
				]),
			);
			if (index === 0) assert.equal((await read(secondId)).status, "queued");
			const denied = await mutate<{ error: string }>(
				`/api/runs/${id}/rerun`,
				{ targetId: "demo-corrected" },
				409,
			);
			assert.ok(denied.error);
		} finally {
			release.resolve();
		}
		const result = await processing;
		assert.equal(result.status, "passed");
		assert.deepEqual(
			result.assertions.map((item) => item.actual),
			[1, 9],
		);
		assert.deepEqual(
			result.deliveries.map((item) => item.httpStatus),
			[200, 200],
		);
		assert.deepEqual(
			await read(id),
			result,
			"refresh must read the same saved result",
		);
	}
	assert.deepEqual(
		await read(sourceId),
		source,
		"editing and rerunning must not modify the original",
	);
	assert.equal(
		requests.filter((request) => request.runId === sourceId).length,
		2,
		"rerunning must not resend the old run",
	);
	for (const id of [firstId, secondId]) {
		const sent = requests.filter((request) => request.runId === id);
		assert.deepEqual(
			sent.map((item) => item.deliveryId),
			["delivery_1", "delivery_2"],
		);
		assert.deepEqual(
			sent.map((item) => item.payload),
			[
				{
					id: "payment_001",
					type: "payment.succeeded",
					data: { orderId: "order_001", quantity: 1 },
				},
				{
					id: "payment_001",
					type: "payment.succeeded",
					data: { orderId: "order_001", quantity: 1 },
				},
			],
		);
	}
	const remaining = await queryPool.query<{ run_id: string; quantity: number }>(
		"SELECT run_id,quantity::int FROM inventory WHERE run_id=ANY($1::uuid[])",
		[[...runIds, independentRun]],
	);
	assert.deepEqual(remaining.rows, [{ run_id: independentRun, quantity: 8 }]);
	const history = await fetch(`${apiBase}/api/runs?limit=50`);
	assert.equal(history.status, 200);
	const page = (await history.json()) as RunHistoryPage;
	for (const id of runIds) assert.ok(page.runs.some((run) => run.id === id));
	assert.deepEqual(proxyErrors, []);
});
