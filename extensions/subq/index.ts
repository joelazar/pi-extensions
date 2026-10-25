/**
 * SubQ Snap classifier provider.
 *
 * SubQ's Decisions API (POST /v1/systemone) speaks TypeSafe's System One protocol,
 * so this reuses pi-ai's System One transport. Only images differ: SubQ wants
 * `images: [{ mediaType, base64 }]` instead of data URLs.
 *
 * Usage (codemode), same as Jev:
 *   const snap = await models.getModelOfType("classifier", "subq", "subq-snap-1.1");
 *   await models.classify(snap, { state, questions });
 */
import { classifySystemOne, type SystemOneTransport } from "@earendil-works/pi-ai/api/system-one-shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "subq-system-one";

/** Converts `data:<mime>;base64,<data>` URLs into SubQ's image objects. */
export function toSubqImages(urls: string[]) {
	return urls.map((url) => {
		const match = /^data:([^;]+);base64,(.*)$/su.exec(url);
		if (!match) throw new Error("SubQ image is not a base64 data URL");
		return { mediaType: match[1], base64: match[2] };
	});
}

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
		baseUrl: "https://api.subq.ai/v1",
		apiKey: "$SUBQ_API_KEY",
		models: [
			{
				type: "classifier",
				id: "subq-snap-1.1",
				name: "SubQ Snap 1.1",
				api: API,
				input: ["text", "image"],
				// $0.04 per 1M input tokens; output is free.
				cost: { input: 0.04, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 393216,
			},
		],
		classifiers: {
			[API]: { classify: (model, context, options) => classifySystemOne(transport, model, context, options) },
		},
	});
}
