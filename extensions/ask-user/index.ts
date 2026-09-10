// Source: khoi/pi (https://github.com/khoi/pi) via davis7dotsh/my-pi-setup
//   Path: extensions/ask_user_question/index.ts

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const TIMEOUT_SECONDS = Number(process.env.PI_ASK_USER_TIMEOUT ?? 300);
const COUNTDOWN_SECONDS = 20;
const OTHER_LABEL = "Write my own answer…";

const Params = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "Short display label for this option" }),
      description: Type.Optional(
        Type.String({
          description: "Optional one-line description shown below the label",
        }),
      ),
    }),
    {
      minItems: 2,
      maxItems: 5,
      description:
        "Between 2 and 5 answer options. A free-form 'write my own answer' option is always appended automatically - never include one yourself.",
    },
  ),
});

type Outcome =
  | { kind: "no-ui" }
  | { kind: "cancelled" }
  | { kind: "dismissed" }
  | { kind: "timeout"; seconds: number }
  | { kind: "custom"; answer: string }
  | { kind: "selected"; answer: string; index: number };

function describe(outcome: Outcome): string {
  switch (outcome.kind) {
    case "no-ui":
      return "No interactive UI is available, so the question could not be shown. Ask the user in plain text instead.";
    case "cancelled":
      return "Cancelled";
    case "dismissed":
      return "User dismissed the question without answering. Do not assume an answer; proceed accordingly or ask differently.";
    case "timeout":
      return `No response after ${outcome.seconds}s — the user may be away from keyboard. A timeout is not approval or consent. Continue only with work that does not require user authorization; otherwise leave the action pending and re-ask later.`;
    case "custom":
      return `User wrote their own answer: ${outcome.answer}`;
    case "selected":
      return `User selected option ${outcome.index}: ${outcome.answer}`;
  }
}

