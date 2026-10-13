import assert from "node:assert/strict";
import test from "node:test";
import type { RunEventPayload, RunEventType } from "@webhook-tester/contracts";
import { appendRunEvent } from "@webhook-tester/db";

test("event appends reject invalid values before any write", async () => {
	let writes = 0;
	const client = {
		query: async () => {
			writes++;
			return {};
		},
	};
	for (const payload of [
		{ expected: { endpoint: "https://private.invalid", credential: "secret" } },
		{ actual: ["secret"] },
		{ expected: Number.NaN },
		{ actual: Number.POSITIVE_INFINITY },
		{ phase: "x".repeat(201) },
		{ deliveryId: "x".repeat(101) },
		{ assertionName: "x".repeat(201) },
		{ status: "secret" },
		{ outcome: "secret" },
		{ assertionStatus: "secret" },
		{ httpStatus: 700 },
	]) {
		await assert.rejects(
			appendRunEvent(client, "unused", "run.phase", payload as RunEventPayload),
		);
	}
	await assert.rejects(
		appendRunEvent(client, "unused", "private.error" as RunEventType, {}),
	);
	assert.equal(writes, 0);
});
