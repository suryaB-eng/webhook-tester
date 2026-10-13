import type {
	PublicTarget,
	RunResponse,
	RunStatus,
} from "@webhook-tester/contracts";
import { useEffect, useRef, useState } from "react";
import { loadTargets, rerunRun } from "./api";

export function RerunForm({
	status,
	targets,
	targetId,
	pending,
	loading,
	onTarget,
	onRerun,
}: {
	status: RunStatus;
	targets: PublicTarget[];
	targetId: string;
	pending: boolean;
	loading: boolean;
	onTarget: (targetId: string) => void;
	onRerun: () => void;
}) {
	const terminal = status !== "queued" && status !== "running";
	const available = targets.some((target) => target.id === targetId);
	return (
		<form
			className="rerun-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (terminal && available && !pending && !loading) onRerun();
			}}
		>
			<div className="form-field">
				<label>
					Rerun with
					<select
						value={targetId}
						disabled={loading || pending || !terminal}
						onChange={(event) => onTarget(event.target.value)}
					>
						<option value="">Choose a target</option>
						{targets.map((target) => (
							<option key={target.id} value={target.id}>
								{target.name}
							</option>
						))}
					</select>
				</label>
			</div>
			<button
				type="submit"
				className="primary"
				disabled={!terminal || !available || pending || loading}
			>
				{pending ? "Starting..." : "Rerun"}
			</button>
			{!terminal && (
				<p className="section-help picker-help">
					This run must complete before it can be rerun.
				</p>
			)}
		</form>
	);
}

export function RerunControls({ run }: { run: RunResponse }) {
	const [targets, setTargets] = useState<PublicTarget[]>([]);
	const [targetId, setTargetId] = useState("");
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const requestController = useRef<AbortController | null>(null);
	const currentTargetId = run.targetSnapshot.id;

	// biome-ignore lint/correctness/useExhaustiveDependencies: A retry reloads configured targets.
	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		setError(null);
		void loadTargets(controller.signal)
			.then((profiles) => {
				if (controller.signal.aborted) return;
				setTargets(profiles);
				setTargetId(
					profiles.find((profile) => profile.id === currentTargetId)?.id ??
						profiles[0]?.id ??
						"",
				);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted)
					setError(
						reason instanceof Error
							? reason.message
							: "Unable to load targets.",
					);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [attempt, currentTargetId]);
	useEffect(() => () => requestController.current?.abort(), []);

	async function rerun() {
		if (
			pending ||
			run.status === "queued" ||
			run.status === "running" ||
			!targets.some((target) => target.id === targetId)
		)
			return;
		const controller = new AbortController();
		requestController.current = controller;
		setPending(true);
		setError(null);
		try {
			const newId = await rerunRun(run.id, targetId, controller.signal);
			if (!controller.signal.aborted)
				window.location.hash = `/runs/${encodeURIComponent(newId)}`;
		} catch (reason) {
			if (!controller.signal.aborted)
				setError(
					reason instanceof Error
						? reason.message
						: "Unable to rerun this snapshot.",
				);
		} finally {
			if (!controller.signal.aborted) setPending(false);
		}
	}

	return (
		<section className="panel" aria-label="Rerun saved snapshot">
			<p className="section-help">
				Start a new run using this saved scenario snapshot.
			</p>
			<RerunForm
				status={run.status}
				targets={targets}
				targetId={targetId}
				loading={loading}
				pending={pending}
				onTarget={setTargetId}
				onRerun={() => void rerun()}
			/>
			{loading && <p role="status">Loading targets...</p>}
			{!loading && !error && targets.length === 0 && (
				<p className="section-help">No configured targets are available.</p>
			)}
			{error && (
				<div className="notice error" role="alert">
					<p>{error}</p>
					{targets.length === 0 && (
						<button
							type="button"
							onClick={() => setAttempt((value) => value + 1)}
						>
							Retry targets
						</button>
					)}
				</div>
			)}
		</section>
	);
}
