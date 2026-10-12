import {
	MAX_IMPORT_BYTES,
	parseScenarioImport,
	serializeScenarioExport,
	type ScenarioV1,
} from "@webhook-tester/contracts";
import { useEffect, useRef, useState } from "react";
import { ApiError, createScenario, loadScenario, updateScenario } from "./api";
import { AssertionEditor } from "./AssertionEditor";
import { EditorField, GroupErrors } from "./EditorField";
import { EventEditor } from "./EventEditor";
import {
	createDefaultDraft,
	scenarioToDraft,
	validateDraft,
	type ScenarioDraft,
} from "./editor-model";
import { StepEditor } from "./StepEditor";

function messageOf(error: unknown) {
	if (
		error &&
		typeof error === "object" &&
		"issues" in error &&
		Array.isArray(error.issues) &&
		error.issues.length
	) {
		return error.issues
			.map((issue: unknown) => {
				if (
					!issue ||
					typeof issue !== "object" ||
					!("message" in issue) ||
					typeof issue.message !== "string"
				)
					return "Invalid scenario field.";
				const path =
					"path" in issue
						? Array.isArray(issue.path)
							? issue.path.join(".")
							: typeof issue.path === "string"
								? issue.path
								: ""
						: "";
				return `${path || "Scenario"}: ${issue.message}`;
			})
			.join("\n");
	}
	return error instanceof Error
		? error.message
		: "Unable to complete the request.";
}

