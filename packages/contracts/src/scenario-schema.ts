import { z } from "zod";
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };
export const MAX_IMPORT_BYTES = 1048576;
export const MAX_BODY_BYTES = 1048576;
export const MAX_DELIVERIES = 100;

// PostgreSQL JSONB cannot store NUL or unpaired UTF-16 surrogates.
const persistedTextSchema = z.string().refine((value) => {
	if (value.includes(String.fromCharCode(0))) return false;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(++index);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
		} else if (code >= 0xdc00 && code <= 0xdfff) return false;
	}
	return true;
}, "Text must be valid Unicode without NUL for PostgreSQL JSONB");

export const jsonScalarSchema = z.union([
	persistedTextSchema,
	z.number().finite(),
	z.boolean(),
	z.null(),
]);
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
	z.union([
		jsonScalarSchema,
		z.array(jsonValueSchema),
		z.record(persistedTextSchema, jsonValueSchema),
	]),
);

const configurationIdSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "must be a simple configuration ID");
export const businessIdSchema = persistedTextSchema
	.min(1)
	.max(200)
	.refine((value) => value.trim().length > 0, "must not be whitespace-only");
const nonemptyText = (maximum: number) =>
	persistedTextSchema
		.min(1)
		.max(maximum)
		.refine((value) => value.trim().length > 0, "must not be whitespace-only");

const eventSchema = z.strictObject({
	id: configurationIdSchema,
	payload: z.object({ id: businessIdSchema }).catchall(jsonValueSchema),
});
const deliverySchema = z.strictObject({
	deliveryId: configurationIdSchema,
	eventId: configurationIdSchema,
});
const stepSchema = z.strictObject({
	id: configurationIdSchema,
	mode: z.enum(["sequential", "concurrent"]),
	delayBeforeMs: z.number().int().min(0).max(5000),
	deliveries: z.array(deliverySchema).max(MAX_DELIVERIES),
});
const limitsSchema = z.strictObject({
	maxConcurrency: z.number().int().min(1).max(10),
	requestTimeoutMs: z.number().int().min(100).max(10000),
	runTimeoutMs: z.number().int().min(1000).max(60000),
});
const assertionSchema = z.strictObject({
	id: configurationIdSchema,
	name: nonemptyText(200),
	query: nonemptyText(10000),
	expected: jsonScalarSchema,
});

function reportDuplicates(
	values: readonly { id: string; path: (string | number)[] }[],
	label: string,
	context: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	for (const { id: value, path } of values) {
		if (seen.has(value))
			context.addIssue({
				code: "custom",
				path,
				message: `duplicate ${label} ID: ${value}`,
			});
		seen.add(value);
	}
}

const scenarioStructureSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		name: nonemptyText(200),
		description: persistedTextSchema.max(2000),
		targetId: configurationIdSchema,
		events: z.array(eventSchema).min(1).max(MAX_DELIVERIES),
		steps: z.array(stepSchema).min(1).max(MAX_DELIVERIES),
		limits: limitsSchema,
		assertions: z.array(assertionSchema).min(1).max(MAX_DELIVERIES),
	})
	.superRefine((scenario, context) => {
		reportDuplicates(
			scenario.events.map((event, index) => ({
				id: event.id,
				path: ["events", index, "id"],
			})),
			"event",
			context,
		);
		reportDuplicates(
			scenario.steps.map((step, index) => ({
				id: step.id,
				path: ["steps", index, "id"],
			})),
			"step",
			context,
		);
		reportDuplicates(
			scenario.assertions.map((assertion, index) => ({
				id: assertion.id,
				path: ["assertions", index, "id"],
			})),
			"assertion",
			context,
		);
		const deliveries = scenario.steps.flatMap((step) => step.deliveries);
		reportDuplicates(
			scenario.steps.flatMap((step, stepIndex) =>
				step.deliveries.map((delivery, deliveryIndex) => ({
					id: delivery.deliveryId,
					path: ["steps", stepIndex, "deliveries", deliveryIndex, "deliveryId"],
				})),
			),
			"delivery",
			context,
		);
		if (deliveries.length === 0) {
			context.addIssue({
				code: "custom",
				path: ["steps"],
				message: "at least one delivery is required",
			});
		}
		if (deliveries.length > MAX_DELIVERIES) {
			context.addIssue({
				code: "custom",
				path: ["steps"],
				message: `at most ${MAX_DELIVERIES} deliveries are allowed`,
			});
		}
		const eventIds = new Set(scenario.events.map((event) => event.id));
		scenario.steps.forEach((step, stepIndex) => {
			step.deliveries.forEach((delivery, deliveryIndex) => {
				if (!eventIds.has(delivery.eventId)) {
					context.addIssue({
						code: "custom",
						path: ["steps", stepIndex, "deliveries", deliveryIndex, "eventId"],
						message: `unknown event reference: ${delivery.eventId}`,
					});
				}
			});
		});
	});

// Bound the raw object before schema traversal so every parsing entry point
// applies the same UTF-8 limit, including callers that use the schema directly.
export const scenarioV1Schema = z
	.unknown()
	.superRefine((input, context) => {
		try {
			const serialized = JSON.stringify(input);
			if (
				serialized !== undefined &&
				new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES
			) {
				context.addIssue({
					code: "custom",
					message: "scenario body exceeds the 1 MiB size limit",
				});
			}
		} catch {
			context.addIssue({
				code: "custom",
				message: "scenario body must be serializable JSON",
			});
		}
	})
	.pipe(scenarioStructureSchema);

export type ScenarioV1 = z.infer<typeof scenarioV1Schema>;

export function parseScenarioV1(input: unknown): ScenarioV1 {
	return scenarioV1Schema.parse(input);
}
