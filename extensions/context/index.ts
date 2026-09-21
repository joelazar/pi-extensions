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

/**
 * Extension entry points pi would load from a directory: a `pi.extensions`
 * manifest if present, otherwise an index file. Mirrors pi's loader.
 */
async function resolveExtensionEntries(dir: string): Promise<string[]> {
  try {
    const pkg = JSON.parse(
      await fs.readFile(path.join(dir, "package.json"), "utf8"),
    );
    const declared = pkg?.pi?.extensions;
    if (Array.isArray(declared)) {
      const entries: string[] = [];
      for (const rel of declared) {
        if (typeof rel !== "string") continue;
        const abs = path.resolve(dir, rel);
        if (await exists(abs)) entries.push(abs);
      }
      if (entries.length > 0) return entries;
    }
  } catch {
    // no manifest — fall through to index files
  }
  for (const name of ["index.ts", "index.js"]) {
    const abs = path.join(dir, name);
    if (await exists(abs)) return [abs];
  }
  return [];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function discoverExtensionsInDir(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if ((e.isFile() || e.isSymbolicLink()) && /\.[jt]s$/.test(e.name)) {
      out.push(p);
      continue;
    }
    if (e.isDirectory() || e.isSymbolicLink()) {
      out.push(...(await resolveExtensionEntries(p)));
    }
  }
  return out;
}

