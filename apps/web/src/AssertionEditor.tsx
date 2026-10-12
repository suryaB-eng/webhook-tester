import { EditorField, GroupErrors } from "./EditorField";
import {
	addAssertion,
	moveItem,
	removeAssertion,
	type DraftIssue,
	type ScenarioDraft,
} from "./editor-model";

export function AssertionEditor({
	draft,
	issues,
	onChange,
}: {
	draft: ScenarioDraft;
	issues: DraftIssue[];
	onChange: (draft: ScenarioDraft) => void;
}) {
	function update(
		index: number,
		field: "id" | "name" | "query" | "expectedText",
		value: string,
	) {
		onChange({
			...draft,
			assertions: draft.assertions.map((item, at) =>
				at === index ? { ...item, [field]: value } : item,
			),
		});
	}
	return (
		<section className="panel editor-section">
			<h2>SQL assertions</h2>
			<p className="section-help">
				Bind $1 to the run ID and return one row with one scalar column named
				value. Queries use SELECT-only access. Use explicit SQL casts when
				matching JSON numbers; expected values support strings, numbers,
				booleans and null.
			</p>
			<GroupErrors path="assertions" issues={issues} />
			{draft.assertions.map((assertion, index) => (
				<fieldset className="editor-item" key={assertion.localKey}>
					<legend>Assertion {index + 1}</legend>
					<div className="form-grid">
						<EditorField
							label="Assertion ID"
							path={`assertions.${index}.id`}
							issues={issues}
						>
							<input
								value={assertion.id}
								onChange={(e) => update(index, "id", e.target.value)}
							/>
						</EditorField>
						<EditorField
							label="Assertion name"
							path={`assertions.${index}.name`}
							issues={issues}
						>
							<input
								value={assertion.name}
								onChange={(e) => update(index, "name", e.target.value)}
							/>
						</EditorField>
					</div>
					<EditorField
						label="SQL query"
						path={`assertions.${index}.query`}
						issues={issues}
					>
						<textarea
							className="mono"
							rows={4}
							spellCheck={false}
							value={assertion.query}
							onChange={(e) => update(index, "query", e.target.value)}
						/>
					</EditorField>
					<EditorField
						label="Expected scalar (JSON)"
						path={`assertions.${index}.expectedText`}
						issues={issues}
					>
						<input
							className="mono"
							value={assertion.expectedText}
							onChange={(e) => update(index, "expectedText", e.target.value)}
						/>
					</EditorField>
					<div className="item-actions">
						<button
							type="button"
							disabled={index === 0}
							aria-label={`Move assertion ${index + 1} up`}
							onClick={() =>
								onChange({
									...draft,
									assertions: moveItem(draft.assertions, index, index - 1),
								})
							}
						>
							Up
						</button>
						<button
							type="button"
							disabled={index === draft.assertions.length - 1}
							aria-label={`Move assertion ${index + 1} down`}
							onClick={() =>
								onChange({
									...draft,
									assertions: moveItem(draft.assertions, index, index + 1),
								})
							}
						>
							Down
						</button>
						<button
							type="button"
							onClick={() => onChange(removeAssertion(draft, index))}
						>
							Remove assertion {index + 1}
						</button>
					</div>
				</fieldset>
			))}
			<button
				type="button"
				disabled={draft.assertions.length >= 100}
				onClick={() => onChange(addAssertion(draft))}
			>
				Add assertion
			</button>
		</section>
	);
}
