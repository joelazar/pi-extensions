// Source: mitsuhiko/agent-stuff (https://github.com/mitsuhiko/agent-stuff)
//   Path: extensions/split-fork.ts
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  describeBackend,
  detectTerminalBackend,
  launchTerminal,
  type LaunchMode as ForkMode,
} from "../shared/terminal.ts";

function parseArgs(args: string): { mode: ForkMode; prompt: string } {
  const trimmed = args.trim();
  const match = /^(tab|split)\b\s*/i.exec(trimmed);
  if (match) {
    return {
      mode: match[1].toLowerCase() as ForkMode,
      prompt: trimmed.slice(match[0].length).trim(),
    };
  }
  return { mode: "tab", prompt: trimmed };
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
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return [process.execPath];
  }

  return ["pi"];
}

function buildPiCommand(
  sessionFile: string | undefined,
  prompt: string,
): string {
  const commandParts = [...getPiInvocationParts()];

  if (sessionFile) {
    commandParts.push("--session", sessionFile);
  }

  if (prompt.length > 0) {
    commandParts.push("--", prompt);
  }

  return commandParts.map(shellQuote).join(" ");
}

async function createForkedSession(
  ctx: ExtensionCommandContext,
): Promise<string | undefined> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    return undefined;
  }

  const sessionDir = path.dirname(sessionFile);
  const branchEntries = ctx.sessionManager.getBranch();
  const currentHeader = ctx.sessionManager.getHeader();

  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const newSessionId = randomUUID();
  const newSessionFile = path.join(
    sessionDir,
    `${fileTimestamp}_${newSessionId}.jsonl`,
  );

  const newHeader = {
    type: "session",
    version: currentHeader?.version ?? 3,
    id: newSessionId,
    timestamp,
    cwd: currentHeader?.cwd ?? ctx.cwd,
    parentSession: sessionFile,
  };

  const lines =
    [
      JSON.stringify(newHeader),
      ...branchEntries.map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n";

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(newSessionFile, lines, "utf8");

  return newSessionFile;
}

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("split-fork", {
    description:
      "Fork this session into a new pi process in a Herdr or Ghostty tab/split. Usage: /split-fork [tab|split] [optional prompt] (defaults to tab)",
    handler: async (args, ctx) => {
      const backend = detectTerminalBackend();
      if (!backend) {
        ctx.ui.notify(
          "/split-fork needs Herdr (HERDR_ENV=1) or macOS with Ghostty.",
          "warning",
        );
        return;
      }
      const app = describeBackend(backend);

      const wasBusy = !ctx.isIdle();
      const { mode, prompt } = parseArgs(args);
      const forkedSessionFile = await createForkedSession(ctx);
      const command = buildPiCommand(forkedSessionFile, prompt);

      try {
        await launchTerminal(pi, backend, {
          mode,
          cwd: ctx.cwd,
          command,
          label: `fork: ${path.basename(ctx.cwd)}`,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to launch ${app} ${mode}: ${reason}`, "error");
        if (forkedSessionFile) {
          ctx.ui.notify(
            `Forked session was created: ${forkedSessionFile}`,
            "info",
          );
        }
        return;
      }

      if (forkedSessionFile) {
        const fileName = path.basename(forkedSessionFile);
        const suffix = prompt ? " and sent prompt" : "";
        ctx.ui.notify(
          `Forked to ${fileName} in a new ${app} ${mode}${suffix}.`,
          "info",
        );
        if (wasBusy) {
          ctx.ui.notify(
            "Forked from current committed state (in-flight turn continues in original session).",
            "info",
          );
        }
      } else {
        ctx.ui.notify(
          `Opened a new ${app} ${mode} (no persisted session to fork).`,
          "warning",
        );
      }
    },
  });
}
