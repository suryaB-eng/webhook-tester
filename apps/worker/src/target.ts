import { performance } from "node:perf_hooks";
import type { JsonValue } from "@webhook-tester/contracts";

export interface WorkerTargetProfile {
	id: string;
	name: string;
	endpoint: string;
	completion: { kind: "synchronous" };
}
export interface DeliveryCompletion {
	httpStatus: number | null;
	durationMs: number;
	responseExcerpt: string | null;
	responseTruncated: boolean;
	outcome: "ok" | "failed" | "error";
	error: string | null;
	uncertain: boolean;
}
const MAX_RESPONSE_BYTES = 16384;

async function capture(body: ReadableStream<Uint8Array> | null) {
	if (!body) return { excerpt: "", truncated: false };
	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let length = 0;
	let truncated = false;
	try {
		while (length <= MAX_RESPONSE_BYTES) {
			const next = await reader.read();
			if (next.done) break;
			const remaining = MAX_RESPONSE_BYTES + 1 - length;
			const chunk = Buffer.from(next.value.subarray(0, remaining));
			chunks.push(chunk);
			length += chunk.byteLength;
			if (next.value.byteLength > remaining || length > MAX_RESPONSE_BYTES) {
				truncated = true;
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	// Streaming decode omits an incomplete UTF-8 character at the byte boundary.
	const decoded = new TextDecoder().decode(
		Buffer.concat(chunks).subarray(0, MAX_RESPONSE_BYTES),
		{ stream: true },
	);
	const encoded = Buffer.from(decoded.replace(/\0/g, "\\u0000"));
	const excerpt = new TextDecoder().decode(
		encoded.subarray(0, MAX_RESPONSE_BYTES),
		{ stream: true },
	);
	return {
		excerpt,
		truncated: truncated || encoded.byteLength > MAX_RESPONSE_BYTES,
	};
}

export async function deliverWebhook(options: {
	profile: WorkerTargetProfile;
	runId: string;
	deliveryId: string;
	payload: JsonValue;
	requestTimeoutMs: number;
	runSignal: AbortSignal;
}): Promise<DeliveryCompletion> {
	const started = performance.now();
	const signal = AbortSignal.any([
		options.runSignal,
		AbortSignal.timeout(options.requestTimeoutMs),
	]);
	let httpStatus: number | null = null;
	try {
		const response = await fetch(options.profile.endpoint, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/json",
				"x-webhook-lab-run-id": options.runId,
				"x-webhook-lab-delivery-id": options.deliveryId,
			},
			body: JSON.stringify(options.payload),
			signal,
		});
		httpStatus = response.status;
		const captured = await capture(response.body);
		const ok = httpStatus >= 200 && httpStatus < 300;
		return {
			httpStatus,
			durationMs: Math.max(0, Math.round(performance.now() - started)),
			responseExcerpt: captured.excerpt,
			responseTruncated: captured.truncated,
			outcome: ok ? "ok" : "failed",
			error: ok ? null : `HTTP ${httpStatus}`,
			uncertain: false,
		};
	} catch {
		return {
			httpStatus,
			durationMs: Math.max(0, Math.round(performance.now() - started)),
			responseExcerpt: null,
			responseTruncated: false,
			outcome: "error",
			error: signal.aborted
				? options.runSignal.aborted
					? "Overall run timeout"
					: "Webhook request timed out"
				: "Webhook transport error",
			// A disconnected or aborted request does not prove target work has stopped.
			uncertain: true,
		};
	}
}
