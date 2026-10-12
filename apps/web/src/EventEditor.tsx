import { EditorField, GroupErrors } from "./EditorField";
import {
	addEvent,
	moveItem,
	removeEvent,
	type DraftIssue,
	type ScenarioDraft,
} from "./editor-model";

export function EventEditor({
	draft,
	issues,
	onChange,
}: {
	draft: ScenarioDraft;
	issues: DraftIssue[];
	onChange: (draft: ScenarioDraft) => void;
}) {
	function update(index: number, field: "id" | "payloadText", value: string) {
		onChange({
			...draft,
			events: draft.events.map((event, at) =>
				at === index ? { ...event, [field]: value } : event,
			),
		});
	}
	return (
		<section className="panel editor-section">
			<h2>Events</h2>
			<p className="section-help">
				Supported payloads: payment.succeeded and order.status_changed. Payload
				id identifies the logical event; delivery IDs identify each transport
				attempt. The fixture starts with stock 10 for sku_001.
			</p>
			<GroupErrors path="events" issues={issues} />
			{draft.events.map((event, index) => (
				<fieldset className="editor-item" key={event.localKey}>
					<legend>Event {index + 1}</legend>
					<EditorField
						label="Event reference ID"
						path={`events.${index}.id`}
						issues={issues}
					>
						<input
							value={event.id}
							onChange={(e) => update(index, "id", e.target.value)}
						/>
					</EditorField>
					<EditorField
						label="Event payload (JSON)"
						path={`events.${index}.payloadText`}
						issues={issues}
					>
						<textarea
							className="mono"
							rows={9}
							spellCheck={false}
							value={event.payloadText}
							onChange={(e) => update(index, "payloadText", e.target.value)}
						/>
					</EditorField>
					<div className="item-actions">
						<button
							type="button"
							disabled={index === 0}
							onClick={() =>
								onChange({
									...draft,
									events: moveItem(draft.events, index, index - 1),
								})
							}
							aria-label={`Move event ${index + 1} up`}
						>
							Up
						</button>
						<button
							type="button"
							disabled={index === draft.events.length - 1}
							onClick={() =>
								onChange({
									...draft,
									events: moveItem(draft.events, index, index + 1),
								})
							}
							aria-label={`Move event ${index + 1} down`}
						>
							Down
						</button>
						<button
							type="button"
							onClick={() => onChange(removeEvent(draft, index))}
						>
							Remove event {index + 1}
						</button>
					</div>
				</fieldset>
			))}
			<div className="item-actions">
				<button
					type="button"
					disabled={draft.events.length >= 100}
					onClick={() => onChange(addEvent(draft, "payment.succeeded"))}
				>
					Add payment event
				</button>
				<button
					type="button"
					disabled={draft.events.length >= 100}
					onClick={() => onChange(addEvent(draft, "order.status_changed"))}
				>
					Add status event
				</button>
			</div>
		</section>
	);
}
