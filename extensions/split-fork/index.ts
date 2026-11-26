// Source: https://github.com/mitsuhiko/agent-stuff/blob/a3f8ab1108a4/extensions/split-fork.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { describeBackend, detectTerminalBackend, launchTerminal } from "./terminal.ts";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function getPiInvocationParts(): string[] {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return [process.execPath, currentScript];
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return [process.execPath];
  }

  return ["pi"];
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("split-fork", {
    description: "Fork this session into a new pi process in a Rex or Ghostty tab/split. Usage: /split-fork [tab|split]",
    getArgumentCompletions: (prefix) =>
      ["tab", "split"].filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
    handler: async (args, ctx) => {
      const backend = detectTerminalBackend();
      if (!backend) {
        ctx.ui.notify("/split-fork needs Rex (REX_BLOCK) or macOS with Ghostty.", "warning");
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("/split-fork needs a persisted session.", "warning");
        return;
      }

      const mode = args.trim().toLowerCase() === "split" ? "split" : "tab";
      const name = pi.getSessionName();
      const parts = [...getPiInvocationParts(), "--fork", sessionFile];
      if (name) parts.push("--name", `${name} (fork)`);
      const app = describeBackend(backend);

      try {
        await launchTerminal(pi, backend, { mode, cwd: ctx.cwd, command: parts.map(shellQuote).join(" ") });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to launch ${app} ${mode}: ${reason}`, "error");
        return;
      }

      ctx.ui.notify(
        ctx.isIdle()
          ? `Forked into a new ${app} ${mode}.`
          : `Forked into a new ${app} ${mode} from the committed state; the running turn continues here.`,
        "info",
      );
    },
  });
}
