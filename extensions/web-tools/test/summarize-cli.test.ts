import test from "node:test";
import assert from "node:assert/strict";
import { ok, type Result } from "../result.ts";
import type { CommandOutput, CommandRequest, CommandRunner, CommandRunnerError } from "../providers/command.ts";
import {
	buildSummarizeCliArgs,
	isYouTubeUrl,
	parseSummarizeCliOutput,
	SummarizeCliProvider,
} from "../providers/summarize-cli.ts";
import { parsePublicHttpUrl, type PublicHttpUrl } from "../types.ts";

class FakeCommandRunner implements CommandRunner {
	readonly requests: CommandRequest[] = [];

	constructor(private readonly output: Result<CommandOutput, CommandRunnerError>) {}

	async run(request: CommandRequest): Promise<Result<CommandOutput, CommandRunnerError>> {
		this.requests.push(request);
		return this.output;
	}
}

const video = mustUrl("https://youtu.be/a0jm8l2PAcw");

test("isYouTubeUrl matches YouTube hosts only", () => {
	assert.equal(isYouTubeUrl(mustUrl("https://youtu.be/abc")), true);
	assert.equal(isYouTubeUrl(mustUrl("https://www.youtube.com/watch?v=abc")), true);
	assert.equal(isYouTubeUrl(mustUrl("https://m.youtube.com/watch?v=abc")), true);
	assert.equal(isYouTubeUrl(mustUrl("https://example.com/youtube.com")), false);
	assert.equal(isYouTubeUrl(mustUrl("https://notyoutube.com/watch")), false);
});

test("buildSummarizeCliArgs asks for a long JSON summary and adapts the prompt per type", () => {
	const summary = buildSummarizeCliArgs({ url: video, summaryType: "summary" });
	assert.deepEqual(summary, [video, "--json", "--length", "xl", "--stream", "off", "--metrics", "off", "--no-color"]);

	const keypoints = buildSummarizeCliArgs({ url: video, summaryType: "keypoints" });
	assert.equal(keypoints[keypoints.indexOf("--length") + 1], "long");
	assert.match(keypoints.at(-1) ?? "", /bullet list/);

	const eli5 = buildSummarizeCliArgs({ url: video, summaryType: "eli5" });
	assert.match(eli5.at(-1) ?? "", /simply/);
});

test("parseSummarizeCliOutput returns the titled summary", () => {
	const stdout = JSON.stringify({ extracted: { title: "Astra review", transcriptSource: "captionTracks" }, summary: " ### Overview\n\nText " });
	assert.deepEqual(parseSummarizeCliOutput(stdout), { _tag: "ok", value: "# Astra review\n\n### Overview\n\nText" });
});

test("parseSummarizeCliOutput rejects runs without a transcript or summary", () => {
	const noTranscript = JSON.stringify({
		extracted: { title: "- YouTube", transcriptSource: "unavailable" },
		summary: "The page only returned YouTube's generic site description.",
	});
	assert.deepEqual(parseSummarizeCliOutput(noTranscript), {
		_tag: "err",
		error: { _tag: "SummarizerReturnedError", safeMessage: "No transcript available for this video" },
	});
	assert.deepEqual(parseSummarizeCliOutput("not json"), {
		_tag: "err",
		error: { _tag: "SummarizerProtocolInvalid", reason: "Invalid JSON CLI output" },
	});
	assert.deepEqual(parseSummarizeCliOutput('{"summary":"  "}'), {
		_tag: "err",
		error: { _tag: "SummarizerProtocolInvalid", reason: "Empty summary" },
	});
});

test("SummarizeCliProvider runs the CLI and returns markdown", async () => {
	const runner = new FakeCommandRunner(
		ok({ exitCode: 0, stdout: JSON.stringify({ extracted: { title: "T" }, summary: "Body" }), stderr: "" }),
	);
	const result = await new SummarizeCliProvider("summarize", runner).summarize({ url: video, summaryType: "summary" });

	assert.deepEqual(result, { _tag: "ok", value: { url: video, summaryType: "summary", markdown: "# T\n\nBody" } });
	assert.equal(runner.requests[0]?.command, "summarize");
	assert.equal(runner.requests[0]?.args[0], video);
});

test("SummarizeCliProvider surfaces the last stderr line on failure", async () => {
	const runner = new FakeCommandRunner(ok({ exitCode: 1, stdout: "", stderr: "progress\nyt-dlp failed: video unavailable\n" }));
	const result = await new SummarizeCliProvider("summarize", runner).summarize({ url: video, summaryType: "summary" });

	assert.deepEqual(result, {
		_tag: "err",
		error: { _tag: "SummarizerReturnedError", safeMessage: "summarize: yt-dlp failed: video unavailable" },
	});
});

test("SummarizeCliProvider reports a missing binary as unavailable", async () => {
	const { SpawnCommandRunner } = await import("../providers/command.ts");
	const result = await new SummarizeCliProvider("pi-summarize-does-not-exist", new SpawnCommandRunner()).summarize({
		url: video,
		summaryType: "summary",
	});

	assert.equal(result._tag, "err");
	assert.equal(result._tag === "err" ? result.error._tag : "", "SummarizerUnavailable");
});

function mustUrl(input: string): PublicHttpUrl {
	const parsed = parsePublicHttpUrl(input);
	if (parsed._tag === "err") {
		throw new Error("Invalid test URL");
	}
	return parsed.value;
}
