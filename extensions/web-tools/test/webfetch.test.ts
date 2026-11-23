import test from "node:test";
import assert from "node:assert/strict";
import { createWebFetchTool, describeRequestFailure } from "../webfetch.ts";

test("webfetch execute rejects URL credentials with a safe message", async () => {
	const tool = createWebFetchTool();

	await assert.rejects(
		tool.execute("id", { url: "https://user:pass@example.com/secret" }),
		(error: unknown) => error instanceof Error && error.message === "URL credentials are not supported",
	);
});

test("describeRequestFailure names the network error code", () => {
	const dns = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x.invalid"), { code: "ENOTFOUND" }) });
	assert.equal(describeRequestFailure(dns), "Request failed (ENOTFOUND: DNS lookup failed, the host does not exist)");

	const unknown = new TypeError("fetch failed", { cause: Object.assign(new Error("boom"), { code: "UND_ERR_SOCKET" }) });
	assert.equal(describeRequestFailure(unknown), "Request failed (UND_ERR_SOCKET)");

	assert.equal(describeRequestFailure(new Error("no code")), "Request failed");
	assert.equal(describeRequestFailure(undefined), "Request failed");
});

test("webfetch execute reports DNS failures with their cause", async () => {
	const tool = createWebFetchTool();

	await assert.rejects(
		tool.execute("id", { url: "https://pi-web-tools-test.invalid/" }),
		(error: unknown) => error instanceof Error && /^Request failed \((ENOTFOUND|EAI_AGAIN)/.test(error.message),
	);
});
