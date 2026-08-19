/**
 * Minimal two-line footer:
 *   cwd                                        provider/model · thinking
 *   ctx%/window · $cost · tok/s                branch · N files changed
 *
 * Extension statuses render below, one per line.
 *
 * Re-applied on a short delay so it wins over footers installed by other
 * extensions during session_start (notably pi-claude-code-use).
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type TUI,
} from "@earendil-works/pi-tui";

const CHARS_PER_ESTIMATED_TOKEN = 4;
const LIVE_UPDATE_INTERVAL_MS = 200;
const GIT_TIMEOUT_MS = 3_000;
const FOOTER_CLAIM_DELAYS_MS = [0, 250, 1_000];

function isAnthropicLike(provider: string | undefined) {
  return provider === "anthropic" || !!provider?.startsWith("anthropic-");
}

function countChangedFiles(cwd: string) {
  return new Promise<number>((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve(0);
        resolve(stdout.split("\n").filter((line) => line.trim()).length);
      },
    );
  });
}

function formatTokens(tokens: number) {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~/${relative(home, cwd)}` : cwd;
}

function estimateTokens(characters: number) {
  return Math.ceil(characters / CHARS_PER_ESTIMATED_TOKEN);
}

function sessionCost(ctx: ExtensionContext) {
  let cost = 0;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      cost += entry.message.usage.cost.total;
    }
  }
  return cost;
}

function columns(left: string, right: string, width: number) {
  if (!right) return truncateToWidth(left, width);

  const gap = width - visibleWidth(left) - visibleWidth(right);
  if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;

  const leftWidth = Math.max(1, Math.floor(width * 0.45));
  const fittedLeft = truncateToWidth(left, leftWidth);
  const fittedRight = truncateToWidth(
    right,
    Math.max(1, width - leftWidth - 1),
  );
  const fittedGap = Math.max(
    1,
    width - visibleWidth(fittedLeft) - visibleWidth(fittedRight),
  );
  return truncateToWidth(
    `${fittedLeft}${" ".repeat(fittedGap)}${fittedRight}`,
    width,
  );
}

export default function footer(pi: ExtensionAPI) {
  let changedFiles = 0;
  let tokensPerSecond: number | null = null;
  let requestRender: (() => void) | undefined;
  let claimTimers: Array<ReturnType<typeof setTimeout>> = [];

  let streamStart: number | null = null;
  let lastDeltaAt: number | null = null;
  let streamedCharacters = 0;
  let firstDeltaCharacters = 0;
  let deltaCount = 0;
  let sawToolCall = false;
  let runTokens = 0;
  let runStreamMs = 0;
  let lastLiveUpdate = 0;

  function resetStream() {
    streamStart = null;
    lastDeltaAt = null;
    streamedCharacters = 0;
    firstDeltaCharacters = 0;
    deltaCount = 0;
    sawToolCall = false;
    lastLiveUpdate = 0;
  }

  async function refreshGit(ctx: ExtensionContext) {
    const count = await countChangedFiles(ctx.cwd);
    if (count === changedFiles) return;
    changedFiles = count;
    requestRender?.();
  }

  pi.on("session_start", (_event, ctx) => {
    resetStream();
    runTokens = 0;
    runStreamMs = 0;
    tokensPerSecond = null;
    void refreshGit(ctx);

    if (ctx.mode !== "tui") return;

    const factory = (
      tui: TUI,
      theme: Theme,
      footerData: ReadonlyFooterDataProvider,
    ) => {
      requestRender = () => tui.requestRender();

      return {
        invalidate() {},
        render(width: number) {
          const model = ctx.model;
          const usage = ctx.getContextUsage();
          const contextPercent =
            usage?.percent === undefined || usage?.percent === null
              ? "?"
              : `${Math.round(usage.percent)}`;
          const contextWindow =
            usage?.contextWindow ?? model?.contextWindow ?? 0;
          const rate =
            tokensPerSecond === null
              ? "— tok/s"
              : `${Math.round(tokensPerSecond)} tok/s`;
          const subscription = model
            ? ctx.modelRegistry.isUsingOAuth(model)
            : false;
          const cost = `$${sessionCost(ctx).toFixed(2)}${subscription ? " (sub)" : ""}`;
          const stats = `${contextPercent}%/${contextWindow > 0 ? formatTokens(contextWindow) : "?"} · ${cost} · ${rate}`;

          const thinking = model?.reasoning ? pi.getThinkingLevel() : "off";
          const modelId =
            subscription && isAnthropicLike(model?.provider)
              ? `${model?.id} (cc-use)`
              : (model?.id ?? "no-model");
          const modelLabel = model
            ? `${model.provider}/${modelId} · ${thinking}`
            : modelId;

          const branch = footerData.getGitBranch();
          const git = branch
            ? `${branch} · ${changedFiles} ${changedFiles === 1 ? "file" : "files"} changed`
            : "";

          const lines = [
            columns(
              theme.fg("text", formatDirectory(ctx.cwd)),
              theme.fg("muted", modelLabel),
              width,
            ),
            columns(theme.fg("muted", stats), theme.fg("muted", git), width),
          ];

          for (const [, text] of [
            ...footerData.getExtensionStatuses().entries(),
          ].sort(([a], [b]) => a.localeCompare(b))) {
            for (const statusLine of text.split("\n")) {
              lines.push(
                truncateToWidth(statusLine, width, theme.fg("dim", "...")),
              );
            }
          }

          return lines;
        },
      };
    };

    for (const timer of claimTimers) clearTimeout(timer);
    claimTimers = FOOTER_CLAIM_DELAYS_MS.map((delay) =>
      setTimeout(() => ctx.ui.setFooter(factory), delay),
    );
    ctx.ui.setFooter(factory);
  });

  pi.on("input", (_event, ctx) => {
    void refreshGit(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", (_event, ctx) => {
    void refreshGit(ctx);
  });

  pi.on("agent_start", () => {
    runTokens = 0;
    runStreamMs = 0;
    resetStream();
    tokensPerSecond = null;
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") resetStream();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;

    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "toolcall_delta") {
      sawToolCall = true;
      return;
    }
    if (
      streamEvent.type !== "text_delta" &&
      streamEvent.type !== "thinking_delta"
    )
      return;
    if (!streamEvent.delta) return;

    const now = Date.now();
    if (streamStart === null) {
      streamStart = now;
      firstDeltaCharacters = streamEvent.delta.length;
    }
    lastDeltaAt = now;
    streamedCharacters += streamEvent.delta.length;
    deltaCount += 1;

    const elapsedMs = now - streamStart;
    const characters = streamedCharacters - firstDeltaCharacters;
    if (
      deltaCount < 2 ||
      elapsedMs <= 0 ||
      characters <= 0 ||
      now - lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS
    )
      return;

    lastLiveUpdate = now;
    tokensPerSecond = estimateTokens(characters) / (elapsedMs / 1000);
    requestRender?.();
  });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;

    sawToolCall ||= event.message.content.some(
      (block) => block.type === "toolCall",
    );

    if (streamStart !== null && streamedCharacters > 0) {
      const streamMs = (lastDeltaAt ?? streamStart) - streamStart;
      const firstDeltaTokens = estimateTokens(firstDeltaCharacters);
      // Count tokens after the first delta over the observed interval, so an
      // initial chunk is not treated as generated instantaneously.
      const tokens =
        !sawToolCall && event.message.usage.output > 0
          ? Math.max(0, event.message.usage.output - firstDeltaTokens)
          : Math.max(0, estimateTokens(streamedCharacters) - firstDeltaTokens);

      if (deltaCount >= 2 && streamMs >= 50 && tokens > 0) {
        runTokens += tokens;
        runStreamMs += streamMs;
        tokensPerSecond = runTokens / (runStreamMs / 1000);
      }
    }

    resetStream();
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    for (const timer of claimTimers) clearTimeout(timer);
    claimTimers = [];
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
