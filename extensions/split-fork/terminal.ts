// Open a new terminal tab or split and type a command into it.
//
// Picks the backend from the environment: Rex (via the `rex` CLI) inside a Rex
// terminal, otherwise Ghostty through AppleScript on macOS.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type LaunchMode = "tab" | "split";
export type TerminalBackend = "rex" | "ghostty";

export interface LaunchRequest {
  mode: LaunchMode;
  cwd: string;
  /** Shell command line to run in the new terminal, without trailing newline. */
  command: string;
}

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

const GHOSTTY_TAB_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			new tab in front window with configuration cfg
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

export function detectTerminalBackend(): TerminalBackend | undefined {
  if (process.env.REX_SESSION) return "rex";
  if (process.platform === "darwin") return "ghostty";
  return undefined;
}

export function describeBackend(backend: TerminalBackend): string {
  return { rex: "Rex", ghostty: "Ghostty" }[backend];
}

function failureReason(result: { stdout?: string; stderr?: string }, fallback: string): string {
  return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

async function launchRex(pi: ExtensionAPI, req: LaunchRequest): Promise<void> {
  const session = process.env.REX_SESSION!;
  const args =
    req.mode === "split"
      ? ["split", "-s", session, "--split=right", "-c", req.cwd, "--interactive"]
      : ["window", "new", "-s", session, "-c", req.cwd, "--interactive"];
  // Anchor the split on pi's own pane, not whatever pane has focus.
  if (req.mode === "split" && process.env.REX_BLOCK) args.push("-b", process.env.REX_BLOCK);
  args.push("--", "sh", "-c", req.command);
  const result = await pi.exec("rex", args);
  if (result.code !== 0) {
    throw new Error(failureReason(result, `rex ${args[0]} failed`));
  }
}

async function launchGhostty(pi: ExtensionAPI, req: LaunchRequest): Promise<void> {
  const script = req.mode === "split" ? GHOSTTY_SPLIT_SCRIPT : GHOSTTY_TAB_SCRIPT;
  const result = await pi.exec("osascript", ["-e", script, "--", req.cwd, `${req.command}\n`]);
  if (result.code !== 0) {
    throw new Error(failureReason(result, "unknown osascript error"));
  }
}

/** Open the terminal and run the command. Throws with a readable reason on failure. */
export async function launchTerminal(
  pi: ExtensionAPI,
  backend: TerminalBackend,
  req: LaunchRequest,
): Promise<void> {
  if (backend === "rex") {
    await launchRex(pi, req);
  } else {
    await launchGhostty(pi, req);
  }
}
