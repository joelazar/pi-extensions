import { homedir } from "node:os";
import { err, ok, type Result } from "../result.ts";
import type { PublicHttpUrl } from "../types.ts";
import type { CommandRunner, CommandRunnerError } from "./command.ts";
import type { SummarizeError, SummarizeRequest, SummarizeResult, SummarizeUrl } from "./kagi-summarize.ts";

const MAX_SUMMARIZE_CLI_OUTPUT_BYTES = 4 * 1024 * 1024;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

export function isYouTubeUrl(url: PublicHttpUrl): boolean {
	return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase());
}

export class SummarizeCliProvider implements SummarizeUrl {
	constructor(
		private readonly command: string,
		private readonly runner: CommandRunner,
	) {}

	/** Summarize a video from its transcript with the local `summarize` CLI. */
	async summarize(
		input: SummarizeRequest,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<Result<SummarizeResult, SummarizeError>> {
		const output = await this.runner.run(
			{
				command: this.command,
				args: buildSummarizeCliArgs(input),
				cwd: homedir(),
				maxOutputBytes: MAX_SUMMARIZE_CLI_OUTPUT_BYTES,
			},
			{ signal: options.signal },
		);
		if (output._tag === "err") {
			return err(mapCommandRunnerError(output.error));
		}
		if (output.value.exitCode !== 0) {
			const lastLine = output.value.stderr.trim().split("\n").at(-1)?.trim();
			if (lastLine) {
				return err({ _tag: "SummarizerReturnedError", safeMessage: `summarize: ${lastLine}` });
			}
			return err({ _tag: "SummarizerCommandFailed", exitCode: output.value.exitCode });
		}

		const markdown = parseSummarizeCliOutput(output.value.stdout);
		if (markdown._tag === "err") {
			return markdown;
		}
		return ok({ url: input.url, summaryType: input.summaryType, markdown: markdown.value });
	}
}

export function buildSummarizeCliArgs(input: SummarizeRequest): readonly string[] {
	const length = input.summaryType === "keypoints" ? "long" : "xl";
	const prompt =
		input.summaryType === "eli5"
			? ["--prompt", "Explain this video simply, as to a curious beginner. Avoid jargon; use short paragraphs."]
			: input.summaryType === "keypoints"
				? ["--prompt", "Summarize this video as a structured bullet list of its key points, grouped under short headings."]
				: [];
	return [input.url, "--json", "--length", length, "--stream", "off", "--metrics", "off", "--no-color", ...prompt];
}

/** Extract the summary from `summarize --json`, rejecting runs where no transcript was found. */
export function parseSummarizeCliOutput(
	stdout: string,
): Result<string, Extract<SummarizeError, { _tag: "SummarizerProtocolInvalid" | "SummarizerReturnedError" }>> {
	let payload: unknown;
	try {
		payload = JSON.parse(stdout.trim());
	} catch {
		return err({ _tag: "SummarizerProtocolInvalid", reason: "Invalid JSON CLI output" });
	}
	if (!isPlainObject(payload)) {
		return err({ _tag: "SummarizerProtocolInvalid", reason: "Missing summary payload" });
	}

	const extracted = payload["extracted"];
	if (isPlainObject(extracted) && extracted["transcriptSource"] === "unavailable") {
		return err({ _tag: "SummarizerReturnedError", safeMessage: "No transcript available for this video" });
	}

	const summary = payload["summary"];
	if (typeof summary !== "string" || !summary.trim()) {
		return err({ _tag: "SummarizerProtocolInvalid", reason: "Empty summary" });
	}

	const title = isPlainObject(extracted) && typeof extracted["title"] === "string" ? extracted["title"].trim() : "";
	return ok(title ? `# ${title}\n\n${summary.trim()}` : summary.trim());
}

function mapCommandRunnerError(error: CommandRunnerError): SummarizeError {
	switch (error._tag) {
		case "CommandSpawnFailed":
			return { _tag: "SummarizerUnavailable", cause: error.cause };
		case "CommandOutputTooLarge":
			return { _tag: "SummarizerResponseTooLarge", maxBytes: error.maxBytes };
		case "CommandCancelled":
			return { _tag: "SummarizerCancelled", cause: error.cause };
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
