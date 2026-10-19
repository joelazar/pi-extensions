import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_DIRS = [join(homedir(), ".agents/skills"), join(getAgentDir(), "skills")];

// Load named skills as system-prompt sections, for direct model calls that skip
// pi's agent loop (and with it the session's skill list and prompt injectors).
// Throws on a missing skill so a renamed skill fails loudly instead of silently.
export function skillsPrompt(names: string[]): string {
	return names
		.map((name) => {
			const path = SKILL_DIRS.map((d) => join(d, name, "SKILL.md")).find(existsSync);
			if (!path) throw new Error(`Skill not found: ${name} (looked in ${SKILL_DIRS.join(", ")})`);
			const body = readFileSync(path, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
			return `<skill name="${name}">\n${body}\n</skill>`;
		})
		.join("\n\n");
}
