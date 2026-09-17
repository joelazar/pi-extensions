import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  describeBackend,
  detectTerminalBackend,
  launchTerminal,
  type LaunchMode,
} from "../shared/terminal.ts";

function splitMode(input: string): { mode: LaunchMode; rest: string } {
  const match = /^(tab|split)\s+/i.exec(input);
  if (match) {
    return {
      mode: match[1].toLowerCase() as LaunchMode,
      rest: input.slice(match[0].length),
    };
  }
  return { mode: "tab", rest: input };
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function resolveDir(base: string, p: string): string {
  const expanded = expandTilde(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return [process.execPath, currentScript];
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return [process.execPath];
  }
  return ["pi"];
}

function buildPiCommand(): string {
  return getPiInvocationParts().map(shellQuote).join(" ");
}

async function completeDirectories(
  prefix: string,
): Promise<AutocompleteItem[] | null> {
  const { mode, rest } = splitMode(prefix);
  const modePart = mode === "tab" && !/^(tab|split)\s+/i.test(prefix) ? "" : `${mode} `;
  const lastSlash = rest.lastIndexOf("/");
  const dirPart = lastSlash >= 0 ? rest.slice(0, lastSlash + 1) : "";
  const fragment = lastSlash >= 0 ? rest.slice(lastSlash + 1) : rest;
  const listDir = dirPart === "" ? process.cwd() : resolveDir(process.cwd(), dirPart);

  let entries;
  try {
    entries = await fs.readdir(listDir, { withFileTypes: true });
  } catch {
    // Directory missing or unreadable; no completions to offer.
  }
  if (!entries) return null;

  const fragmentLower = fragment.toLowerCase();
  const showHidden = fragment.startsWith(".");
  const dirs = entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .filter((e) => showHidden || !e.name.startsWith("."))
    .filter((e) => e.name.toLowerCase().startsWith(fragmentLower))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 50);

  if (dirs.length === 0) return null;

  return dirs.map((e) => ({
    value: `${modePart}${dirPart}${e.name}/`,
    label: `${e.name}/`,
    description: resolveDir(process.cwd(), `${dirPart}${e.name}`),
  }));
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("spawn", {
    description:
      "Open a fresh pi in another directory (new Herdr or Ghostty tab/split). Usage: /spawn [tab|split] <dir>",
    getArgumentCompletions: completeDirectories,
    handler: async (args, ctx) => {
      const backend = detectTerminalBackend();
      if (!backend) {
        ctx.ui.notify(
          "/spawn needs Herdr (HERDR_ENV=1) or macOS with Ghostty.",
          "warning",
        );
        return;
      }

      const { mode, rest } = splitMode(args.trim());
      const raw = rest.trim();
      if (!raw) {
        ctx.ui.notify("Usage: /spawn [tab|split] <dir>", "error");
        return;
      }

      const target = resolveDir(ctx.cwd, raw);
      let stat;
      try {
        stat = await fs.stat(target);
      } catch {
        ctx.ui.notify(`Directory not found: ${target}`, "error");
        return;
      }
      if (!stat.isDirectory()) {
        ctx.ui.notify(`Not a directory: ${target}`, "error");
        return;
      }

      const app = describeBackend(backend);
      try {
        await launchTerminal(pi, backend, {
          mode,
          cwd: target,
          command: buildPiCommand(),
          label: path.basename(target),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to launch ${app} ${mode}: ${reason}`, "error");
        return;
      }

      ctx.ui.notify(`Opened pi in ${target} (new ${app} ${mode}).`, "info");
    },
  });
}