export default function askUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the user a single multiple-choice question (2-5 options). A free-form 'write my own answer' option is always added automatically, and the user may dismiss the question without answering. Ask exactly one question per call.",
    promptSnippet:
      "Ask the user a multiple-choice question (2-5 options plus a free-form answer)",
    promptGuidelines: [
      "When asking the user a question whose likely answers can be enumerated, use the ask_user tool instead of asking in plain text.",
      "Ask one question per ask_user call; ask follow-up questions in subsequent calls.",
    ],
    parameters: Params,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const reply = (outcome: Outcome) => ({
        content: [{ type: "text" as const, text: describe(outcome) }],
        details: outcome,
      });

      if (ctx.mode !== "tui") return reply({ kind: "no-ui" });
      if (signal?.aborted) return reply({ kind: "cancelled" });

      const options = [
        ...params.options,
        { label: OTHER_LABEL, description: undefined },
      ];
      const otherIndex = options.length - 1;

      const outcome = await ctx.ui.custom<Outcome>((tui, theme, _kb, done) => {
        let cursor = 0;
        let editing = false;
        let cached: string[] | undefined;
        let settled = false;
        let lastActivity = Date.now();
        let remaining = TIMEOUT_SECONDS;

        const finish = (outcome: Outcome) => {
          if (settled) return;
          settled = true;
          done(outcome);
        };
        const cancel = () => finish({ kind: "cancelled" });
        signal?.addEventListener("abort", cancel, { once: true });

        const refresh = () => {
          cached = undefined;
          tui.requestRender();
        };

        const tick = () => {
          remaining = TIMEOUT_SECONDS - Math.floor((Date.now() - lastActivity) / 1000);
          if (remaining <= 0) return finish({ kind: "timeout", seconds: TIMEOUT_SECONDS });
          if (remaining <= COUNTDOWN_SECONDS) refresh();
        };
        const timer = TIMEOUT_SECONDS > 0 ? setInterval(tick, 1000) : undefined;
        timer?.unref?.();

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg("accent", s),
          selectList: {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          },
        };
        const editor = new Editor(tui, editorTheme);

        const leaveEditor = () => {
          editing = false;
          editor.setText("");
          refresh();
        };

        editor.onSubmit = (value) => {
          const answer = value.trim();
          if (answer) finish({ kind: "custom", answer });
          else leaveEditor();
        };

        const select = (index: number) => {
          cursor = index;
          if (index === otherIndex) {
            editing = true;
            refresh();
          } else {
            finish({ kind: "selected", answer: options[index].label, index: index + 1 });
          }
        };

        const handleInput = (data: string) => {
          lastActivity = Date.now();
          if (remaining <= COUNTDOWN_SECONDS) refresh();
          remaining = TIMEOUT_SECONDS;

          if (editing) {
            if (matchesKey(data, Key.escape)) return leaveEditor();
            editor.handleInput(data);
            return refresh();
          }
          if (matchesKey(data, Key.up)) {
            cursor = (cursor - 1 + options.length) % options.length;
            return refresh();
          }
          if (matchesKey(data, Key.down)) {
            cursor = (cursor + 1) % options.length;
            return refresh();
          }
          if (data.length === 1 && data >= "1" && data <= String(options.length)) {
            return select(Number(data) - 1);
          }
          if (matchesKey(data, Key.enter)) return select(cursor);
          if (matchesKey(data, Key.escape)) finish({ kind: "dismissed" });
        };

        const render = (width: number): string[] => {
          if (cached) return cached;
          const lines: string[] = [];
          const add = (s: string) => lines.push(truncateToWidth(s, width));

          const title = " Question ";
          add(theme.fg("accent", `─${title}${"─".repeat(Math.max(0, width - title.length - 1))}`));
          for (const line of wrapTextWithAnsi(params.question, Math.max(10, width - 2))) {
            add(` ${theme.bold(line)}`);
          }
          lines.push("");

          options.forEach((opt, i) => {
            const isOther = i === otherIndex;
            const active = i === cursor || (isOther && editing);
            const prefix = i === cursor ? theme.fg("accent", " ❯ ") : "   ";
            const label = `${isOther ? "✎" : `${i + 1}.`} ${opt.label}`;
            add(prefix + theme.fg(active ? "accent" : isOther ? "muted" : "text", label));
            if (opt.description) add(`      ${theme.fg("muted", opt.description)}`);
          });

          if (editing) {
            lines.push("");
            add(theme.fg("muted", " Your answer:"));
            for (const line of editor.render(width - 2)) add(` ${line}`);
          }

          lines.push("");
          if (timer && remaining <= COUNTDOWN_SECONDS) {
            add(theme.fg("warning", ` auto-continue in ${remaining}s · any key to stay`));
          }
          add(
            theme.fg(
              "dim",
              editing
                ? " Enter submit • Esc back to options"
                : ` ↑↓ or 1-${options.length} select • Enter confirm • Esc dismiss`,
            ),
          );
          add(theme.fg("accent", "─".repeat(width)));

          cached = lines;
          return lines;
        };

        return {
          render,
          handleInput,
          invalidate: () => {
            cached = undefined;
          },
          dispose: () => {
            if (timer) clearInterval(timer);
            signal?.removeEventListener("abort", cancel);
          },
        };
      });

      return reply(outcome);
    },

    renderCall(args, theme) {
      const numbered = args.options.map((o, i) => `${i + 1}. ${o.label}`).join("  ");
      return new Text(
        theme.fg("toolTitle", theme.bold("ask_user ")) +
          theme.fg("muted", args.question) +
          `\n${theme.fg("dim", `  ${numbered}`)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const outcome = result.details as Outcome;
      switch (outcome.kind) {
        case "selected":
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("accent", `${outcome.index}. ${outcome.answer}`),
            0,
            0,
          );
        case "custom":
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", outcome.answer),
            0,
            0,
          );
        case "dismissed":
        case "cancelled":
          return new Text(theme.fg("warning", "✗ dismissed"), 0, 0);
        case "timeout":
          return new Text(theme.fg("warning", `⏱ no response after ${outcome.seconds}s`), 0, 0);
        default:
          return new Text(theme.fg("muted", describe(outcome)), 0, 0);
      }
    },
  });
}
