import { homedir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { resolveModels } from "../shared/models.ts";

const SCRIPT = join(homedir(), ".local/bin/pr-create");
const REVIEWERS_FILE =
  process.env.PR_CREATE_REVIEWERS_FILE ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "pr-create/reviewers.conf",
  );


const ALLOWED_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
  "deps",
] as const;
const TYPES_ALT = ALLOWED_TYPES.join("|");
const TITLE_RE = new RegExp(`^(${TYPES_ALT})(\\([^)]+\\))?!?: .+`);
const LOOSE_TITLE_RE = new RegExp(
  `^(${TYPES_ALT})(\\([^)]+\\))?(!)?\\s+(.+)`,
);

const TITLE_HINT =
  "format: <type>[(scope)][!]: <subject>  (e.g. feat: add login, fix(api)!: drop v1)";

type Ctx = ExtensionCommandContext;

interface Changes {
  baseRef: string;
  stat: string;
  diff: string;
  commits: string;
}

interface ReviewerConfig {
  groups: Map<string, string>;
  people: Map<string, string>;
}

function normalizeTitleCandidate(raw: string): string {
  return raw
    .trim()
    .replace(/^(:[a-z0-9_+-]+:\s*)+/i, "")
    .replace(/^(?:\p{Extended_Pictographic}\ufe0f?\s*)+/u, "")
    .trim()
    .replace(
      LOOSE_TITLE_RE,
      (_m, type, scope = "", bang = "", subject) =>
        `${type}${scope}${bang}: ${subject}`,
    );
}

function validTitle(raw: string): string | undefined {
  const t = raw.trim();
  if (t && TITLE_RE.test(t)) return t;
  const n = normalizeTitleCandidate(t);
  if (n && TITLE_RE.test(n)) return n;
  return undefined;
}

