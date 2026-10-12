import { cloneElement, useId, type ReactElement } from "react";
import type { DraftIssue } from "./editor-model";

export function EditorField({
	label,
	path,
	issues,
	children,
}: {
	label: string;
	path: string;
	issues: DraftIssue[];
	children: ReactElement<{
		id?: string;
		"aria-describedby"?: string;
		"aria-invalid"?: boolean;
	}>;
}) {
	const inputId = useId();
	const errors = issues.filter((issue) => issue.path === path);
	return (
		<div className="form-field">
			<label htmlFor={inputId}>{label}</label>
			{cloneElement(children, {
				id: inputId,
				...(errors.length ? { "aria-describedby": `${inputId}-errors` } : {}),
				"aria-invalid": errors.length > 0,
			})}
			<div id={`${inputId}-errors`}>
				{errors.map((issue) => (
					<p
						className="field-error"
						role="alert"
						key={`${path}-${issue.message}`}
					>
						{issue.message}
					</p>
				))}
			</div>
		</div>
	);
}
export function GroupErrors({
	path,
	issues,
}: {
	path: string;
	issues: DraftIssue[];
}) {
	return (
		<>
			{issues
				.filter((issue) => issue.path === path)
				.map((issue) => (
					<p
						className="field-error"
						role="alert"
						key={`${path}-${issue.message}`}
					>
						{issue.message}
					</p>
				))}
		</>
	);
}
