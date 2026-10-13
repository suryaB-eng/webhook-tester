import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { RunResponse } from "@webhook-tester/contracts";
import {
	assertNoPageOverflow,
	assertRunView,
	assertSuccessfulHttp,
	launchCard,
	profiles,
	waitForRun,
} from "./helpers.js";

async function assertComparison(
	page: Page,
	source: RunResponse,
	rerun: RunResponse,
) {
	await expect(
		page.getByRole("region", { name: "First run", exact: true }),
	).toContainText(source.id);
	await expect(
		page.getByRole("region", { name: "First run", exact: true }),
	).toContainText("Without deduplication");
	await expect(
		page.getByRole("region", { name: "Second run", exact: true }),
	).toContainText(rerun.id);
	await expect(
		page.getByRole("region", { name: "Second run", exact: true }),
	).toContainText("With deduplication");
	await expect(
		page.getByText("Second run is a snapshot rerun of the first.", {
			exact: true,
		}),
	).toBeVisible();
	const configuration = page.getByRole("table", {
		name: "Saved configuration",
		exact: true,
	});
	for (const name of [
		"Scenario",
		"Events and payloads",
		"Delivery plan",
		"Limits",
		"Assertion definitions",
	]) {
		const row = configuration
			.getByRole("row")
			.filter({ has: page.getByRole("rowheader", { name, exact: true }) });
		await expect(row.getByRole("cell").last()).toHaveText("Same");
	}
	for (const name of [
		"Scenario target ID",
		"Target ID",
		"Target name",
		"Target override",
	]) {
		const row = configuration
			.getByRole("row")
			.filter({ has: page.getByRole("rowheader", { name, exact: true }) });
		await expect(row.getByRole("cell").last()).toHaveText("Different");
	}
	const deliveries = page.getByRole("table", {
		name: "Delivery results",
		exact: true,
	});
	await expect(deliveries.locator("tbody tr")).toHaveCount(2);
	for (const delivery of source.deliveries) {
		const row = deliveries.getByRole("row").filter({
			has: page.getByRole("rowheader", {
				name: delivery.deliveryId,
				exact: true,
			}),
		});
		for (const cell of [
			row.getByRole("cell").nth(0),
			row.getByRole("cell").nth(1),
		]) {
			await expect(cell.locator("dd").nth(0)).toHaveText("200");
			await expect(cell.locator("dd").nth(1)).toHaveText("ok");
		}
	}
	const assertions = page.getByRole("table", {
		name: "Assertion results",
		exact: true,
	});
	await expect(assertions.locator("tbody tr")).toHaveCount(2);
	for (const [index, assertion] of source.assertions.entries()) {
		const row = assertions.getByRole("row").filter({
			has: page.getByRole("rowheader", { name: assertion.id, exact: true }),
		});
		const first = row.getByRole("cell").nth(0);
		const second = row.getByRole("cell").nth(1);
		await expect(first).toContainText(assertion.name);
		await expect(second).toContainText(assertion.name);
		await expect(first.locator("dd").nth(0)).toHaveText("failed");
		await expect(second.locator("dd").nth(0)).toHaveText("passed");
		await expect(first.locator("dd").nth(2)).toHaveText(
			JSON.stringify(assertion.actual),
		);
		await expect(second.locator("dd").nth(2)).toHaveText(
			JSON.stringify(rerun.assertions[index]?.actual),
		);
	}
}

test("history selects stored runs and compares a corrected snapshot rerun across refresh and narrow viewports", async ({
	page,
	request,
}) => {
	const sourceId = await launchCard(
		page,
		"Sequential duplicate payment",
		profiles[0],
	);
	const source = await waitForRun(request, sourceId);
	expect(source.status).toBe("failed");
	expect(source.assertions.map((assertion) => assertion.actual)).toEqual([
		2, 8,
	]);
	assertSuccessfulHttp(source, 2);
	await assertRunView(page, source);
	await expect(
		page.getByRole("combobox", { name: "Rerun with", exact: true }),
	).toBeEnabled();
	await page
		.getByRole("combobox", { name: "Rerun with", exact: true })
		.selectOption("demo-corrected");
	const rerunning = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/runs/${source.id}/rerun`) &&
			response.request().method() === "POST",
	);
	await page.getByRole("button", { name: "Rerun", exact: true }).click();
	const response = await rerunning;
	expect(response.status()).toBe(202);
	const { runId } = (await response.json()) as { runId: string };
	expect(runId).not.toBe(source.id);
	await expect(page).toHaveURL(new RegExp(`/#/runs/${runId}$`));
	const rerun = await waitForRun(request, runId);
	expect(rerun.sourceRunId).toBe(source.id);
	expect(rerun.targetOverride).toBe("demo-corrected");
	expect(rerun.scenarioSnapshot).toEqual({
		...source.scenarioSnapshot,
		targetId: "demo-corrected",
	});
	expect(rerun.status).toBe("passed");
	expect(rerun.assertions.map((assertion) => assertion.actual)).toEqual([1, 9]);
	assertSuccessfulHttp(rerun, 2);
	await assertRunView(page, rerun);
	await page
		.getByRole("main")
		.getByRole("link", { name: "Run history", exact: true })
		.click();
	const history = page.getByRole("table", { name: "Saved runs", exact: true });
	await expect(
		history.locator(
			`tbody tr:has(td:nth-child(2) a[href="#/runs/${source.id}"])`,
		),
	).toContainText("failed");
	await expect(
		history.locator(
			`tbody tr:has(td:nth-child(2) a[href="#/runs/${rerun.id}"])`,
		),
	).toContainText("passed");
	const first = page.getByRole("combobox", { name: "First run", exact: true });
	const second = page.getByRole("combobox", {
		name: "Second run",
		exact: true,
	});
	await first.selectOption(source.id);
	await first.focus();
	await first.press("ArrowUp");
	await expect(first).toHaveValue(rerun.id);
	await first.press("ArrowDown");
	await expect(first).toHaveValue(source.id);
	await second.selectOption(rerun.id);
	await second.focus();
	await second.press("Tab");
	const compare = page.getByRole("link", { name: "Compare runs", exact: true });
	await expect(compare).toBeFocused();
	await compare.press("Enter");
	await expect(page).toHaveURL(
		new RegExp(`/#/compare/${source.id}/${rerun.id}$`),
	);
	await assertComparison(page, source, rerun);
	await page
		.getByRole("button", { name: "Refresh results", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Refresh results", exact: true }),
	).toBeEnabled();
	await assertComparison(page, source, rerun);
	await page.reload();
	await assertComparison(page, source, rerun);
	if (process.env.CAPTURE_DEMO === "1") {
		await page.setViewportSize({ width: 1280, height: 1000 });
		await mkdir("docs/assets", { recursive: true });
		await page.screenshot({
			path: "docs/assets/duplicate-payment.png",
			fullPage: true,
		});
	}
	await page.setViewportSize({ width: 390, height: 844 });
	await assertComparison(page, source, rerun);
	await assertNoPageOverflow(page);
	for (const id of [source.id, rerun.id]) {
		await page
			.getByRole("region", {
				name: id === source.id ? "First run" : "Second run",
				exact: true,
			})
			.getByRole("link", { name: id, exact: true })
			.first()
			.click();
		await assertRunView(page, id === source.id ? source : rerun);
		await assertNoPageOverflow(page);
		await page.goto(`/#/compare/${source.id}/${rerun.id}`);
		await assertComparison(page, source, rerun);
	}
});
