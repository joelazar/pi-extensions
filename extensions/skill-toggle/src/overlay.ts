import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import { toggle, type SkillMode } from "./frontmatter.ts";
import type { Skill } from "./skills.ts";

export function showSkillToggleUi(ctx: ExtensionContext, skills: Skill[]): Promise<Map<Skill, SkillMode> | undefined> {
  return ctx.ui.custom(
    (tui, theme, _keybindings, done) => new SkillToggleOverlay(tui, theme, skills, done),
    {
      overlay: true,
      blocked: { kind: "question", message: "Choose skills to toggle" },
      overlayOptions: { anchor: "center", width: "92%", maxHeight: "88%", minWidth: 86 },
    },
  );
}

class SkillToggleOverlay {
  private readonly desired: Map<Skill, SkillMode>;
  private search = "";
  private selectedIndex = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly skills: Skill[],
    private readonly done: (result: Map<Skill, SkillMode> | undefined) => void,
  ) {
    this.desired = new Map(skills.map((skill) => [skill, skill.mode]));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return this.done(undefined);
    if (matchesKey(data, Key.ctrl("s"))) return this.done(this.desired);
    if (matchesKey(data, Key.up)) return this.move(-1);
    if (matchesKey(data, Key.down)) return this.move(1);
    if (matchesKey(data, Key.space)) {
      const skill = this.filtered()[this.selectedIndex];
      if (skill && !skill.readOnly) this.desired.set(skill, toggle(this.desired.get(skill)!));
    } else if (matchesKey(data, Key.backspace)) {
      this.search = Array.from(this.search).slice(0, -1).join("");
      this.selectedIndex = 0;
    } else if (data >= " " && !/[\x1b\r\n]/.test(data)) {
      this.search += data;
      this.selectedIndex = 0;
    } else {
      return;
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(20, width - 2);
    const bodyHeight = Math.max(10, clamp(Math.floor((this.tui.terminal.rows ?? 30) * 0.82), 16, 52) - 7);
    const leftWidth = Math.max(32, Math.floor((inner - 1) * 0.48));
    const rightWidth = Math.max(28, inner - leftWidth - 1);
    const line = (content: string) => `${t.fg("borderAccent", "│")}${fit(content, inner)}${t.fg("borderAccent", "│")}`;
    const rule = (l: string, r: string) => t.fg("borderAccent", `${l}${"─".repeat(inner)}${r}`);

    const changed = this.skills.filter((skill) => this.desired.get(skill) !== skill.mode).length;
    const title = t.fg("accent", t.bold("Pi Skill Toggle"));
    const summary = t.fg("muted", `${this.skills.length} skills • ${changed} changed`);
    const left = this.renderList(leftWidth, bodyHeight);
    const right = this.renderDetails(rightWidth, bodyHeight);

    return [
      rule("┌", "┐"),
      line(`${title}${" ".repeat(Math.max(1, inner - visibleWidth(title) - visibleWidth(summary)))}${summary}`),
      line(t.fg("muted", `Search: ${this.search || "(type to filter)"}`)),
      rule("├", "┤"),
      ...left.map((l, i) => line(`${fit(l, leftWidth)}${t.fg("borderMuted", "│")}${fit(right[i]!, rightWidth)}`)),
      rule("├", "┤"),
      line(t.fg("dim", "type search • ↑↓ move • space toggle • ctrl+s apply + reload • esc cancel")),
      rule("└", "┘"),
    ];
  }

  invalidate(): void {}

  private renderList(width: number, height: number): string[] {
    const t = this.theme;
    const filtered = this.filtered();
    if (filtered.length === 0) return pad([t.fg("dim", "No matching skills")], height);

    this.selectedIndex = clamp(this.selectedIndex, 0, filtered.length - 1);
    const visible = Math.max(4, Math.floor(height / 2));
    const start = clamp(this.selectedIndex - Math.floor(visible / 2), 0, Math.max(0, filtered.length - visible));
    const lines: string[] = [];
    for (const [offset, skill] of filtered.slice(start, start + visible).entries()) {
      const mode = this.desired.get(skill)!;
      const selected = start + offset === this.selectedIndex;
      const label = `${selected ? "›" : " "} ${mode === "manual-only" ? "◼" : "□"} ${skill.name}`
        + (mode !== skill.mode ? t.fg("accent", " *") : "")
        + (skill.readOnly ? t.fg("warning", ` read-only (${skill.readOnly})`) : "");
      lines.push(selected ? t.fg("accent", t.bold(fit(label, width))) : label);
      lines.push(t.fg("dim", `    ${modeLabel(mode)} — ${skill.description}`));
    }
    return pad(lines, height);
  }

  private renderDetails(width: number, height: number): string[] {
    const t = this.theme;
    const skill = this.filtered()[this.selectedIndex];
    if (!skill) return pad([t.fg("dim", "No skill selected")], height);
    const mode = this.desired.get(skill)!;
    return pad(
      [
        t.fg("accent", t.bold(skill.name)),
        "",
        `${t.fg("muted", "Current:")} ${modeLabel(skill.mode)}`,
        `${t.fg("muted", "Desired:")} ${modeLabel(mode)}${mode !== skill.mode ? t.fg("accent", " (changed)") : ""}`,
        `${t.fg("muted", "Source:")} ${skill.source}`,
        `${t.fg("muted", "Editable:")} ${skill.readOnly ? t.fg("warning", `no, ${skill.readOnly}`) : "yes"}`,
        "",
        t.fg("muted", "Path:"),
        ...wrapTextWithAnsi(skill.filePath, width),
        "",
        t.fg("muted", "Description:"),
        ...wrapTextWithAnsi(skill.description, width),
      ],
      height,
    );
  }

  private move(delta: number): void {
    this.selectedIndex = clamp(this.selectedIndex + delta, 0, Math.max(0, this.filtered().length - 1));
    this.tui.requestRender();
  }

  private filtered(): Skill[] {
    const tokens = this.search.toLowerCase().split(/\s+/).filter(Boolean);
    return this.skills.filter((skill) => {
      const haystack = `${skill.name} ${skill.description} ${skill.filePath} ${skill.source} ${modeLabel(this.desired.get(skill)!)}`.toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }
}

function modeLabel(mode: SkillMode): string {
  return mode === "manual-only" ? "Manual-only" : "Agent-invocable";
}

// Every rendered row must be exactly one terminal line; descriptions from YAML block scalars contain newlines.
function fit(text: string, width: number): string {
  const truncated = truncateToWidth(text.replace(/\s*[\r\n\t]\s*/g, " "), Math.max(0, width));
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pad(lines: string[], height: number): string[] {
  return [...lines, ...Array<string>(Math.max(0, height - lines.length)).fill("")].slice(0, height);
}
