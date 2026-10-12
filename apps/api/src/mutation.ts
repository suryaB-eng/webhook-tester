import type { FastifyReply, FastifyRequest } from "fastify";

export function localJsonMutation(allowedOrigin: string) {
	return async (request: FastifyRequest, reply: FastifyReply) => {
		if (request.headers.origin !== allowedOrigin)
			return reply
				.code(403)
				.send({ error: "A configured local Origin is required" });
		if (
			request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
			"application/json"
		)
			return reply
				.code(415)
				.send({ error: "Content-Type must be application/json" });
	};
}
