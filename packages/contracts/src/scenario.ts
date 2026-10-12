import { validateDemoScenario } from "./demo.js";
import {
	MAX_IMPORT_BYTES,
	parseScenarioV1,
	type ScenarioV1,
} from "./scenario-schema.js";
export * from "./scenario-schema.js";

export function parseScenarioImport(source: string): ScenarioV1 {
	if (new TextEncoder().encode(source).byteLength > MAX_IMPORT_BYTES)
		throw new Error("scenario import exceeds the 1 MiB size limit");
	let input: unknown;
	try {
		input = JSON.parse(source);
	} catch (cause) {
		throw new Error("scenario import is not valid JSON", { cause });
	}
	const document = parseScenarioV1(input);
	validateDemoScenario(document);
	return document;
}

export function serializeScenarioExport(input: unknown): string {
	const document = parseScenarioV1(input);
	validateDemoScenario(document);
	const formatted = JSON.stringify(document, null, 2);
	// A document near the import limit must still round-trip after export.
	return new TextEncoder().encode(formatted).byteLength <= MAX_IMPORT_BYTES
		? formatted
		: JSON.stringify(document);
}
