export type TaskFinishedStatus = "completed" | "failed" | "cancelled" | "unknown";

export interface TaskFinishedEvent {
	schemaVersion: 1;
	eventId: string;
	event: "task.finished";
	source: "omp";
	title: string;
	directory: string;
	durationMs: number;
	status: TaskFinishedStatus;
}

export type NotificationConfig =
	| { enabled: false }
	| {
			enabled: true;
			url: string;
			token: string;
			timeoutMs: number;
	  };

export type ChannelDeliveryStatus = "sent" | "failed" | "unknown";

export interface NotificationDeliveryResult {
	ok: boolean;
	partial: boolean;
	status: number;
	channels: { discord: ChannelDeliveryStatus; telegram: ChannelDeliveryStatus };
}

export type WebhookFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

function enabled(value: string | undefined): boolean {
	return value !== undefined && /^(?:1|true|yes|on)$/i.test(value.trim());
}

function endpoint(value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "https:" || url.username || url.password) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}


export function loadNotificationConfig(
	environment: Readonly<Record<string, string | undefined>> = process.env,
): NotificationConfig {
	if (!enabled(environment.OMP_NOTIFY_ENABLED)) return { enabled: false };

	const url = endpoint(environment.OMP_NOTIFY_URL);
	const token = environment.OMP_NOTIFY_TOKEN;
	if (!url || !token?.trim()) return { enabled: false };

	return {
		enabled: true,
		url,
		token,
		timeoutMs: DEFAULT_TIMEOUT_MS,
	};
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(
			value => {
				signal.removeEventListener("abort", aborted);
				resolve(value);
			},
			error => {
				signal.removeEventListener("abort", aborted);
				reject(error);
			},
		);
	});
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await waitFor(reader.read(), signal);
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > MAX_RESPONSE_BYTES) throw new Error("Gateway response body exceeded limit");
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		void reader.cancel().catch(() => {});
		try {
			reader.releaseLock();
		} catch {
			// A timed-out read can retain the lock until cancellation settles.
		}
	}
}

function channelStatus(value: unknown): ChannelDeliveryStatus {
	return value === "sent" || value === "failed" || value === "unknown" ? value : "unknown";
}

function gatewayResult(response: Response, body: string, eventId: string): NotificationDeliveryResult {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		payload = undefined;
	}
	const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
	const channelRecord = record && "channels" in record && record.channels && typeof record.channels === "object"
		? record.channels
		: undefined;
	const channels = {
		discord: channelStatus(channelRecord && "discord" in channelRecord ? channelRecord.discord : undefined),
		telegram: channelStatus(channelRecord && "telegram" in channelRecord ? channelRecord.telegram : undefined),
	};
	const correlated = record !== undefined && "eventId" in record && record.eventId === eventId;
	const sentCount = Number(channels.discord === "sent") + Number(channels.telegram === "sent");
	const ok = Boolean(
		response.status === 200 && correlated && record && "ok" in record && record.ok === true && sentCount === 2,
	);
	const partial = Boolean(
		response.status === 207 && correlated && record && "ok" in record && record.ok === false && sentCount === 1,
	);
	return { ok, partial, status: response.status, channels };
}

export async function postTaskFinished(
	config: Extract<NotificationConfig, { enabled: true }>,
	event: Readonly<TaskFinishedEvent>,
	fetchImpl: WebhookFetch = fetch,
): Promise<NotificationDeliveryResult> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new DOMException("Webhook request timed out", "TimeoutError")),
		config.timeoutMs,
	);
	timeout.unref?.();

	try {
		const response = await waitFor(
			fetchImpl(config.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${config.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(event),
				signal: controller.signal,
			}),
			controller.signal,
		);
		const body = await readResponseBody(response, controller.signal);
		return gatewayResult(response, body, event.eventId);
	} finally {
		clearTimeout(timeout);
	}
}
