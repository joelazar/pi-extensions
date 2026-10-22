// Mirrors `herdr:blocked` events (Guardrails approvals, ask_user) into an OSC 7501
// child record, so Rex shows pi as waiting on the user. Pi itself only reports
// `blocked` for its built-in dialogs, not for ctx.ui.custom ones.
// Spec: https://www.superlogical.com/rex/docs/build/program-status
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const RECORD_ID = "dialog";
const KINDS = new Set(["permission", "question", "auth"]);

type BlockedEvent = { active?: boolean; label?: string; kind?: string };

// shortcut: gated on Rex env vars because pi's OSC 7501 support probe is private; widen if another terminal adopts it.
function enabled(): boolean {
  if (process.env.PI_PROGRAM_STATUS === "0") return false;
  return !!process.env.REX_SESSION || process.env.PI_PROGRAM_STATUS === "1";
}

export function formatRecord(event: BlockedEvent | undefined): string {
  if (!event?.active) return `\x1b]7501;state=clear:id=${RECORD_ID}\x1b\\`;
  const pairs = ["state=blocked", `id=${RECORD_ID}`, "app=pi"];
  if (event.kind && KINDS.has(event.kind)) pairs.push(`kind=${event.kind}`);
  // Terminals drop the whole report if msg contains control characters.
  const msg = (event.label ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim().slice(0, 500);
  if (msg) pairs.push(`msg=${Buffer.from(msg, "utf8").toString("base64")}`);
  return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}

export default function (pi: ExtensionAPI): void {
  if (!enabled()) return;

  // Open dialogs, most recent last; the top one is reported.
  const open: BlockedEvent[] = [];
  let tui = false;

  const report = () => {
    if (tui && process.stdout.isTTY) process.stdout.write(formatRecord(open.at(-1)));
  };

  pi.on("session_start", (_event, ctx) => {
    tui = ctx.mode === "tui";
  });

  pi.events.on("herdr:blocked", (data) => {
    const event = data as BlockedEvent | undefined;
    if (event?.active) open.push(event);
    else open.pop();
    report();
  });

  pi.on("session_shutdown", () => {
    open.length = 0;
    report();
  });
}
