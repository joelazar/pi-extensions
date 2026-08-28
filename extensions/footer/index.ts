/**
 * Minimal two-line footer:
 *   cwd                                        provider/model · thinking
 *   ctx%/window · $cost                    branch · 3 files · +120/-40
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

type Diffstat = { files: number; insertions: number; deletions: number };

function readDiffstat(cwd: string) {
  return new Promise<Diffstat>((resolve) => {
    execFile(
      "git",
      ["diff", "--numstat", "HEAD"],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve({ files: 0, insertions: 0, deletions: 0 });
        let files = 0;
        let insertions = 0;
        let deletions = 0;
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const [added, removed] = line.split("\t");
          files += 1;
          insertions += Number.parseInt(added, 10) || 0;
          deletions += Number.parseInt(removed, 10) || 0;
        }
        resolve({ files, insertions, deletions });
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
  let diffstat: Diffstat = { files: 0, insertions: 0, deletions: 0 };
  let requestRender: (() => void) | undefined;
  let claimTimers: Array<ReturnType<typeof setTimeout>> = [];

  async function refreshGit(ctx: ExtensionContext) {
    const next = await readDiffstat(ctx.cwd);
    if (
      next.files === diffstat.files &&
      next.insertions === diffstat.insertions &&
      next.deletions === diffstat.deletions
    )
      return;
    diffstat = next;
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
          const changes = diffstat.files
            ? ` · ${diffstat.files} ${diffstat.files === 1 ? "file" : "files"} · +${diffstat.insertions}/-${diffstat.deletions}`
            : "";
          const git = branch ? `${branch}${changes}` : "";

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
