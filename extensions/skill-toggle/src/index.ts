import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { toggle, writeMode, type SkillMode } from "./frontmatter.ts";
import { loadSkills, type Skill } from "./skills.ts";
import { showSkillToggleUi } from "./overlay.ts";

export default function piSkillToggle(pi: ExtensionAPI) {
  pi.registerCommand("toggle-skills", {
    description: "Toggle whether skills are agent-invocable or manual-only (pass a name to flip one)",
    getArgumentCompletions: (prefix) => {
      const items = pi
        .getCommands()
        .filter((command) => command.source === "skill")
        .map((command) => command.name.slice("skill:".length))
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const skills = await loadSkills(pi);
      const name = args.trim();
      if (name) {
        const skill = skills.find((s) => s.name === name);
        if (!skill) return ctx.ui.notify(`No skill named ${name}`, "error");
        return apply(ctx, new Map([[skill, toggle(skill.mode)]]));
      }
      if (!ctx.hasUI) return ctx.ui.notify("/toggle-skills without a name requires interactive mode", "error");
      const desired = await showSkillToggleUi(ctx, skills);
      if (desired) await apply(ctx, desired);
    },
  });
}

async function apply(ctx: ExtensionCommandContext, desired: Map<Skill, SkillMode>): Promise<void> {
  const applied: string[] = [];
  const errors: string[] = [];
  for (const [skill, mode] of desired) {
    if (mode === skill.mode) continue;
    if (skill.readOnly) {
      errors.push(`${skill.name}: ${skill.readOnly}`);
      continue;
    }
    try {
      if ((await readFile(skill.filePath, "utf8")) !== skill.raw) {
        errors.push(`${skill.name}: file changed since it was loaded; skipped`);
        continue;
      }
      await writeFile(skill.filePath, writeMode(skill.raw, mode));
      applied.push(`${skill.name} → ${mode}`);
    } catch (error) {
      errors.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (applied.length === 0 && errors.length === 0) return ctx.ui.notify("No changes to apply", "info");
  ctx.ui.notify([...applied, ...errors].join("\n"), errors.length > 0 ? "warning" : "info");
  if (applied.length > 0) await ctx.reload();
}
