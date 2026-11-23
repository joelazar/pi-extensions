import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readMode, type SkillMode } from "./frontmatter.ts";

export interface Skill {
  name: string;
  description: string;
  filePath: string;
  source: string;
  raw: string;
  mode: SkillMode;
  readOnly?: string;
}

export async function loadSkills(pi: ExtensionAPI): Promise<Skill[]> {
  const entries = pi.getCommands().filter((command) => command.source === "skill");
  const skills = await Promise.all(
    entries.map(async ({ name, description, sourceInfo }) => {
      const raw = await readFile(sourceInfo.path, "utf8");
      return {
        name: name.slice("skill:".length),
        description: description ?? "",
        filePath: sourceInfo.path,
        source: sourceInfo.origin === "package" ? `package ${sourceInfo.source}` : sourceInfo.scope,
        raw,
        mode: readMode(raw),
        readOnly: await readOnlyReason(sourceInfo.path, sourceInfo.source),
      };
    }),
  );
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

async function readOnlyReason(path: string, source: string): Promise<string | undefined> {
  if (/^(git|npm|https?):/.test(source)) return `managed by ${source}`;
  return access(path, constants.W_OK).then(
    () => undefined,
    () => "not writable",
  );
}
