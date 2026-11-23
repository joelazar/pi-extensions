export type SkillMode = "agent-invocable" | "manual-only";

const KEY_RE = /^disable-model-invocation\s*:(.*)$/;

function split(raw: string): { head: string; lines: string[]; tail: string } | undefined {
  const match = /^(---[ \t]*\r?\n)([\s\S]*?)(^---[ \t]*(?:\r?\n|$)[\s\S]*)$/m.exec(raw);
  if (!match) return undefined;
  return { head: match[1]!, lines: match[2]!.match(/.*\r?\n/g) ?? [], tail: match[3]! };
}

export function readMode(raw: string): SkillMode {
  const value = split(raw)?.lines.map((line) => KEY_RE.exec(line.trimEnd())?.[1]?.trim()).find((v) => v !== undefined);
  return value === "true" ? "manual-only" : "agent-invocable";
}

export function writeMode(raw: string, mode: SkillMode): string {
  const parts = split(raw);
  if (!parts) return raw;
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const kept = parts.lines.filter((line) => !KEY_RE.test(line.trimEnd()));
  if (mode === "manual-only") kept.push(`disable-model-invocation: true${eol}`);
  return parts.head + kept.join("") + parts.tail;
}

export function toggle(mode: SkillMode): SkillMode {
  return mode === "manual-only" ? "agent-invocable" : "manual-only";
}
