import { homedir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const SCRIPT = join(homedir(), ".local/bin/pr-create");
const REVIEWERS_FILE =
  process.env.PR_CREATE_REVIEWERS_FILE ??
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "pr-create/reviewers.conf",
  );

const MODELS = ["anthropic-extra/claude-opus-5", "anthropic/claude-opus-5"];

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
type CommitType = (typeof ALLOWED_TYPES)[number];

const TYPE_HELP: Record<CommitType, string> = {
  feat: "user-facing new functionality",
  fix: "bug fix",
  docs: "documentation only",
  style: "formatting/whitespace, no behavior change",
  refactor: "code change that doesn't add features or fix bugs",
  perf: "performance improvement",
  test: "add or fix tests",
  build: "build system, packaging, tooling",
  ci: "CI config and scripts",
  chore: "maintenance, configs, dotfiles",
  revert: "revert a previous commit",
  deps: "dependency bumps",
};

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

async function autoTitle(
  pi: ExtensionAPI,
  ctx: Ctx,
  initial: string,
): Promise<string | undefined> {
  const fromArgs = validTitle(initial);
  if (fromArgs) return fromArgs;
  const subject = await tryExec(
    pi,
    ctx,
    "git",
    ["log", "-1", "--pretty=%s"],
    5_000,
  );
  return subject ? validTitle(subject) : undefined;
}

async function inputTitle(
  ctx: Ctx,
  initial: string,
): Promise<string | undefined> {
  for (;;) {
    const t = await ctx.ui.input(`Title (${TITLE_HINT})`, initial);
    if (t === undefined) return undefined;
    const trimmed = t.trim();
    if (!trimmed) {
      ctx.ui.notify(
        "Title is required — try again or press Esc to cancel",
        "warning",
      );
      continue;
    }
    if (!TITLE_RE.test(trimmed)) {
      ctx.ui.notify(`Invalid title: ${trimmed}`, "error");
      continue;
    }
    return trimmed;
  }
}

