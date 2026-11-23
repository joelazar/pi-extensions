import { findPackageJSON } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { SystemOneTransport } from "@earendil-works/pi-ai/api/system-one-shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi's extension loader prefix-aliases "@earendil-works/pi-ai" to its extension view, which breaks subpath imports.
// shortcut: loads pi's own pi-ai copy by file path, switch to a plain import once pi aliases subpaths.
let systemOne: Promise<typeof import("@earendil-works/pi-ai/api/system-one-shared")> | undefined;
function loadSystemOne() {
	systemOne ??= (async () => {
		const pkg = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(realpathSync(process.argv[1])));
		if (!pkg) throw new Error("SubQ: cannot locate @earendil-works/pi-ai from pi's cli");
		return import(pathToFileURL(join(dirname(pkg), "dist/api/system-one-shared.js")).href);
	})();
	return systemOne;
}

const API = "subq-system-one";
const BASE_URL = "https://api.subq.ai/v1";

export function toSubqImages(urls: string[]) {
	return urls.map((url) => {
		const match = /^data:([^;]+);base64,(.*)$/su.exec(url);
		if (!match) throw new Error("SubQ image is not a base64 data URL");
		return { mediaType: match[1], base64: match[2] };
	});
}

export function toModel({ id, name }: { id: string; name?: string }) {
	return {
		type: "classifier" as const,
		id,
		name: name ?? id,
		api: API,
		input: ["text" as const, "image" as const],
		// Snap is $0.04 per 1M input tokens for every version; output is free.
		cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 393216,
	};
}

const fallbackModels = [toModel({ id: "subq-snap-1.2", name: "SubQ Snap 1.2" })];

const transport: SystemOneTransport = {
	api: API,
	label: "SubQ Decisions API",
	// "images" yields data URLs (PNG/JPEG/WebP, max 4), which matches SubQ's limits.
	detectCompat: () => ({ imageInput: "images", sendImageOptInHeader: false }),
	url: (model) => new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`),
	payload: (model, { images, ...rest }) => ({
		model: model.id,
		...rest,
		...(images?.length ? { images: toSubqImages(images) } : {}),
	}),
	output: (body) => {
		if (typeof body !== "object" || body === null) throw new Error("SubQ returned an unexpected response");
		return body as Record<string, unknown>;
	},
};

export default function (pi: ExtensionAPI) {
	pi.registerProvider("subq", {
		name: "SubQ",
		baseUrl: BASE_URL,
		apiKey: "$SUBQ_API_KEY",
		models: fallbackModels,
		async refreshModels({ allowNetwork, signal }) {
			if (!allowNetwork) return fallbackModels;
			const response = await fetch(`${BASE_URL}/models`, { signal });
			if (!response.ok) throw new Error(`SubQ /models returned ${response.status}`);
			const { data } = (await response.json()) as { data: { id: string; name?: string }[] };
			return data.map(toModel);
		},
		classifiers: {
			[API]: { classify: async (model, context, options) =>
					(await loadSystemOne()).classifySystemOne(transport, model, context, options), },
		},
	});
}
