import {
	createServer,
	request as forwardRequest,
	type ClientRequest,
	type ServerResponse,
} from "node:http";

/** Pipes real HTTP bytes. Cutting a socket tests native EventSource recovery. */
export async function createStreamTransport(baseURL: string) {
	const origin = new URL(baseURL).origin;
	const streams = new Set<{
		upstream: ClientRequest;
		downstream: ServerResponse;
	}>();
	const server = createServer((incoming, downstream) => {
		const destination = new URL(incoming.url ?? "/", origin);
		if (destination.origin !== origin || destination.protocol !== "http:") {
			downstream.destroy(
				new Error("The test transport only forwards the configured stack"),
			);
			return;
		}
		const upstream = forwardRequest(
			destination,
			{ method: incoming.method, headers: incoming.headers },
			(response) => {
				downstream.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(downstream);
			},
		);
		const stream = { upstream, downstream };
		if (/\/api\/runs\/[^/]+\/events$/.test(destination.pathname))
			streams.add(stream);
		upstream.on("error", () => downstream.destroy());
		downstream.on("close", () => {
			streams.delete(stream);
			upstream.destroy();
		});
		incoming.pipe(upstream);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Expected a loopback HTTP transport port");
	return {
		server: `http://127.0.0.1:${address.port}`,
		cutStreams() {
			const count = streams.size;
			for (const stream of streams) {
				stream.downstream.destroy();
				stream.upstream.destroy();
			}
			return count;
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}