async function tryExec(
  pi: ExtensionAPI,
  ctx: Ctx,
  cmd: string,
  args: string[],
  timeout: number,
): Promise<string | undefined> {
  try {
    const r = await pi.exec(cmd, args, { signal: ctx.signal, timeout });
    return r.code === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

async function detectDefaultBranch(
  pi: ExtensionAPI,
  ctx: Ctx,
): Promise<string | undefined> {
  const symbolic = await tryExec(
    pi,
    ctx,
    "git",
    ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    5_000,
  );
  const local = symbolic?.trim().replace(/^origin\//, "");
  if (local) return local;
  const remote = await tryExec(
    pi,
    ctx,
    "gh",
    [
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "--jq",
      ".defaultBranchRef.name",
    ],
    10_000,
  );
  return remote?.trim() || undefined;
}

async function resolveBaseRef(
  pi: ExtensionAPI,
  ctx: Ctx,
  base: string,
): Promise<string | undefined> {
  const candidate = base.trim() || (await detectDefaultBranch(pi, ctx));
  if (!candidate) return undefined;
  const bare = candidate.replace(/^origin\//, "");
  for (const ref of [`origin/${bare}`, bare]) {
    const r = await tryExec(
      pi,
      ctx,
      "git",
      ["rev-parse", "--verify", "--quiet", ref],
      5_000,
    );
    if (r?.trim()) return ref;
  }
  return undefined;
}

async function computeBranchChanges(
  pi: ExtensionAPI,
  ctx: Ctx,
  base: string,
): Promise<Changes | undefined> {
  const baseRef = await resolveBaseRef(pi, ctx, base);
  if (!baseRef) return undefined;
  const range = `${baseRef}...HEAD`;
  const opts = { signal: ctx.signal, timeout: 15_000 };
  try {
    const [stat, diff, commits] = await Promise.all([
      pi.exec("git", ["diff", "--stat", range], opts),
      pi.exec("git", ["diff", range], opts),
      pi.exec(
        "git",
        ["log", "--no-merges", "--pretty=%s", `${baseRef}..HEAD`],
        opts,
      ),
    ]);
    if (stat.code !== 0 || diff.code !== 0) return undefined;
    return {
      baseRef,
      stat: stat.stdout.trim(),
      diff: diff.stdout,
      commits: commits.code === 0 ? commits.stdout.trim() : "",
    };
  } catch {
    return undefined;
  }
}

const MAX_DIFF_CHARS = 100_000;

function changesContext(changes: Changes): string {
  const diffText =
    changes.diff.length > MAX_DIFF_CHARS
      ? `${changes.diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`
      : changes.diff;
  return [
    "The exact changes introduced by this PR are provided below as a git diff",
    `against ${changes.baseRef}. Base ONLY your output on this diff. Do NOT run any`,
    "git commands and do NOT consider any changes outside of the provided diff.",
    "",
    "Commit subjects:",
    changes.commits || "(none)",
    "",
    "Diff stat:",
    changes.stat || "(empty)",
    "",
    "Diff:",
    diffText,
  ].join("\n");
}

async function runPi(
  pi: ExtensionAPI,
  ctx: Ctx,
  label: string,
  prompt: string,
  accept: (raw: string) => string | undefined,
  extraArgs: string[],
): Promise<string | undefined> {
  const errors: string[] = [];
  try {
    const models = resolveModels(ctx, "fast").map((m) => `${m.provider}/${m.id}`);
    if (models.length === 0) errors.push("no model with configured auth for role \"fast\"");
    for (const model of models) {
      ctx.ui.setStatus("pr-create", `${label} (${model})…`);
      try {
        const result = await pi.exec(
          "pi",
          [
            "-p",
            "--no-session",
            "--model",
            model,
            "--thinking",
            "off",
            ...extraArgs,
            prompt,
          ],
          { signal: ctx.signal, timeout: 120_000 },
        );
        if (result.code === 0) {
          const out = accept(result.stdout);
          if (out) return out;
          errors.push(`${model}: unusable output`);
        } else {
          errors.push(
            `${model} (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
          );
        }
      } catch (err) {
        errors.push(`${model}: ${(err as Error).message}`);
      }
    }
  } finally {
    ctx.ui.setStatus("pr-create", undefined);
  }
  ctx.ui.notify(`${label} failed:\n${errors.join("\n")}`, "warning");
  return undefined;
}

async function generatePrTitle(
  pi: ExtensionAPI,
  ctx: Ctx,
  changes: Changes,
): Promise<string | undefined> {
  const prompt = [
    "Generate a single GitHub pull request title for this branch.",
    "",
    "Requirements:",
    "- Conventional commit format: <type>[(scope)]: <subject>",
    `- Allowed types: ${ALLOWED_TYPES.join(" ")}`,
    "- Lower case subject, no trailing period, max 72 characters.",
    "- Do not invent details.",
    "- Output only the title, nothing else.",
    "",
    changesContext(changes),
  ].join("\n");
  return runPi(
    pi,
    ctx,
    "Generating PR title",
    prompt,
    (raw) => validTitle(raw.trim().split("\n")[0] ?? ""),
    ["--no-tools"],
  );
}

async function generatePrBody(
  pi: ExtensionAPI,
  ctx: Ctx,
  changes: Changes,
): Promise<string | undefined> {
  const prompt = [
    "Write the GitHub pull request body for this branch.",
    "",
    "Read the pr skill and follow its template: ## Summary, ## Evidence.",
    "Then apply the unslop skill to the prose internally. Output only the final body.",
    "",
    "Requirements:",
    "- Summary: pick the smallest visual (diff-sketch, call tree, file tree, pseudocode, or mermaid) that shows the change. One or two short lines of text at most.",
    "- Evidence: you cannot run anything. Use tests added or changed in the diff, shown as pseudocode of the case that failed before and passes after. If the diff adds or changes no tests, omit the whole ## Evidence section. Never invent output.",
    "- Do not invent details.",
    "- Do not include Linear ticket lines.",
    "",
    "Output rules (strict):",
    "- Output ONLY the raw PR description body as plain markdown.",
    "- Do NOT include any preamble, closing remarks, or sign-offs.",
    "- Do NOT wrap the body in code fences, blockquotes, or horizontal rules (---).",
    "- Do NOT add a title/heading line.",
    "",
    changesContext(changes),
  ].join("\n");
  // The read tool lets pi load the pr and unslop skills.
  return runPi(pi, ctx, "Generating PR description", prompt, sanitizePrBody, [
    "--tools",
    "read",
  ]);
}

const HR_RE = /^[-*_]{3,}$/;
const PREAMBLE_RE =
  /^(here(?:'|\u2019)?s|here is|below is|sure[,!.]?|of course[,!.]?|certainly[,!.]?|okay[,!.]?|ok[,!.]?)\b[^\n]*?:?\s*$/i;

function sanitizePrBody(raw: string): string {
  let body = raw.replace(/\r\n/g, "\n").trim();
  const fence = body.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) body = fence[1].trim();

  const lines = body.split("\n");
  while (lines.length) {
    const first = lines[0].trim();
    if (first === "" || HR_RE.test(first) || PREAMBLE_RE.test(first)) {
      lines.shift();
      continue;
    }
    break;
  }
  while (lines.length) {
    const last = lines[lines.length - 1].trim();
    if (last === "" || HR_RE.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  return lines.join("\n").trim();
}

function loadReviewerConfig(): ReviewerConfig {
  const config: ReviewerConfig = { groups: new Map(), people: new Map() };
  if (!existsSync(REVIEWERS_FILE)) return config;
  let section = "people";
  for (const rawLine of readFileSync(REVIEWERS_FILE, "utf8").split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)\]$/);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    const eq = line.indexOf("=");
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    const value = eq === -1 ? "" : line.slice(eq + 1).trim();
    if (!key) continue;
    if (section === "groups") {
      if (!value) continue;
      const members = value.replace(/\s+/g, "");
      config.groups.set(key, members);
      for (const handle of members.split(",")) {
        if (handle && !handle.includes("/") && !config.people.has(handle)) {
          config.people.set(handle, "");
        }
      }
    } else {
      config.people.set(key, value);
    }
  }
  return config;
}

async function pickReviewers(ctx: Ctx): Promise<string[] | undefined> {
  const config = loadReviewerConfig();
  const chosen: string[] = [];
  const DONE = "Done";
  const NONE = "None";
  const MANUAL = "Enter handles manually";
  for (;;) {
    const groupChoices = [...config.groups.keys()]
      .filter((g) => !chosen.includes(g))
      .map((g) => `Group: ${g}`);
    const peopleChoices = [...config.people.entries()]
      .filter(([h]) => !chosen.includes(h))
      .map(([h, name]) => (name ? `${h} - ${name}` : h));
    const pick = await ctx.ui.select(
      chosen.length ? `Reviewers: ${chosen.join(", ")}` : "Reviewers",
      [chosen.length ? DONE : NONE, MANUAL, ...groupChoices, ...peopleChoices],
    );
    if (!pick) return undefined;
    if (pick === DONE || pick === NONE) return chosen;
    if (pick === MANUAL) {
      const manual = await ctx.ui.input("Handles (comma separated)", "");
      if (manual === undefined) return undefined;
      for (const h of manual.split(",")) {
        const handle = h.trim();
        if (handle && !chosen.includes(handle)) chosen.push(handle);
      }
      continue;
    }
    chosen.push(
      pick.startsWith("Group: ") ? pick.slice(7) : pick.split(" ")[0],
    );
  }
}

async function detectLinearFromBranch(
  pi: ExtensionAPI,
  ctx: Ctx,
): Promise<string[]> {
  const branch = await tryExec(
    pi,
    ctx,
    "git",
    ["branch", "--show-current"],
    5_000,
  );
  if (!branch) return [];
  // Ticket IDs at the start of the branch or after a slash: ONO-123-x, joe/ono-123-x.
  const ids = [
    ...branch
      .trim()
      .matchAll(/(?:^|\/)([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?=-|\/|$)/g),
  ].map((m) => m[1].toUpperCase());
  return [...new Set(ids)].map((id) => `Closes ${id}`);
}

function writeTempBody(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-description-"));
  const path = join(dir, "body.md");
  writeFileSync(path, body, "utf8");
  return path;
}

function parseLinear(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^(Closes|Ref)\s/.test(l) ? l : `Closes ${l}`));
}

// Single conventional commit: use its subject. Otherwise ask pi, falling back
// to the last commit subject.
async function autoTitle(
  pi: ExtensionAPI,
  ctx: Ctx,
  changes: Changes | undefined,
): Promise<string | undefined> {
  const subject =
    (await tryExec(pi, ctx, "git", ["log", "-1", "--pretty=%s"], 5_000))?.trim() ?? "";
  const commitCount = changes?.commits ? changes.commits.split("\n").length : 0;
  if (commitCount === 1) {
    const fromCommit = validTitle(subject);
    if (fromCommit) return fromCommit;
  }
  if (changes) {
    const generated = await generatePrTitle(pi, ctx, changes);
    if (generated) return generated;
  }
  return validTitle(subject);
}

async function pushStatus(pi: ExtensionAPI, ctx: Ctx): Promise<string> {
  const upstream = await tryExec(
    pi,
    ctx,
    "git",
    ["rev-parse", "--verify", "--quiet", "@{u}"],
    5_000,
  );
  if (!upstream?.trim()) return "new branch";
  const n = Number(
    (await tryExec(pi, ctx, "git", ["rev-list", "--count", "@{u}..HEAD"], 5_000))?.trim() ?? 0,
  );
  return n ? `${n} unpushed` : "up to date";
}

interface PrState {
  title?: string;
  base: string;
  draft: boolean;
  reviewers: string[];
  body?: string;
  bodySource: "none" | "generated" | "edited";
  linear: string[];
  changes?: Changes;
}

function summaryLines(s: PrState, defaultBase: string | undefined, push: string): string[] {
  const body = s.body
    ? `${s.body.split("\n").length} lines, ${s.bodySource}`
    : "none (gh fills from commits)";
  return [
    `Title      ${s.title ?? "(missing)"}`,
    `Base       ${s.base || `${defaultBase ?? "repo default"} (default)`}`,
    `Draft      ${s.draft ? "yes" : "no"}`,
    `Reviewers  ${s.reviewers.join(", ") || "none"}`,
    `Linear     ${s.linear.join(", ") || "none"}`,
    `Body       ${body}`,
    `Push       yes (${push})`,
  ];
}

const ACTIONS = {
  create: "Create",
  title: "Edit title",
  regenTitle: "Regenerate title",
  body: "Edit body",
  regenBody: "Regenerate body",
  base: "Base",
  draft: "Toggle draft",
  reviewers: "Reviewers",
  linear: "Linear",
  cancel: "Cancel",
} as const;

// Loop until Create (true) or Cancel/Esc (false). The summary sits in a widget
// above the editor while the menu is open.
async function review(
  pi: ExtensionAPI,
  ctx: Ctx,
  s: PrState,
  defaultBase: string | undefined,
): Promise<boolean> {
  const push = await pushStatus(pi, ctx);
  try {
    for (;;) {
      ctx.ui.setWidget("pr-create", summaryLines(s, defaultBase, push));
      const pick = await ctx.ui.select("Review PR", Object.values(ACTIONS));
      switch (pick) {
        case undefined:
        case ACTIONS.cancel:
          return false;
        case ACTIONS.create:
          if (s.title) return true;
          ctx.ui.notify("Title is required", "warning");
          break;
        case ACTIONS.title: {
          const raw = await ctx.ui.input(
            `Title (${TITLE_HINT}; empty = keep)`,
            s.title ?? "",
          );
          if (!raw?.trim()) break;
          const title = validTitle(raw);
          if (title) s.title = title;
          else ctx.ui.notify(`Invalid title, kept the old one: ${raw.trim()}`, "error");
          break;
        }
        case ACTIONS.regenTitle:
          if (s.changes) s.title = (await generatePrTitle(pi, ctx, s.changes)) ?? s.title;
          else ctx.ui.notify("No branch diff, cannot generate", "warning");
          break;
        case ACTIONS.body: {
          const body = await ctx.ui.editor("PR description", s.body ?? "");
          if (body !== undefined) {
            s.body = body.trim() || undefined;
            s.bodySource = s.body ? "edited" : "none";
          }
          break;
        }
        case ACTIONS.regenBody: {
          if (!s.changes) {
            ctx.ui.notify("No branch diff, cannot generate", "warning");
            break;
          }
          const body = await generatePrBody(pi, ctx, s.changes);
          if (body) {
            s.body = body;
            s.bodySource = "generated";
          }
          break;
        }
        case ACTIONS.base: {
          const base = await ctx.ui.input(
            "Base branch (empty = repo default)",
            defaultBase ?? "",
          );
          if (base === undefined) break;
          s.base = base.trim();
          s.changes = await computeBranchChanges(pi, ctx, s.base);
          if (s.bodySource === "generated") {
            ctx.ui.notify(
              "Body was generated against the old base. Regenerate it if needed.",
              "info",
            );
          }
          break;
        }
        case ACTIONS.draft:
          s.draft = !s.draft;
          break;
        case ACTIONS.reviewers: {
          const reviewers = await pickReviewers(ctx);
          if (reviewers) s.reviewers = reviewers;
          break;
        }
        case ACTIONS.linear: {
          const raw = await ctx.ui.editor(
            "Linear links, one per line (Closes ABC-1 / Ref ABC-2; empty = none)",
            s.linear.join("\n"),
          );
          if (raw !== undefined) s.linear = parseLinear(raw);
          break;
        }
      }
    }
  } finally {
    ctx.ui.setWidget("pr-create", undefined);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr-create", {
    description:
      "Create a GitHub PR: fills every field automatically, then lets you review before creating",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pr-create requires interactive mode", "error");
        return;
      }

      const defaultBase = await detectDefaultBranch(pi, ctx);
      const s: PrState = {
        title: validTitle(rawArgs ?? ""),
        base: "",
        draft: false,
        reviewers: [],
        bodySource: "none",
        linear: await detectLinearFromBranch(pi, ctx),
        changes: await computeBranchChanges(pi, ctx, ""),
      };
      if (!s.changes) {
        ctx.ui.notify(
          "Could not compute the branch diff, pi generation unavailable",
          "warning",
        );
      }
      s.title ??= await autoTitle(pi, ctx, s.changes);
      if (s.changes) {
        s.body = await generatePrBody(pi, ctx, s.changes);
        if (s.body) s.bodySource = "generated";
      }

      if (!(await review(pi, ctx, s, defaultBase)) || !s.title) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      const args = [
        "--yes",
        "--no-generate",
        "--push",
        "--title",
        s.title,
        s.draft ? "--draft" : "--no-draft",
      ];
      for (const r of s.reviewers.length ? s.reviewers : ["none"]) {
        args.push("--reviewers", r);
      }
      if (s.base) args.push("--base", s.base);
      if (s.body) args.push("--body-file", writeTempBody(s.body));
      // An empty --linear tells the script not to re-detect from the branch.
      for (const link of s.linear.length ? s.linear : [""]) args.push("--linear", link);

      ctx.ui.setStatus("pr-create", "Creating PR…");
      let result;
      try {
        result = await pi.exec(SCRIPT, args, {
          signal: ctx.signal,
          timeout: 120_000,
        });
      } finally {
        ctx.ui.setStatus("pr-create", undefined);
      }

      if (result.code !== 0) {
        ctx.ui.notify(
          `pr-create failed (exit ${result.code}): ${result.stderr.trim().slice(0, 300)}`,
          "error",
        );
        return;
      }

      const url = result.stdout.trim().split("\n").pop() ?? "";
      ctx.ui.notify(`PR created: ${url}`, "info");
      pi.sendMessage(
        {
          customType: "pr-create",
          content: [
            `Created pull request: ${url}`,
            `Title: ${s.title}`,
            s.base ? `Base: ${s.base}` : undefined,
            s.reviewers.length ? `Reviewers: ${s.reviewers.join(", ")}` : undefined,
            s.draft ? "Draft: yes" : undefined,
            s.linear.length ? `Linear: ${s.linear.join(", ")}` : undefined,
          ]
            .filter(Boolean)
            .join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });
}
