import { completeSimple, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveModels, type ModelRole } from "./models.ts";

// One-shot model call with our own system prompt, trying each model of the role
// in order. Returns the first output `accept` maps to a non-empty string.
// Errors go to the UI, or stderr in print mode.
export async function completeWithFallback(
	ctx: ExtensionContext,
	opts: {
		label: string;
		role: ModelRole;
		systemPrompt: string;
		userText: string;
		accept: (raw: string) => string | undefined;
	},
): Promise<string | undefined> {
	const errors: string[] = [];
	const models = resolveModels(ctx, opts.role);
	if (models.length === 0) errors.push(`no model with configured auth for role "${opts.role}"`);
	const message: UserMessage = {
		role: "user",
		content: [{ type: "text", text: opts.userText }],
		timestamp: Date.now(),
	};
	try {
		for (const model of models) {
			const name = `${model.provider}/${model.id}`;
			if (ctx.hasUI) ctx.ui.setStatus("complete", `${opts.label} (${name})…`);
			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) throw new Error(auth.error);
				const response = await completeSimple(
					model,
					{ systemPrompt: opts.systemPrompt, messages: [message] },
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						signal: ctx.signal,
						reasoning: "low" as const,
						// Same override as commit: some reasoning models ignore named effort fields.
						...(model.api === "openai-completions" && model.reasoning
							? { samplingParams: { reasoning_effort: "low" as const } }
							: {}),
					},
				);
				if (response.stopReason === "aborted") return undefined;
				if (response.stopReason === "error") throw new Error(response.errorMessage || "model call failed");
				const raw = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n");
				const out = opts.accept(raw);
				if (out) return out;
				errors.push(`${name}: unusable output`);
			} catch (err) {
				errors.push(`${name}: ${(err as Error).message}`);
			}
		}
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("complete", undefined);
	}
	const msg = `${opts.label} failed:\n${errors.join("\n")}`;
	if (ctx.hasUI) ctx.ui.notify(msg, "warning");
	else process.stderr.write(`${msg}\n`);
	return undefined;
}
