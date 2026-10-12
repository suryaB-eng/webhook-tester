import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
	demoOrders,
	parseScenarioV1,
	validateDemoScenario,
} from "@webhook-tester/contracts";
import { cleanupDemoFixtures, prepareDemoFixtures } from "@webhook-tester/db";
import { executeDeliveryPlan } from "@webhook-tester/runner";
import type { Pool } from "pg";
import { executeAssertion } from "./assertions.js";
import * as repository from "./repository.js";
import { budgetSession } from "./session.js";
import { deliverWebhook, type WorkerTargetProfile } from "./target.js";

export interface WorkerOptions {
	appPool: Pool;
	fixturePool: Pool;
	queryPool: Pool;
	targetProfiles: ReadonlyMap<string, WorkerTargetProfile>;
	workerId: string;
}
const OWNERSHIP_LOCK = 716053;
class OwnershipLost extends Error {}
class RunTimeout extends Error {}

export async function runWorkerOnce(
	options: WorkerOptions,
): Promise<"processed" | "idle" | "not-owner"> {
	const session = await options.appPool.connect();
	let owns = false;
	let lost = false;
	let released = false;
	const stopDeliveries = new AbortController();
	const onError = () => {
		lost = true;
		stopDeliveries.abort(
			new OwnershipLost("Worker ownership lost; run was not replayed"),
		);
	};
	session.on("error", onError);
	try {
		owns =
			(
				await session.query<{ owned: boolean }>(
					"SELECT pg_try_advisory_lock($1) AS owned",
					[OWNERSHIP_LOCK],
				)
			).rows[0]?.owned === true;
		if (!owns) return "not-owner";
		await session.query("SET statement_timeout = 2000");
		await repository.interruptAbandoned(session);
		const run = await repository.claimNext(session, options.workerId);
		if (!run) return "idle";
		const runId = run.id;

		async function probe() {
			try {
				if (lost) throw new OwnershipLost();
				await session.query("SET statement_timeout = 2000");
				const result = await session.query<{ owned: boolean }>(
					`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
          AND classid=0 AND objid=$1 AND granted) AS owned`,
					[OWNERSHIP_LOCK],
				);
				if (
					!result.rows[0]?.owned ||
					!(await repository.stillAssigned(session, runId, options.workerId))
				)
					throw new OwnershipLost();
			} catch (caught) {
				if (
					typeof caught === "object" &&
					caught !== null &&
					"code" in caught &&
					caught.code === "57014"
				)
					throw new RunTimeout("Overall run timeout during ownership probe");
				lost = true;
				stopDeliveries.abort(
					new OwnershipLost("Worker ownership lost; run was not replayed"),
				);
				throw new OwnershipLost("Worker ownership lost; run was not replayed");
			}
		}

		let status: "passed" | "failed" | "error" | "interrupted" = "passed";
		let error: string | null = null;
		let prepared = false;
		let uncertain = false;
		let pendingObservations = 0;
		// Serialize complete operations on the owning session, including timeout settings.
		let sessionWork: Promise<unknown> = Promise.resolve();
		function owned<T>(operation: () => Promise<T>): Promise<T> {
			const pending = sessionWork.then(operation);
			sessionWork = pending.then(
				() => undefined,
				() => undefined,
			);
			return pending;
		}
		const started = performance.now();
		let deadline = started;
		const execution = budgetSession(session, () => deadline);
		const observations = budgetSession(session, () => performance.now() + 2000);
		const checkDeadline = () => {
			if (performance.now() >= deadline)
				throw new RunTimeout("Overall run timeout");
		};
		try {
			const scenario = parseScenarioV1(run.scenario);
			validateDemoScenario(scenario);
			deadline = started + scenario.limits.runTimeoutMs;
			const runSignal = AbortSignal.timeout(
				Math.max(1, Math.ceil(deadline - performance.now())),
			);
			const target = options.targetProfiles.get(run.target.id);
			if (
				!target ||
				target.id !== scenario.targetId ||
				target.completion.kind !== "synchronous"
			)
				throw new Error(
					"Supported synchronous target configuration is missing",
				);
			await probe();
			checkDeadline();
			await prepareDemoFixtures(
				options.fixturePool,
				run.id,
				demoOrders(scenario),
				{ timeoutMs: deadline - performance.now() },
			);
			prepared = true;
			await probe();
			checkDeadline();
			await repository.phase(execution, run.id, "delivery");
			const events = new Map(
				scenario.events.map((event) => [event.id, event.payload]),
			);
			const planSignal = AbortSignal.any([runSignal, stopDeliveries.signal]);
			try {
				await executeDeliveryPlan({
					steps: scenario.steps,
					maxConcurrency: scenario.limits.maxConcurrency,
					signal: planSignal,
					delay: async (milliseconds, signal) => {
						await delay(milliseconds, undefined, { signal });
					},
					now: () => new Date(),
					onScheduled: async (_step, delivery, scheduledAt) => {
						await owned(async () => {
							planSignal.throwIfAborted();
							await probe();
							checkDeadline();
							await repository.schedule(
								execution,
								run.id,
								delivery.deliveryId,
								scheduledAt,
							);
						});
					},
					dispatch: async (_step, delivery) => {
						try {
							const payload = events.get(delivery.eventId);
							if (!payload)
								throw new Error("Validated event reference is missing");
							await owned(async () => {
								planSignal.throwIfAborted();
								await probe();
								checkDeadline();
								await repository.startDelivery(
									execution,
									run.id,
									delivery.deliveryId,
								);
								await probe();
								checkDeadline();
								planSignal.throwIfAborted();
							});
							planSignal.throwIfAborted();
							// A peer failure stops new dispatches without abandoning started responses.
							const result = await deliverWebhook({
								profile: target,
								runId: run.id,
								deliveryId: delivery.deliveryId,
								payload,
								requestTimeoutMs: scenario.limits.requestTimeoutMs,
								runSignal,
							});
							uncertain ||= result.uncertain;
							pendingObservations++;
							const deliveryError =
								result.outcome === "error"
									? new Error(result.error ?? "Webhook delivery error")
									: null;
							if (deliveryError) stopDeliveries.abort(deliveryError);
							await owned(async () => {
								await probe();
								await repository.completeDelivery(
									observations,
									run.id,
									delivery.deliveryId,
									result,
								);
								pendingObservations--;
							});
							if (deliveryError) throw deliveryError;
							if (result.outcome === "failed") status = "failed";
						} catch (caught) {
							stopDeliveries.abort(caught);
							throw caught;
						}
					},
				});
			} catch (caught) {
				if (runSignal.aborted && !(caught instanceof OwnershipLost))
					throw new RunTimeout("Overall run timeout during delivery plan");
				throw caught;
			}
			checkDeadline();
			await repository.phase(execution, run.id, "assertions");
			for (const assertion of scenario.assertions) {
				await probe();
				checkDeadline();
				const result = await executeAssertion(
					options.queryPool,
					run.id,
					assertion,
					deadline - performance.now(),
				);
				pendingObservations++;
				await probe();
				await repository.completeAssertion(
					observations,
					run.id,
					assertion.id,
					result,
				);
				pendingObservations--;
				if (result.status === "error") {
					status = "error";
					error ??= result.error;
				} else if (result.status === "failed" && status !== "error")
					status = "failed";
			}
			checkDeadline();
		} catch (caught) {
			if (caught instanceof OwnershipLost || lost) status = "interrupted";
			else status = "error";
			error = caught instanceof Error ? caught.message : "Run execution failed";
		}

		// Persist observations before cleanup. Retain uncertain HTTP work in its own run.
		if (
			prepared &&
			!uncertain &&
			pendingObservations === 0 &&
			status !== "interrupted"
		) {
			try {
				await probe();
				await repository.phase(observations, run.id, "cleanup");
				await probe();
				if (lost)
					throw new OwnershipLost(
						"Worker ownership lost before fixture cleanup",
					);
				await cleanupDemoFixtures(options.fixturePool, run.id, {
					timeoutMs: 2000,
				});
				await probe();
			} catch (caught) {
				status =
					caught instanceof OwnershipLost || lost ? "interrupted" : "error";
				error =
					caught instanceof Error ? caught.message : "Fixture cleanup failed";
			}
		}
		if ((uncertain || pendingObservations > 0) && status !== "interrupted")
			error = `${error ?? "Uncertain target work"}; run-scoped fixtures retained`;
		try {
			await probe();
		} catch (caught) {
			status =
				caught instanceof OwnershipLost || lost ? "interrupted" : "error";
			error =
				caught instanceof Error ? caught.message : "Worker ownership lost";
		}
		if (status === "interrupted") {
			session.release(true);
			released = true;
			await repository.finishInterrupted(
				options.appPool,
				run.id,
				options.workerId,
				error,
			);
		} else {
			try {
				await repository.finishOwned(
					observations,
					run.id,
					options.workerId,
					status,
					error,
				);
			} catch (caught) {
				// A disconnect can occur between the last probe and the terminal transaction.
				try {
					await probe();
				} catch {
					/* probe records lost ownership */
				}
				if (!lost) throw caught;
				session.release(true);
				released = true;
				await repository.finishInterrupted(
					options.appPool,
					run.id,
					options.workerId,
					"Worker ownership lost during finalization; run was not replayed",
				);
			}
		}
		return "processed";
	} catch (caught) {
		if (lost) return "not-owner";
		throw caught;
	} finally {
		try {
			if (owns && !lost && !released) {
				await session.query("SET statement_timeout = 2000");
				await session.query("SELECT pg_advisory_unlock($1)", [OWNERSHIP_LOCK]);
				await session.query("SET statement_timeout = 0");
			}
		} catch {
			lost = true;
		} finally {
			if (!released) session.release(lost);
			// Healthy clients now have the pool's idle error handler. Discarded clients keep
			// this listener through asynchronous close/error events until pg disposes them.
			if (!lost && !released) session.removeListener("error", onError);
		}
	}
}
