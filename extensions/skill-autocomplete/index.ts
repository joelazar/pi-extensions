/**
 * Skill autocomplete anywhere in the prompt, plus expansion of mid-message skills.
 * Inspired by https://github.com/zereight/pi-skill-inline-autocomplete
 *
 * - `/skill:<query>` anywhere: fuzzy skill menu (auto-opens with editor-enhancements, else Tab)
 * - `/<query>` after a space: skill menu on Tab only, so paths like ` /tmp` stay untouched
 * - On submit, every known `/skill:name` token is expanded into a <skill> block,
 *   since pi core only expands a skill at the very start of the message.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, fuzzyFilter } from "@earendil-works/pi-tui";

export type SkillEntry = { name: string; description?: string; filePath: string; baseDir?: string };

const MAX_SUGGESTIONS = 20;
const INLINE_RE = /(?:^|\s)(\/(?:skill:)?[\w-]*)$/;
const TOKEN_RE = /(?<=^|\s)\/skill:([\w-]+)/g;

// Pi core owns `/cmd` at the very start of the first line.
function isCoreSlashContext(cursorLine: number, beforeCursor: string): boolean {
  const trimmed = beforeCursor.trimStart();
  return cursorLine === 0 && trimmed.startsWith("/") && !/\s/.test(trimmed);
}

export function suggestSkills(
  skills: SkillEntry[],
  cursorLine: number,
  beforeCursor: string,
  force: boolean,
): { prefix: string; items: AutocompleteItem[] } | null {
  if (isCoreSlashContext(cursorLine, beforeCursor)) return null;
  const prefix = beforeCursor.match(INLINE_RE)?.[1];
  if (!prefix) return null;

  const explicit = prefix.startsWith("/skill:");
  if (!explicit && !force) return null;
  const query = explicit ? prefix.slice("/skill:".length) : prefix.slice(1);

  const matches = explicit
    ? fuzzyFilter(skills, query, (s) => `${s.name} ${s.description ?? ""}`)
    : skills.filter((s) => s.name.includes(query.toLowerCase()));
  if (matches.length === 0) return null;

  return {
    prefix,
    items: matches.slice(0, MAX_SUGGESTIONS).map((s) => ({
      value: `/skill:${s.name}`,
      label: s.name,
      description: s.description,
    })),
  };
}

export function expandInlineSkills(text: string, skills: SkillEntry[], read: (path: string) => string): string {
  const names = [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]!))];
  // Leave a lone leading /skill: to pi core, which also turns the rest into args.
  if (names.length === 0 || (names.length === 1 && text.startsWith(`/skill:${names[0]}`))) return text;

  const blocks = names.flatMap((name) => {
    const skill = skills.find((s) => s.name === name);
    if (!skill) return [];
    const body = stripFrontmatter(read(skill.filePath)).trim();
    const refs = skill.baseDir ? `References are relative to ${skill.baseDir}.\n\n` : "";
    return [`<skill name="${skill.name}" location="${skill.filePath}">\n${refs}${body}\n</skill>`];
  });
  return blocks.length === 0 ? text : `${blocks.join("\n\n")}\n\n${text}`;
}

export default function skillAutocomplete(pi: ExtensionAPI): void {
  const getSkills = (): SkillEntry[] =>
    pi
      .getCommands()
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name.slice("skill:".length),
        description: c.description,
        filePath: c.sourceInfo.path,
        baseDir: c.sourceInfo.baseDir,
      }));

  pi.on("input", (event, ctx) => {
    try {
      const text = expandInlineSkills(event.text, getSkills(), (p) => readFileSync(p, "utf8"));
      return text === event.text ? { action: "continue" } : { action: "transform", text, images: event.images };
    } catch (err) {
      // Never drop the user's message over a skill read error.
      if (ctx.hasUI) ctx.ui.notify(`skill-autocomplete: ${err instanceof Error ? err.message : err}`, "error");
      return { action: "continue" };
    }
  });

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider(
      (current): AutocompleteProvider => ({
        triggerCharacters: current.triggerCharacters,
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
          return (
            suggestSkills(getSkills(), cursorLine, beforeCursor, options.force ?? false) ??
            current.getSuggestions(lines, cursorLine, cursorCol, options)
          );
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          // Core treats a "/" prefix at line start as a slash command and would insert "//skill:...".
          if (!item.value.startsWith("/skill:")) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
          }
          const line = lines[cursorLine] ?? "";
          const start = cursorCol - prefix.length;
          const newLines = [...lines];
          newLines[cursorLine] = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol).trimStart()}`;
          return { lines: newLines, cursorLine, cursorCol: start + item.value.length + 1 };
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
          if (suggestSkills(getSkills(), cursorLine, beforeCursor, true)) return true;
          return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
      }),
    );
  });
}
