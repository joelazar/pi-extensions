/**
 * Rex Resume
 *
 * Reports `pi --session <file>` to the terminal with the Program Resume
 * Protocol (OSC 7577), so a terminal such as Rex brings this pi session back
 * after a restart. Spec: https://www.superlogical.com/rex/docs/build/program-resume
 *
 * Rex also needs a trust rule in ~/.config/rex/init.lua:
 *   rex.set("resume.trust.pi", {
 *     command = { "pi", "--session", rex.match.under("~/.pi/agent/sessions") },
 *   })
 *
 * Stopgap: pi reports for itself from its first release after 1.6.1, and Rex
 * ships a built-in pi rule (docs/features/session-restore). This extension goes
 * quiet on newer pi; once pi > 1.6.1 and a Rex server with the built-in rule are
 * installed, delete this extension and the resume.trust.pi rule in init.lua.
 *
 * No `clear` is sent: Rex drops the record itself when pi exits, and the spec
 * forbids clearing on SIGHUP/SIGTERM, which pi's shutdown can't tell apart.
 */

import { createHash } from "node:crypto";
import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent";

// pi after 1.6.1 reports natively; leave the token to it.
const native = VERSION !== "1.6.1" && !/^(0|1\.[0-5]|1\.6\.0)\b/.test(VERSION);

// Take the token so tools pi runs (bash, subagents) can't report in its place.
const token = native ? undefined : process.env.OSC7577_TOKEN;
if (!native) delete process.env.OSC7577_TOKEN;

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export function buildReport(argv: string[], pid: number, time: number, secret: string): string {
	const body = `pid=${pid}:time=${time}:argv=${argv.map(b64).join(",")}`;
	const mac = createHash("sha256").update(`${body}:${secret}`).digest("hex");
	return `\x1b]7577;${body}:mac=${mac}\x1b\\`;
}

export default function (pi: ExtensionAPI): void {
	if (!token) return;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const file = ctx.sessionManager.getSessionFile();
		// Arguments with control characters can't be reported.
		if (!file || /[\x00-\x1f\x7f-\x9f]/.test(file)) return;
		process.stdout.write(buildReport(["pi", "--session", file], process.pid, Math.floor(Date.now() / 1000), token));
	});
}
