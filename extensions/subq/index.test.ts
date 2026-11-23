import assert from "node:assert/strict";
import { test } from "node:test";
import { toModel, toSubqImages } from "./index.ts";

test("toSubqImages splits data URLs into mediaType and base64", () => {
	assert.deepEqual(toSubqImages(["data:image/png;base64,iVBO\nRw=="]), [
		{ mediaType: "image/png", base64: "iVBO\nRw==" },
	]);
	assert.throws(() => toSubqImages(["https://example.com/a.png"]), /not a base64 data URL/);
});

test("toModel maps /v1/models entries to classifier models", () => {
	assert.equal(toModel({ id: "subq-snap-latest", name: "SubQ Snap Latest" }).name, "SubQ Snap Latest");
	assert.equal(toModel({ id: "subq-snap-preview" }).name, "subq-snap-preview");
	assert.equal(toModel({ id: "x" }).type, "classifier");
});