export function downloadScenario(document: ScenarioV1) {
	const source = serializeScenarioExport(document);
	const url = URL.createObjectURL(
		new Blob([source], { type: "application/json;charset=utf-8" }),
	);
	const link = window.document.createElement("a");
	link.href = url;
	link.download = `${document.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80) || "scenario"}.json`;
	window.document.body.append(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ScenarioImport({
	onImport,
}: {
	onImport: (document: ScenarioV1) => void;
}) {
	const [source, setSource] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [reading, setReading] = useState(false);
	function preview(text: string) {
		try {
			const document = parseScenarioImport(text);
			setError(null);
			onImport(document);
		} catch (reason) {
			setError(messageOf(reason));
		}
	}
	return (
		<section className="import-controls">
			<p className="section-help">
				Import a ScenarioV1 JSON document (up to 1 MiB). Preview opens a local
				draft; save when ready.
			</p>
			<label className="form-field">
				<span>Scenario JSON file</span>
				<input
					type="file"
					accept=".json,application/json"
					disabled={reading}
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (!file) return;
						if (file.size > MAX_IMPORT_BYTES) {
							setError("Scenario import exceeds the 1 MiB size limit.");
							return;
						}
						setReading(true);
						void file
							.text()
							.then(preview)
							.catch((reason: unknown) => setError(messageOf(reason)))
							.finally(() => setReading(false));
					}}
				/>
			</label>
			<label className="form-field">
				<span>Or paste scenario JSON</span>
				<textarea
					className="mono"
					rows={6}
					spellCheck={false}
					value={source}
					onChange={(event) => setSource(event.target.value)}
				/>
			</label>
			<button
				type="button"
				disabled={reading || !source.trim()}
				onClick={() => preview(source)}
			>
				Preview imported draft
			</button>
			{reading && <p role="status">Reading JSON file…</p>}
			{error && (
				<p className="field-error" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}

export function ScenarioEditor({
	scenarioId,
	initialDocument,
	onDirtyChange,
}: {
	scenarioId?: string;
	initialDocument?: ScenarioV1;
	onDirtyChange: (dirty: boolean) => void;
}) {
	const [draft, setDraft] = useState<ScenarioDraft>(() =>
		initialDocument ? scenarioToDraft(initialDocument) : createDefaultDraft(),
	);
	const [baseline, setBaseline] = useState(() =>
		initialDocument ? "" : JSON.stringify(draft),
	);
	const [revision, setRevision] = useState<number | null>(null);
	const [loading, setLoading] = useState(Boolean(scenarioId));
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [conflict, setConflict] = useState<number | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	const saveController = useRef<AbortController | null>(null);
	const dirty = JSON.stringify(draft) !== baseline;
	const validation = validateDraft(draft);
	const issues = validation.issues;

	// biome-ignore lint/correctness/useExhaustiveDependencies: A retry explicitly reloads the saved scenario.
	useEffect(() => {
		const controller = new AbortController();
		if (!scenarioId) {
			const next = initialDocument
				? scenarioToDraft(initialDocument)
				: createDefaultDraft();
			setDraft(next);
			setBaseline(initialDocument ? "" : JSON.stringify(next));
			setRevision(null);
			setLoading(false);
			return () => controller.abort();
		}
		setLoading(true);
		setError(null);
		void loadScenario(scenarioId, controller.signal)
			.then((saved) => {
				if (controller.signal.aborted) return;
				const next = scenarioToDraft(saved.document);
				setDraft(next);
				setBaseline(JSON.stringify(next));
				setRevision(saved.revision);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted) setError(messageOf(reason));
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});
		return () => controller.abort();
	}, [scenarioId, initialDocument, attempt]);
	useEffect(() => {
		onDirtyChange(dirty);
		return () => onDirtyChange(false);
	}, [dirty, onDirtyChange]);
	useEffect(() => {
		if (!dirty) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [dirty]);
	useEffect(() => () => saveController.current?.abort(), []);

	async function save(asNew = false) {
		const current = validateDraft(draft);
		if (!current.success || (scenarioId && revision === null && !asNew)) return;
		const controller = new AbortController();
		saveController.current = controller;
		setSaving(true);
		setError(null);
		setNotice(null);
		try {
			const saved =
				scenarioId && !asNew && revision !== null
					? await updateScenario(
							scenarioId,
							revision,
							current.document,
							controller.signal,
						)
					: await createScenario(current.document, controller.signal);
			if (controller.signal.aborted) return;
			const next = scenarioToDraft(saved.document);
			setDraft(next);
			setBaseline(JSON.stringify(next));
			setRevision(saved.revision);
			setConflict(null);
			onDirtyChange(false);
			setNotice(`Saved revision ${saved.revision}.`);
			if (!scenarioId || asNew)
				window.location.hash = `/scenarios/${encodeURIComponent(saved.id)}/edit`;
		} catch (reason) {
			if (!controller.signal.aborted) {
				if (reason instanceof ApiError && reason.status === 409)
					setConflict(reason.currentRevision ?? -1);
				else setError(messageOf(reason));
			}
		} finally {
			if (!controller.signal.aborted) setSaving(false);
		}
	}
	function exportDraft() {
		if (validation.success) {
			try {
				downloadScenario(validation.document);
			} catch (reason) {
				setError(messageOf(reason));
			}
		}
	}
	function back() {
		if (
			!dirty ||
			window.confirm("Discard unsaved changes and return to scenarios?")
		) {
			onDirtyChange(false);
			window.location.hash = "/scenarios";
		}
	}
	if (loading) return <p role="status">Loading scenario…</p>;
	if (scenarioId && revision === null)
		return (
			<>
				<button type="button" className="back-link" onClick={back}>
					← Scenarios
				</button>
				<div className="notice error" role="alert">
					<p>{error || "Unable to load scenario."}</p>
					<button
						type="button"
						onClick={() => setAttempt((value) => value + 1)}
					>
						Try again
					</button>
				</div>
			</>
		);

	return (
		<>
			<button
				type="button"
				className="back-link"
				disabled={saving}
				onClick={back}
			>
				← Scenarios
			</button>
			<header className="page-header">
				<div>
					<h1>{scenarioId ? "Edit scenario" : "Create scenario"}</h1>
					<p className="subheading">
						{revision === null
							? "Local draft · save to add it to your workspace"
							: `Revision ${revision}${dirty ? " · unsaved changes" : ""}`}
					</p>
				</div>
				<div className="item-actions">
					<button
						type="button"
						disabled={saving || !validation.success}
						onClick={exportDraft}
					>
						Export JSON
					</button>
					<button
						className="primary"
						type="button"
						disabled={saving || !validation.success}
						onClick={() => void save()}
					>
						{saving ? "Saving…" : "Save scenario"}
					</button>
				</div>
			</header>
			{error && (
				<div className="notice error" role="alert">
					<p>{error}</p>
				</div>
			)}
			{notice && (
				<div className="notice success" role="status">
					<p>{notice}</p>
				</div>
			)}
			{conflict !== null && (
				<div className="notice error" role="alert">
					<p>
						This scenario changed on the server
						{conflict >= 0 ? ` (current revision ${conflict})` : ""}. Your draft
						and original revision {revision} are preserved. Save your draft as a
						new scenario to keep both versions.
					</p>
					<button
						type="button"
						disabled={saving || !validation.success}
						onClick={() => void save(true)}
					>
						Save draft as new scenario
					</button>
				</div>
			)}
			{!scenarioId && (
				<fieldset className="editor-form" disabled={saving}>
					<details className="panel">
						<summary>Import JSON</summary>
						<ScenarioImport
							onImport={(document) => {
								if (!saving) {
									setDraft(scenarioToDraft(document));
									setNotice("Imported locally. Save to create a scenario.");
									setError(null);
								}
							}}
						/>
					</details>
				</fieldset>
			)}
			{issues.length > 0 && (
				<div className="notice error" role="alert">
					<p>
						Resolve {issues.length} validation{" "}
						{issues.length === 1 ? "issue" : "issues"} below before saving or
						exporting.
					</p>
					<GroupErrors path="" issues={issues} />
				</div>
			)}
			<fieldset className="editor-form" disabled={saving}>
				<section className="panel">
					<h2>Scenario details</h2>
					<EditorField label="Name" path="name" issues={issues}>
						<input
							maxLength={200}
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
						/>
					</EditorField>
					<EditorField label="Description" path="description" issues={issues}>
						<textarea
							rows={3}
							maxLength={2000}
							value={draft.description}
							onChange={(e) =>
								setDraft({ ...draft, description: e.target.value })
							}
						/>
					</EditorField>
					<EditorField label="Target profile" path="targetId" issues={issues}>
						<select
							value={draft.targetId}
							onChange={(e) => setDraft({ ...draft, targetId: e.target.value })}
						>
							<option value="demo-flawed">Without deduplication</option>
							<option value="demo-corrected">With deduplication</option>
						</select>
					</EditorField>
				</section>
				<EventEditor draft={draft} issues={issues} onChange={setDraft} />
				<StepEditor draft={draft} issues={issues} onChange={setDraft} />
				<section className="panel">
					<h2>Run limits</h2>
					<div className="form-grid">
						{(
							[
								["maxConcurrency", "Maximum concurrency (1–10)", 1, 10],
								[
									"requestTimeoutMs",
									"Request timeout (ms, 100–10000)",
									100,
									10000,
								],
								["runTimeoutMs", "Run timeout (ms, 1000–60000)", 1000, 60000],
							] as const
						).map(([key, label, min, max]) => (
							<EditorField
								key={key}
								label={label}
								path={`limits.${key}`}
								issues={issues}
							>
								<input
									type="number"
									min={min}
									max={max}
									value={draft.limits[key]}
									onChange={(e) =>
										setDraft({
											...draft,
											limits: { ...draft.limits, [key]: e.target.value },
										})
									}
								/>
							</EditorField>
						))}
					</div>
				</section>
				<AssertionEditor draft={draft} issues={issues} onChange={setDraft} />
			</fieldset>
			<div className="editor-footer item-actions">
				<button
					type="button"
					className="primary"
					disabled={saving || !validation.success}
					onClick={() => void save()}
				>
					{saving ? "Saving…" : "Save scenario"}
				</button>
				<button
					type="button"
					disabled={saving || !validation.success}
					onClick={exportDraft}
				>
					Export JSON
				</button>
				<span className="section-help">
					Changes save only when you choose Save scenario.
				</span>
			</div>
		</>
	);
}
