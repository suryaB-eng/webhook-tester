import { EditorField, GroupErrors } from "./EditorField";
import {
	addDelivery,
	addStep,
	duplicateDelivery,
	moveItem,
	removeDelivery,
	removeStep,
	type DraftIssue,
	type ScenarioDraft,
} from "./editor-model";

export function StepEditor({
	draft,
	issues,
	onChange,
}: {
	draft: ScenarioDraft;
	issues: DraftIssue[];
	onChange: (draft: ScenarioDraft) => void;
}) {
	const count = draft.steps.reduce(
		(total, step) => total + step.deliveries.length,
		0,
	);
	function update(
		index: number,
		values: Partial<ScenarioDraft["steps"][number]>,
	) {
		onChange({
			...draft,
			steps: draft.steps.map((step, at) =>
				at === index ? { ...step, ...values } : step,
			),
		});
	}
	return (
		<section className="panel editor-section">
			<h2>Steps and deliveries</h2>
			<p className="section-help">
				Steps run in order. Sequential mode sends one delivery at a time;
				concurrent mode uses the concurrency limit. Repeat delivery keeps its
				event reference and assigns a fresh delivery ID. {count}/100 deliveries.
			</p>
			<GroupErrors path="steps" issues={issues} />
			{draft.steps.map((step, index) => (
				<fieldset className="editor-item" key={step.localKey}>
					<legend>Step {index + 1}</legend>
					<div className="form-grid">
						<EditorField
							label="Step ID"
							path={`steps.${index}.id`}
							issues={issues}
						>
							<input
								value={step.id}
								onChange={(e) => update(index, { id: e.target.value })}
							/>
						</EditorField>
						<EditorField
							label="Delivery mode"
							path={`steps.${index}.mode`}
							issues={issues}
						>
							<select
								value={step.mode}
								onChange={(e) =>
									update(index, {
										mode: e.target.value as "sequential" | "concurrent",
									})
								}
							>
								<option value="sequential">Sequential</option>
								<option value="concurrent">Concurrent</option>
							</select>
						</EditorField>
						<EditorField
							label="Delay before step (ms, 0–5000)"
							path={`steps.${index}.delayBeforeMs`}
							issues={issues}
						>
							<input
								type="number"
								min="0"
								max="5000"
								value={step.delayBeforeMs}
								onChange={(e) =>
									update(index, { delayBeforeMs: e.target.value })
								}
							/>
						</EditorField>
					</div>
					<GroupErrors path={`steps.${index}.deliveries`} issues={issues} />
					{step.deliveries.map((delivery, deliveryIndex) => (
						<div className="delivery-row" key={delivery.localKey}>
							<div className="form-grid">
								<EditorField
									label={`Delivery ${deliveryIndex + 1} transport ID`}
									path={`steps.${index}.deliveries.${deliveryIndex}.deliveryId`}
									issues={issues}
								>
									<input
										value={delivery.deliveryId}
										onChange={(e) =>
											update(index, {
												deliveries: step.deliveries.map((item, at) =>
													at === deliveryIndex
														? { ...item, deliveryId: e.target.value }
														: item,
												),
											})
										}
									/>
								</EditorField>
								<EditorField
									label={`Delivery ${deliveryIndex + 1} event reference`}
									path={`steps.${index}.deliveries.${deliveryIndex}.eventId`}
									issues={issues}
								>
									<select
										value={delivery.eventId}
										onChange={(e) =>
											update(index, {
												deliveries: step.deliveries.map((item, at) =>
													at === deliveryIndex
														? { ...item, eventId: e.target.value }
														: item,
												),
											})
										}
									>
										{!draft.events.some(
											(event) => event.id === delivery.eventId,
										) && (
											<option value={delivery.eventId}>
												{delivery.eventId || "Choose event"} (missing)
											</option>
										)}
										{draft.events.map((event, at) => (
											<option key={event.localKey} value={event.id}>
												{event.id || `Event ${at + 1} (no ID)`}
											</option>
										))}
									</select>
								</EditorField>
							</div>
							<div className="item-actions">
								<button
									type="button"
									disabled={count >= 100}
									onClick={() =>
										onChange(duplicateDelivery(draft, index, deliveryIndex))
									}
								>
									Repeat delivery {deliveryIndex + 1}
								</button>
								<button
									type="button"
									disabled={deliveryIndex === 0}
									aria-label={`Move delivery ${deliveryIndex + 1} in step ${index + 1} up`}
									onClick={() =>
										update(index, {
											deliveries: moveItem(
												step.deliveries,
												deliveryIndex,
												deliveryIndex - 1,
											),
										})
									}
								>
									Up
								</button>
								<button
									type="button"
									disabled={deliveryIndex === step.deliveries.length - 1}
									aria-label={`Move delivery ${deliveryIndex + 1} in step ${index + 1} down`}
									onClick={() =>
										update(index, {
											deliveries: moveItem(
												step.deliveries,
												deliveryIndex,
												deliveryIndex + 1,
											),
										})
									}
								>
									Down
								</button>
								<button
									type="button"
									onClick={() =>
										onChange(removeDelivery(draft, index, deliveryIndex))
									}
								>
									Remove delivery {deliveryIndex + 1}
								</button>
							</div>
						</div>
					))}
					<div className="item-actions">
						<button
							type="button"
							disabled={count >= 100 || draft.events.length === 0}
							onClick={() =>
								onChange(addDelivery(draft, index, draft.events[0]?.id ?? ""))
							}
						>
							Add delivery
						</button>
						<button
							type="button"
							disabled={index === 0}
							aria-label={`Move step ${index + 1} up`}
							onClick={() =>
								onChange({
									...draft,
									steps: moveItem(draft.steps, index, index - 1),
								})
							}
						>
							Step up
						</button>
						<button
							type="button"
							disabled={index === draft.steps.length - 1}
							aria-label={`Move step ${index + 1} down`}
							onClick={() =>
								onChange({
									...draft,
									steps: moveItem(draft.steps, index, index + 1),
								})
							}
						>
							Step down
						</button>
						<button
							type="button"
							onClick={() => onChange(removeStep(draft, index))}
						>
							Remove step {index + 1}
						</button>
					</div>
				</fieldset>
			))}
			<button
				type="button"
				disabled={draft.steps.length >= 100}
				onClick={() => onChange(addStep(draft))}
			>
				Add step
			</button>
		</section>
	);
}
