import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type {
	RunResponse,
	SavedScenario,
	ScenarioV1,
} from "@webhook-tester/contracts";
import { createPool, runMigrations, seedScenarios } from "@webhook-tester/db";
import {
	assertTestDatabase,
	testDatabaseUrls,
} from "@webhook-tester/db/testing";
import { buildApp } from "./app.js";

const document: ScenarioV1 = {
	schemaVersion: 1,
	name: "Editable payment",
	description: "An independent HTTP test scenario",
	targetId: "demo-flawed",
	events: [
		{
			id: "payment",
			payload: {
				id: "business-001",
				type: "payment.succeeded",
				data: { orderId: "order-001", quantity: 1 },
			},
		},
	],
	steps: [
		{
			id: "payments",
			mode: "sequential",
			delayBeforeMs: 0,
			deliveries: [{ deliveryId: "transport-001", eventId: "payment" }],
		},
	],
	limits: { maxConcurrency: 1, requestTimeoutMs: 3000, runTimeoutMs: 30000 },
	assertions: [
		{
			id: "effect",
			name: "One effect",
			query: "SELECT 1 AS value",
			expected: 1,
		},
	],
};

test("real HTTP scenario editing preserves revisions, independent copies and queued evidence", async (t) => {
	const urls = testDatabaseUrls();
	await assertTestDatabase(urls);
	await runMigrations(urls);
	const pool = createPool(urls.app);
	const adminUrl = new URL(urls.admin);
	adminUrl.pathname = new URL(urls.app).pathname;
	const admin = createPool(adminUrl.toString());
	const app = buildApp({
		appPool: pool,
		allowedOrigin: "http://127.0.0.1:4173",
		logger: false,
	});
	const scenarioIds: string[] = [];
	const runIds: string[] = [];
	t.after(async () => {
		try {
			await app.close();
		} finally {
			try {
				for (const id of runIds)
					await admin.query("DELETE FROM runs WHERE id=$1", [id]);
				for (const id of scenarioIds)
					await admin.query("DELETE FROM scenarios WHERE id=$1", [id]);
			} finally {
				await Promise.all([pool.end(), admin.end()]);
			}
		}
	});
	const address = await app.listen({ host: "127.0.0.1", port: 0 });
	const mutate = (
		path: string,
		body: unknown,
		method = "POST",
		headers: Record<string, string> = {},
	) =>
		fetch(`${address}${path}`, {
			method,
			headers: {
				Origin: "http://127.0.0.1:4173",
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify(body),
		});
	const read = async (id: string): Promise<SavedScenario> => {
		const result = await fetch(`${address}/api/scenarios/${id}`);
		assert.equal(result.status, 200);
		return result.json() as Promise<SavedScenario>;
	};
	const createdResponse = await mutate("/api/scenarios", { document });
	assert.equal(createdResponse.status, 201);
	const created = (await createdResponse.json()) as SavedScenario;
	scenarioIds.push(created.id);
	assert.match(created.id, /^[a-f0-9-]{36}$/);
	assert.equal(created.revision, 1);
	assert.deepEqual(created.document, document);

	await t.test(
		"two editor reads cannot overwrite the first editor's saved revision",
		async () => {
			const [first, second] = await Promise.all([
				read(created.id),
				read(created.id),
			]);
			assert.equal(first.revision, 1);
			assert.equal(second.revision, 1);
			const saved = await mutate(
				`/api/scenarios/${created.id}`,
				{
					revision: first.revision,
					document: { ...first.document, name: "First editor saved" },
				},
				"PUT",
			);
			assert.equal(saved.status, 200);
			assert.equal(((await saved.json()) as SavedScenario).revision, 2);
			const stale = await mutate(
				`/api/scenarios/${created.id}`,
				{
					revision: second.revision,
					document: { ...second.document, name: "Second editor stale" },
				},
				"PUT",
			);
			assert.equal(stale.status, 409);
			assert.equal(
				((await stale.json()) as { currentRevision: number }).currentRevision,
				2,
			);
			assert.equal(
				(await read(created.id)).document.name,
				"First editor saved",
			);
			const summaries = (await (
				await fetch(`${address}/api/scenarios`)
			).json()) as { id: string; revision: number }[];
			assert.equal(
				summaries.find((item) => item.id === created.id)?.revision,
				2,
			);
		},
	);

	await t.test(
		"duplicate preserves business and transport identities while edits remain independent",
		async () => {
			const source = await read(created.id);
			const response = await mutate(
				`/api/scenarios/${created.id}/duplicate`,
				{},
			);
			assert.equal(response.status, 201);
			const copy = (await response.json()) as SavedScenario;
			scenarioIds.push(copy.id);
			assert.notEqual(copy.id, created.id);
			assert.equal(copy.revision, 1);
			assert.ok(copy.document.name.endsWith(" copy"));
			assert.deepEqual(
				{ ...copy.document, name: source.document.name },
				source.document,
			);
			const edited = structuredClone(copy.document);
			edited.name = "x".repeat(200);
			const copiedEvent = edited.events[0];
			assert.ok(copiedEvent);
			copiedEvent.payload.id = "copy-business-002";
			assert.equal(
				(
					await mutate(
						`/api/scenarios/${copy.id}`,
						{ revision: 1, document: edited },
						"PUT",
					)
				).status,
				200,
			);
			assert.equal(
				(await read(created.id)).document.events[0]?.payload.id,
				"business-001",
			);
			assert.equal((await read(created.id)).revision, 2);
			assert.equal((await read(copy.id)).revision, 2);
			const boundedCopyResponse = await mutate(
				`/api/scenarios/${copy.id}/duplicate`,
				{},
			);
			assert.equal(boundedCopyResponse.status, 201);
			const boundedCopy = (await boundedCopyResponse.json()) as SavedScenario;
			scenarioIds.push(boundedCopy.id);
			assert.equal(boundedCopy.document.name.length, 200);
			assert.equal(boundedCopy.revision, 1);
			assert.equal(
				boundedCopy.document.events[0]?.payload.id,
				"copy-business-002",
			);
		},
	);

	await t.test(
		"all scenario mutations enforce configured Origin, JSON and strict envelope bodies",
		async () => {
			for (const [path, method, body] of [
				["/api/scenarios", "POST", { document }],
				[`/api/scenarios/${created.id}`, "PUT", { revision: 2, document }],
				[`/api/scenarios/${created.id}/duplicate`, "POST", {}],
			] as const) {
				for (const origin of [
					"",
					"null",
					"http://localhost:4173",
					"https://outside.invalid",
				])
					assert.equal(
						(await mutate(path, body, method, { Origin: origin })).status,
						403,
					);
				assert.equal(
					(await mutate(path, body, method, { "Content-Type": "text/plain" }))
						.status,
					415,
				);
				assert.equal(
					(
						await mutate(
							path,
							{ ...body, endpoint: "https://outside.invalid" },
							method,
						)
					).status,
					400,
				);
			}
			assert.equal(
				(
					await mutate(
						`/api/scenarios/${created.id}`,
						{ revision: "2", document },
						"PUT",
					)
				).status,
				400,
			);
			assert.equal(
				(
					await mutate(
						`/api/scenarios/${created.id}`,
						{ revision: 0, document },
						"PUT",
					)
				).status,
				400,
			);
			assert.equal(
				(await fetch(`${address}/api/scenarios/missing`)).status,
				404,
			);
			assert.equal(
				(
					await mutate(
						"/api/scenarios/missing",
						{ revision: 1, document },
						"PUT",
					)
				).status,
				404,
			);
			assert.equal(
				(await mutate("/api/scenarios/missing/duplicate", {})).status,
				404,
			);
			const oversizedId = await fetch(
				`${address}/api/scenarios/${"x".repeat(101)}`,
			);
			assert.ok(oversizedId.status >= 400 && oversizedId.status < 500);
			assert.equal((await fetch(`${address}/api/targets/config`)).status, 404);
			const targets = (await (
				await fetch(`${address}/api/targets`)
			).json()) as Record<string, unknown>[];
			assert.ok(
				targets.every(
					(target) => Object.keys(target).sort().join(",") === "id,name",
				),
			);
			const malformed = await fetch(`${address}/api/scenarios`, {
				method: "POST",
				headers: {
					Origin: "http://127.0.0.1:4173",
					"Content-Type": "application/json",
				},
				body: "{",
			});
			assert.equal(malformed.status, 400);
		},
	);

	await t.test(
		"invalid targets, demo payloads, IDs and limits return field issues without persisting",
		async () => {
			const invalids: { document: unknown; path: string }[] = [
				{ document: { ...document, targetId: "external" }, path: "targetId" },
				{
					document: {
						...document,
						events: [
							{
								...document.events[0],
								payload: { id: "business", type: "unsupported", data: {} },
							},
						],
					},
					path: "events",
				},
				{
					document: {
						...document,
						events: [{ ...document.events[0], id: "bad/id" }],
					},
					path: "events",
				},
				{
					document: {
						...document,
						steps: [
							{
								...document.steps[0],
								deliveries: [{ deliveryId: "transport", eventId: "missing" }],
							},
						],
					},
					path: "steps",
				},
				{
					document: {
						...document,
						limits: { ...document.limits, maxConcurrency: 11 },
					},
					path: "limits",
				},
				{
					document: {
						...document,
						steps: [
							{
								...document.steps[0],
								deliveries: Array.from({ length: 101 }, (_, i) => ({
									deliveryId: `transport_${i}`,
									eventId: "payment",
								})),
							},
						],
					},
					path: "steps",
				},
			];
			for (const invalid of invalids) {
				const response = await mutate("/api/scenarios", {
					document: invalid.document,
				});
				assert.equal(response.status, 400);
				const body = (await response.json()) as {
					issues?: { path: (string | number)[]; message: string }[];
				};
				assert.ok(
					body.issues?.some(
						(issue) =>
							issue.path.includes(invalid.path) && issue.message.length > 0,
					),
				);
			}
			const before = await read(created.id);
			const invalidPayload = invalids[1];
			assert.ok(invalidPayload);
			assert.equal(
				(
					await mutate(
						`/api/scenarios/${created.id}`,
						{ revision: before.revision, document: invalidPayload.document },
						"PUT",
					)
				).status,
				400,
			);
			assert.deepEqual(await read(created.id), before);
		},
	);

	await t.test(
		"editing a saved source leaves a queued run's business payload and snapshot immutable",
		async () => {
			const source = await read(created.id);
			const launched = await mutate("/api/runs", { scenarioId: source.id });
			assert.equal(launched.status, 202);
			const { runId } = (await launched.json()) as { runId: string };
			runIds.push(runId);
			const before = (await (
				await fetch(`${address}/api/runs/${runId}`)
			).json()) as RunResponse;
			const edited = structuredClone(source.document);
			edited.name = "Source edited after enqueue";
			const editedEvent = edited.events[0];
			assert.ok(editedEvent);
			editedEvent.payload.id = "new-business-id";
			assert.equal(
				(
					await mutate(
						`/api/scenarios/${source.id}`,
						{ revision: source.revision, document: edited },
						"PUT",
					)
				).status,
				200,
			);
			const after = (await (
				await fetch(`${address}/api/runs/${runId}`)
			).json()) as RunResponse;
			assert.deepEqual(after, before);
			assert.deepEqual(after.deliveries[0]?.requestPayload, {
				id: "business-001",
				type: "payment.succeeded",
				data: { orderId: "order-001", quantity: 1 },
			});
			assert.equal(
				(await read(source.id)).document.events[0]?.payload.id,
				"new-business-id",
			);
		},
	);

	await t.test(
		"restarting seeds preserves an API-edited preset document and revision",
		async () => {
			await seedScenarios(pool);
			const original = (
				await admin.query(
					"SELECT definition,revision,updated_at FROM scenarios WHERE id='one-payment'",
				)
			).rows[0];
			assert.ok(original);
			try {
				const saved = await read("one-payment");
				assert.equal(
					(
						await mutate(
							"/api/scenarios/one-payment",
							{
								revision: saved.revision,
								document: {
									...saved.document,
									name: `Seed edit ${randomUUID()}`,
								},
							},
							"PUT",
						)
					).status,
					200,
				);
				const edited = await read("one-payment");
				await seedScenarios(pool);
				assert.deepEqual(await read("one-payment"), edited);
				assert.equal(edited.revision, saved.revision + 1);
			} finally {
				await admin.query(
					"UPDATE scenarios SET definition=$1,revision=$2,updated_at=$3 WHERE id='one-payment'",
					[
						JSON.stringify(original.definition),
						original.revision,
						original.updated_at,
					],
				);
			}
		},
	);
	await t.test(
		"a document at the import byte limit saves and updates through JSON envelopes",
		async () => {
			const bounded = structuredClone(document);
			const assertion = bounded.assertions[0];
			assert.ok(assertion);
			assertion.expected = "";
			assertion.expected = "x".repeat(
				1048576 - new TextEncoder().encode(JSON.stringify(bounded)).byteLength,
			);
			assert.equal(
				new TextEncoder().encode(JSON.stringify(bounded)).byteLength,
				1048576,
			);
			const response = await mutate("/api/scenarios", { document: bounded });
			if (response.status === 201)
				scenarioIds.push(((await response.clone().json()) as SavedScenario).id);
			assert.equal(response.status, 201);
			const saved = (await response.json()) as SavedScenario;
			assert.deepEqual(saved.document, bounded);
			const updated = await mutate(
				`/api/scenarios/${saved.id}`,
				{ revision: saved.revision, document: bounded },
				"PUT",
			);
			assert.equal(updated.status, 200);
			assert.equal(((await updated.json()) as SavedScenario).revision, 2);
			const duplicate = await mutate(
				`/api/scenarios/${saved.id}/duplicate`,
				{},
			);
			if (duplicate.status === 201)
				scenarioIds.push(
					((await duplicate.clone().json()) as SavedScenario).id,
				);
			assert.equal(duplicate.status, 201);
			const copy = (await duplicate.json()) as SavedScenario;
			assert.notEqual(copy.id, saved.id);
			assert.deepEqual(copy.document, saved.document);
		},
	);
	await t.test(
		"text PostgreSQL cannot persist is rejected as a field error before writes",
		async () => {
			for (const text of [
				String.fromCharCode(0),
				String.fromCharCode(0xd800),
				String.fromCharCode(0xdc00),
			]) {
				for (const field of [
					"name",
					"description",
					"eventId",
					"orderId",
					"query",
					"expected",
				] as const) {
					const invalid = structuredClone(document);
					const event = invalid.events[0];
					const assertion = invalid.assertions[0];
					assert.ok(event && assertion);
					if (field === "name" || field === "description")
						invalid[field] = `before${text}after`;
					else if (field === "eventId") event.payload.id = `business${text}`;
					else if (field === "orderId")
						event.payload.data = { orderId: `order${text}`, quantity: 1 };
					else assertion[field] = `value${text}`;
					const response = await mutate("/api/scenarios", {
						document: invalid,
					});
					if (response.status === 201)
						scenarioIds.push(
							((await response.clone().json()) as SavedScenario).id,
						);
					assert.equal(response.status, 400, field);
					const result = (await response.json()) as { issues?: unknown[] };
					assert.ok(result.issues?.length);
				}
			}
		},
	);
	await t.test(
		"duplicate names preserve valid Unicode when truncating a long source name",
		async () => {
			const unicode = {
				...document,
				name: `${"x".repeat(194) + String.fromCodePoint(0x1f680)}aaaa`,
			};
			const response = await mutate("/api/scenarios", { document: unicode });
			assert.equal(response.status, 201);
			const saved = (await response.json()) as SavedScenario;
			scenarioIds.push(saved.id);
			const duplicate = await mutate(
				`/api/scenarios/${saved.id}/duplicate`,
				{},
			);
			if (duplicate.status === 201)
				scenarioIds.push(
					((await duplicate.clone().json()) as SavedScenario).id,
				);
			assert.equal(duplicate.status, 201);
			const copy = (await duplicate.json()) as SavedScenario;
			assert.ok(copy.document.name.endsWith(" copy"));
			assert.ok(copy.document.name.length <= 200);
		},
	);
});
