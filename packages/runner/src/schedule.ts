export interface DeliveryPlanStep<T> {
	id: string;
	mode: "sequential" | "concurrent";
	delayBeforeMs: number;
	deliveries: readonly T[];
}

export interface ExecuteDeliveryPlanOptions<T> {
	steps: readonly DeliveryPlanStep<T>[];
	maxConcurrency: number;
	signal: AbortSignal;
	delay: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	now: () => Date;
	onScheduled: (
		step: DeliveryPlanStep<T>,
		delivery: T,
		scheduledAt: Date,
	) => Promise<void>;
	dispatch: (step: DeliveryPlanStep<T>, delivery: T) => Promise<void>;
}

async function executeConcurrent<T>(
	step: DeliveryPlanStep<T>,
	options: ExecuteDeliveryPlanOptions<T>,
): Promise<void> {
	let nextIndex = 0;
	let stopped = false;
	let firstError: unknown;

	async function consume(): Promise<void> {
		while (!stopped && !options.signal.aborted) {
			if (nextIndex >= step.deliveries.length) return;
			const index = nextIndex++;
			// Bounds determine queue exhaustion; undefined is a valid delivery.
			const delivery = step.deliveries[index] as T;
			try {
				await options.dispatch(step, delivery);
			} catch (error) {
				if (!stopped) firstError = error;
				stopped = true;
			}
		}
	}

	await Promise.all(
		Array.from(
			{ length: Math.min(options.maxConcurrency, step.deliveries.length) },
			() => consume(),
		),
	);
	// stopped also records thrown undefined, which is still a failure.
	if (stopped) throw firstError;
	options.signal.throwIfAborted();
}

export async function executeDeliveryPlan<T>(
	options: ExecuteDeliveryPlanOptions<T>,
): Promise<void> {
	if (
		!Number.isInteger(options.maxConcurrency) ||
		options.maxConcurrency < 1 ||
		options.maxConcurrency > 10
	) {
		throw new RangeError("maxConcurrency must be an integer from 1 to 10");
	}
	options.signal.throwIfAborted();
	for (const step of options.steps) {
		options.signal.throwIfAborted();
		if (step.delayBeforeMs > 0) {
			await options.delay(step.delayBeforeMs, options.signal);
			options.signal.throwIfAborted();
		}

		const scheduledAt = options.now();
		for (const delivery of step.deliveries) {
			options.signal.throwIfAborted();
			await options.onScheduled(step, delivery, scheduledAt);
		}
		options.signal.throwIfAborted();

		if (step.mode === "sequential") {
			for (const delivery of step.deliveries) {
				options.signal.throwIfAborted();
				await options.dispatch(step, delivery);
			}
			options.signal.throwIfAborted();
		} else {
			await executeConcurrent(step, options);
		}
	}
}
