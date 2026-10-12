import { z } from "zod";
import {
	businessIdSchema,
	parseScenarioV1,
	type ScenarioV1,
} from "./scenario-schema.js";
export const demoTargetIds = ["demo-flawed", "demo-corrected"] as const;
export const demoPaymentSchema = z.strictObject({
	id: businessIdSchema,
	type: z.literal("payment.succeeded"),
	data: z.strictObject({
		orderId: businessIdSchema,
		quantity: z.number().int().min(1).max(10),
	}),
});
export type DemoPayment = z.infer<typeof demoPaymentSchema>;
export const demoStatusSchema = z.strictObject({
	id: businessIdSchema,
	type: z.literal("order.status_changed"),
	data: z.strictObject({
		orderId: businessIdSchema,
		status: businessIdSchema.max(100),
		version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
	}),
});
export type DemoStatus = z.infer<typeof demoStatusSchema>;
export const demoEventSchema = z.discriminatedUnion("type", [
	demoPaymentSchema,
	demoStatusSchema,
]);
export type DemoEvent = z.infer<typeof demoEventSchema>;

export function validateDemoScenario(scenario: ScenarioV1): void {
	const parsed = parseScenarioV1(scenario);
	if (!demoTargetIds.some((targetId) => targetId === parsed.targetId)) {
		throw new z.ZodError([
			{
				code: "custom",
				path: ["targetId"],
				message: `unsupported demo target: ${parsed.targetId}`,
			},
		]);
	}
	const events = new Map<string, DemoEvent>();
	const orderQuantities = new Map<string, number>();
	for (const [index, event] of parsed.events.entries()) {
		const result = demoEventSchema.safeParse(event.payload);
		if (!result.success)
			throw new z.ZodError(
				result.error.issues.map((issue) => ({
					...issue,
					path: ["events", index, "payload", ...issue.path],
				})),
			);
		const payload = result.data;
		const previous = events.get(payload.id);
		if (previous && JSON.stringify(previous) !== JSON.stringify(payload)) {
			throw new z.ZodError([
				{
					code: "custom",
					path: ["events", index, "payload", "id"],
					message: `conflicting payload for logical event ID: ${payload.id}`,
				},
			]);
		}
		events.set(payload.id, payload);
		if (payload.type !== "payment.succeeded") continue;
		const quantity = orderQuantities.get(payload.data.orderId);
		if (quantity !== undefined && quantity !== payload.data.quantity) {
			throw new z.ZodError([
				{
					code: "custom",
					path: ["events", index, "payload", "data", "quantity"],
					message: `inconsistent quantity for order: ${payload.data.orderId}`,
				},
			]);
		}
		orderQuantities.set(payload.data.orderId, payload.data.quantity);
	}
}

export function demoOrders(
	scenario: ScenarioV1,
): Array<{ orderId: string; quantity: number }> {
	validateDemoScenario(scenario);
	const events = new Map(scenario.events.map((event) => [event.id, event]));
	const paymentQuantities = new Map<string, number>();
	for (const event of scenario.events) {
		const payload = demoEventSchema.parse(event.payload);
		if (payload.type === "payment.succeeded")
			paymentQuantities.set(payload.data.orderId, payload.data.quantity);
	}
	const orders = new Map<string, { orderId: string; quantity: number }>();
	for (const step of scenario.steps) {
		for (const delivery of step.deliveries) {
			const event = events.get(delivery.eventId);
			if (!event)
				throw new Error(`unknown event reference: ${delivery.eventId}`);
			const payload = demoEventSchema.parse(event.payload);
			orders.set(payload.data.orderId, {
				orderId: payload.data.orderId,
				quantity: paymentQuantities.get(payload.data.orderId) ?? 1,
			});
		}
	}
	return [...orders.values()];
}
