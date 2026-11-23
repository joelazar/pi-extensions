import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
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
const ROT_WARN_TOKENS = 100_000;
const ROT_DEGRADED_TOKENS = 300_000;
const ROT_LIMIT_PERCENT = 85;

type Diffstat = { files: number; insertions: number; deletions: number };

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const UNTRACKED_MAX_FILES = 200;
const UNTRACKED_MAX_BYTES = 1_000_000;

function git(cwd: string, args: string[]) {
  return new Promise<string | undefined>((resolve) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    );
  });
}

export function parseNumstat(stdout: string): Diffstat {
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
  return { files, insertions, deletions };
}

export function countLines(content: Buffer) {
  if (content.length === 0 || content.includes(0)) return 0;
  let lines = 0;
  for (const byte of content) if (byte === 10) lines += 1;
  return content[content.length - 1] === 10 ? lines : lines + 1;
}

async function untrackedLines(cwd: string, paths: string[]) {
  let lines = 0;
  // shortcut: counts lines of the first 200 untracked files under 1 MB, upgrade if big untracked trees show wrong totals
  for (const path of paths.slice(0, UNTRACKED_MAX_FILES)) {
    try {
      const file = join(cwd, path);
      if ((await stat(file)).size > UNTRACKED_MAX_BYTES) continue;
      lines += countLines(await readFile(file));
    } catch {}
  }
  return lines;
}

export async function readDiffstat(cwd: string): Promise<Diffstat> {
  const head = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  const [tracked, others] = await Promise.all([
    git(cwd, ["diff", "--numstat", head ? "HEAD" : EMPTY_TREE]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const diffstat = parseNumstat(tracked ?? "");
  const untracked = (others ?? "").split("\0").filter(Boolean);
  return {
    files: diffstat.files + untracked.length,
    insertions: diffstat.insertions + (await untrackedLines(cwd, untracked)),
    deletions: diffstat.deletions,
  };
}

function rotColor(tokens: number | null, percent: number | null) {
  if (tokens === null) return "muted" as const;
  if (percent !== null && percent >= ROT_LIMIT_PERCENT) return "error" as const;
  if (tokens >= ROT_DEGRADED_TOKENS) return "error" as const;
  if (tokens >= ROT_WARN_TOKENS) return "warning" as const;
  return "success" as const;
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

const HIDDEN_STATUSES = new Set(["i-have-adhd", "ponytail"]);

export default function footer(pi: ExtensionAPI) {
  let diffstat: Diffstat = { files: 0, insertions: 0, deletions: 0 };
  let requestRender: (() => void) | undefined;
  let gitRequest = 0;

  async function refreshGit(ctx: ExtensionContext) {
    const request = ++gitRequest;
    const next = await readDiffstat(ctx.cwd);
    if (
      request !== gitRequest ||
      (next.files === diffstat.files &&
        next.insertions === diffstat.insertions &&
        next.deletions === diffstat.deletions)
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
      const unsubscribeBranch = footerData.onBranchChange(
        () => void refreshGit(ctx),
      );

      return {
        invalidate() {},
        dispose: unsubscribeBranch,
        render(width: number) {
          const model = ctx.model;
          const usage = ctx.getContextUsage();
          const contextPercent =
            usage === undefined
              ? "?%"
              : usage.percent === null
                ? "compacted"
                : `${Math.round(usage.percent)}%`;
          const contextWindow =
            usage?.contextWindow ?? model?.contextWindow ?? 0;
          const subscription = model
            ? ctx.modelRegistry.isUsingOAuth(model)
            : false;
          const cost = `$${sessionCost(ctx).toFixed(2)}${subscription ? " (sub)" : ""}`;
          const context = theme.fg(
            rotColor(usage?.tokens ?? null, usage?.percent ?? null),
            `${contextPercent}/${contextWindow > 0 ? formatTokens(contextWindow) : "?"}`,
          );
          const stats = `${context}${theme.fg("muted", ` · ${cost}`)}`;

          const thinking = model?.reasoning ? pi.getThinkingLevel() : "off";
          const modelId = model?.id ?? "no-model";
          const modelLabel = model
            ? `${model.provider}/${modelId} · ${thinking}`
            : modelId;

          const branch = footerData.getGitBranch();
          const changes = diffstat.files
            ? `${theme.fg("muted", ` · ${diffstat.files} ${diffstat.files === 1 ? "file" : "files"} · `)}${theme.fg("toolDiffAdded", `+${diffstat.insertions}`)}${theme.fg("muted", "/")}${theme.fg("toolDiffRemoved", `-${diffstat.deletions}`)}`
            : "";
          const git = branch ? `${theme.fg("muted", branch)}${changes}` : "";

          const lines = [
            columns(
              theme.fg("text", formatDirectory(ctx.cwd)),
              theme.fg("muted", modelLabel),
              width,
            ),
            columns(stats, git, width),
          ];

          for (const [, text] of [
            ...footerData.getExtensionStatuses().entries(),
          ].filter(([key]) => !HIDDEN_STATUSES.has(key)).sort(([a], [b]) => a.localeCompare(b))) {
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
    requestRender = undefined;
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
