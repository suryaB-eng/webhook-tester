import { getRunEventPage } from "@webhook-tester/db";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { ServerResponse } from "node:http";

export interface EventStreamOptions {
	pollIntervalMs?: number;
	heartbeatIntervalMs?: number;
	batchSize?: number;
}
function parseCursor(value: unknown): string | null {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value))
		return null;
	return BigInt(value) <= 9223372036854775807n ? value : null;
}
function acceptsStream(accept: string | undefined): boolean {
	let streamQuality = 0;
	let jsonQuality = 0;
	for (const entry of (accept ?? "").split(",")) {
		const [media, ...parameters] = entry.trim().toLowerCase().split(";");
		const qualityText = parameters
			.find((parameter) => parameter.trim().startsWith("q="))
			?.trim()
			.slice(2);
		const quality = qualityText === undefined ? 1 : Number(qualityText);
		if (!Number.isFinite(quality) || quality < 0 || quality > 1) continue;
		if (media?.trim() === "text/event-stream") streamQuality = quality;
		if (media?.trim() === "application/json") jsonQuality = quality;
	}
	return streamQuality > 0 && streamQuality >= jsonQuality;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}
async function writeFrame(
	raw: ServerResponse,
	frame: string,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted || raw.destroyed) return;
	if (raw.write(frame)) return;
	await new Promise<void>((resolve) => {
		const done = () => {
			raw.off("drain", done);
			signal.removeEventListener("abort", done);
			resolve();
		};
		raw.once("drain", done);
		signal.addEventListener("abort", done, { once: true });
	});
}
export function registerRunEventRoutes(
	app: FastifyInstance,
	pool: Pool,
	options: EventStreamOptions = {},
): void {
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15000;
	const batchSize = options.batchSize ?? 100;
	const streams = new Set<AbortController>();
	let closing = false;
	app.addHook("preClose", async () => {
		closing = true;
		for (const stream of streams) stream.abort();
	});
	app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
		"/api/runs/:id/events",
		{
			schema: {
				params: {
					type: "object",
					required: ["id"],
					properties: {
						id: {
							type: "string",
							pattern:
								"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
						},
					},
				},
			},
		},
		async (request, reply) => {
			let cursor =
				request.query.after === undefined
					? "0"
					: parseCursor(request.query.after);
			if (cursor === null)
				return reply.code(400).send({
					error: "after must be a canonical nonnegative bigint cursor",
				});
			const headerCursor = parseCursor(request.headers["last-event-id"]);
			if (headerCursor !== null && BigInt(headerCursor) > BigInt(cursor))
				cursor = headerCursor;
			const streaming = acceptsStream(request.headers.accept);
			let disconnected = request.raw.aborted || reply.raw.destroyed;
			const disconnect = () => {
				disconnected = true;
			};
			reply.raw.once("close", disconnect);
			request.raw.once("aborted", disconnect);
			let page: Awaited<ReturnType<typeof getRunEventPage>>;
			try {
				page = await getRunEventPage(
					pool,
					request.params.id,
					cursor,
					streaming ? batchSize : undefined,
				);
			} finally {
				reply.raw.off("close", disconnect);
				request.raw.off("aborted", disconnect);
			}
			if (disconnected || reply.raw.destroyed || request.raw.aborted)
				return reply.hijack();
			if (closing) return reply.code(503).send({ error: "Server is closing" });
			if (!page) return reply.code(404).send({ error: "Run not found" });
			if (!streaming) return page.events;
			const abort = new AbortController();
			const raw = reply.raw;
			const stop = () => abort.abort();
			const end = () => {
				if (!raw.destroyed) {
					raw.end();
				}
			};
			streams.add(abort);
			raw.once("close", stop);
			request.raw.once("aborted", stop);
			abort.signal.addEventListener("abort", end, { once: true });
			reply.hijack();
			raw.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
				"X-Accel-Buffering": "no",
			});
			try {
				await writeFrame(raw, ": connected\n\n", abort.signal);
				let lastFrameAt = Date.now();
				while (!abort.signal.aborted && page) {
					for (const event of page.events) {
						if (abort.signal.aborted) break;
						await writeFrame(
							raw,
							`id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`,
							abort.signal,
						);
						cursor = event.cursor;
						lastFrameAt = Date.now();
					}
					if (page.events.length < batchSize) {
						if (page.status !== "queued" && page.status !== "running") break;
						await pause(pollIntervalMs, abort.signal);
						if (
							!abort.signal.aborted &&
							Date.now() - lastFrameAt >= heartbeatIntervalMs
						) {
							await writeFrame(raw, ": heartbeat\n\n", abort.signal);
							lastFrameAt = Date.now();
						}
					}
					if (abort.signal.aborted) break;
					page = await getRunEventPage(
						pool,
						request.params.id,
						cursor,
						batchSize,
					);
				}
				end();
			} catch (error) {
				request.log.error(error);
				raw.destroy();
			} finally {
				streams.delete(abort);
				raw.off("close", stop);
				request.raw.off("aborted", stop);
				abort.signal.removeEventListener("abort", end);
			}
		},
	);
}
