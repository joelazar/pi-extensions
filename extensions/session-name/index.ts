// Source: danielcherubini/pi-archimedes (https://github.com/danielcherubini/pi-archimedes)
//   Path: packages/session-name/src/index.ts
/**
 * Session Name
 *
 * Names the session after the first user + assistant exchange settles.
 * `/rename` regenerates the name from the whole conversation, overwriting
 * whatever name the session has.
 *
 * Titles come from the first usable model of the "fast" role in
 * ~/.pi/agent/extension-models.json.
 *
 * Inside Herdr the name is reported as the pane's agent title
 * (`herdr pane report-metadata --title`). The herdr-auto-title plugin ranks
 * that above the terminal title, so tabs read `3 · repo › pi › <name>` while
 * the plugin keeps owning numbering, cwd, branch and manual-rename locks.
 * Renaming panes or tabs directly would register as a manual rename and
 * lock the plugin out.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModels } from "../shared/models.ts";

const PER_MESSAGE_CHARS = 500;
const CONVERSATION_CHARS = 40_000;
const MAX_FAILURES = 3;
const HERDR_SOURCE = "pi-session-name";

type Scope = "first-exchange" | "whole";

function messageText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

function conversationLines(ctx: ExtensionContext, scope: Scope): string[] {
	const lines: string[] = [];
	let sawUser = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const { role } = message;
		if (role === "assistant" && !sawUser) continue;
		const text = messageText(message.content);
		if (!text) continue;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${text.slice(0, PER_MESSAGE_CHARS)}`);
		sawUser = true;
		if (scope === "first-exchange" && role === "assistant") break;
	}
	return lines;
}

function fitConversation(lines: string[]): string {
	const [first, ...rest] = lines;
	if (!first) return "";
	const tail: string[] = [];
	let budget = CONVERSATION_CHARS - first.length;
	for (let i = rest.length - 1; i >= 0; i--) {
		const line = rest[i]!;
		if (line.length + 1 > budget) break;
		tail.unshift(line);
		budget -= line.length + 1;
	}
	const skipped = rest.length - tail.length;
	return [first, ...(skipped > 0 ? [`[... ${skipped} messages omitted ...]`] : []), ...tail].join("\n");
}

type TitleResult = { ok: true; title: string } | { ok: false; reason: "skipped" | "failed"; error?: string };

async function generateTitle(ctx: ExtensionContext, scope: Scope, signal?: AbortSignal): Promise<TitleResult> {
	const lines = conversationLines(ctx, scope);
	if (scope === "first-exchange" && lines.length < 2) return { ok: false, reason: "skipped" };
	const conversation = fitConversation(lines);
	if (!conversation) return { ok: false, reason: "skipped", error: "no conversation yet" };

	const [model] = resolveModels(ctx, "fast");
	if (!model) return { ok: false, reason: "skipped", error: "no model with configured auth" };

	const prompt = [
		"Generate a concise title (3-8 words) for this conversation.",
		scope === "whole"
			? "The title should capture the overall topic of the whole conversation, not just its opening."
			: "The title should capture what the user is working on.",
		"Return only the title, nothing else.",
		"",
		"<conversation>",
		conversation,
		"</conversation>",
	].join("\n");

	const response = await ctx.modelRegistry
		.streamSimple(
			model,
			{ messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
			{ reasoning: "minimal", cacheRetention: "none", sessionId: crypto.randomUUID(), signal },
		)
		.result();

	if (response.stopReason === "aborted") return { ok: false, reason: "skipped" };
	if (response.stopReason === "error") return { ok: false, reason: "failed", error: response.errorMessage };

	const title = messageText(response.content)
		.replace(/\s+/g, " ")
		.replace(/^(["'])((?:(?!\1).)*)\1$/, "$2")
		.slice(0, 80)
		.trim();

	return title ? { ok: true, title } : { ok: false, reason: "failed", error: "empty title" };
}

async function syncHerdrTitle(pi: ExtensionAPI): Promise<void> {
	const paneId = process.env.HERDR_PANE_ID;
	if (process.env.HERDR_ENV !== "1" || !paneId) return;
	const name = pi.getSessionName();
	const result = await pi.exec("herdr", [
		"pane",
		"report-metadata",
		paneId,
		"--source",
		HERDR_SOURCE,
		"--agent",
		"pi",
		...(name ? ["--title", name] : ["--clear-title"]),
	]);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `herdr exited ${result.code}`);
}

export default function (pi: ExtensionAPI) {
	let failures = 0;
	let pending: AbortController | undefined;

	const syncHerdr = () =>
		syncHerdrTitle(pi).catch((error) => console.error("[session-name] herdr sync failed:", error));

	pi.on("session_start", () => {
		failures = 0;
		void syncHerdr();
	});

	pi.on("session_shutdown", () => {
		pending?.abort();
		pending = undefined;
	});

	pi.on("agent_end", (_event, ctx) => {
		void syncHerdr();
		if (pending || failures >= MAX_FAILURES) return;
		if (pi.getSessionName() || !ctx.sessionManager.getSessionFile()) return;

		const run = new AbortController();
		pending = run;
		void generateTitle(ctx, "first-exchange", run.signal)
			.then((result) => {
				if (run.signal.aborted) return;
				if (result.ok) {
					if (pi.getSessionName()) return;
					pi.setSessionName(result.title);
					void syncHerdr();
				} else if (result.reason === "failed") {
					failures++;
				}
			})
			.catch((error) => {
				if (run.signal.aborted) return;
				failures++;
				console.error("[session-name] failed:", error);
			})
			.finally(() => {
				if (pending === run) pending = undefined;
			});
	});

	pi.registerCommand("rename", {
		description: "Rename the session based on the whole conversation",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Generating session name...", "info");
			try {
				const result = await generateTitle(ctx, "whole");
				if (result.ok) {
					pi.setSessionName(result.title);
					const herdrError = await syncHerdrTitle(pi).then(
						() => undefined,
						(error) => (error instanceof Error ? error.message : String(error)),
					);
					if (herdrError) ctx.ui.notify(`Session renamed: ${result.title} (herdr: ${herdrError})`, "warning");
					else ctx.ui.notify(`Session renamed: ${result.title}`, "info");
				} else {
					ctx.ui.notify(`Rename ${result.reason}${result.error ? `: ${result.error}` : ""}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(`Rename failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
