import { randomUUID } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type {
	RunResponse,
	SavedScenario,
	ScenarioV1,
} from "@webhook-tester/contracts";

export const profiles = [
	{ id: "demo-flawed", name: "Without deduplication" },
	{ id: "demo-corrected", name: "With deduplication" },
] as const;

export function uniqueName(label: string) {
	return `E2E ${label} ${randomUUID()}`;
}

export async function getRun(
	request: APIRequestContext,
	id: string,
): Promise<RunResponse> {
	const response = await request.get(`/api/runs/${id}`);
	expect(response.status()).toBe(200);
	const run = (await response.json()) as RunResponse;
	expect(run.id).toBe(id);
	return run;
}

export async function waitForRun(
	request: APIRequestContext,
	id: string,
): Promise<RunResponse> {
	await expect
		.poll(async () => (await getRun(request, id)).status, {
			timeout: 40_000,
			intervals: [100, 250, 500],
		})
		.not.toMatch(/^(queued|running)$/);
	return getRun(request, id);
}

export async function launchCard(
	page: Page,
	name: string,
	profile: (typeof profiles)[number],
): Promise<string> {
	await page.goto("/#/scenarios");
	const card = page.getByRole("region", { name, exact: true });
	await expect(card).toBeVisible();
	const started = page.waitForResponse(
		(response) =>
			response.url().endsWith("/api/runs") &&
			response.request().method() === "POST",
	);
	await card
		.getByRole("button", { name: `Run · ${profile.name}`, exact: true })
		.click();
	const response = await started;
	expect(response.status()).toBe(202);
	const { runId } = (await response.json()) as { runId: string };
	await expect(page).toHaveURL(new RegExp(`/#/runs/${runId}$`));
	return runId;
}

export async function assertRunView(page: Page, run: RunResponse) {
	await expect(page.locator(".page-header .run-status")).toHaveText(run.status);
	await expect(page.getByRole("region", { name: "Run details" })).toContainText(
		run.id,
	);
	const rows = page
		.getByRole("region", { name: "Deliveries", exact: true })
		.locator("tbody tr");
	await expect(rows).toHaveCount(run.deliveries.length);
	for (const delivery of run.deliveries) {
		const row = rows.filter({
			has: page.getByRole("button", { name: delivery.deliveryId, exact: true }),
		});
		await expect(row.getByRole("cell").nth(1)).toHaveText(delivery.outcome);
		await expect(row.getByRole("cell").nth(2)).toHaveText(
			String(delivery.httpStatus),
		);
	}
	for (const assertion of run.assertions) {
		const article = page.getByRole("article").filter({
			has: page.getByRole("heading", { name: assertion.name, exact: true }),
		});
		await expect(article.locator(".run-status")).toHaveText(assertion.status);
		await expect(article.locator(".scalar-values dd").nth(0)).toHaveText(
			JSON.stringify(assertion.expected),
		);
		await expect(article.locator(".scalar-values dd").nth(1)).toHaveText(
			JSON.stringify(assertion.actual),
		);
	}
}

export function assertSuccessfulHttp(run: RunResponse, count: number) {
	expect(run.error).toBeNull();
	expect(run.deliveries).toHaveLength(count);
	for (const delivery of run.deliveries) {
		expect(delivery.httpStatus).toBe(200);
		expect(delivery.outcome).toBe("ok");
		expect(delivery.error).toBeNull();
		expect(delivery.completedAt).not.toBeNull();
	}
}

export async function saveEditor(
	page: Page,
	method: "POST" | "PUT" = "POST",
): Promise<SavedScenario> {
	const saved = page.waitForResponse(
		(response) =>
			/\/api\/scenarios(?:\/[^/]+)?$/.test(response.url()) &&
			response.request().method() === method,
	);
	await page
		.getByRole("button", { name: "Save scenario", exact: true })
		.first()
		.click();
	const response = await saved;
	expect(response.status()).toBe(method === "POST" ? 201 : 200);
	const scenario = (await response.json()) as SavedScenario;
	await expect(page).toHaveURL(new RegExp(`/#/scenarios/${scenario.id}/edit$`));
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		scenario.document.name,
	);
	await expect(page.locator(".page-header .subheading")).toHaveText(
		`Revision ${scenario.revision}`,
	);
	return scenario;
}

export async function loadScenario(
	request: APIRequestContext,
	id: string,
): Promise<SavedScenario> {
	const response = await request.get(`/api/scenarios/${id}`);
	expect(response.status()).toBe(200);
	return response.json() as Promise<SavedScenario>;
}

export async function createScenario(
	request: APIRequestContext,
	document: ScenarioV1,
	origin: string,
): Promise<SavedScenario> {
	const response = await request.post("/api/scenarios", {
		data: { document },
		headers: { Origin: origin },
	});
	expect(response.status()).toBe(201);
	return response.json() as Promise<SavedScenario>;
}

export async function assertNoPageOverflow(page: Page) {
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
}
