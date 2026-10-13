import { expect, test } from "@playwright/test";
import {
	assertRunView,
	assertSuccessfulHttp,
	launchCard,
	profiles,
	waitForRun,
} from "./helpers.js";

const presets = [
	{ name: "One payment", count: 1, duplicate: false, status: false },
	{
		name: "Sequential duplicate payment",
		count: 2,
		duplicate: true,
		status: false,
	},
	{
		name: "Concurrent duplicate payment",
		count: 2,
		duplicate: true,
		status: false,
	},
	{
		name: "Status version 2 before version 1",
		count: 2,
		duplicate: false,
		status: true,
	},
] as const;

for (const preset of presets) {
	for (const profile of profiles) {
		test(`${preset.name} against ${profile.name} records real HTTP and SQL outcomes`, async ({
			page,
			request,
		}) => {
			const runId = await launchCard(page, preset.name, profile);
			const run = await waitForRun(request, runId);
			const flawed = profile.id === "demo-flawed";
			expect(run.status).toBe(
				flawed && (preset.duplicate || preset.status) ? "failed" : "passed",
			);
			expect(run.scenarioSnapshot.name).toBe(preset.name);
			expect(run.targetSnapshot).toEqual(profile);
			assertSuccessfulHttp(run, preset.count);
			expect(run.assertions.map((assertion) => assertion.actual)).toEqual(
				preset.status
					? flawed
						? ["processing", 1]
						: ["shipped", 2]
					: flawed && preset.duplicate
						? [2, 8]
						: [1, 9],
			);
			expect(
				run.assertions.every(
					(assertion) =>
						assertion.status ===
						(run.status === "passed" ? "passed" : "failed"),
				),
			).toBe(true);
			await assertRunView(page, run);
			await page.reload();
			await assertRunView(page, run);
		});
	}
}
