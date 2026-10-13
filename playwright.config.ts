import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	globalTimeout: 480_000,
	expect: { timeout: 15_000 },
	outputDir: "test-results",
	reporter: [["list"], ["html", { open: "never" }]],
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:14173",
		actionTimeout: 15_000,
		navigationTimeout: 20_000,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	projects: [
		{ name: "chromium", use: { ...devices["Desktop Chrome"], headless: true } },
	],
});
