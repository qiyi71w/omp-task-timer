const MAX_REQUEST_BYTES = 32 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 4_096;
const MAX_DIRECTORY_LENGTH = 8_192;
const DISCORD_MESSAGE_LIMIT = 2_000;
const TELEGRAM_MESSAGE_LIMIT = 4_096;
const DEFAULT_PROVIDER_TIMEOUT_MS = 5_000;
const JSON_CONTENT_TYPE = /^\s*application\/json\s*(?:;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t !#-\[\]-~]|\\[\t !-~])*")\s*)*$/i;
const STATUS_VALUES = { completed: true, failed: true, cancelled: true, unknown: true };
const STATUS_SUMMARIES = {
	completed: "✅ Task finished",
	failed: "❌ Task failed",
	cancelled: "⏹ Task interrupted",
	unknown: "❔ Task ended",
};
const EVENT_FIELDS = {
	schemaVersion: true,
	eventId: true,
	event: true,
	source: true,
	title: true,
	directory: true,
	durationMs: true,
	status: true,
};

class PayloadTooLargeError extends Error {}
class DeliveryFailedError extends Error {}
class DeliveryUnknownError extends Error {}

function jsonResponse(status, value, headers = {}) {
	return Response.json(value, {
		status,
		headers: { "Cache-Control": "no-store", ...headers },
	});
}

function waitFor(promise, signal) {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
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

async function readStream(stream, signal, limit) {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await waitFor(reader.read(), signal);
			if (done) return text + decoder.decode();
			bytes += value.byteLength;
			if (bytes > limit) throw new PayloadTooLargeError();
			text += decoder.decode(value, { stream: true });
		}
	} catch (error) {
		void reader.cancel(error).catch(() => {});
		throw error;
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// A timed-out reader may still own a pending read until cancellation settles.
		}
	}
}

async function sameSecret(provided, expected) {
	const encoder = new TextEncoder();
	const [providedHash, expectedHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(expected)),
	]);
	const left = new Uint8Array(providedHash);
	const right = new Uint8Array(expectedHash);
	let difference = 0;
	for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
	return difference === 0;
}

function validateEvent(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const keys = Object.keys(value);
	if (keys.length !== Object.keys(EVENT_FIELDS).length || keys.some(key => EVENT_FIELDS[key] !== true)) return undefined;
	if (value.schemaVersion !== 1 || value.event !== "task.finished" || value.source !== "omp") return undefined;
	if (
		typeof value.eventId !== "string" ||
		value.eventId.length === 0 ||
		value.eventId.length > MAX_EVENT_ID_LENGTH ||
		typeof value.title !== "string" ||
		value.title.length > MAX_TITLE_LENGTH ||
		typeof value.directory !== "string" ||
		value.directory.length === 0 ||
		value.directory.length > MAX_DIRECTORY_LENGTH ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs < 0 ||
		value.durationMs > Number.MAX_SAFE_INTEGER ||
		typeof value.status !== "string" ||
		STATUS_VALUES[value.status] !== true
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		eventId: value.eventId,
		event: "task.finished",
		source: "omp",
		title: value.title,
		directory: value.directory,
		durationMs: value.durationMs,
		status: value.status,
	};
}

function formatDuration(durationMs) {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes === 0) return `${seconds}s`;
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return hours === 0 ? `${minutes}m ${seconds}s` : `${hours}h ${minutes}m ${seconds}s`;
}

