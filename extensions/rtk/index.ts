import type { BashToolCallEvent, ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent"

const REWRITE_TIMEOUT_MS = 2_000

const RTK_PROMPT = `Bash commands are transparently compressed by rtk. When output ends with a hint like \`[full output: rtk recall <id>]\` or \`[+N hidden: rtk recall <id>]\`, run that exact \`rtk recall <id>\` command to get the elided part instead of re-running the command or re-reading files. Use \`rtk bypass <cmd>\` when you need raw, unfiltered output.`
function isBashToolCallEvent(event: ToolCallEvent): event is BashToolCallEvent {
  return event.toolName === "bash"
}
function hasPipe(cmd: string): boolean {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (ch === "\\" && !inSingle) {
      i++
      continue
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle
      continue
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
      continue
    }
    if (ch === "|" && !inSingle && !inDouble) {
      if (cmd[i + 1] === "|") {
        i++
        continue
      }
      return true
    }
  }
  return false
}
async function rewriteCommand(pi: ExtensionAPI, cmd: string, signal?: AbortSignal): Promise<string | null> {
  const result = await pi.exec("rtk", ["rewrite", cmd], { timeout: REWRITE_TIMEOUT_MS, signal })
  if (result.killed) return null
  if (result.code !== 0 && result.code !== 3) return null
  return result.stdout.trim() || null
}

export default async function (pi: ExtensionAPI) {
  const ver = await pi.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
  if (ver.code !== 0) {
    pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("rtk", "rtk not in PATH"))
    return
  }

  pi.on("before_agent_start", async (event) => {
    if (process.env.RTK_DISABLED === "1") return
    return { systemPrompt: `${event.systemPrompt}\n\n${RTK_PROMPT}` }
  })

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!isBashToolCallEvent(event)) return
      const cmd = event.input.command
      if (typeof cmd !== "string" || cmd.trim() === "") return
      if (cmd.startsWith("rtk ")) return
      if (process.env.RTK_DISABLED === "1") return
      if (hasPipe(cmd)) return

      const rewritten = await rewriteCommand(pi, cmd, ctx.signal)
      if (rewritten && rewritten !== cmd) event.input.command = rewritten
    } catch {
      return
    }
  })
}
