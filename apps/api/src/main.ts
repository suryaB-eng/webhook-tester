import { buildApp } from "./app.js";

const app = buildApp();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({
    host: process.env.API_HOST ?? "127.0.0.1",
    port: Number(process.env.API_PORT ?? 4000),
  });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
