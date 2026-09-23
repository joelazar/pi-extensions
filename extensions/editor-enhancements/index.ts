// Source: w-winter/dot314 (https://github.com/w-winter/dot314)
//   Path: extensions/editor-enhancements/
// Prompt history seeding merged in from the former cwd-history extension.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig, type EditorEnhancementsRuntimeConfig } from "./config.js";
import { EnhancedEditor } from "./enhanced-editor.js";
import {
    buildHistoryList,
    collectUserPromptsFromEntries,
    historiesMatch,
    loadPromptHistoryForCwd,
    type PromptEntry,
} from "./history.js";

type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

function resolveDoubleEscapeCommand(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    doubleEscapeCommand: string | null,
): string | null {
    if (!doubleEscapeCommand) return null;

    const hasMatchingExtensionCommand = pi.getCommands().some(
        (command) => command.source === "extension" && command.name === doubleEscapeCommand,
    );

    if (hasMatchingExtensionCommand) {
        return doubleEscapeCommand;
    }

    ctx.ui.notify(
        `editor-enhancements: configured doubleEscapeCommand '/${doubleEscapeCommand}' is not a registered extension command`,
        "warning",
    );
    return null;
}

export default function (pi: ExtensionAPI) {
    let activeContext: ExtensionContext | null = null;
    let activeEditor: EnhancedEditor | null = null;
    let lastKnownThinkingLevel: ThinkingLevel | undefined;
    let loadCounter = 0;

    const currentThinkingLevel = (): ThinkingLevel => {
        try {
            lastKnownThinkingLevel = pi.getThinkingLevel();
        } catch {
            return lastKnownThinkingLevel ?? "off";
        }
        return lastKnownThinkingLevel;
    };

    const attachEditor = (
        ctx: ExtensionContext,
        config: EditorEnhancementsRuntimeConfig,
        doubleEscapeCommand: string | null,
        history: PromptEntry[],
    ) => {
        activeContext = ctx;
        const uiTheme = ctx.ui.theme;

        ctx.ui.setEditorComponent((tui, theme, keybindings) => {
            activeEditor = new EnhancedEditor(tui, theme, keybindings, ctx.ui, {
                doubleEscapeCommand,
                canTriggerDoubleEscapeCommand: () => {
                    if (!activeContext) return false;
                    return activeContext.isIdle() && !activeContext.hasPendingMessages();
                },
                commandRemap: config.commandRemap,
                history: history.map((prompt) => prompt.text),
                borderColor: (editor) => (text) => {
                    const colorFn = editor.getText().trimStart().startsWith("!")
                        ? uiTheme.getBashModeBorderColor()
                        : uiTheme.getThinkingBorderColor(currentThinkingLevel());
                    return colorFn(text);
                },
            });
            return activeEditor;
        });
    };

    pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI) return;

        const config = loadConfig();
        const doubleEscapeCommand = resolveDoubleEscapeCommand(pi, ctx, config.doubleEscapeCommand);
        const sessionFile = ctx.sessionManager.getSessionFile();
        const currentPrompts = collectUserPromptsFromEntries(ctx.sessionManager.getBranch());
        const immediateHistory = buildHistoryList(currentPrompts, []);

        const currentLoad = ++loadCounter;
        const initialText = ctx.ui.getEditorText();
        attachEditor(ctx, config, doubleEscapeCommand, immediateHistory);

        void (async () => {
            const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
            if (currentLoad !== loadCounter) return;
            if (ctx.ui.getEditorText() !== initialText) return;
            const history = buildHistoryList(currentPrompts, previousPrompts);
            if (historiesMatch(history, immediateHistory)) return;
            attachEditor(ctx, config, doubleEscapeCommand, history);
        })();
    });

    pi.registerShortcut("alt+v", {
        description: "Paste clipboard text raw into editor (bypasses [paste #..] markers)",
        handler: async (ctx) => {
            if (!ctx.hasUI) return;
            if (!activeEditor) {
                ctx.ui.notify("Editor not ready", "warning");
                return;
            }
            await activeEditor.pasteClipboardRawAtCursor();
        },
    });
}
