import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WIDGET_KEY = "omp-task-timer.duration";

function formatDuration(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.round(elapsedMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);

	if (totalMinutes === 0) return `${seconds}s`;

	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return hours === 0 ? `${minutes}m ${seconds}s` : `${hours}h ${minutes}m ${seconds}s`;
}

export default function taskDuration(pi: ExtensionAPI): void {
	let pendingStartedAt: number | undefined;
	let startedAt: number | undefined;

	const reset = (): void => {
		pendingStartedAt = undefined;
		startedAt = undefined;
	};

	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		if (startedAt === undefined) pendingStartedAt = performance.now();
	});

	pi.on("agent_start", () => {
		if (startedAt === undefined) startedAt = pendingStartedAt ?? performance.now();
		pendingStartedAt = undefined;
	});

	pi.on("agent_end", (event, ctx) => {
		if (event.willContinue) return;

		const taskStartedAt = startedAt;
		reset();
		if (taskStartedAt === undefined || !ctx.hasUI) return;

		let resultLabel: string | undefined;
		for (let index = event.messages.length - 1; index >= 0; index--) {
			const message = event.messages[index];
			if (message.role !== "assistant") continue;
			switch (message.stopReason) {
				case "stop":
					resultLabel = "✓ Task finished";
					break;
				case "error":
					resultLabel = "✗ Task failed";
					break;
				case "aborted":
					resultLabel = "■ Task interrupted";
					break;
			}
			break;
		}
		if (resultLabel === undefined) return;

		ctx.ui.setWidget(
			WIDGET_KEY,
			[ctx.ui.theme.fg("muted", `${resultLabel} · ${formatDuration(performance.now() - taskStartedAt)}`)],
			{ placement: "aboveEditor" },
		);
	});

	pi.on("session_shutdown", reset);
}