async function buildTitle(
  ctx: Ctx,
  pi: ExtensionAPI,
  initial: string,
): Promise<string | undefined> {
  const suggestion = (await autoTitle(pi, ctx, initial)) ?? initial.trim();
  const suggestedType = suggestion.match(TITLE_RE)?.[1] as
    | CommitType
    | undefined;
  const orderedTypes = suggestedType
    ? [suggestedType, ...ALLOWED_TYPES.filter((t) => t !== suggestedType)]
    : [...ALLOWED_TYPES];
  const typePick = await ctx.ui.select(
    "Conventional commit type",
    orderedTypes.map((t) => `${t}  —  ${TYPE_HELP[t]}`),
  );
  if (!typePick) return undefined;
  const type = typePick.split(" ")[0] as CommitType;

  const scope = await ctx.ui.input(
    `Scope for ${type} (optional, e.g. api, ui)`,
    "",
  );
  if (scope === undefined) return undefined;

  const breaking = await ctx.ui.confirm(
    "Breaking change?",
    "Append `!` to mark a breaking change.",
  );

  const initialSubject = suggestion.replace(TITLE_RE, "").trim() || suggestion;

  for (;;) {
    const subject = await ctx.ui.input(
      "Subject (imperative, lowercase, ≤72 chars)",
      initialSubject,
    );
    if (subject === undefined) return undefined;
    const subjectTrim = subject.trim();
    if (!subjectTrim) {
      ctx.ui.notify(
        "Subject is required — try again or press Esc to cancel",
        "warning",
      );
      continue;
    }
    const scopePart = scope.trim() ? `(${scope.trim()})` : "";
    return `${type}${scopePart}${breaking ? "!" : ""}: ${subjectTrim}`;
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
): Promise<string | undefined> {
  const errors: string[] = [];
  try {
    for (const model of MODELS) {
      ctx.ui.setStatus("pr-create", `${label} (${model})…`);
      try {
        const result = await pi.exec(
          "pi",
          ["-p", "--no-session", "--model", model, "--thinking", "off", prompt],
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
  return runPi(pi, ctx, "Generating PR title", prompt, (raw) =>
    validTitle(raw.trim().split("\n")[0] ?? ""),
  );
}

async function generatePrBody(
  pi: ExtensionAPI,
  ctx: Ctx,
  changes: Changes,
): Promise<string | undefined> {
  const prompt = [
    "Use the humanizer skill's audit loop internally to self-check the prose, then return ONLY the final result.",
    "Do not output the draft, the \"still-AI\" bullets, or any summary of changes — output only the final PR body, nothing else.",
    "",
    "Generate a short GitHub pull request description for this branch.",
    "",
    "Requirements:",
    "- Concise and natural.",
    "- Summarize only the actual code/config changes shown in the diff.",
    "- Start directly with the bullets. No summary or intro sentence; the title is a separate field.",
    "- Prefer 2-4 bullets.",
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
  return runPi(pi, ctx, "Generating PR description", prompt, sanitizePrBody);
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
  return [
    ...new Set(
      [...branch.trim().matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g)].map(
        (m) => m[1],
      ),
    ),
  ];
}

async function collectLinearLinks(ctx: Ctx): Promise<string[]> {
  const links: string[] = [];
  for (;;) {
    const ticket = await ctx.ui.input("Ticket ID (e.g. ABC-123)", "");
    const id = ticket?.trim();
    if (!id) break;
    const rel = await ctx.ui.select(`Relation for ${id}`, ["Closes", "Ref"]);
    if (!rel) break;
    links.push(`${rel} ${id}`);
    const more = await ctx.ui.confirm("Add another?", "Another Linear ticket?");
    if (!more) break;
  }
  return links;
}

async function pickLinearLinks(
  pi: ExtensionAPI,
  ctx: Ctx,
): Promise<string[] | undefined> {
  const detected = await detectLinearFromBranch(pi, ctx);
  const choices = [
    ...(detected.length
      ? [`Auto: Closes ${detected.join(", Closes ")}`]
      : []),
    "Add manually",
    "None",
  ];
  const pick = await ctx.ui.select("Linear tickets", choices);
  if (!pick) return undefined;
  if (pick === "None") return [];
  if (pick.startsWith("Auto:")) return detected.map((id) => `Closes ${id}`);
  return collectLinearLinks(ctx);
}

async function pickBoolWithAuto(
  ctx: Ctx,
  label: string,
  autoValue: boolean,
): Promise<boolean | undefined> {
  const pick = await ctx.ui.select(label, [
    `Auto: ${autoValue ? "Yes" : "No"}`,
    "Yes",
    "No",
  ]);
  if (!pick) return undefined;
  if (pick.startsWith("Auto:")) return autoValue;
  return pick === "Yes";
}

async function pickTitleInteractive(
  ctx: Ctx,
  pi: ExtensionAPI,
  rawArgs: string,
  changes: Changes | undefined,
): Promise<string | undefined> {
  const auto = await autoTitle(pi, ctx, rawArgs);
  const GENERATE = "Generate with pi";
  const DIRECT = "Enter directly (one line)";
  const BUILD = "Build step-by-step (type → scope → subject)";
  for (;;) {
    const pick = await ctx.ui.select("Title", [
      ...(auto ? [`Auto: ${auto}`] : []),
      ...(changes ? [GENERATE] : []),
      DIRECT,
      BUILD,
    ]);
    if (!pick) return undefined;
    if (pick.startsWith("Auto:")) return auto;
    if (pick === DIRECT) return inputTitle(ctx, auto ?? rawArgs.trim());
    if (pick === BUILD) return buildTitle(ctx, pi, rawArgs);
    const generated = await generatePrTitle(pi, ctx, changes!);
    if (!generated) continue;
    const use = await ctx.ui.select(`Suggested: ${generated}`, [
      "Use it",
      "Edit it",
      "Regenerate",
      "Back",
    ]);
    if (!use) return undefined;
    if (use === "Use it") return generated;
    if (use === "Edit it") return inputTitle(ctx, generated);
    if (use === "Regenerate") {
      const again = await generatePrTitle(pi, ctx, changes!);
      if (again) return inputTitle(ctx, again);
    }
  }
}

function writeTempBody(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-description-"));
  const path = join(dir, "body.md");
  writeFileSync(path, body, "utf8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr-create", {
    description:
      "Create a GitHub PR via ~/.local/bin/pr-create using interactive pi dialogs",
    handler: async (rawArgs, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/pr-create requires interactive mode", "error");
        return;
      }
      const initial = rawArgs ?? "";
      const cancel = () => ctx.ui.notify("Cancelled", "info");

      const modePick = await ctx.ui.select("Mode", [
        "Automatic (sensible defaults, no prompts)",
        "Interactive (ask for every field)",
      ]);
      if (!modePick) return cancel();
      const automatic = modePick.startsWith("Automatic");

      let title: string | undefined;
      let base = "";
      let draft = false;
      let reviewers: string[] = [];
      let bodyPath: string | undefined;
      let linear: string[] = [];
      let autoPush = true;

      if (automatic) {
        const changes = await computeBranchChanges(pi, ctx, base);
        title = await autoTitle(pi, ctx, initial);
        if (!title && changes) title = await generatePrTitle(pi, ctx, changes);
        if (!title) {
          ctx.ui.notify(
            "Could not auto-derive a title — falling back to interactive picker",
            "info",
          );
          title = await buildTitle(ctx, pi, initial);
          if (!title) return cancel();
        }
        if (changes) {
          const body = await generatePrBody(pi, ctx, changes);
          if (body) bodyPath = writeTempBody(body);
        } else {
          ctx.ui.notify(
            "Could not compute the branch diff — skipping description generation",
            "warning",
          );
        }
      } else {
        const detectedBase = await detectDefaultBranch(pi, ctx);
        const basePick = await ctx.ui.select("Base branch", [
          detectedBase
            ? `Auto: ${detectedBase} (repo default)`
            : "Auto: repo default",
          "Enter manually",
        ]);
        if (!basePick) return cancel();
        if (!basePick.startsWith("Auto:")) {
          const baseRaw = await ctx.ui.input(
            "Base branch (empty = repo default)",
            detectedBase ?? "",
          );
          base = (baseRaw ?? "").trim();
        }

        const changes = await computeBranchChanges(pi, ctx, base);
        if (!changes) {
          ctx.ui.notify(
            "Could not compute the branch diff — pi generation unavailable",
            "warning",
          );
        }

        title = await pickTitleInteractive(ctx, pi, initial, changes);
        if (!title) return cancel();

        const draftPick = await pickBoolWithAuto(ctx, "Draft PR?", false);
        if (draftPick === undefined) return cancel();
        draft = draftPick;

        const reviewerPick = await pickReviewers(ctx);
        if (reviewerPick === undefined) return cancel();
        reviewers = reviewerPick;

        const GENERATE = "Generate with pi";
        const MANUAL = "Write manually in the editor";
        const descPick = await ctx.ui.select("PR description", [
          ...(changes ? [`Auto: ${GENERATE}`] : []),
          MANUAL,
          "Skip (no description)",
        ]);
        if (!descPick) return cancel();
        if (descPick === MANUAL) {
          const manual = await ctx.ui.editor("PR description", "");
          if (manual?.trim()) bodyPath = writeTempBody(manual);
        } else if (descPick.startsWith("Auto:")) {
          const body = await generatePrBody(pi, ctx, changes!);
          if (body !== undefined) {
            const edit = await ctx.ui.confirm(
              "Edit description?",
              "Open the generated description in the editor before creating the PR?",
            );
            const finalBody = edit
              ? ((await ctx.ui.editor("PR description", body)) ?? body)
              : body;
            bodyPath = writeTempBody(finalBody);
          } else {
            const next = await ctx.ui.select(
              "Description generation failed — what now?",
              ["Continue without a description", MANUAL, "Cancel"],
            );
            if (!next || next === "Cancel") return cancel();
            if (next === MANUAL) {
              const manual = await ctx.ui.editor("PR description", "");
              if (manual?.trim()) bodyPath = writeTempBody(manual);
            }
          }
        }

        const linearPick = await pickLinearLinks(pi, ctx);
        if (linearPick === undefined) return cancel();
        linear = linearPick;

        const pushPick = await pickBoolWithAuto(ctx, "Auto-push branch?", true);
        if (pushPick === undefined) return cancel();
        autoPush = pushPick;
      }

      const args = [
        "--yes",
        "--title",
        title,
        draft ? "--draft" : "--no-draft",
        autoPush ? "--push" : "--no-push",
        "--no-edit",
        "--no-generate-description",
      ];
      for (const r of reviewers.length ? reviewers : ["none"]) {
        args.push("--reviewers", r);
      }
      if (base) args.push("--base", base);
      if (bodyPath) args.push("--body-file", bodyPath);
      for (const link of linear) args.push("--linear", link);

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
            `Title: ${title}`,
            base ? `Base: ${base}` : undefined,
            reviewers.length ? `Reviewers: ${reviewers.join(", ")}` : undefined,
            draft ? "Draft: yes" : undefined,
            linear.length ? `Linear: ${linear.join(", ")}` : undefined,
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
