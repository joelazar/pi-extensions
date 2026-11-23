import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readMode, writeMode } from "./frontmatter.ts";

const base = "---\nname: handoff\ndescription: Compact.\n---\n\n# Handoff\n";
const duplicated = "---\nname: handoff\ndisable-model-invocation: true\ndescription: Compact.\ndisable-model-invocation: true\n---\n\n# Handoff\n";

describe("frontmatter", () => {
  it("round-trips agent-invocable ↔ manual-only", () => {
    const manual = writeMode(base, "manual-only");
    assert.equal(readMode(base), "agent-invocable");
    assert.equal(readMode(manual), "manual-only");
    assert.equal(writeMode(manual, "agent-invocable"), base);
  });

  it("collapses duplicate keys", () => {
    assert.equal(writeMode(duplicated, "manual-only").match(/disable-model-invocation/g)?.length, 1);
    assert.equal(writeMode(duplicated, "agent-invocable"), base);
  });

  it("preserves CRLF and leaves files without frontmatter alone", () => {
    const crlf = base.replaceAll("\n", "\r\n");
    assert.equal(writeMode(crlf, "manual-only"), crlf.replace("---\r\n\r\n", "disable-model-invocation: true\r\n---\r\n\r\n"));
    assert.equal(writeMode("# no frontmatter\n", "manual-only"), "# no frontmatter\n");
  });

  it("does not treat body lines as frontmatter", () => {
    assert.equal(readMode(`${base}disable-model-invocation: true\n`), "agent-invocable");
  });
});
