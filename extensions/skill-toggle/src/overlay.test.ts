import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showSkillToggleUi } from "./overlay.ts";
import type { Skill } from "./skills.ts";

const skill = (name: string, description: string): Skill => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  source: "user",
  raw: "",
  mode: "agent-invocable",
});

function mount(skills: Skill[]) {
  const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
  const tui = { terminal: { rows: 40 }, requestRender() {} };
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const ctx = {
    ui: {
      custom: (factory: (...args: unknown[]) => typeof component) => {
        component = factory(tui, theme, {}, () => {});
        return Promise.resolve(undefined);
      },
    },
  } as unknown as ExtensionContext;
  void showSkillToggleUi(ctx, skills);
  return component!;
}

describe("overlay", () => {
  it("renders single-line rows of exact width while moving through multi-line descriptions", () => {
    const skills = [
      skill("bro", "Restate the last message."),
      skill("humanizer", "Rewrite AI-sounding text.\nUse when editing prose:\r\n  not-X-but-Y contrasts,\tdashes."),
      ...Array.from({ length: 30 }, (_, i) => skill(`skill-${i}`, `Line one ${i}\nline two ${i}`)),
    ];
    const overlay = mount(skills);
    const width = 120;
    for (let i = 0; i < skills.length + 2; i++) {
      const lines = overlay.render(width);
      for (const line of lines) {
        assert.doesNotMatch(line, /[\r\n\t]/, `control char in row at step ${i}: ${JSON.stringify(line)}`);
        assert.equal(visibleWidth(line), width, `bad width at step ${i}: ${JSON.stringify(line)}`);
      }
      overlay.handleInput("\x1b[B");
    }
  });
});
