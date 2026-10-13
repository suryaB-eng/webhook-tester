import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunEvent } from "@webhook-tester/contracts";
import * as runView from "./RunView.js";
import { RunTimeline } from "./RunView.js";

test("saved rerun details link to the source identity and label its target override", () => {
	assert.equal(typeof runView.RunLineage, "function");
	const html = renderToStaticMarkup(
		createElement(runView.RunLineage, {
			sourceRunId: "source/run",
			targetOverride: "demo-corrected",
		}),
	);
	assert.match(html, /href="#\/runs\/source%2Frun"/);
	assert.match(html, /<dt>Source run<\/dt>/);
	assert.match(html, /<dt>Target override<\/dt>/);
	assert.match(html, /demo-corrected/);
	const original = renderToStaticMarkup(
		createElement(runView.RunLineage, {
			sourceRunId: null,
			targetOverride: null,
		}),
	);
	assert.doesNotMatch(original, /href=|Target override/);
});

test("saved timeline renders delivery outcomes assertion scalars and semantic timestamps", () => {
	const events: RunEvent[] = [
		{
			cursor: "1",
			runId: "run",
			type: "run.queued",
			payload: { status: "queued" },
			createdAt: "2026-10-12T12:00:00.000Z",
		},
		{
			cursor: "2",
			runId: "run",
			type: "delivery.completed",
			payload: { deliveryId: "delivery-1", outcome: "ok", httpStatus: 200 },
			createdAt: "2026-10-12T12:00:01.000Z",
		},
		{
			cursor: "3",
			runId: "run",
			type: "assertion.completed",
			payload: {
				assertionId: "assertion-1",
				assertionName: "One order",
				assertionStatus: "passed",
				expected: 1,
				actual: 1,
			},
			createdAt: "2026-10-12T12:00:02.000Z",
		},
	];
	const html = renderToStaticMarkup(
		createElement(RunTimeline, { events, onSelectDelivery: () => {} }),
	);
	assert.match(html, /Run queued/);
	assert.match(html, /Delivery completed/);
	assert.match(html, /delivery-1/);
	assert.match(html, /HTTP 200/);
	assert.match(html, /One order/);
	assert.match(html, /Expected 1/);
	assert.match(html, /actual 1/);
	assert.match(html, /datetime="2026-10-12T12:00:02.000Z"/i);
	assert.match(html, /<button[^>]*type="button"/);
});

test("saved timeline has an empty state before the first persisted event", () => {
	const html = renderToStaticMarkup(createElement(RunTimeline, { events: [] }));
	assert.match(html, /No activity recorded yet/);
});

test("assertion errors distinguish missing actual results from a recorded JSON null", () => {
	const events: RunEvent[] = [
		{
			cursor: "1",
			runId: "run",
			type: "assertion.completed",
			payload: {
				assertionName: "Query failed",
				assertionStatus: "error",
				expected: null,
				actual: null,
			},
			createdAt: "2026-10-12T12:00:01.000Z",
		},
		{
			cursor: "2",
			runId: "run",
			type: "assertion.completed",
			payload: {
				assertionName: "Nullable value",
				assertionStatus: "passed",
				expected: null,
				actual: null,
			},
			createdAt: "2026-10-12T12:00:02.000Z",
		},
	];
	const html = renderToStaticMarkup(createElement(RunTimeline, { events }));
	assert.match(html, /Actual not recorded/);
	assert.match(html, /actual null/);
});
