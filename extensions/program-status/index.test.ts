// Run: node --test extensions/program-status/index.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRecord } from "./index.ts";

test("blocked record carries id, app, kind and base64 msg without control chars", () => {
  const seq = formatRecord({ active: true, label: "Pick\none", kind: "question" });
  assert.equal(seq, `\x1b]7501;state=blocked:id=dialog:app=pi:kind=question:msg=${btoa("Pick one")}\x1b\\`);
});

test("unknown kind is dropped, inactive clears the record", () => {
  assert.doesNotMatch(formatRecord({ active: true, kind: "nope" }), /kind=/);
  assert.equal(formatRecord({ active: false }), "\x1b]7501;state=clear:id=dialog\x1b\\");
  assert.equal(formatRecord(undefined), "\x1b]7501;state=clear:id=dialog\x1b\\");
});
