import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ModelRole = "fast" | "smart";

const CONFIG_PATH = join(getAgentDir(), "extension-models.json");

function roleEntries(role: ModelRole): string[] {
	if (!existsSync(CONFIG_PATH)) return ["current"];
	let config: unknown;
	try {
		config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch (err) {
		throw new Error(`Invalid ${CONFIG_PATH}: ${(err as Error).message}`);
	}
	const entries = (config as Record<string, unknown> | null)?.[role];
	if (!Array.isArray(entries)) return ["current"];
	return entries.filter((entry): entry is string => typeof entry === "string");
}

function lookup(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, entry: string): Model<Api> | undefined {
	if (entry === "current") return ctx.model;
	const slash = entry.indexOf("/");
	if (slash <= 0) return undefined;
	return ctx.modelRegistry.find(entry.slice(0, slash), entry.slice(slash + 1));
}

export function resolveModels(ctx: Pick<ExtensionContext, "model" | "modelRegistry">, role: ModelRole): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const entry of roleEntries(role)) {
		const model = lookup(ctx, entry);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) continue;
		if (models.some((m) => m.provider === model.provider && m.id === model.id)) continue;
		models.push(model);
	}
	return models;
}
