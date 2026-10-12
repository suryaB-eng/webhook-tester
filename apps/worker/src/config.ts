import type { WorkerTargetProfile } from "./target.js";

export function targetProfiles(
	env: NodeJS.ProcessEnv = process.env,
): ReadonlyMap<string, WorkerTargetProfile> {
	const base = env.DEMO_TARGET_BASE_URL ?? "http://127.0.0.1:4010";
	return new Map([
		[
			"demo-flawed",
			{
				id: "demo-flawed",
				name: "Without deduplication",
				endpoint: new URL("/webhooks/flawed", base).toString(),
				completion: { kind: "synchronous" },
			},
		],
		[
			"demo-corrected",
			{
				id: "demo-corrected",
				name: "With deduplication",
				endpoint: new URL("/webhooks/corrected", base).toString(),
				completion: { kind: "synchronous" },
			},
		],
	]);
}
