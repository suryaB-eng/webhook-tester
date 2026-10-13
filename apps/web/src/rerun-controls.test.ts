import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunStatus } from "@webhook-tester/contracts";
import * as controls from "./RerunControls.js";

test("rerun target form enables only terminal runs with a configured target", () => {
	assert.equal(typeof controls.RerunForm, "function");
	const render = (status: RunStatus, targetId = "demo", pending = false) =>
		renderToStaticMarkup(
			createElement(controls.RerunForm, {
				status,
				targets: [{ id: "demo", name: "Demo" }],
				targetId,
				pending,
				loading: false,
				onTarget: () => {},
				onRerun: () => {},
			}),
		);
	for (const status of ["queued", "running"] as const) {
		assert.match(render(status), /<button[^>]*disabled=""/);
		assert.match(render(status), /complete before/i);
	}
	for (const status of ["passed", "failed", "error", "interrupted"] as const)
		assert.doesNotMatch(render(status), /<button[^>]*disabled=""/);
	assert.match(render("passed", ""), /<button[^>]*disabled=""/);
	assert.match(
		render("passed", "unavailable-target"),
		/<button[^>]*disabled=""/,
	);
	assert.match(render("passed", "demo", true), /<button[^>]*disabled=""/);
	assert.match(render("passed"), /<label[^>]*>Rerun with<select/);
});
