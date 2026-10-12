import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { createPool } from "@webhook-tester/db";
import { executeAssertion } from "./assertions.js";

test("a failed assertion database connection is saved as a query error", async (t) => {
	const server = createServer((socket) => socket.destroy());
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const pool = createPool(
		`postgres://test:test@127.0.0.1:${address.port}/test`,
	);
	t.after(async () => {
		await pool.end();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const result = await executeAssertion(
		pool,
		"00000000-0000-0000-0000-000000000001",
		{
			id: "assertion",
			name: "Count",
			query: "SELECT 1 AS value WHERE $1::uuid IS NOT NULL",
			expected: 1,
		},
		2000,
	);
	assert.equal(result.status, "error");
	assert.equal(result.actual, null);
	assert.match(result.error ?? "", /query error/i);
});