async function readSettingsExtensionPaths(file: string): Promise<string[]> {
  try {
    const settings = JSON.parse(await fs.readFile(file, "utf8"));
    const list = settings?.extensions;
    return Array.isArray(list)
      ? list.filter((x: unknown): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Extension files pi loads that register neither a slash command nor a tool.
 * They are invisible to getCommands()/getAllTools(), so the discovery dirs and
 * settings lists are replayed here. Package-manager specs (globs, `-`/`!`/`+`
 * overrides, bare package names) are skipped — resolving those faithfully
 * needs pi's package manager.
 */
export async function discoverSilentExtensionPaths(
  cwd: string,
): Promise<string[]> {
  const out: string[] = [];
  out.push(
    ...(await discoverExtensionsInDir(path.join(cwd, ".pi", "extensions"))),
  );
  out.push(
    ...(await discoverExtensionsInDir(path.join(getAgentDir(), "extensions"))),
  );

  const configured = [
    ...(await readSettingsExtensionPaths(
      path.join(getAgentDir(), "settings.json"),
    )),
    ...(await readSettingsExtensionPaths(
      path.join(cwd, ".pi", "settings.json"),
    )),
  ];
  for (const spec of configured) {
    if (/^[-!+]/.test(spec) || /[*?]/.test(spec)) continue;
    if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("~"))
      continue;
    const abs = normalizeReadPath(spec, cwd);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) continue;
    if (stat.isDirectory()) {
      const entries = await resolveExtensionEntries(abs);
      out.push(...(entries.length ? entries : await discoverExtensionsInDir(abs)));
    } else {
      out.push(abs);
    }
  }
  return [...new Set(out.map((p) => path.resolve(p)))];
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
  discoveredPaths: string[] = [],
): ExtensionEntry[] {
  const byPath = new Map<string, ExtensionEntry>();

  const entryFor = (info: SourceInfo | undefined): ExtensionEntry => {
    const p = info?.path ?? "<unknown>";
    let e = byPath.get(p);
    if (!e) {
      e = { label: extensionLabel(p), path: p, commands: [], tools: [] };
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
  // Extensions that only register hooks or renderers contribute no command
  // and no tool, so they exist only as a file path on disk.
  const known = new Set(
    [...byPath.keys()]
      .filter((k) => !k.startsWith("<"))
      .map((k) => path.resolve(k)),
  );
  for (const p of discoveredPaths) {
    if (!known.has(path.resolve(p))) entryFor({ path: p } as SourceInfo);
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

/**
 * pi renders the system prompt as a preamble followed by `<name>…</name>`
 * sections joined by blank lines. Splitting on that structure attributes every
 * token to the section that actually carries it, instead of guessing with
 * substring offsets that rot whenever pi reshapes the prompt.
 */
export function splitSystemPromptSections(prompt: string): {
  preamble: string;
  sections: Array<{ name: string; text: string }>;
} {
  const re = /(?:^|\n\n)<([a-z][a-z0-9_-]*)>\n([\s\S]*?)\n<\/\1>(?=\n\n|$)/g;
  const sections: Array<{ name: string; text: string }> = [];
  let firstIndex = prompt.length;
  for (const m of prompt.matchAll(re)) {
    if (m.index !== undefined && m.index < firstIndex) firstIndex = m.index;
    sections.push({ name: m[1], text: m[0].replace(/^\n\n/, "") });
  }
  return { preamble: prompt.slice(0, firstIndex), sections };
}

const SECTION_LABELS: Record<string, string> = {
  tools: "tool list",
  rules: "rules",
  docs: "pi docs pointers",
  addendum: "appendSystemPrompt",
  project_context: "AGENTS/context files",
  cwd: "cwd",
};

export function buildSystemPromptBreakdown(
  options: BuildSystemPromptOptions | null,
  fullSystemPrompt: string,
  skillsCount: number,
): Array<{ label: string; tokens: number }> {
  const out: Array<{ label: string; tokens: number }> = [];
  if (!fullSystemPrompt) return out;

  const { preamble, sections } = splitSystemPromptSections(fullSystemPrompt);
  const preambleTokens = estimateTokens(preamble);
  if (preambleTokens > 0)
    out.push({
      label: options?.customPrompt ? "custom prompt" : "pi base prompt",
      tokens: preambleTokens,
    });
  for (const s of sections) {
    out.push({
      label:
        s.name === "skills"
          ? `skills index (${skillsCount} model-invocable)`
          : (SECTION_LABELS[s.name] ?? s.name),
      tokens: estimateTokens(s.text),
    });
  }

  const accounted = out.reduce((a, x) => a + x.tokens, 0);
  const drift = estimateTokens(fullSystemPrompt) - accounted;
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
    toolsTokens: number;
    activeTools: number;
    /** Flat tools an active mcp alias replaces on the wire. */
    replacedTools: number;
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
    /** Inactive flat tool this mcp__ alias mirrors, when detected. */
    aliasOf?: string;
    /** Active alias that replaces this flat tool on the wire. */
    replacedBy?: string;
    /** false → not sent to the provider, so excluded from the tools total. */
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
 * Split the reported total into system / tools / conversation. In "measured"
 * mode the provider total already contains the system prompt and tool schemas,
 * so they are carved out of it rather than added.
 */
function splitUsage(u: NonNullable<ContextViewData["usage"]>): {
  system: number;
  tools: number;
  convo: number;
} {
  const system = Math.min(u.systemPromptTokens, u.effectiveTokens);
  const tools = Math.max(
    0,
    Math.min(u.toolsTokens, u.effectiveTokens - system),
  );
  return {
    system,
    tools,
    convo: Math.max(0, u.effectiveTokens - system - tools),
  };
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
        s.label(
          ` (${u.activeTools - u.replacedTools} sent of ${u.activeTools} active`,
        ) +
        (u.replacedTools > 0
          ? s.label(", ") +
            s.dim(`${u.replacedTools} replaced by mcp aliases`)
          : "") +
        s.label(")"),
    );
    for (const x of d.toolBreakdown) {
      if (!x.counted) {
        // Flat name the provider rejects, nested under the alias that ships.
        lines.push(
          "      " +
            s.dim(`↳ replaces ${x.name}, not sent under Anthropic OAuth`),
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
    lines.push(
      s.label("Messages: ") +
        s.value(tok(splitUsage(u).convo)) +
        s.dim("  conversation so far"),
    );
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
  lines.push(
    s.dim("  from registered commands, active tools, and discovered paths"),
  );
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
          s.dim(
            parts.length
              ? `  ${parts.join("  ·  ")}`
              : "  (no commands or tools)",
          ),
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
      const { system: sys, tools, convo } = splitUsage(u);
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

  const ensureCaches = (
    ctx: ExtensionContext,
    options?: BuildSystemPromptOptions,
  ) => {
    const sid = ctx.sessionManager.getSessionId();
    if (sid !== lastSessionId) {
      lastSessionId = sid;
      cachedLoadedSkills = getLoadedSkillsFromSession(ctx);
      cachedSkillIndex = [];
      lastPromptOptions = null;
    }
    // Prefer skill index from the prompt options; fall back to the command
    // registry when no agent turn has run yet this session.
    const snapshotIndex = skillIndexFromPromptOptions(
      (options ?? lastPromptOptions)?.skills,
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
      const allTools = pi.getAllTools();
      const activeToolNames = pi.getActiveTools();
      const activeToolSet = new Set(activeToolNames);
      // The per-turn snapshot reflects extension mutations; the base options
      // are always available, including before the first agent turn.
      const promptOptions = lastPromptOptions ?? ctx.getSystemPromptOptions();

      // Extensions are identified by their source file and grouped with
      // everything they contribute, so every line is self-explanatory.
      const extensions = collectExtensions(
        commands,
        allTools.filter((t) => activeToolSet.has(t.name)),
        await discoverSilentExtensionPaths(ctx.cwd),
      );

      ensureCaches(ctx as unknown as ExtensionContext, promptOptions);
      const promptSkills = promptOptions.skills ?? [];
      const skillSourceByName = new Map<string, string>();
      for (const s of promptSkills) {
        const n = normalizeSkillName(s.name);
        if (n && s.baseDir) skillSourceByName.set(n, path.resolve(s.baseDir));
      }
      // Skills flagged disableModelInvocation stay out of the system prompt
      // but remain callable via /skill:name.
      const skills = promptSkills
        .map((s) => {
          const name = normalizeSkillName(s.name);
          return {
            name,
            source: skillSourceByName.has(name)
              ? shortenHome(skillSourceByName.get(name)!)
              : undefined,
            userInvoked: !!s.disableModelInvocation,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const agentFilesShown = (promptOptions.contextFiles ?? []).map((f) => ({
        path: shortenPath(f.path, ctx.cwd),
        tokens: estimateTokens(f.content),
      }));

      const systemPrompt = ctx.getSystemPrompt();
      const systemPromptTokens = systemPrompt
        ? estimateTokens(systemPrompt)
        : 0;
      const skillBreakdown = buildSkillPromptBreakdown(promptSkills).map((x) => ({
        ...x,
        source: skillSourceByName.get(x.name)
          ? shortenHome(skillSourceByName.get(x.name)!)
          : undefined,
      }));
      // Only model-invocable skills contribute to the <available_skills>
      // block, so that's the count the breakdown label should show.
      const systemBreakdown = buildSystemPromptBreakdown(
        promptOptions,
        systemPrompt,
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
      // sides are active the alias is what reaches the provider and the flat
      // twin is dropped, so the alias carries the token cost.
      const aliasSourceByName = new Map<
        string,
        { source: string; sourceActive: boolean }
      >();
      const aliasByFlatName = new Map<string, string>();
      for (const name of activeToolNames) {
        const info = toolInfoByName.get(name);
        if (!info) continue;
        const src = findAliasSource(info, allTools);
        if (!src) continue;
        const sourceActive = activeToolSet.has(src.name);
        aliasSourceByName.set(name, { source: src.name, sourceActive });
        if (sourceActive) aliasByFlatName.set(src.name, name);
      }

      let toolsTokens = 0;
      let replacedTools = 0;
      type ToolLine = ContextViewData["toolBreakdown"][number];
      const countedLines: ToolLine[] = [];
      const replacedByAliasName = new Map<string, ToolLine>();
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
        const replacedBy = aliasByFlatName.get(name);
        const line: ToolLine = {
          name,
          tokens,
          // Attribute every tool to its provider so duplicate-looking tools
          // (e.g. an MCP tool and a native one) are distinguishable.
          source: info ? extensionLabel(info.sourceInfo?.path) : undefined,
          aliasOf: alias && !alias.sourceActive ? alias.source : undefined,
          replacedBy,
          counted: !replacedBy,
        };
        if (replacedBy) {
          replacedTools++;
          replacedByAliasName.set(replacedBy, line);
        } else {
          toolsTokens += tokens;
          countedLines.push(line);
        }
      }
      countedLines.sort(
        (a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name),
      );
      // Interleave: each replaced flat tool goes right below its alias.
      const toolBreakdown: ToolLine[] = [];
      for (const line of countedLines) {
        toolBreakdown.push(line);
        const replaced = replacedByAliasName.get(line.name);
        if (replaced) {
          toolBreakdown.push(replaced);
          replacedByAliasName.delete(line.name);
        }
      }
      // Safety net: any replaced tool whose alias line vanished still shows.
      toolBreakdown.push(...replacedByAliasName.values());

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
              toolsTokens,
              activeTools: activeToolNames.length,
              replacedTools,
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
