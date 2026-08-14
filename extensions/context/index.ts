// Source: mitsuhiko/agent-stuff (https://github.com/mitsuhiko/agent-stuff)
//   Path: extensions/context.ts
/**
 * /context
 *
 * Small TUI view showing what's loaded/available:
 * - extensions (best-effort from registered extension slash commands)
 * - skills
 * - project context files (AGENTS.md / CLAUDE.md)
 * - current context window usage + session totals (tokens/cost)
 */

import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Skill,
  SourceInfo,
  ToolInfo,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  Text,
  matchesKey,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
  // Deliberately fuzzy (good enough for “how big-ish is this”).
  return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeReadPath(inputPath: string, cwd: string): string {
  // Similar to pi's resolveToCwd/resolveReadPath, but simplified.
  let p = inputPath;
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
  return path.resolve(p);
}

function getAgentDir(): string {
  // Mirrors pi's behavior reasonably well.
  const envCandidates = ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"];
  let envDir: string | undefined;
  for (const k of envCandidates) {
    if (process.env[k]) {
      envDir = process.env[k];
      break;
    }
  }
  if (!envDir) {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.endsWith("_CODING_AGENT_DIR") && v) {
        envDir = v;
        break;
      }
    }
  }

  if (envDir) {
    if (envDir === "~") return os.homedir();
    if (envDir.startsWith("~/"))
      return path.join(os.homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

async function readFileIfExists(
  filePath: string,
): Promise<{ path: string; content: string; bytes: number } | null> {
  try {
    const buf = await fs.readFile(filePath);
    return {
      path: filePath,
      content: buf.toString("utf8"),
      bytes: buf.byteLength,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return null;
  }
}

async function loadProjectContextFiles(
  cwd: string,
): Promise<Array<{ path: string; tokens: number; bytes: number }>> {
  const out: Array<{ path: string; tokens: number; bytes: number }> = [];
  const seen = new Set<string>();

  const loadFromDir = async (dir: string) => {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(dir, name);
      const f = await readFileIfExists(p);
      if (f && !seen.has(f.path)) {
        seen.add(f.path);
        out.push({
          path: f.path,
          tokens: estimateTokens(f.content),
          bytes: f.bytes,
        });
        // pi loads at most one of those per dir
        return;
      }
    }
  };

  await loadFromDir(getAgentDir());

  // Ancestors: root → cwd (same order as pi)
  const stack: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    stack.push(current);
    const parent = path.resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  stack.reverse();
  for (const dir of stack) await loadFromDir(dir);

  return out;
}

function parseDisableModelInvocationFromFrontmatter(
  content: string,
): boolean {
  // Minimal YAML scan: look for `disable-model-invocation: true` inside the
  // leading `---` ... `---` block. Avoids pulling in a YAML parser.
  if (!content.startsWith("---")) return false;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return false;
  const fm = content.slice(3, end);
  for (const raw of fm.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^disable-model-invocation\s*:\s*(\S+)/i);
    if (m) return m[1].toLowerCase() === "true";
  }
  return false;
}

async function readDisableModelInvocation(
  filePath: string,
): Promise<boolean> {
  if (!filePath) return false;
  try {
    // Frontmatter sits at the top; read a small slice instead of the full file.
    const fh = await fs.open(filePath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return parseDisableModelInvocationFromFrontmatter(
        buf.slice(0, bytesRead).toString("utf8"),
      );
    } finally {
      await fh.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return false;
  }
}

function normalizeSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

type SkillIndexEntry = {
  name: string;
  skillFilePath: string;
  skillDir: string;
};

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndexEntry[] {
  return pi
    .getCommands()
    .filter((c) => c.source === "skill")
    .map((c) => {
      const p = c.sourceInfo?.path
        ? normalizeReadPath(c.sourceInfo.path, cwd)
        : "";
      return {
        name: normalizeSkillName(c.name),
        skillFilePath: p,
        skillDir: p ? path.dirname(p) : "",
      };
    })
    .filter((x) => x.name && x.skillDir);
}

function skillIndexFromPromptOptions(
  skills: Skill[] | undefined,
): SkillIndexEntry[] {
  if (!skills?.length) return [];
  return skills.map((s) => ({
    name: normalizeSkillName(s.name),
    skillFilePath: path.resolve(s.filePath),
    skillDir: path.resolve(s.baseDir),
  }));
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";

type SkillLoadedEntryData = {
  name: string;
  path: string;
};

function getLoadedSkillsFromSession(ctx: ExtensionContext): Set<string> {
  const out = new Set<string>();
  for (const e of ctx.sessionManager.getEntries()) {
    if ((e as any)?.type !== "custom") continue;
    if ((e as any)?.customType !== SKILL_LOADED_ENTRY) continue;
    const data = (e as any)?.data as SkillLoadedEntryData | undefined;
    if (data?.name) out.add(data.name);
  }
  return out;
}

function extractCostTotal(usage: any): number {
  if (!usage) return 0;
  const c = usage?.cost;
  if (typeof c === "number") return Number.isFinite(c) ? c : 0;
  if (typeof c === "string") {
    const n = Number(c);
    return Number.isFinite(n) ? n : 0;
  }
  const t = c?.total;
  if (typeof t === "number") return Number.isFinite(t) ? t : 0;
  if (typeof t === "string") {
    const n = Number(t);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if ((entry as any)?.type !== "message") continue;
    const msg = (entry as any)?.message;
    if (!msg || msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (!usage) continue;
    input += Number(usage.inputTokens ?? 0) || 0;
    output += Number(usage.outputTokens ?? 0) || 0;
    cacheRead += Number(usage.cacheRead ?? 0) || 0;
    cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
    totalCost += extractCostTotal(usage);
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    totalCost,
  };
}

function shortenPath(p: string, cwd: string): string {
  const rp = path.resolve(p);
  const rc = path.resolve(cwd);
  if (rp === rc) return ".";
  if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
  return shortenHome(rp);
}

function shortenHome(p: string): string {
  if (!p) return p;
  const rp = path.resolve(p);
  const home = os.homedir();
  if (rp === home) return "~";
  if (rp.startsWith(home + path.sep)) return "~/" + rp.slice(home.length + 1);
  return rp;
}

// Directory names that carry no identity of their own — they're layout, not
// the extension's name. Used when deriving a stable label from a file path.
const GENERIC_DIRS = new Set([
  "src",
  "dist",
  "lib",
  "build",
  "out",
  "extensions",
  "extension",
  "agent",
  ".pi",
  "node_modules",
]);

/**
 * Turn an extension/tool source path into a short, human-recognisable name.
 *
 * Synthetic paths (`<builtin:read>`, `<inline:llama.cpp>`) keep their inner
 * label. Real paths collapse to the nearest meaningful directory so that
 * `.../web-tools/index.ts` and `.../skill-toggle/src/index.ts` become
 * `web-tools` and `skill-toggle` instead of two identical `index.ts` lines.
 */
export function extensionLabel(rawPath: string | undefined): string {
  const p = rawPath ?? "";
  if (!p) return "<unknown>";
  if (p.startsWith("<")) return p.replace(/^<|>$/g, "");

  const abs = path.resolve(p);
  const stem = path.basename(abs).replace(/\.[cm]?[jt]sx?$/i, "");
  const dirs = path.dirname(abs).split(path.sep).filter(Boolean);

  if (stem === "index" || stem === "main" || stem === "extension") {
    for (let i = dirs.length - 1; i >= 0; i--) {
      if (!GENERIC_DIRS.has(dirs[i])) return dirs[i];
    }
    return stem;
  }
  const parent = dirs[dirs.length - 1];
  if (!parent || GENERIC_DIRS.has(parent)) return stem;
  return `${parent}/${stem}`;
}

/** Make labels unique by appending a shortened path to any collisions. */
function disambiguateLabels<T extends { label: string; path: string }>(
  entries: T[],
): T[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.label, (counts.get(e.label) ?? 0) + 1);
  return entries.map((e) =>
    (counts.get(e.label) ?? 0) > 1 && !e.path.startsWith("<")
      ? { ...e, label: `${e.label} (${shortenHome(e.path)})` }
      : e,
  );
}

function isSyntheticSource(info: SourceInfo | undefined): boolean {
  return !info?.path || info.path.startsWith("<");
}

/** Mirror of pi-claude-code-use's alias segment sanitizer. */
function sanitizeAliasSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Detect schema-only `mcp__` alias tools (as registered by
 * pi-claude-code-use for Anthropic OAuth, which rejects flat-named custom
 * tools). An alias is `mcp__<server>__<sanitized source name>` from a
 * different source file with an identical description. On the wire the flat
 * duplicate is removed, so counting both would overstate token cost.
 */
export function findAliasSource(
  alias: ToolInfo,
  candidates: ToolInfo[],
): ToolInfo | null {
  const nameLc = alias.name.toLowerCase();
  if (!nameLc.startsWith("mcp__")) return null;
  for (const c of candidates) {
    if (c.name === alias.name) continue;
    if (c.name.toLowerCase().startsWith("mcp__")) continue;
    if (c.sourceInfo?.path === alias.sourceInfo?.path) continue;
    const seg = sanitizeAliasSegment(c.name);
    if (!seg) continue;
    // mcp__<server>__<tool>, optionally with a numeric collision suffix.
    if (!new RegExp(`^mcp__[a-z0-9_]+__${seg}(_\\d+)?$`).test(nameLc)) continue;
    if ((alias.description ?? "") !== (c.description ?? "")) continue;
    return c;
  }
  return null;
}

type ExtensionEntry = {
  label: string;
  path: string;
  scope?: string;
  commands: string[];
  tools: string[];
};

/**
 * Group everything a single extension file contributes (slash commands and
 * tools) under one line, keyed by its source path.
 */
export function collectExtensions(
  commands: Array<{ name: string; source: string; sourceInfo?: SourceInfo }>,
  tools: Array<{ name: string; sourceInfo?: SourceInfo }>,
): ExtensionEntry[] {
  const byPath = new Map<string, ExtensionEntry>();

  const entryFor = (info: SourceInfo | undefined): ExtensionEntry => {
    const p = info?.path ?? "<unknown>";
    let e = byPath.get(p);
    if (!e) {
      e = {
        label: extensionLabel(p),
        path: p,
        scope: info?.scope,
        commands: [],
        tools: [],
      };
      byPath.set(p, e);
    }
    return e;
  };

  for (const c of commands) {
    if (c.source !== "extension") continue;
    entryFor(c.sourceInfo).commands.push(c.name);
  }
  for (const t of tools) {
    // builtin/sdk tools are not extensions; they're attributed but not listed.
    if (isSyntheticSource(t.sourceInfo)) continue;
    entryFor(t.sourceInfo).tools.push(t.name);
  }

  const entries = [...byPath.values()].map((e) => ({
    ...e,
    commands: [...e.commands].sort((a, b) => a.localeCompare(b)),
    tools: [...e.tools].sort((a, b) => a.localeCompare(b)),
  }));
  return disambiguateLabels(entries).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

function renderUsageBar(
  theme: any,
  parts: { system: number; tools: number; convo: number; remaining: number },
  total: number,
  width: number,
): string {
  const w = Math.max(10, width);
  if (total <= 0) return "";

  const toCols = (n: number) => Math.round((n / total) * w);
  let sys = toCols(parts.system);
  let tools = toCols(parts.tools);
  let con = toCols(parts.convo);
  let rem = w - sys - tools - con;
  if (rem < 0) rem = 0;
  // adjust rounding drift
  while (sys + tools + con + rem < w) rem++;
  while (sys + tools + con + rem > w && rem > 0) rem--;

  const block = "█";
  const sysStr = theme.fg("accent", block.repeat(sys));
  const toolsStr = theme.fg("warning", block.repeat(tools));
  const conStr = theme.fg("success", block.repeat(con));
  const remStr = theme.fg("dim", block.repeat(rem));
  return `${sysStr}${toolsStr}${conStr}${remStr}`;
}

function buildSystemPromptBreakdown(
  options: BuildSystemPromptOptions | null,
  fullSystemPrompt: string,
  agentTokens: number,
  skillsCount: number,
): Array<{ label: string; tokens: number }> {
  const out: Array<{ label: string; tokens: number }> = [];
  if (!fullSystemPrompt) return out;

  const total = estimateTokens(fullSystemPrompt);
  const appendTokens = estimateTokens(options?.appendSystemPrompt ?? "");
  const customTokens = estimateTokens(options?.customPrompt ?? "");
  const skillsMarker = "<available_skills>";
  const skillsTokens = fullSystemPrompt.includes(skillsMarker)
    ? estimateTokens(
        fullSystemPrompt.slice(fullSystemPrompt.indexOf(skillsMarker)),
      )
    : 0;
  const cwdDateMatch = fullSystemPrompt.match(
    /\nCurrent date: .*\nCurrent working directory: .*$/s,
  );
  const cwdDateTokens = estimateTokens(cwdDateMatch?.[0] ?? "");

  if (customTokens > 0)
    out.push({ label: "custom prompt", tokens: customTokens });
  else {
    const baseTokens = Math.max(
      0,
      total - appendTokens - agentTokens - skillsTokens - cwdDateTokens,
    );
    out.push({ label: "pi base prompt/docs/guidelines", tokens: baseTokens });
  }
  if (appendTokens > 0)
    out.push({ label: "appendSystemPrompt", tokens: appendTokens });
  if (agentTokens > 0)
    out.push({ label: "AGENTS/context files", tokens: agentTokens });
  if (skillsTokens > 0)
    out.push({
      label: `skills index (${skillsCount} model-invocable)`,
      tokens: skillsTokens,
    });
  if (cwdDateTokens > 0)
    out.push({ label: "date + cwd", tokens: cwdDateTokens });

  const accounted = out.reduce((a, x) => a + x.tokens, 0);
  const drift = total - accounted;
  if (Math.abs(drift) > 10)
    out.push({ label: "unclassified/rounding", tokens: drift });
  return out;
}

function escapeXmlForPrompt(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSkillPromptBreakdown(
  skills: Skill[] | undefined,
): Array<{ name: string; tokens: number }> {
  if (!skills?.length) return [];
  return skills
    .filter((s) => !s.disableModelInvocation)
    .map((s) => {
      const entry = [
        "  <skill>",
        `    <name>${escapeXmlForPrompt(s.name)}</name>`,
        `    <description>${escapeXmlForPrompt(s.description)}</description>`,
        `    <location>${escapeXmlForPrompt(s.filePath)}</location>`,
        "  </skill>",
      ].join("\n");
      return {
        name: normalizeSkillName(s.name),
        tokens: estimateTokens(entry),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildSkillPromptBreakdownFromCommands(
  commands: ReturnType<ExtensionAPI["getCommands"]>,
  cwd: string,
  userInvokedByName?: Map<string, boolean>,
): Array<{ name: string; tokens: number }> {
  return commands
    .filter((c) => c.source === "skill")
    .filter((c) => !userInvokedByName?.get(normalizeSkillName(c.name)))
    .map((c) => {
      const name = normalizeSkillName(c.name);
      const filePath = c.sourceInfo?.path
        ? normalizeReadPath(c.sourceInfo.path, cwd)
        : "";
      const entry = [
        "  <skill>",
        `    <name>${escapeXmlForPrompt(name)}</name>`,
        `    <description>${escapeXmlForPrompt(c.description ?? "")}</description>`,
        `    <location>${escapeXmlForPrompt(filePath)}</location>`,
        "  </skill>",
      ].join("\n");
      return { name, tokens: estimateTokens(entry) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

type ContextViewData = {
  usage: {
    /** Context estimate from ctx.getContextUsage() (provider-anchored once a reply exists). */
    messageTokens: number;
    contextWindow: number;
    /** What we actually report as "used" — see `mode`. */
    effectiveTokens: number;
    percent: number;
    remainingTokens: number;
    systemPromptTokens: number;
    agentTokens: number;
    toolsTokens: number;
    activeTools: number;
    /** Active aliases whose flat source is also active (deduped on the wire). */
    dedupedAliases: number;
    /**
     * "measured": the provider already reported usage, which includes system
     * prompt + tool schemas, so we must not add our own estimates on top.
     * "estimated": no assistant reply yet, so we sum our own estimates.
     */
    mode: "measured" | "estimated";
  } | null;
  agentFiles: Array<{ path: string; tokens: number }>;
  systemBreakdown: Array<{ label: string; tokens: number }>;
  skillBreakdown: Array<{ name: string; tokens: number; source?: string }>;
  toolBreakdown: Array<{
    name: string;
    tokens: number;
    source?: string;
    /** Flat tool this mcp__ alias mirrors, when detected. */
    aliasOf?: string;
    /** false → excluded from the tools total (wire-deduplicated duplicate). */
    counted: boolean;
  }>;
  extensions: ExtensionEntry[];
  skills: Array<{
    name: string;
    source?: string;
    userInvoked: boolean;
    loaded: boolean;
    tokens?: number;
  }>;
  session: { totalTokens: number; totalCost: number };
};

type Styler = {
  heading: (s: string) => string;
  label: (s: string) => string;
  value: (s: string) => string;
  dim: (s: string) => string;
  skillName: (name: string, loaded: boolean, userInvoked: boolean) => string;
};

export const PLAIN_STYLER: Styler = {
  heading: (s) => s,
  label: (s) => s,
  value: (s) => s,
  dim: (s) => s,
  skillName: (n) => n,
};

const ITEM = "  - ";
const SUBITEM = "    - ";

function tok(n: number): string {
  return `~${n.toLocaleString()} tok`;
}

/**
 * Single source of truth for the report layout. The TUI passes a themed
 * styler (plus a pre-rendered usage bar); the headless path passes
 * PLAIN_STYLER. Keeping one renderer stops the two outputs from drifting.
 */
export function buildReportLines(
  d: ContextViewData,
  s: Styler,
  bar?: string,
): string[] {
  const lines: string[] = [];

  if (!d.usage) {
    lines.push(s.label("Window: ") + s.dim("(unknown)"));
  } else {
    const u = d.usage;
    lines.push(
      s.label("Window: ") +
        s.value(
          `~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`,
        ) +
        s.label(
          `  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`,
        ) +
        s.dim(
          u.mode === "measured"
            ? "  [reported by provider]"
            : "  [estimated, no reply yet]",
        ),
    );
    if (bar) lines.push(bar);
  }

  const section = (title: string) => {
    lines.push("");
    lines.push(s.heading(title));
  };

  if (d.usage) {
    const u = d.usage;
    section("Prompt");
    lines.push(s.label("System: ") + s.value(tok(u.systemPromptTokens)));
    for (const x of d.systemBreakdown) {
      lines.push(SUBITEM + s.value(x.label) + s.label(` ${tok(x.tokens)}`));
    }
    lines.push(
      s.label("Tools: ") +
        s.value(tok(u.toolsTokens)) +
        s.label(` (${u.activeTools} active`) +
        (u.dedupedAliases > 0
          ? s.label(", ") +
            s.dim(`${u.dedupedAliases} aliases not double-counted`)
          : "") +
        s.label(")"),
    );
    for (const x of d.toolBreakdown) {
      if (!x.counted) {
        // Wire-deduplicated alias, nested under its flat source line.
        lines.push(
          "      " +
            s.dim(`↳ ${x.name}  sent instead under Anthropic OAuth`),
        );
        continue;
      }
      lines.push(
        SUBITEM +
          s.value(x.name) +
          s.label(` ${tok(x.tokens)}`) +
          (x.source ? s.dim(`  from ${x.source}`) : "") +
          (x.aliasOf ? s.dim(`  alias of ${x.aliasOf} (inactive)`) : ""),
      );
    }
  }

  section(`Context files (${d.agentFiles.length})`);
  if (d.agentFiles.length === 0) {
    lines.push(ITEM + s.dim("(none)"));
  } else {
    for (const f of d.agentFiles) {
      lines.push(ITEM + s.value(f.path) + s.label(` ${tok(f.tokens)}`));
    }
  }

  section(`Extensions (${d.extensions.length})`);
  lines.push(s.dim("  detected from registered commands and active tools"));
  if (d.extensions.length === 0) {
    lines.push(ITEM + s.dim("(none)"));
  } else {
    for (const e of d.extensions) {
      const parts: string[] = [];
      if (e.commands.length)
        parts.push(e.commands.map((c) => `/${c}`).join(" "));
      if (e.tools.length) parts.push(`tools: ${e.tools.join(" ")}`);
      lines.push(
        ITEM +
          s.value(e.label) +
          (parts.length ? s.dim(`  ${parts.join("  ·  ")}`) : ""),
      );
    }
  }

  const inPrompt = d.skills.filter((x) => !x.userInvoked).length;
  section(
    `Skills (${d.skills.length}: ${inPrompt} in prompt, ${d.skills.length - inPrompt} user-invoked)`,
  );
  if (d.skills.length === 0) {
    lines.push(ITEM + s.dim("(none)"));
  } else {
    for (const sk of d.skills) {
      lines.push(
        ITEM +
          s.skillName(sk.name, sk.loaded, sk.userInvoked) +
          (sk.tokens != null ? s.label(` ${tok(sk.tokens)}`) : "") +
          (sk.userInvoked ? s.dim(" [user-invoked]") : "") +
          (sk.loaded ? s.dim(" [read this session]") : "") +
          (sk.source ? s.dim(`  ${sk.source}`) : ""),
      );
    }
  }

  lines.push("");
  lines.push(
    s.label("Session: ") +
      s.value(`${d.session.totalTokens.toLocaleString()} tokens`) +
      s.label(" · ") +
      s.value(formatUsd(d.session.totalCost)),
  );

  return lines;
}

class ContextView implements Component {
  private tui: TUI;
  private theme: any;
  private onDone: () => void;
  private data: ContextViewData;
  private container: Container;
  private body: Text;
  private cachedWidth?: number;

  constructor(tui: TUI, theme: any, data: ContextViewData, onDone: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.data = data;
    this.onDone = onDone;

    this.container = new Container();
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
    this.container.addChild(
      new Text(
        theme.fg("accent", theme.bold("Context")) +
          theme.fg("dim", "  (Esc/q/Enter to close)"),
        1,
        0,
      ),
    );
    this.container.addChild(new Text("", 1, 0));

    this.body = new Text("", 1, 0);
    this.container.addChild(this.body);

    this.container.addChild(new Text("", 1, 0));
    this.container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
  }

  private rebuild(width: number): void {
    const theme = this.theme;
    const styler: Styler = {
      heading: (s) => theme.fg("accent", theme.bold(s)),
      label: (s) => theme.fg("muted", s),
      value: (s) => theme.fg("text", s),
      dim: (s) => theme.fg("dim", s),
      skillName: (name, loaded, userInvoked) =>
        userInvoked
          ? theme.fg("warning", name)
          : loaded
            ? theme.fg("success", name)
            : theme.fg("text", name),
    };

    let bar: string | undefined;
    const u = this.data.usage;
    if (u && u.contextWindow > 0) {
      const barWidth = Math.max(10, Math.min(36, width - 10));
      // Split the reported total into system / tools / conversation. In
      // "measured" mode the provider total already contains the system prompt
      // and tool schemas, so they are carved out of it rather than added.
      const sys = Math.min(u.systemPromptTokens, u.effectiveTokens);
      const tools = Math.max(0, Math.min(u.toolsTokens, u.effectiveTokens - sys));
      const convo = Math.max(0, u.effectiveTokens - sys - tools);
      bar =
        renderUsageBar(
          theme,
          {
            system: sys,
            tools,
            convo,
            remaining: u.remainingTokens,
          },
          u.contextWindow,
          barWidth,
        ) +
        " " +
        theme.fg("dim", "sys") +
        theme.fg("accent", "\u2588") +
        " " +
        theme.fg("dim", "tools") +
        theme.fg("warning", "\u2588") +
        " " +
        theme.fg("dim", "convo") +
        theme.fg("success", "\u2588") +
        " " +
        theme.fg("dim", "free") +
        theme.fg("dim", "\u2588");
    }

    this.body.setText(buildReportLines(this.data, styler, bar).join("\n"));
    this.cachedWidth = width;
  }

  handleInput(data: string): void {
    if (
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c")) ||
      data.toLowerCase() === "q" ||
      data === "\r"
    ) {
      this.onDone();
      return;
    }
  }

  invalidate(): void {
    this.container.invalidate();
    this.cachedWidth = undefined;
  }

  render(width: number): string[] {
    if (this.cachedWidth !== width) this.rebuild(width);
    return this.container.render(width);
  }
}

export default function contextExtension(pi: ExtensionAPI) {
  // Track which skills were actually pulled in via read tool calls.
  let lastSessionId: string | null = null;
  let cachedLoadedSkills = new Set<string>();
  let cachedSkillIndex: SkillIndexEntry[] = [];
  // Snapshot of the structured prompt options used on the most recent
  // before_agent_start — lets /context report what pi actually loaded
  // instead of re-scanning cwd.
  let lastPromptOptions: BuildSystemPromptOptions | null = null;

  const ensureCaches = (ctx: ExtensionContext) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid !== lastSessionId) {
      lastSessionId = sid;
      cachedLoadedSkills = getLoadedSkillsFromSession(ctx);
      cachedSkillIndex = [];
      lastPromptOptions = null;
    }
    // Prefer skill index from last prompt snapshot; fall back to command
    // registry when no agent turn has run yet this session.
    const snapshotIndex = skillIndexFromPromptOptions(
      lastPromptOptions?.skills,
    );
    if (snapshotIndex.length > 0) {
      cachedSkillIndex = snapshotIndex;
    } else if (cachedSkillIndex.length === 0) {
      cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
    }
  };

  pi.on("before_agent_start", (event: BeforeAgentStartEvent) => {
    if (event.systemPromptOptions) {
      lastPromptOptions = event.systemPromptOptions;
    }
  });

  const matchSkillForPath = (absPath: string): string | null => {
    let best: SkillIndexEntry | null = null;
    for (const s of cachedSkillIndex) {
      if (!s.skillDir) continue;
      if (
        absPath === s.skillFilePath ||
        absPath.startsWith(s.skillDir + path.sep)
      ) {
        if (!best || s.skillDir.length > best.skillDir.length) best = s;
      }
    }
    return best?.name ?? null;
  };

  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    // Only count successful reads.
    if ((event as any).toolName !== "read") return;
    if ((event as any).isError) return;

    const input = (event as any).input as { path?: unknown } | undefined;
    const p = typeof input?.path === "string" ? input.path : "";
    if (!p) return;

    ensureCaches(ctx);
    const abs = normalizeReadPath(p, ctx.cwd);
    const skillName = matchSkillForPath(abs);
    if (!skillName) return;

    if (!cachedLoadedSkills.has(skillName)) {
      cachedLoadedSkills.add(skillName);
      pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, {
        name: skillName,
        path: abs,
      });
    }
  });

  pi.registerCommand("context", {
    description: "Show loaded context overview",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const commands = pi.getCommands();
      const skillCmds = commands.filter((c) => c.source === "skill");
      const allTools = pi.getAllTools();
      const activeToolNames = pi.getActiveTools();
      const activeToolSet = new Set(activeToolNames);

      // Extensions are identified by their source file and grouped with
      // everything they contribute, so every line is self-explanatory.
      const extensions = collectExtensions(
        commands,
        allTools.filter((t) => activeToolSet.has(t.name)),
      );

      // Build a name -> source dir map from the skill index so we can
      // show users where each skill is loaded from.
      ensureCaches(ctx as unknown as ExtensionContext);
      const skillSourceByName = new Map<string, string>();
      for (const s of cachedSkillIndex) {
        if (s.name && s.skillDir) skillSourceByName.set(s.name, s.skillDir);
      }
      // Also fold in directly-known sources from the prompt snapshot.
      if (lastPromptOptions?.skills?.length) {
        for (const s of lastPromptOptions.skills) {
          const n = normalizeSkillName(s.name);
          if (n && s.baseDir && !skillSourceByName.has(n)) {
            skillSourceByName.set(n, path.resolve(s.baseDir));
          }
        }
      }

      // Prefer skills from last prompt snapshot (the set pi actually
      // formatted into the system prompt) over the command registry.
      // Track which ones are user-invoked only (disableModelInvocation):
      // those don't appear in the system prompt but can still be triggered
      // via /skill:name.
      const userInvokedByName = new Map<string, boolean>();
      if (lastPromptOptions?.skills?.length) {
        for (const s of lastPromptOptions.skills) {
          userInvokedByName.set(
            normalizeSkillName(s.name),
            !!s.disableModelInvocation,
          );
        }
      }
      // Fill in any skills we don't have a snapshot flag for by reading
      // the SKILL.md frontmatter directly. This covers the common case of
      // /context being invoked before any agent turn has run, when
      // `lastPromptOptions` is still null.
      const skillFileByName = new Map<string, string>();
      for (const c of skillCmds) {
        const n = normalizeSkillName(c.name);
        const p = c.sourceInfo?.path
          ? normalizeReadPath(c.sourceInfo.path, ctx.cwd)
          : "";
        if (n && p && !skillFileByName.has(n)) skillFileByName.set(n, p);
      }
      if (lastPromptOptions?.skills?.length) {
        for (const s of lastPromptOptions.skills) {
          const n = normalizeSkillName(s.name);
          if (n && s.filePath && !skillFileByName.has(n)) {
            skillFileByName.set(n, path.resolve(s.filePath));
          }
        }
      }
      await Promise.all(
        [...skillFileByName.entries()].map(async ([n, p]) => {
          if (userInvokedByName.has(n)) return;
          userInvokedByName.set(n, await readDisableModelInvocation(p));
        }),
      );
      const skillNames = (
        lastPromptOptions?.skills?.length
          ? lastPromptOptions.skills.map((s) => normalizeSkillName(s.name))
          : skillCmds.map((c) => normalizeSkillName(c.name))
      ).sort((a, b) => a.localeCompare(b));
      const skills = skillNames.map((name) => ({
        name,
        source: skillSourceByName.get(name)
          ? shortenHome(skillSourceByName.get(name)!)
          : undefined,
        userInvoked: userInvokedByName.get(name) ?? false,
      }));

      // Prefer context files from last prompt snapshot — that's exactly
      // what pi loaded into the system prompt. Fall back to disk scan if
      // no agent turn has run yet this session.
      const agentFiles =
        lastPromptOptions?.contextFiles?.map((f) => ({
          path: f.path,
          tokens: estimateTokens(f.content),
          bytes: Buffer.byteLength(f.content, "utf8"),
        })) ?? (await loadProjectContextFiles(ctx.cwd));
      const agentFilesShown = agentFiles.map((f) => ({
        path: shortenPath(f.path, ctx.cwd),
        tokens: f.tokens,
      }));
      const agentTokens = agentFiles.reduce((a, f) => a + f.tokens, 0);

      const systemPrompt = ctx.getSystemPrompt();
      const systemPromptTokens = systemPrompt
        ? estimateTokens(systemPrompt)
        : 0;
      const skillBreakdownRaw = lastPromptOptions?.skills?.length
        ? buildSkillPromptBreakdown(lastPromptOptions.skills)
        : buildSkillPromptBreakdownFromCommands(
            commands,
            ctx.cwd,
            userInvokedByName,
          );
      const skillBreakdown = skillBreakdownRaw.map((x) => ({
        ...x,
        source: skillSourceByName.get(x.name)
          ? shortenHome(skillSourceByName.get(x.name)!)
          : undefined,
      }));
      // Only model-invocable skills contribute to the <available_skills>
      // block, so that's the count the breakdown label should show.
      const systemBreakdown = buildSystemPromptBreakdown(
        lastPromptOptions,
        systemPrompt,
        agentTokens,
        skillBreakdown.length,
      );

      const usage = ctx.getContextUsage();
      const messageTokens = usage?.tokens ?? 0;
      const ctxWindow = usage?.contextWindow ?? 0;

      // Tool definitions aren't itemised anywhere, so estimate them from the
      // full serialized definition (name + description + JSON schema + any
      // prompt guidelines) plus a small per-tool framing overhead.
      const TOOL_OVERHEAD_TOKENS = 8;
      const toolInfoByName = new Map(allTools.map((t) => [t.name, t] as const));

      // Detect mcp__ aliases of flat tools (see findAliasSource). When both
      // sides are active the flat one is stripped from the wire, so only the
      // alias' twin is counted once; when only the alias is active it *is*
      // the real tool on the wire and counts normally.
      const aliasSourceByName = new Map<
        string,
        { source: string; sourceActive: boolean }
      >();
      for (const name of activeToolNames) {
        const info = toolInfoByName.get(name);
        if (!info) continue;
        const src = findAliasSource(info, allTools);
        if (src) {
          aliasSourceByName.set(name, {
            source: src.name,
            sourceActive: activeToolSet.has(src.name),
          });
        }
      }

      let toolsTokens = 0;
      let dedupedAliases = 0;
      type ToolLine = ContextViewData["toolBreakdown"][number];
      const countedLines: ToolLine[] = [];
      const dedupedByFlatName = new Map<string, ToolLine>();
      for (const name of activeToolNames) {
        const info = toolInfoByName.get(name);
        const blob = [
          name,
          info?.description ?? "",
          info?.parameters ? JSON.stringify(info.parameters) : "",
          typeof info?.promptGuidelines === "string"
            ? info.promptGuidelines
            : "",
        ].join("\n");
        const tokens = estimateTokens(blob) + TOOL_OVERHEAD_TOKENS;
        const alias = aliasSourceByName.get(name);
        const line: ToolLine = {
          name,
          tokens,
          // Attribute every tool to its provider so duplicate-looking tools
          // (e.g. an MCP tool and a native one) are distinguishable.
          source: info ? extensionLabel(info.sourceInfo?.path) : undefined,
          aliasOf: alias?.source,
          counted: !alias?.sourceActive,
        };
        if (!line.counted) {
          dedupedAliases++;
          dedupedByFlatName.set(alias!.source, line);
        } else {
          toolsTokens += tokens;
          countedLines.push(line);
        }
      }
      countedLines.sort(
        (a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name),
      );
      // Interleave: each deduplicated alias goes right below its flat source.
      const toolBreakdown: ToolLine[] = [];
      for (const line of countedLines) {
        toolBreakdown.push(line);
        const dup = dedupedByFlatName.get(line.name);
        if (dup) {
          toolBreakdown.push(dup);
          dedupedByFlatName.delete(line.name);
        }
      }
      // Safety net: any alias whose source line vanished still gets shown.
      toolBreakdown.push(...dedupedByFlatName.values());

      // Once the provider has reported usage, ctx.getContextUsage() is
      // anchored to a real total that already includes the system prompt and
      // tool schemas — adding our estimates on top would double count. Before
      // the first reply there is nothing to anchor to, so we sum estimates.
      const hasProviderUsage = ctx.sessionManager
        .getEntries()
        .some(
          (e: any) =>
            e?.type === "message" &&
            e?.message?.role === "assistant" &&
            e?.message?.usage,
        );
      const mode: "measured" | "estimated" = hasProviderUsage
        ? "measured"
        : "estimated";
      const effectiveTokens = hasProviderUsage
        ? messageTokens
        : messageTokens + systemPromptTokens + toolsTokens;
      const percent = ctxWindow > 0 ? (effectiveTokens / ctxWindow) * 100 : 0;
      const remainingTokens =
        ctxWindow > 0 ? Math.max(0, ctxWindow - effectiveTokens) : 0;

      const sessionUsage = sumSessionUsage(ctx);
      const loadedSkills = getLoadedSkillsFromSession(ctx);
      const skillTokensByName = new Map(
        skillBreakdown.map((x) => [x.name, x.tokens] as const),
      );

      const viewData: ContextViewData = {
        usage: usage
          ? {
              messageTokens,
              contextWindow: ctxWindow,
              effectiveTokens,
              percent,
              remainingTokens,
              systemPromptTokens,
              agentTokens,
              toolsTokens,
              activeTools: activeToolNames.length,
              dedupedAliases,
              mode,
            }
          : null,
        agentFiles: agentFilesShown,
        systemBreakdown,
        skillBreakdown,
        toolBreakdown,
        extensions,
        skills: skills.map((s) => ({
          ...s,
          loaded: loadedSkills.has(s.name),
          tokens: skillTokensByName.get(s.name),
        })),
        session: {
          totalTokens: sessionUsage.totalTokens,
          totalCost: sessionUsage.totalCost,
        },
      };

      if (!ctx.hasUI) {
        pi.sendMessage(
          {
            customType: "context",
            content: ["Context", ...buildReportLines(viewData, PLAIN_STYLER)]
              .join("\n"),
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        return new ContextView(tui, theme, viewData, done);
      });
    },
  });
}
