import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("the HTTP health endpoint returns the public JSON contract", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/health`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), { status: "ok" });
});
