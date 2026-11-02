export function getTextContent(content: Array<{ type: string; text?: string }> | undefined): string {
	if (!content) return "";
	return content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

export function appendExpandedPreview(
	base: string,
	text: string,
	theme: {
		fg: (name: string, value: string) => string;
	},
	options: { maxLines?: number; maxColumns?: number } = {},
): string {
	const maxLines = options.maxLines ?? 12;
	const maxColumns = options.maxColumns ?? 200;
	const lines = text.split("\n");
	for (const line of lines.slice(0, maxLines)) {
		base += `\n${theme.fg("dim", line.slice(0, maxColumns))}`;
	}
	if (lines.length > maxLines) {
		base += `\n${theme.fg("muted", "...")}`;
	}
	return base;
}

/** Pi's injected render context; an imported keyHint may be another package copy that misses user keybindings. */
export interface KeyHints {
	keyHint(keybinding: "app.tools.expand", description: string): string;
}

export function appendExpandHint(base: string, expanded: boolean, context: KeyHints): string {
	if (expanded) return base;
	return `${base} ${context.keyHint("app.tools.expand", "for details")}`;
}
