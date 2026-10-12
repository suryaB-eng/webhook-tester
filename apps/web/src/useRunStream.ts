import { useCallback, useEffect, useRef, useState } from "react";
import { loadRun, subscribeRun } from "./api";
import { RunStreamController, type RunStreamState } from "./run-stream";

const initialState: RunStreamState = { run: null, error: null, connection: "loading", refreshing: false };

export function useRunStream(runId: string) {
	const controller = useRef<RunStreamController | null>(null);
	const [saved, setSaved] = useState({ runId, state: initialState });
	useEffect(() => {
		const stream = new RunStreamController(runId, { load: loadRun, subscribe: subscribeRun }, (state) => setSaved({ runId, state }));
		controller.current = stream;
		stream.start();
		return () => { stream.stop(); controller.current = null; };
	}, [runId]);
	const refresh = useCallback(() => controller.current?.refresh(), []);
	return { ...(saved.runId === runId ? saved.state : initialState), refresh };
}
