import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverTestGroups, runTestGroups } from "./test.mjs";

async function fixture(t) {
	const root = await mkdtemp(join(tmpdir(), "webhook-test-runner-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("discovers nested tests and separates integration files without overlap", async (t) => {
	const root = await fixture(t);
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ workspaces: ["apps/example", "packages/empty"] }),
	);
	const workspace = join(root, "apps/example");
	await mkdir(join(workspace, "src/nested"), { recursive: true });
	await mkdir(join(root, "packages/empty/src"), { recursive: true });
	for (const file of [
		"a.test.ts",
		"a.integration.test.ts",
		"nested/b.test.ts",
		"helper.ts",
	])
		await writeFile(join(workspace, "src", file), "");
	const unit = await discoverTestGroups(root, "unit");
	const integration = await discoverTestGroups(root, "integration");
	assert.deepEqual(unit, [
		{
			cwd: workspace,
			files: [
				join(workspace, "src/a.test.ts"),
				join(workspace, "src/nested/b.test.ts"),
			],
		},
	]);
	assert.deepEqual(integration, [
		{ cwd: workspace, files: [join(workspace, "src/a.integration.test.ts")] },
	]);
	await assert.rejects(discoverTestGroups(root, "all"), /unit or integration/);
});

test("runs groups in their workspace and stops after a failed child", async (t) => {
	const root = await fixture(t);
	const first = join(root, "first");
	const second = join(root, "second");
	await mkdir(first);
	await mkdir(second);
	const fail = join(first, "failure.test.mjs");
	const skipped = join(second, "skipped.test.mjs");
	await writeFile(
		fail,
		`import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs'; writeFileSync('cwd-marker', process.cwd()); assert.fail('intentional child failure');`,
	);
	await writeFile(
		skipped,
		`import { writeFileSync } from 'node:fs'; writeFileSync('should-not-exist', 'ran');`,
	);
	const exitCode = await runTestGroups(
		[
			{ cwd: first, files: [fail] },
			{ cwd: second, files: [skipped] },
		],
		{ args: [], stdio: "ignore" },
	);
	assert.equal(exitCode, 1);
	const { readFile, access } = await import("node:fs/promises");
	assert.equal(await readFile(join(first, "cwd-marker"), "utf8"), first);
	await assert.rejects(access(join(second, "should-not-exist")), {
		code: "ENOENT",
	});
});

test("returns success for passing groups and rejects an empty selection", async (t) => {
	const root = await fixture(t);
	const file = join(root, "passing.test.mjs");
	await writeFile(
		file,
		"import assert from 'node:assert/strict'; assert.equal(1, 1);",
	);
	assert.equal(
		await runTestGroups([{ cwd: root, files: [file] }], {
			args: [],
			stdio: "ignore",
		}),
		0,
	);
	await assert.rejects(runTestGroups([]), /No test files/);
});
