// Source: ogulcancelik/pi-extensions (https://github.com/ogulcancelik/pi-extensions)
//   Path: packages/pi-session-recall/session-recall.ts
/**
 * Session Recall
 *
 * `session_search` runs `rg -i -F` over the session JSONL files and returns
 * the best matching sessions with snippets. `session_query` loads one session
 * and asks an LLM a question about it, dropping thinking and tool output.
 * Sessions larger than the model's context are windowed around the
 * question's keywords.
 *
 * Queries go to the first usable model of the "fast" role in
 * ~/.pi/agent/extension-models.json.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	getAgentDir,
	getMarkdownTheme,
	SessionManager,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { resolveModels } from "../shared/models.ts";

const QUERY_SYSTEM_PROMPT = `You are a session context assistant. Given the conversation history from a pi coding session and a question, provide a concise answer based on the session contents.

Focus on:
- Specific facts, decisions, and outcomes
- File paths and code changes mentioned
- Key context the user is asking about

Be concise and direct. If the information isn't in the session, say so.`;

const MAX_SEARCH_RESULTS = 10;
const MAX_SNIPPETS_PER_SESSION = 3;
const BOOKEND_COUNT = 3;

const NO_MATCH_HINT =
	"session_search is literal fixed-string search, not semantic search. Retry with one exact distinctive token or phrase, such as a filename, package name, error text, function name, issue id, or unique term.";

const STOP_WORDS = new Set([
	"a", "an", "the", "is", "was", "were", "are", "be", "been", "being",
	"have", "has", "had", "do", "does", "did", "will", "would", "could",
	"should", "may", "might", "can", "shall", "to", "of", "in", "for",
	"on", "with", "at", "by", "from", "as", "into", "about", "like",
	"through", "after", "over", "between", "out", "against", "during",
	"without", "before", "under", "around", "among", "and", "but", "or",
	"nor", "not", "so", "yet", "both", "either", "neither", "each",
	"every", "all", "any", "few", "more", "most", "other", "some", "such",
	"no", "only", "own", "same", "than", "too", "very", "just", "because",
	"if", "when", "where", "how", "what", "which", "who", "whom", "this",
	"that", "these", "those", "it", "its", "they", "them", "their", "we",
	"us", "our", "you", "your", "he", "him", "his", "she", "her", "i", "me", "my",
]);

interface FileMatchCount {
	path: string;
	count: number;
}

interface SerializedMessage {
	role: string;
	text: string;
}

function projectFromPath(sessionPath: string): string {
	const match = sessionPath.match(/sessions\/(--.*?--)\//);
	if (!match?.[1]) return "~";
	let encoded = match[1].slice(2, -2);
	const homeEncoded = homedir().replace(/^\//, "").replace(/[/:]/g, "-");
	if (encoded === homeEncoded) return "~";
	if (encoded.startsWith(`${homeEncoded}-`)) encoded = encoded.slice(homeEncoded.length + 1);
	return encoded.replace(/-/g, "/") || "~";
}

function dateFromPath(sessionPath: string): string {
	return sessionPath.match(/(\d{4}-\d{2}-\d{2})T/)?.[1] ?? "unknown";
}

function extractMessageText(jsonLine: string): { role: string; text: string } | null {
	try {
		const entry = JSON.parse(jsonLine);
		if (entry.type !== "message") return null;
		const content = entry.message.content;
		if (!Array.isArray(content)) return null;
		const text = content
			.filter((c: { type?: string }) => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join(" ");
		return text ? { role: entry.message.role, text } : null;
	} catch {
		return null;
	}
}

function snippetAround(text: string, keyword: string, radius = 100): string {
	const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
	if (idx === -1) return text.slice(0, radius * 2);
	const start = Math.max(0, idx - radius);
	const end = Math.min(text.length, idx + keyword.length + radius);
	return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

function rg(args: string[], timeout: number): string {
	try {
		return execFileSync("rg", ["--no-config", ...args], { encoding: "utf-8", timeout, stdio: ["ignore", "pipe", "pipe"] });
	} catch (err) {
		if ((err as { status?: number }).status === 1) return "";
		throw err;
	}
}

function searchFiles(query: string, sessionsDir: string): FileMatchCount[] {
	return rg(["-i", "-c", "-F", "--glob", "*.jsonl", "--", query, sessionsDir], 10_000)
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const lastColon = line.lastIndexOf(":");
			return { path: line.slice(0, lastColon), count: Number.parseInt(line.slice(lastColon + 1), 10) };
		})
		.filter((m) => m.count > 0);
}

function searchLines(query: string, filePath: string): string[] {
	return rg(["-i", "-F", "-m", String(MAX_SNIPPETS_PER_SESSION), "--", query, filePath], 5_000)
		.split("\n")
		.filter(Boolean);
}

function prepareRecallMessages(messages: Message[]): Message[] {
	const prepared: Message[] = [];
	for (const message of messages) {
		if (message.role === "toolResult") continue;
		if (message.role !== "assistant") {
			prepared.push(message);
			continue;
		}
		const content = message.content.filter((block) => block.type !== "thinking");
		if (content.length > 0) prepared.push({ ...message, content });
	}
	return prepared;
}

function extractKeywords(question: string): string[] {
	return question
		.toLowerCase()
		.replace(/[^\w\s-]/g, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

function omitted(gap: number): string {
	return `[... ${gap} message${gap > 1 ? "s" : ""} omitted ...]`;
}

function buildWindowedContext(messages: SerializedMessage[], question: string, tokenBudget: number): string {
	const total = messages.length;
	const render = (m: SerializedMessage) => `[${m.role}]\n${m.text}`;
	if (total <= BOOKEND_COUNT * 2 + 2) return messages.map(render).join("\n\n");

	const keywords = extractKeywords(question);
	const matchIndices = messages
		.map((msg, i) => {
			const lower = msg.text.toLowerCase();
			return { i, score: keywords.filter((kw) => lower.includes(kw)).length };
		})
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score)
		.map((x) => x.i);

	const included = new Set<number>(matchIndices);
	for (let i = 0; i < BOOKEND_COUNT; i++) included.add(i);
	for (let i = total - BOOKEND_COUNT; i < total; i++) included.add(i);

	const charLimit = tokenBudget * 4 * 0.8;
	const currentChars = () => [...included].reduce((sum, i) => sum + messages[i].text.length + 20, 0);

	for (let radius = 1; currentChars() < charLimit && radius < total; radius++) {
		const before = included.size;
		for (const i of matchIndices) {
			for (let idx = Math.max(0, i - radius); idx <= Math.min(total - 1, i + radius); idx++) included.add(idx);
		}
		if (included.size === before) break;
	}

	for (let i = BOOKEND_COUNT; i < total && currentChars() < charLimit; i++) included.add(i);

	const parts: string[] = [];
	let lastIdx = -1;
	for (const i of [...included].sort((a, b) => a - b)) {
		if (lastIdx >= 0 && i > lastIdx + 1) parts.push(omitted(i - lastIdx - 1));
		parts.push(render(messages[i]));
		lastIdx = i;
	}
	return parts.join("\n\n");
}

function errorResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: { error: true } };
}

function textOf(result: { content?: { type: string; text?: string }[] }): string {
	const first = result.content?.[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

export default function sessionRecallExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description:
			"Find past sessions by literal text search. This is essentially `rg -i -F` over session JSONL files, not semantic search. " +
			"Use one exact token or phrase. Spaces are exact spaces in an exact phrase, so only use spaces for wording you expect appeared in the session, such as an error message. " +
			"Good examples: `libc++abi`, `Cannot find module '@sinclair/typebox'`, `Blender VAT bake`. " +
			"Bad example: `build ci c lib dependency ghostty` because that searches for one exact phrase, not separate keywords. " +
			"Do not combine independent keywords into one search string. If you need multiple unrelated terms, call session_search multiple times. " +
			"After finding a likely session, use session_query for semantic questions.",
		parameters: Type.Object({
			query: Type.String({
				description:
					"Literal search pattern passed to fixed-string ripgrep-style search. Use one distinctive token or exact phrase, not a bag of unrelated keywords. Spaces mean exact spaces in an exact phrase.",
			}),
		}),
		renderResult: (result, options, theme) => {
			const container = new Container();
			const text = textOf(result);
			const details = result.details as { matchCount?: number; query?: string } | undefined;

			if (!details?.matchCount) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				return container;
			}

			const summary = `${details.matchCount} session${details.matchCount > 1 ? "s" : ""} matching "${details.query}"`;
			container.addChild(new Text(theme.fg("toolOutput", summary), 0, 0));
			if (options.expanded) {
				container.addChild(new Spacer(1));
				const body = text.replace(/^Found \d+ sessions? matching "[^"]*":\n\n/, "");
				container.addChild(
					new Markdown(body, 0, 0, getMarkdownTheme(), { color: (t: string) => theme.fg("toolOutput", t) }),
				);
			}
			return container;
		},

		async execute(_toolCallId, { query }, signal) {
			const sessionsDir = join(getAgentDir(), "sessions");
			if (!existsSync(sessionsDir)) return errorResult("No sessions directory found.");

			const noMatches = (text: string) => ({
				content: [{ type: "text" as const, text: `${text}\n\n${NO_MATCH_HINT}` }],
				details: { matchCount: 0 },
			});

			let fileMatches: FileMatchCount[];
			try {
				fileMatches = searchFiles(query, sessionsDir);
			} catch (err) {
				return errorResult(`rg failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (fileMatches.length === 0) return noMatches(`No sessions found matching "${query}".`);

			const results: string[] = [];
			const top = fileMatches
				.sort((a, b) => b.count - a.count || b.path.localeCompare(a.path))
				.slice(0, MAX_SEARCH_RESULTS);

			for (const { path: filePath, count } of top) {
				if (signal?.aborted) break;
				const snippets = searchLines(query, filePath)
					.map(extractMessageText)
					.filter((msg) => msg !== null)
					.map((msg) => `  [${msg.role}] ${snippetAround(msg.text, query)}`);
				if (snippets.length === 0) continue;

				results.push(
					`**${dateFromPath(filePath)}** · \`${projectFromPath(filePath)}\` · ${count} match${count > 1 ? "es" : ""}\n` +
						`Session: \`${filePath}\`\n` +
						snippets.join("\n"),
				);
			}

			if (results.length === 0) return noMatches(`No readable matches found for "${query}".`);

			return {
				content: [
					{
						type: "text" as const,
						text: `Found ${results.length} session${results.length > 1 ? "s" : ""} matching "${query}":\n\n${results.join("\n\n---\n\n")}`,
					},
				],
				details: { matchCount: results.length, query },
			};
		},
	});

	pi.registerTool({
		name: "session_query",
		label: "Session Query",
		description:
			"Query a specific session file to get detailed information. Use after session_search to dig into a particular session, " +
			"or when you already have a session path (e.g., from a handoff). Sends the conversation and tool calls, without assistant thinking or tool output, to an LLM for analysis.",
		parameters: Type.Object({
			sessionPath: Type.String({
				description: "Full path to the session file (e.g., /home/user/.pi/agent/sessions/.../session.jsonl)",
			}),
			question: Type.String({
				description:
					"What you want to know about that session (e.g., 'What files were modified?' or 'What approach was chosen?')",
			}),
		}),
		renderResult: (result, options, theme) => {
			const container = new Container();
			const text = textOf(result);
			const match = text.match(/\*\*Query:\*\* (.+?)\n\n---\n\n([\s\S]+)/);

			if (!match) {
				container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
				return container;
			}

			const [, query, answer] = match;
			if (options.expanded) {
				container.addChild(new Text(theme.bold("Query: ") + theme.fg("accent", query), 0, 0));
				container.addChild(new Spacer(1));
				container.addChild(
					new Markdown(answer.trim(), 0, 0, getMarkdownTheme(), {
						color: (t: string) => theme.fg("toolOutput", t),
					}),
				);
				return container;
			}

			const firstLine =
				answer
					.trim()
					.split("\n")
					.find((l) => l.trim().length > 0 && !l.startsWith("#") && !l.startsWith("---"))
					?.trim() ?? query;
			const summary = firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine;
			container.addChild(new Text(theme.fg("toolOutput", summary), 0, 0));
			return container;
		},

		async execute(_toolCallId, { sessionPath, question }, signal, onUpdate, ctx) {
			if (!sessionPath.endsWith(".jsonl")) {
				return errorResult(`Error: Invalid session path. Expected a .jsonl file, got: ${sessionPath}`);
			}
			if (!existsSync(sessionPath)) return errorResult(`Error: Session file not found: ${sessionPath}`);

			onUpdate?.({ content: [{ type: "text", text: `Query: ${question}` }], details: { status: "loading", question } });

			let sessionManager: SessionManager;
			try {
				sessionManager = SessionManager.open(sessionPath);
			} catch (err) {
				return errorResult(`Error loading session: ${err}`);
			}

			const messages = sessionManager
				.getBranch()
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);
			if (messages.length === 0) {
				return { content: [{ type: "text" as const, text: "Session is empty - no messages found." }], details: {} };
			}

			const [model] = resolveModels(ctx, "fast");
			if (!model) return errorResult("Error: No model with configured auth to analyze the session.");

			const llmMessages = prepareRecallMessages(convertToLlm(messages));
			const fullText = serializeConversation(llmMessages);
			const tokenBudget = Math.floor(model.contextWindow * 0.8);
			const wasWindowed = Math.ceil(fullText.length / 4) > tokenBudget;
			const conversationText = wasWindowed
				? buildWindowedContext(
						llmMessages.map((msg) => ({ role: msg.role, text: serializeConversation([msg]) })),
						question,
						tokenBudget,
					)
				: fullText;

			const contextNote = wasWindowed
				? "\n\n**Note:** This is a large session. The conversation has been windowed to focus on sections most relevant to your question. Some messages were omitted (marked with [...])."
				: "";

			try {
				const response = await ctx.modelRegistry
					.streamSimple(
						model,
						{
							systemPrompt: QUERY_SYSTEM_PROMPT,
							messages: [
								{
									role: "user",
									content: [
										{
											type: "text",
											text: `## Session Conversation${contextNote}\n\n${conversationText}\n\n## Question\n\n${question}`,
										},
									],
									timestamp: Date.now(),
								},
							],
						},
						{ cacheRetention: "none", sessionId: crypto.randomUUID(), signal },
					)
					.result();

				if (response.stopReason === "aborted") {
					return { content: [{ type: "text" as const, text: "Query was cancelled." }], details: {} };
				}
				if (response.stopReason === "error") {
					return errorResult(
						`Error querying ${model.provider}/${model.id}: ${response.errorMessage?.trim() || "provider returned an error without details."}`,
					);
				}

				const answer = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				if (!answer) return errorResult(`Error querying ${model.provider}/${model.id}: empty response.`);

				return {
					content: [
						{
							type: "text" as const,
							text: `**Query:** ${question}\n\n---\n\n${answer}\n\n*Answered by ${model.id} (${model.provider})${wasWindowed ? " · windowed" : ""}*`,
						},
					],
					details: { sessionPath, question, messageCount: messages.length, wasWindowed },
				};
			} catch (err) {
				return errorResult(`Error querying session: ${err}`);
			}
		},
	});
}
