/**
 * Minimal two-line footer:
 *   cwd                                        provider/model · thinking
 *   ctx%/window · $cost                        branch · N files changed
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
  let requestRender: (() => void) | undefined;
  let claimTimers: Array<ReturnType<typeof setTimeout>> = [];

  async function refreshGit(ctx: ExtensionContext) {
    const count = await countChangedFiles(ctx.cwd);
    if (count === changedFiles) return;
    changedFiles = count;
    requestRender?.();
  }

  pi.on("session_start", (_event, ctx) => {
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
          const subscription = model
            ? ctx.modelRegistry.isUsingOAuth(model)
            : false;
          const cost = `$${sessionCost(ctx).toFixed(2)}${subscription ? " (sub)" : ""}`;
          const stats = `${contextPercent}%/${contextWindow > 0 ? formatTokens(contextWindow) : "?"} · ${cost}`;

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

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    requestRender?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    for (const timer of claimTimers) clearTimeout(timer);
    claimTimers = [];
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
