import { z } from "zod";
import {
	businessIdSchema,
	parseScenarioV1,
	type ScenarioV1,
} from "./scenario.js";
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

export function validateDemoScenario(scenario: ScenarioV1): void {
	const parsed = parseScenarioV1(scenario);
	if (!demoTargetIds.some((targetId) => targetId === parsed.targetId)) {
		throw new Error(`unsupported demo target: ${parsed.targetId}`);
	}
	const events = new Map<string, DemoPayment>();
	const orderQuantities = new Map<string, number>();
	for (const event of parsed.events) {
		const payment = demoPaymentSchema.parse(event.payload);
		const previous = events.get(payment.id);
		if (
			previous &&
			(previous.data.orderId !== payment.data.orderId ||
				previous.data.quantity !== payment.data.quantity)
		) {
			throw new Error(
				`conflicting payload for logical event ID: ${payment.id}`,
			);
		}
		events.set(payment.id, payment);
		const quantity = orderQuantities.get(payment.data.orderId);
		if (quantity !== undefined && quantity !== payment.data.quantity) {
			throw new Error(
				`inconsistent quantity for order: ${payment.data.orderId}`,
			);
		}
		orderQuantities.set(payment.data.orderId, payment.data.quantity);
	}
}

export function demoOrders(
	scenario: ScenarioV1,
): Array<{ orderId: string; quantity: number }> {
	validateDemoScenario(scenario);
	const events = new Map(scenario.events.map((event) => [event.id, event]));
	const orders = new Map<string, { orderId: string; quantity: number }>();
	for (const step of scenario.steps) {
		for (const delivery of step.deliveries) {
			const event = events.get(delivery.eventId);
			if (!event)
				throw new Error(`unknown event reference: ${delivery.eventId}`);
			const payment = demoPaymentSchema.parse(event.payload);
			orders.set(payment.data.orderId, { ...payment.data });
		}
	}
	return [...orders.values()];
}
