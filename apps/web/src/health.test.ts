import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { checkHealth } from "./health.js";

test("health checks validate real HTTP responses before reporting connectivity", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    switch (request.url) {
      case "/health":
        response.end('{"status":"ok"}');
        break;
      case "/unavailable":
        response.writeHead(503).end('{"status":"ok"}');
        break;
      case "/wrong-status":
        response.end('{"status":"down"}');
        break;
      default:
        response.end("not json");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  await checkHealth(undefined, `${base}/health`);
  await assert.rejects(checkHealth(undefined, `${base}/unavailable`), /HTTP 503/);
  await assert.rejects(checkHealth(undefined, `${base}/wrong-status`), /Unexpected health response/);
  await assert.rejects(checkHealth(undefined, `${base}/invalid-json`));
  await assert.rejects(checkHealth(AbortSignal.abort(), `${base}/health`));
});
