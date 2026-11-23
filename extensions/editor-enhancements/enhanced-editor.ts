import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
    type AutocompleteItem,
    type AutocompleteProvider,
    type AutocompleteSuggestions,
    type Component,
    type EditorTheme,
    type TUI,
} from "@earendil-works/pi-tui";
import * as Clipboard from "@mariozechner/clipboard";

import { INLINE_SKILL_RE } from "../skill-autocomplete/index.js";
import { openFilePicker } from "./file-picker.js";

type EnhancedEditorOptions = {
    history: string[];
    borderColor: (editor: EnhancedEditor) => (text: string) => string;
};

function isAtCompletionContext(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);
    return Boolean(beforeCursor.match(/(?:^|[\s])@[^\s]*$/));
}

function wrapProviderWithAtFiltering(provider: AutocompleteProvider): AutocompleteProvider {
    return {
        triggerCharacters: provider.triggerCharacters,

        async getSuggestions(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            options: { signal: AbortSignal; force?: boolean },
        ): Promise<AutocompleteSuggestions | null> {
            // If user is typing an @ reference, suppress the native autocomplete
            // (we handle "@" ourselves by opening the picker)
            if (isAtCompletionContext(lines, cursorLine, cursorCol)) {
                return null;
            }

            return provider.getSuggestions(lines, cursorLine, cursorCol, options);
        },

        applyCompletion(
            lines: string[],
            cursorLine: number,
            cursorCol: number,
            item: AutocompleteItem,
            prefix: string,
        ): { lines: string[]; cursorLine: number; cursorCol: number } {
            return provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },

        shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
            return provider.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
    };
}

export class EnhancedEditor extends CustomEditor {
    private readonly tuiInstance: TUI;
    private picker: Component | null = null;
    private wrappedAutocompleteProvider = false;
    private readonly lockedBorderColor: (text: string) => string;

    constructor(
        tui: TUI,
        theme: EditorTheme,
        keybindings: KeybindingsManager,
        private options: EnhancedEditorOptions,
        private keybindingsManager: KeybindingsManager = keybindings,
    ) {
        super(tui, theme, keybindings, { embedWorkingStatus: true });
        this.tuiInstance = tui;

        this.lockedBorderColor = this.options.borderColor(this);
        Object.defineProperty(this, "borderColor", {
            get: () => this.lockedBorderColor,
            set: () => {},
            configurable: true,
            enumerable: true,
        });

        for (const prompt of this.options.history) {
            this.addToHistory(prompt);
        }
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        // Wrap once. If pi resets providers, we still want our wrapper.
        if (!this.wrappedAutocompleteProvider && provider) {
            const wrapped = wrapProviderWithAtFiltering(provider);
            super.setAutocompleteProvider(wrapped);
            this.wrappedAutocompleteProvider = true;
            return;
        }

        super.setAutocompleteProvider(provider);
    }

    async openFilePickerAtCursor(): Promise<void> {
        const { component, result } = openFilePicker(this.lockedBorderColor);
        const wasFocused = this.focused;
        this.picker = component;
        this.focused = false;
        this.tuiInstance.requestRender();
        const refs = await result;
        this.picker = null;
        this.focused = wasFocused;
        if (refs) this.insertTextAtCursor(`${this.getCursor().col > 0 ? "\n" : ""}${refs}\n`);
        this.tuiInstance.requestRender();
    }

    render(width: number): string[] {
        return this.picker ? [...this.picker.render(width), ...super.render(width)] : super.render(width);
    }

    async pasteClipboardRawAtCursor(): Promise<void> {
        let text: string | undefined;
        try {
            text = await Clipboard.getText();
        } catch {
            text = undefined;
        }

        if (!text) return;

        // Normalize line endings
        const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        // Insert using editor primitive (NOT bracketed paste), so it won't turn into [paste #..]
        this.insertTextAtCursor(normalized);
        this.tuiInstance.requestRender();
    }

    handleInput(data: string): void {
        if (this.picker) {
            this.picker.handleInput?.(data);
            return;
        }

        // Editor keeps these private; we rely on them to protect the unsent draft.
        const history = this as unknown as { historyIndex: number; navigateHistory(direction: number): void };

        if (
            history.historyIndex > -1 &&
            this.keybindingsManager.matches(data, "app.interrupt") &&
            !this.isShowingAutocomplete()
        ) {
            history.historyIndex = 0;
            history.navigateHistory(1);
            this.tuiInstance.requestRender();
            return;
        }

        if (
            history.historyIndex === -1 &&
            this.keybindingsManager.matches(data, "tui.editor.cursorUp") &&
            this.getText() !== "" &&
            this.getCursor().line === 0 &&
            this.getCursor().col === 0
        ) {
            return;
        }

        // Intercept @ at token start to open picker
        if (data === "@" && this.shouldTriggerFilePicker()) {
            if (this.isShowingAutocomplete()) {
                // Escape cancels autocomplete in the base editor
                super.handleInput("\x1b");
            }
            void this.openFilePickerAtCursor();
            return;
        }

        super.handleInput(data);

        // Core only auto-opens `/` menus at message start; open the skill-autocomplete menu for inline `/skill:`.
        const { line, col } = this.getCursor();
        const beforeCursor = (this.getLines()[line] ?? "").slice(0, col);
        if (data.length === 1 && !this.isShowingAutocomplete() && INLINE_SKILL_RE.test(beforeCursor)) {
            (this as unknown as { tryTriggerAutocomplete(): void }).tryTriggerAutocomplete();
        }
    }

    private shouldTriggerFilePicker(): boolean {
        const cursor = this.getCursor();
        const line = this.getLines()[cursor.line] ?? "";

        if (cursor.col === 0) return true;

        const before = line[cursor.col - 1];
        return before === " " || before === "\t" || before === undefined;
    }
}
