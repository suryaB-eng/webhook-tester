import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResponse } from "@webhook-tester/contracts";
import { RunCompare, RunComparisonView } from "./RunCompare.js";

function run(id: string): RunResponse {
	return {
		id,
		status: "passed",
		phase: "completed",
		sourceRunId: null,
		targetOverride: null,
		createdAt: "2026-10-12T12:00:00Z",
		startedAt: null,
		completedAt: null,
		error: null,
		events: [],
		eventCursor: "0",
		deliveries: [],
		assertions: [],
		targetSnapshot: { id: "demo", name: "Demo" },
		scenarioSnapshot: {
			schemaVersion: 1,
			name: "Orders",
			description: "",
			targetId: "demo",
			events: [{ id: "event", payload: { id: "order" } }],
			steps: [
				{
					id: "step",
					mode: "sequential",
					delayBeforeMs: 0,
					deliveries: [{ deliveryId: "delivery", eventId: "event" }],
				},
			],
			limits: {
				maxConcurrency: 1,
				requestTimeoutMs: 1000,
				runTimeoutMs: 10000,
			},
			assertions: [
				{ id: "check", name: "Count", query: "SELECT 1", expected: 1 },
			],
		},
	};
}

test("comparison results show matching run links and meaningful empty result states", () => {
	const html = renderToStaticMarkup(
		createElement(RunComparisonView, {
			left: run("first-run"),
			right: run("second-run"),
		}),
	);
	assert.match(html, /href="#\/runs\/first-run"/);
	assert.match(html, /href="#\/runs\/second-run"/);
	assert.match(html, /No deliveries recorded in either run/);
	assert.match(html, /No assertions recorded in either run/);
	assert.match(html, /Saved configuration/);
});

test("comparison shows delivery HTTP status duration and explicit one-sided missing data", () => {
	const left = run("first");
	left.deliveries = [
		{
			deliveryId: "delivery-one",
			stepId: "step",
			eventId: "event",
			ordinal: 1,
			scheduledAt: null,
			startedAt: null,
			completedAt: null,
			requestPayload: { id: "order" },
			httpStatus: 503,
			durationMs: 0,
			outcome: "failed",
			error: "Service unavailable",
			responseExcerpt: null,
			responseTruncated: false,
		},
	];
	const html = renderToStaticMarkup(
		createElement(RunComparisonView, { left, right: run("second") }),
	);
	assert.match(html, /delivery-one/);
	assert.match(html, /503/);
	assert.match(html, /0 ms/);
	assert.match(html, /failed/);
	assert.match(html, /Service unavailable/);
	assert.match(html, /Missing/);
});

test("comparison distinguishes recorded null from pending and error actual values", () => {
	const left = run("first");
	const right = run("second");
	left.assertions = [
		{
			id: "nullable",
			name: "Nullable value",
			query: "SELECT NULL",
			expected: null,
			actual: null,
			status: "passed",
			error: null,
		},
	];
	right.assertions = [
		{
			id: "nullable",
			name: "Query errored",
			query: "SELECT broken",
			expected: null,
			actual: null,
			status: "error",
			error: "Database error",
		},
		{
			id: "pending",
			name: "Not run yet",
			query: "SELECT 1",
			expected: 1,
			actual: null,
			status: "pending",
			error: null,
		},
	];
	const html = renderToStaticMarkup(
		createElement(RunComparisonView, { left, right }),
	);
	assert.match(html, /Actual<\/dt><dd[^>]*>null<\/dd>/);
	assert.equal((html.match(/Actual not recorded/g) ?? []).length, 2);
	assert.match(html, /Database error/);
	assert.match(html, /SELECT broken/);
	assert.match(html, /Not run yet/);
	assert.match(html, /Missing/);
});

test("comparison identifies the rerun direction in ordinary run details", () => {
	const original = run("original");
	const rerun = run("rerun");
	rerun.sourceRunId = original.id;
	const forward = renderToStaticMarkup(
		createElement(RunComparisonView, { left: original, right: rerun }),
	);
	const reverse = renderToStaticMarkup(
		createElement(RunComparisonView, { left: rerun, right: original }),
	);
	assert.match(forward, /Second run is a snapshot rerun of the first/);
	assert.match(reverse, /First run is a snapshot rerun of the second/);
});

test("comparison route exposes loading IDs and a history link before saved responses load", () => {
	const html = renderToStaticMarkup(
		createElement(RunCompare, { leftId: "first", rightId: "second" }),
	);
	assert.match(html, /role="status"/);
	assert.match(html, /Loading saved runs/);
	assert.match(html, /first/);
	assert.match(html, /second/);
	assert.match(html, /href="#\/runs"/);
});
