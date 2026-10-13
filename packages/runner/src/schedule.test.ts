import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
	executeDeliveryPlan,
	type DeliveryPlanStep,
	type ExecuteDeliveryPlanOptions,
} from "./schedule.js";

function gate() {
	let resolve!: () => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<void>((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

function step<T>(
	deliveries: readonly T[],
	mode: "sequential" | "concurrent" = "concurrent",
	id = "first",
	delayBeforeMs = 0,
): DeliveryPlanStep<T> {
	return { id, mode, delayBeforeMs, deliveries };
}

function options<T>(
	steps: readonly DeliveryPlanStep<T>[],
	overrides: Partial<ExecuteDeliveryPlanOptions<T>> = {},
): ExecuteDeliveryPlanOptions<T> {
	return {
		steps,
		maxConcurrency: 2,
		signal: new AbortController().signal,
		delay: async () => {},
		now: () => new Date("2026-10-12T10:00:00Z"),
		onScheduled: async () => {},
		dispatch: async () => {},
		...overrides,
	};
}

function observe(run: Promise<void>) {
	let settled = false;
	const result = run.then(
		() => {
			settled = true;
			return { ok: true as const };
		},
		(error: unknown) => {
			settled = true;
			return { ok: false as const, error };
		},
	);
	return { result, settled: () => settled };
}

test("rejects invalid concurrency before scheduling or dispatching", async () => {
	for (const maxConcurrency of [0, -1, 1.5, 11, NaN, Infinity]) {
		let work = 0;
		await assert.rejects(
			executeDeliveryPlan(
				options([step([1])], {
					maxConcurrency,
					onScheduled: async () => {
						work += 1;
					},
					dispatch: async () => {
						work += 1;
					},
				}),
			),
			RangeError,
		);
		assert.equal(work, 0);
	}
});

for (const maxConcurrency of [1, 2, 10]) {
	test(`concurrent deliveries fill and respect ${maxConcurrency} slots`, async () => {
		const deliveries = Array.from({ length: maxConcurrency + 2 }, (_, i) => i);
		const responses = deliveries.map(() => gate());
		const started: number[] = [];
		const scheduled: number[] = [];
		let active = 0;
		let peak = 0;
		const run = observe(
			executeDeliveryPlan(
				options([step(deliveries)], {
					maxConcurrency,
					onScheduled: async (_step, delivery) => {
						scheduled.push(delivery);
					},
					dispatch: async (_step, delivery) => {
						assert.deepEqual(scheduled, deliveries);
						started.push(delivery);
						active += 1;
						peak = Math.max(peak, active);
						const response = responses[delivery];
						assert.ok(response);
						await response.promise;
						active -= 1;
					},
				}),
			),
		);
		try {
			await setImmediate();
			assert.deepEqual(started, deliveries.slice(0, maxConcurrency));
			assert.equal(run.settled(), false);
			responses[0]?.resolve();
			await setImmediate();
			assert.deepEqual(started, deliveries.slice(0, maxConcurrency + 1));
		} finally {
			for (const response of responses) response.resolve();
			await run.result;
		}
		assert.deepEqual(await run.result, { ok: true });
		assert.deepEqual(started, deliveries);
		assert.equal(peak, maxConcurrency);
	});
}

test("sequential dispatch waits for each response even with ten available slots", async () => {
	const responses = [gate(), gate(), gate()];
	const started: number[] = [];
	const run = observe(
		executeDeliveryPlan(
			options([step([0, 1, 2], "sequential")], {
				maxConcurrency: 10,
				dispatch: async (_step, delivery) => {
					started.push(delivery);
					const response = responses[delivery];
					assert.ok(response);
					await response.promise;
				},
			}),
		),
	);
	try {
		await setImmediate();
		assert.deepEqual(started, [0]);
		responses[0]?.resolve();
		await setImmediate();
		assert.deepEqual(started, [0, 1]);
		responses[1]?.resolve();
		await setImmediate();
		assert.deepEqual(started, [0, 1, 2]);
		assert.equal(run.settled(), false);
	} finally {
		for (const response of responses) response.resolve();
		await run.result;
	}
	assert.deepEqual(await run.result, { ok: true });
});

test("steps follow array order and delay starts after previous responses finish", async () => {
	const firstResponse = gate();
	const delayed = gate();
	const calls: string[] = [];
	const controller = new AbortController();
	const run = observe(
		executeDeliveryPlan(
			options(
				[step([1], "concurrent", "z"), step([2, 3], "sequential", "a", 250)],
				{
					signal: controller.signal,
					delay: async (milliseconds, signal) => {
						assert.equal(milliseconds, 250);
						assert.equal(signal, controller.signal);
						calls.push("delay");
						await delayed.promise;
					},
					onScheduled: async (current, delivery) => {
						calls.push(`schedule:${current.id}:${delivery}`);
					},
					dispatch: async (current, delivery) => {
						calls.push(`dispatch:${current.id}:${delivery}`);
						if (delivery === 1) await firstResponse.promise;
					},
				},
			),
		),
	);
	try {
		await setImmediate();
		assert.deepEqual(calls, ["schedule:z:1", "dispatch:z:1"]);
		firstResponse.resolve();
		await setImmediate();
		assert.deepEqual(calls, ["schedule:z:1", "dispatch:z:1", "delay"]);
		delayed.resolve();
		assert.deepEqual(await run.result, { ok: true });
		assert.deepEqual(calls, [
			"schedule:z:1",
			"dispatch:z:1",
			"delay",
			"schedule:a:2",
			"schedule:a:3",
			"dispatch:a:2",
			"dispatch:a:3",
		]);
	} finally {
		firstResponse.resolve();
		delayed.resolve();
		await run.result;
	}
});

test("all deliveries share their step timestamp, including queued deliveries", async () => {
	const first = new Date("2026-10-12T10:00:00Z");
	const second = new Date("2026-10-12T10:00:01Z");
	const times = [first, second];
	const scheduled: [number, Date][] = [];
	let clockCalls = 0;
	await executeDeliveryPlan(
		options([step([1, 2, 3]), step([4], "sequential", "second")], {
			maxConcurrency: 1,
			now: () => {
				const time = times[clockCalls++];
				assert.ok(time);
				return time;
			},
			onScheduled: async (_step, delivery, scheduledAt) => {
				scheduled.push([delivery, scheduledAt]);
			},
		}),
	);
	assert.equal(clockCalls, 2);
	assert.deepEqual(scheduled, [
		[1, first],
		[2, first],
		[3, first],
		[4, second],
	]);
	for (const [, time] of scheduled.slice(0, 3)) assert.equal(time, first);
});

test("abort stops new dispatches and waits for every active response, including rejection", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled");
	const responses = [gate(), gate()];
	const started: number[] = [];
	const run = observe(
		executeDeliveryPlan(
			options([step([0, 1, 2]), step([3], "sequential", "later", 5)], {
				signal: controller.signal,
				delay: async () => {
					assert.fail("later delay must not start");
				},
				dispatch: async (_step, delivery) => {
					started.push(delivery);
					const response = responses[delivery];
					assert.ok(response);
					await response.promise;
				},
			}),
		),
	);
	try {
		await setImmediate();
		assert.deepEqual(started, [0, 1]);
		controller.abort(reason);
		responses[0]?.reject(reason);
		await setImmediate();
		assert.equal(run.settled(), false);
		assert.deepEqual(started, [0, 1]);
		responses[1]?.resolve();
		assert.deepEqual(await run.result, { ok: false, error: reason });
	} finally {
		for (const response of responses) response.resolve();
		await run.result;
	}
});

for (const failure of [new Error("dispatch failed"), undefined]) {
	test(`dispatch failure (${String(failure)}) stops queued work and settles active promises`, async () => {
		const responses = [gate(), gate()];
		const started: number[] = [];
		const run = observe(
			executeDeliveryPlan(
				options([step([0, 1, 2]), step([3], "concurrent", "later")], {
					dispatch: async (_step, delivery) => {
						started.push(delivery);
						const response = responses[delivery];
						assert.ok(response);
						await response.promise;
					},
				}),
			),
		);
		try {
			await setImmediate();
			assert.deepEqual(started, [0, 1]);
			responses[0]?.reject(failure);
			await setImmediate();
			assert.equal(run.settled(), false);
			assert.deepEqual(started, [0, 1]);
			responses[1]?.reject(new Error("second response also failed"));
			assert.deepEqual(await run.result, { ok: false, error: failure });
		} finally {
			for (const response of responses) response.resolve();
			await run.result;
		}
	});
}

test("synchronous dispatch throws stop dispatch and still wait for earlier work", async () => {
	const firstResponse = gate();
	const failure = new Error("synchronous failure");
	const started: number[] = [];
	const run = observe(
		executeDeliveryPlan(
			options([step([0, 1, 2])], {
				dispatch: (_step, delivery) => {
					started.push(delivery);
					if (delivery === 1) throw failure;
					return firstResponse.promise;
				},
			}),
		),
	);
	try {
		await setImmediate();
		assert.deepEqual(started, [0, 1]);
		assert.equal(run.settled(), false);
		firstResponse.resolve();
		assert.deepEqual(await run.result, { ok: false, error: failure });
	} finally {
		firstResponse.resolve();
		await run.result;
	}
});

test("scheduling failure stops remaining scheduling and prevents dispatch", async () => {
	const failure = new Error("scheduling failed");
	const scheduled: number[] = [];
	let dispatches = 0;
	const run = observe(
		executeDeliveryPlan(
			options([step([1, 2, 3]), step([4])], {
				onScheduled: async (_step, delivery) => {
					scheduled.push(delivery);
					if (delivery === 2) throw failure;
				},
				dispatch: async () => {
					dispatches += 1;
				},
			}),
		),
	);
	assert.deepEqual(await run.result, { ok: false, error: failure });
	assert.deepEqual(scheduled, [1, 2]);
	assert.equal(dispatches, 0);
});

test("abort during scheduling stops remaining scheduling and prevents dispatch", async () => {
	const controller = new AbortController();
	const reason = new Error("cancelled while scheduling");
	const scheduled: number[] = [];
	let dispatches = 0;
	const run = observe(
		executeDeliveryPlan(
			options([step([1, 2, 3])], {
				signal: controller.signal,
				onScheduled: async (_step, delivery) => {
					scheduled.push(delivery);
					controller.abort(reason);
				},
				dispatch: async () => {
					dispatches += 1;
				},
			}),
		),
	);
	assert.deepEqual(await run.result, { ok: false, error: reason });
	assert.deepEqual(scheduled, [1]);
	assert.equal(dispatches, 0);
});

test("pre-aborted plans reject without invoking any callback", async () => {
	const controller = new AbortController();
	const reason = new Error("already aborted");
	controller.abort(reason);
	const unexpected = () => {
		assert.fail("callback invoked after abort");
	};
	const run = observe(
		executeDeliveryPlan(
			options([step([1], "sequential", "first", 5)], {
				signal: controller.signal,
				delay: async () => unexpected(),
				now: unexpected,
				onScheduled: async () => unexpected(),
				dispatch: async () => unexpected(),
			}),
		),
	);
	assert.deepEqual(await run.result, { ok: false, error: reason });
});

test("abort during delay prevents timestamping, scheduling, and dispatch", async () => {
	const delayed = gate();
	const controller = new AbortController();
	const reason = new Error("cancelled during delay");
	let delayStarted = false;
	const unexpected = () => {
		assert.fail("work started after delay abort");
	};
	const run = observe(
		executeDeliveryPlan(
			options([step([1], "concurrent", "first", 5)], {
				signal: controller.signal,
				delay: async () => {
					delayStarted = true;
					await delayed.promise;
				},
				now: unexpected,
				onScheduled: async () => unexpected(),
				dispatch: async () => unexpected(),
			}),
		),
	);
	try {
		await setImmediate();
		assert.equal(delayStarted, true);
		controller.abort(reason);
		delayed.resolve();
		assert.deepEqual(await run.result, { ok: false, error: reason });
	} finally {
		delayed.resolve();
		await run.result;
	}
});

test("undefined delivery values are dispatched rather than ending the queue", async () => {
	const deliveries: (number | undefined)[] = [undefined, 1, undefined, 2];
	const started: (number | undefined)[] = [];
	await executeDeliveryPlan(
		options([step(deliveries)], {
			maxConcurrency: 1,
			dispatch: async (_step, delivery) => {
				started.push(delivery);
			},
		}),
	);
	assert.deepEqual(started, [undefined, 1, undefined, 2]);
});

test("empty plans and empty steps complete without dispatch", async () => {
	let dispatches = 0;
	for (const steps of [[], [step([])]]) {
		await executeDeliveryPlan(
			options(steps, {
				dispatch: async () => {
					dispatches += 1;
				},
			}),
		);
	}
	assert.equal(dispatches, 0);
});
