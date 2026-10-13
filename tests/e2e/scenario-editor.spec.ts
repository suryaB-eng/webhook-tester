import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { ScenarioV1 } from "@webhook-tester/contracts";
import {
	assertRunView,
	assertSuccessfulHttp,
	launchCard,
	loadScenario,
	profiles,
	saveEditor,
	uniqueName,
	waitForRun,
} from "./helpers.js";

test("create, edit, duplicate, download and import preserve executable scenario data", async ({
	page,
	request,
}) => {
	const name = uniqueName("edited payment");
	await page.goto("/#/scenarios");
	await page
		.getByRole("link", { name: "Create scenario", exact: true })
		.click();
	await page.getByLabel("Name", { exact: true }).fill(name);
	const created = await saveEditor(page);
	expect(created.revision).toBe(1);
	await page
		.getByLabel("Description", { exact: true })
		.fill("Created and edited through the real scenario editor.");
	await page
		.getByRole("button", { name: "Repeat delivery 1", exact: true })
		.click();
	const edited = await saveEditor(page, "PUT");
	expect(edited.revision).toBe(2);
	expect(edited.document.steps[0]?.deliveries).toEqual([
		{ deliveryId: "delivery_1", eventId: "payment" },
		{ deliveryId: "delivery_2", eventId: "payment" },
	]);
	await page.reload();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
	await expect(
		page.getByLabel("Delivery 2 event reference", { exact: true }),
	).toHaveValue("payment");
	await page.getByRole("button", { name: /Scenarios$/ }).click();
	const duplicateResponse = page.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/scenarios/${created.id}/duplicate`) &&
			response.request().method() === "POST",
	);
	await page
		.getByRole("region", { name, exact: true })
		.getByRole("button", { name: "Duplicate", exact: true })
		.click();
	const duplicate = await duplicateResponse;
	expect(duplicate.status()).toBe(201);
	const copy = (await duplicate.json()) as {
		id: string;
		revision: number;
		document: ScenarioV1;
	};
	expect(copy.id).not.toBe(created.id);
	expect(copy.revision).toBe(1);
	expect(copy.document).toEqual({ ...edited.document, name: `${name} copy` });
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		copy.document.name,
	);
	const downloading = page.waitForEvent("download");
	await page
		.getByRole("button", { name: "Export JSON", exact: true })
		.first()
		.click();
	const download = await downloading;
	expect(download.suggestedFilename()).toMatch(/\.json$/);
	const path = await download.path();
	expect(path).not.toBeNull();
	const exported = JSON.parse(
		await readFile(path as string, "utf8"),
	) as ScenarioV1;
	expect(exported).toEqual(copy.document);

	// An imported order and quantity must drive the fixture, not only the preview fields.
	const imported = structuredClone(exported);
	imported.name = uniqueName("imported quantity two");
	const payload = imported.events[0]?.payload as {
		id: string;
		type: string;
		data: { orderId: string; quantity: number };
	};
	payload.data = { orderId: "order_e2e_imported", quantity: 2 };
	const fulfillment = imported.assertions[0];
	const inventory = imported.assertions[1];
	if (!fulfillment || !inventory)
		throw new Error("Expected the exported payment assertions");
	fulfillment.query = fulfillment.query.replaceAll(
		"order_001",
		"order_e2e_imported",
	);
	inventory.expected = 8;
	inventory.name = "Imported inventory is 8";
	await page.getByRole("button", { name: /Scenarios$/ }).click();
	await page.getByText("Import scenario JSON", { exact: true }).click();
	await page.getByLabel("Scenario JSON file", { exact: true }).setInputFiles({
		name: "alternate-order.json",
		mimeType: "application/json",
		buffer: Buffer.from(JSON.stringify(imported)),
	});
	await expect(
		page.getByRole("heading", { name: "Create scenario", exact: true }),
	).toBeVisible();
	await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
		imported.name,
	);
	const savedImport = await saveEditor(page);
	expect(savedImport.document).toEqual(imported);
	expect((await loadScenario(request, created.id)).document).toEqual(
		edited.document,
	);
	await page.getByRole("button", { name: /Scenarios$/ }).click();
	const runId = await launchCard(page, imported.name, profiles[1]);
	const run = await waitForRun(request, runId);
	expect(run.status).toBe("passed");
	assertSuccessfulHttp(run, 2);
	expect(run.assertions.map((assertion) => assertion.actual)).toEqual([1, 8]);
	expect(run.deliveries[0]?.requestPayload).toEqual(payload);
	await assertRunView(page, run);
});

test("field validation and unsupported imported payloads block saving", async ({
	page,
	request,
}) => {
	await page.goto("/#/scenarios/new");
	const name = page.getByLabel("Name", { exact: true });
	await name.fill("");
	await expect(name).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("button", { name: "Save scenario", exact: true }).first(),
	).toBeDisabled();
	await name.fill(uniqueName("validation"));
	const payload = page.getByLabel("Event payload (JSON)", { exact: true });
	const valid = await payload.inputValue();
	await payload.fill("{");
	await expect(payload).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("alert").filter({ hasText: "Must be valid JSON." }),
	).toBeVisible();
	await payload.fill(
		JSON.stringify({
			id: "unsupported",
			type: "subscription.created",
			data: {},
		}),
	);
	await expect(payload).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByRole("button", { name: "Save scenario", exact: true }).first(),
	).toBeDisabled();
	await payload.fill(valid);
	await expect(payload).toHaveAttribute("aria-invalid", "false");
	await expect(
		page.getByRole("button", { name: "Save scenario", exact: true }).first(),
	).toBeEnabled();
	await page.getByText("Import JSON", { exact: true }).click();
	const unsupported = structuredClone(
		(await loadScenario(request, "one-payment")).document,
	);
	unsupported.events[0] = {
		id: "payment",
		payload: { id: "unknown", type: "subscription.created", data: {} },
	};
	await page
		.getByLabel("Or paste scenario JSON", { exact: true })
		.fill(JSON.stringify(unsupported));
	await page
		.getByRole("button", { name: "Preview imported draft", exact: true })
		.click();
	await expect(
		page.locator(".import-controls").getByRole("alert"),
	).toContainText(/type|Invalid/);
	await expect(name).toHaveValue(/E2E validation/);
});

test("two real editor pages detect a revision conflict and retain the losing draft", async ({
	page,
	context,
	request,
}) => {
	const originalName = uniqueName("revision conflict");
	await page.goto("/#/scenarios/new");
	await page.getByLabel("Name", { exact: true }).fill(originalName);
	const original = await saveEditor(page);
	const second = await context.newPage();
	await second.goto(`/#/scenarios/${original.id}/edit`);
	await expect(second.locator(".page-header .subheading")).toHaveText(
		"Revision 1",
	);
	await second
		.getByLabel("Name", { exact: true })
		.fill(`${originalName} losing draft`);
	await page.getByLabel("Name", { exact: true }).fill(`${originalName} winner`);
	const winner = await saveEditor(page, "PUT");
	expect(winner.revision).toBe(2);
	const conflictResponse = second.waitForResponse(
		(response) =>
			response.url().endsWith(`/api/scenarios/${original.id}`) &&
			response.request().method() === "PUT",
	);
	await second
		.getByRole("button", { name: "Save scenario", exact: true })
		.first()
		.click();
	const conflict = await conflictResponse;
	expect(conflict.status()).toBe(409);
	expect(await conflict.json()).toMatchObject({ currentRevision: 2 });
	await expect(second.getByRole("alert")).toContainText(
		"Your draft and original revision 1 are preserved",
	);
	await expect(second.getByLabel("Name", { exact: true })).toHaveValue(
		`${originalName} losing draft`,
	);
	expect((await loadScenario(request, original.id)).document.name).toBe(
		winner.document.name,
	);
	const savedDraft = second.waitForResponse(
		(response) =>
			response.url().endsWith("/api/scenarios") &&
			response.request().method() === "POST",
	);
	await second
		.getByRole("button", { name: "Save draft as new scenario", exact: true })
		.click();
	const draftResponse = await savedDraft;
	expect(draftResponse.status()).toBe(201);
	const draft = (await draftResponse.json()) as {
		id: string;
		revision: number;
		document: ScenarioV1;
	};
	expect(draft.id).not.toBe(original.id);
	expect(draft.revision).toBe(1);
	expect(draft.document.name).toBe(`${originalName} losing draft`);
	await expect(second).toHaveURL(new RegExp(`/#/scenarios/${draft.id}/edit$`));
	await second.reload();
	await expect(second.getByLabel("Name", { exact: true })).toHaveValue(
		draft.document.name,
	);
	await second.close();
});
