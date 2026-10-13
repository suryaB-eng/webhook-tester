import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

async function testFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await testFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".test.ts"))
			files.push(path);
	}
	return files.sort();
}

export async function discoverTestGroups(root, mode) {
	if (mode !== "unit" && mode !== "integration") {
		throw new Error("Select unit or integration tests");
	}
	const { workspaces } = JSON.parse(
		await readFile(join(root, "package.json"), "utf8"),
	);
	const groups = [];
	for (const workspace of workspaces) {
		const cwd = resolve(root, workspace);
		const files = (await testFiles(join(cwd, "src"))).filter(
			(file) =>
				file.endsWith(".integration.test.ts") === (mode === "integration"),
		);
		if (files.length) groups.push({ cwd, files });
	}
	return groups;
}

export async function runTestGroups(
	groups,
	{
		args = ["--import", "tsx", "--test", "--test-concurrency=1"],
		stdio = "inherit",
	} = {},
) {
	if (!groups.length) throw new Error("No test files selected");
	for (const { cwd, files } of groups) {
		const exitCode = await new Promise((resolveExit, reject) => {
			const child = spawn(process.execPath, [...args, ...files], {
				cwd,
				stdio,
			});
			child.once("error", reject);
			child.once("exit", (code) => resolveExit(code ?? 1));
		});
		if (exitCode !== 0) return exitCode;
	}
	return 0;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	try {
		process.exitCode = await runTestGroups(
			await discoverTestGroups(root, process.argv[2]),
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
