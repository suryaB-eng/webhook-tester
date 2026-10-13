import { expect, test, type APIRequestContext } from "@playwright/test";
import {
	assertRunView,
	assertSuccessfulHttp,
	createScenario,
	getRun,
	launchCard,
	loadScenario,
	profiles,
	uniqueName,
	waitForRun,
} from "./helpers.js";
import { createStreamTransport } from "./stream-transport.js";

const streamTest = test.extend<{
	streamTransport: Awaited<ReturnType<typeof createStreamTransport>>;
}>({
	streamTransport: async ({ baseURL }, use) => {
		if (!baseURL) throw new Error("A full-stack base URL is required");
		const transport = await createStreamTransport(baseURL);
		try {
			await use(transport);
		} finally {
			await transport.close();
		}
	},
	context: async ({ browser, baseURL, streamTransport }, use) => {
		if (!baseURL) throw new Error("A full-stack base URL is required");
		const context = await browser.newContext({
			baseURL,
			proxy: { server: streamTransport.server, bypass: "<-loopback>" },
		});
		try {
			await use(context);
		} finally {
			await context.close();
		}
	},
});

async function delayedScenario(request: APIRequestContext, origin: string) {
	const { document } = await loadScenario(request, "one-payment");
	document.name = uniqueName("delayed stream");
	document.targetId = "demo-corrected";
	const first = document.steps[0];
	if (!first) throw new Error("Expected a payment step");
	first.delayBeforeMs = 5000;
	document.steps.push({
		...structuredClone(first),
		id: "second_delay",
		deliveries: [{ deliveryId: "delivery_2", eventId: "payment" }],
	});
	return createScenario(request, document, origin);
}

streamTest(
	"a real SSE stream reconnects after offline interruption with ordered saved activity",
	async ({ page, context, request, baseURL, streamTransport }) => {
		if (!baseURL) throw new Error("A full-stack base URL is required");
		const scenario = await delayedScenario(request, new URL(baseURL).origin);
		// Observe the native EventSource; no responses or events are replaced.
		await page.addInitScript(() => {
			const state = { opens: 0, errors: 0, cursors: [] as string[] };
			Object.assign(window, { e2eStream: state });
			const NativeSource = window.EventSource;
			window.EventSource = class extends NativeSource {
				constructor(url: string | URL, options?: EventSourceInit) {
					super(url, options);
					this.addEventListener("open", () => state.opens++);
					this.addEventListener("error", () => state.errors++);
					this.addEventListener("message", (event) =>
						state.cursors.push(event.lastEventId),
					);
				}
			};
		});
		const id = await launchCard(page, scenario.document.name, profiles[1]);
		await expect(
			page.getByRole("status").filter({ hasText: "Live updates connected" }),
		).toBeVisible();
		await expect
			.poll(async () => (await getRun(request, id)).status)
			.toBe("running");
		const before = (await getRun(request, id)).eventCursor;
		await context.setOffline(true);
		try {
			// Chromium keeps established SSE sockets alive under offline emulation.
			// Sever the real forwarded connection; native retries remain offline.
			expect(streamTransport.cutStreams()).toBe(1);
			await expect(
				page
					.getByRole("status")
					.filter({ hasText: "Reconnecting to live updates" }),
			).toBeVisible({ timeout: 4000 });
			await expect
				.poll(async () => (await getRun(request, id)).deliveries[0]?.outcome, {
					timeout: 10_000,
					intervals: [100, 250],
				})
				.toBe("ok");
			expect((await getRun(request, id)).status).toBe("running");
		} finally {
			await context.setOffline(false);
		}
		await expect
			.poll(
				async () =>
					page.evaluate(
						() =>
							(window as unknown as { e2eStream: { opens: number } }).e2eStream
								.opens,
					),
				{ timeout: 5000 },
			)
			.toBeGreaterThan(1);
		await expect
			.poll(async () =>
				page.evaluate(
					(cursor) =>
						(
							window as unknown as { e2eStream: { cursors: string[] } }
						).e2eStream.cursors.some((value) => BigInt(value) > BigInt(cursor)),
					before,
				),
			)
			.toBe(true);
		const run = await waitForRun(request, id);
		expect(run.status).toBe("passed");
		assertSuccessfulHttp(run, 2);
		expect(run.assertions.map((assertion) => assertion.actual)).toEqual([1, 9]);
		await assertRunView(page, run);
		await expect(
			page.getByRole("status").filter({ hasText: "Saved run complete" }),
		).toBeVisible();
		const activity = page.getByRole("region", {
			name: "Activity",
			exact: true,
		});
		await expect(activity.locator("li")).toHaveCount(run.events.length);
		const cursors = run.events.map((event) => event.cursor);
		expect(new Set(cursors).size).toBe(cursors.length);
		expect(
			cursors.every(
				(cursor, index) =>
					index === 0 || BigInt(cursor) > BigInt(cursors[index - 1] as string),
			),
		).toBe(true);
		await expect(activity.locator(".timeline-heading strong")).toHaveText(
			run.events.map(
				(event) =>
					({
						"run.queued": "Run queued",
						"run.started": "Run started",
						"run.phase": "Phase changed",
						"run.completed": "Run completed",
						"delivery.scheduled": "Delivery scheduled",
						"delivery.started": "Delivery started",
						"delivery.completed": "Delivery completed",
						"delivery.interrupted": "Delivery interrupted",
						"assertion.completed": "Assertion completed",
					})[event.type],
			),
		);
		await page
			.getByRole("button", { name: "Refresh results", exact: true })
			.click();
		await expect(activity.locator("li")).toHaveCount(run.events.length);
		await page.reload();
		await assertRunView(page, run);
		await expect(activity.locator("li")).toHaveCount(run.events.length);
	},
);

test("closing the browser page leaves the worker to complete the saved run", async ({
	page,
	context,
	request,
	baseURL,
}) => {
	if (!baseURL) throw new Error("A full-stack base URL is required");
	const scenario = await delayedScenario(request, new URL(baseURL).origin);
	const id = await launchCard(page, scenario.document.name, profiles[1]);
	await expect(
		page.getByRole("status").filter({ hasText: "Live updates connected" }),
	).toBeVisible();
	await expect
		.poll(async () => (await getRun(request, id)).status)
		.toBe("running");
	await page.close();
	const completed = await waitForRun(request, id);
	expect(completed.status).toBe("passed");
	assertSuccessfulHttp(completed, 2);
	expect(completed.assertions.map((assertion) => assertion.actual)).toEqual([
		1, 9,
	]);
	const reopened = await context.newPage();
	await reopened.goto(`/#/runs/${id}`);
	await assertRunView(reopened, completed);
	await expect(
		reopened.getByRole("status").filter({ hasText: "Saved run complete" }),
	).toBeVisible();
	await expect(
		reopened
			.getByRole("region", { name: "Activity", exact: true })
			.locator("li"),
	).toHaveCount(completed.events.length);
	await reopened.close();
});
