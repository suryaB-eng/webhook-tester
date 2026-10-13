import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunSummary } from "@webhook-tester/contracts";
import * as history from "./RunHistory.js";

const saved: RunSummary = {
	id: "saved/run", scenarioName: "Saved snapshot", status: "passed", phase: "completed",
	targetSnapshot: { id: "demo", name: "Demo" }, createdAt: "2026-10-12T12:00:00Z",
	startedAt: null, completedAt: "2026-10-12T12:00:01Z", sourceRunId: "original/run", targetOverride: "demo",
};

test("history rows link to saved identities and expose saved summary lineage", () => {
	assert.equal(typeof history.RunHistoryTable, "function");
	const html = renderToStaticMarkup(createElement(history.RunHistoryTable, { runs: [saved] }));
	assert.match(html, /href="#\/runs\/saved%2Frun"/);
	assert.match(html, /Saved snapshot/);
	assert.match(html, /href="#\/runs\/original%2Frun"/);
	assert.match(html, /datetime="2026-10-12T12:00:00Z"/i);
});

test("comparison keeps selected runs from older pages and prevents comparing a run with itself", () => {
	assert.equal(typeof history.RunComparisonPicker, "function");
	const older = { ...saved, id: "older", scenarioName: "Older snapshot" };
	const html = renderToStaticMarkup(createElement(history.RunComparisonPicker, { runs: [older], left: saved, right: older, onLeft: () => {}, onRight: () => {} }));
	assert.match(html, /<select/);
	assert.match(html, /value="saved\/run" selected=""/);
	assert.match(html, /href="#\/compare\/saved%2Frun\/older"/);
	const same = renderToStaticMarkup(createElement(history.RunComparisonPicker, { runs: [older], left: saved, right: saved, onLeft: () => {}, onRight: () => {} }));
	assert.doesNotMatch(same, /href="#\/compare/);
	assert.match(same, /<button[^>]*disabled=""/);
});