function truncateField(value, limit) {
	if (value.length <= limit) return value;
	if (limit <= 0) return "";
	if (limit === 1) return "…";
	let end = limit - 1;
	const last = value.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${value.slice(0, end)}…`;
}

function mobileText(event, limit) {
	const summary = `${STATUS_SUMMARIES[event.status]} · ${formatDuration(event.durationMs)}`;
	const fieldBudget = Math.max(0, limit - summary.length - "Task: ".length - "Directory: ".length - 2);
	let titleBudget = Math.floor(fieldBudget / 2);
	let directoryBudget = fieldBudget - titleBudget;
	if (event.title.length < titleBudget) {
		directoryBudget += titleBudget - event.title.length;
		titleBudget = event.title.length;
	} else if (event.directory.length < directoryBudget) {
		titleBudget += directoryBudget - event.directory.length;
		directoryBudget = event.directory.length;
	}
	return [
		summary,
		`Task: ${truncateField(event.title, titleBudget)}`,
		`Directory: ${truncateField(event.directory, directoryBudget)}`,
	].join("\n");
}

async function providerRequest(fetchImpl, url, init, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new DOMException("Provider request timed out", "TimeoutError")),
		timeoutMs,
	);
	try {
		const response = await waitFor(fetchImpl(url, { ...init, signal: controller.signal }), controller.signal);
		const body = await readStream(response.body, controller.signal, MAX_PROVIDER_RESPONSE_BYTES);
		return { response, body };
	} catch {
		throw new DeliveryUnknownError();
	} finally {
		clearTimeout(timeout);
	}
}

async function deliverDiscord(fetchImpl, webhookUrl, text, timeoutMs) {
	let endpoint;
	try {
		endpoint = new URL(webhookUrl);
		if (endpoint.protocol !== "https:") throw new Error();
		endpoint.searchParams.set("wait", "true");
	} catch {
		throw new DeliveryFailedError();
	}
	const { response } = await providerRequest(
		fetchImpl,
		endpoint,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
		},
		timeoutMs,
	);
	if (!response.ok) throw new DeliveryFailedError();
}

async function deliverTelegram(fetchImpl, token, chatId, text, timeoutMs) {
	if (!/^\d+:[A-Za-z0-9_-]+$/.test(token ?? "") || !chatId) throw new DeliveryFailedError();
	const { response, body } = await providerRequest(
		fetchImpl,
		`https://api.telegram.org/bot${token}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
		},
		timeoutMs,
	);
	if (!response.ok) throw new DeliveryFailedError();
	let result;
	try {
		result = JSON.parse(body);
	} catch {
		throw new DeliveryUnknownError();
	}
	if (result?.ok !== true) throw new DeliveryFailedError();
}

async function channelResult(delivery) {
	try {
		await delivery;
		return "sent";
	} catch (error) {
		return error instanceof DeliveryUnknownError ? "unknown" : "failed";
	}
}

export function createNotifyGateway(options = {}) {
	const fetchImpl = options.fetch ?? fetch;
	const providerTimeoutMs = options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
	return {
		async fetch(request, env) {
			const url = new URL(request.url);
			if (url.pathname !== "/hook") return jsonResponse(404, { ok: false, error: "not_found" });
			if (request.method !== "POST") {
				return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
			}
			const discordEnabled = Boolean(env.DISCORD_WEBHOOK_URL);
			const telegramTokenConfigured = Boolean(env.TELEGRAM_BOT_TOKEN);
			const telegramChatConfigured = Boolean(env.TELEGRAM_CHAT_ID);
			const telegramEnabled = telegramTokenConfigured && telegramChatConfigured;
			if (
				!env.INBOUND_SECRET ||
				telegramTokenConfigured !== telegramChatConfigured ||
				(!discordEnabled && !telegramEnabled)
			) {
				return jsonResponse(503, { ok: false, error: "gateway_not_configured" });
			}

			const authorization = request.headers.get("Authorization") ?? "";
			const prefix = "Bearer ";
			if (!authorization.startsWith(prefix) || !(await sameSecret(authorization.slice(prefix.length), env.INBOUND_SECRET))) {
				return jsonResponse(401, { ok: false, error: "unauthorized" });
			}
			if (!JSON_CONTENT_TYPE.test(request.headers.get("Content-Type") ?? "")) {
				return jsonResponse(415, { ok: false, error: "unsupported_media_type" });
			}
			const contentLength = Number(request.headers.get("Content-Length"));
			if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
				return jsonResponse(413, { ok: false, error: "payload_too_large" });
			}

			let raw;
			try {
				raw = await readStream(request.body, request.signal, MAX_REQUEST_BYTES);
			} catch (error) {
				if (error instanceof PayloadTooLargeError) {
					return jsonResponse(413, { ok: false, error: "payload_too_large" });
				}
				return jsonResponse(400, { ok: false, error: "invalid_request_body" });
			}

			let parsed;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return jsonResponse(400, { ok: false, error: "invalid_json" });
			}
			const event = validateEvent(parsed);
			if (!event) return jsonResponse(400, { ok: false, error: "invalid_event" });

			const discordText = mobileText(event, DISCORD_MESSAGE_LIMIT);
			const telegramText = mobileText(event, TELEGRAM_MESSAGE_LIMIT);
			const [discord, telegram] = await Promise.all([
				discordEnabled
					? channelResult(deliverDiscord(fetchImpl, env.DISCORD_WEBHOOK_URL, discordText, providerTimeoutMs))
					: "disabled",
				telegramEnabled
					? channelResult(
							deliverTelegram(fetchImpl, env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, telegramText, providerTimeoutMs),
						)
					: "disabled",
			]);
			const enabled = Number(discordEnabled) + Number(telegramEnabled);
			const sent = Number(discord === "sent") + Number(telegram === "sent");
			const ok = sent === enabled;
			return jsonResponse(ok ? 200 : sent > 0 ? 207 : 502, {
				ok,
				eventId: event.eventId,
				channels: { discord, telegram },
			});
		},
	};
}

export default createNotifyGateway();
