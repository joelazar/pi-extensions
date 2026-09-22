// Open a new terminal tab or split and type a command into it.
//
// Picks the backend from the environment: Herdr (via the `herdr` CLI) when pi
// runs inside a Herdr-managed pane, otherwise Ghostty through AppleScript on
// macOS. Both extensions that spawn pi processes share this so the backend
// logic lives in one place.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type LaunchMode = "tab" | "split";
export type TerminalBackend = "herdr" | "ghostty";

export interface LaunchRequest {
  mode: LaunchMode;
  cwd: string;
  /** Shell command line to run in the new terminal, without trailing newline. */
  command: string;
  /**
   * Tab label; only Herdr honors it, and only when `lockLabel` is set.
   * Herdr's auto-title plugin locks any tab that was created with an explicit
   * label, so by default the label is dropped and auto-titling stays on.
   */
  label?: string;
  /** Pass the label to Herdr even though it disables auto-titling. */
  lockLabel?: boolean;
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
  if (process.env.HERDR_ENV === "1") return "herdr";
  if (process.platform === "darwin") return "ghostty";
  return undefined;
}

export function describeBackend(backend: TerminalBackend): string {
  return backend === "herdr" ? "Herdr" : "Ghostty";
}

function failureReason(result: { stdout?: string; stderr?: string }, fallback: string): string {
  return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

async function herdr(pi: ExtensionAPI, args: string[]): Promise<string> {
  const result = await pi.exec("herdr", args);
  if (result.code !== 0) {
    throw new Error(failureReason(result, `herdr ${args[0]} ${args[1]} failed`));
  }
  return result.stdout;
}

/** Run a herdr command that is expected to answer with a JSON envelope. */
async function herdrJson(pi: ExtensionAPI, args: string[]): Promise<unknown> {
  const stdout = await herdr(pi, args);
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`herdr returned non-JSON output: ${stdout.trim()}`);
  }
}

async function launchHerdr(pi: ExtensionAPI, req: LaunchRequest): Promise<void> {
  let paneId: string | undefined;
  if (req.mode === "split") {
    const res = (await herdrJson(pi, [
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      req.cwd,
      "--focus",
    ])) as { result?: { pane?: { pane_id?: string } } };
    paneId = res.result?.pane?.pane_id;
  } else {
    const args = ["tab", "create", "--cwd", req.cwd, "--focus"];
    if (req.label && req.lockLabel) args.push("--label", req.label);
    const res = (await herdrJson(pi, args)) as {
      result?: { root_pane?: { pane_id?: string } };
    };
    paneId = res.result?.root_pane?.pane_id;
  }
  if (!paneId) {
    throw new Error("herdr did not return a pane id");
  }
  await herdr(pi, ["pane", "run", paneId, req.command]);
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
  if (backend === "herdr") {
    await launchHerdr(pi, req);
  } else {
    await launchGhostty(pi, req);
  }
}
