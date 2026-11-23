import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { countLines, parseNumstat, readDiffstat } from "../index.ts";

test("parseNumstat sums text and counts binary files", () => {
  assert.deepEqual(parseNumstat("3\t1\ta.ts\n-\t-\tlogo.png\n10\t0\tb.ts\n"), {
    files: 3,
    insertions: 13,
    deletions: 1,
  });
  assert.deepEqual(parseNumstat(""), { files: 0, insertions: 0, deletions: 0 });
});

test("countLines handles trailing newline, no newline, empty and binary", () => {
  assert.equal(countLines(Buffer.from("a\nb\n")), 2);
  assert.equal(countLines(Buffer.from("a\nb")), 2);
  assert.equal(countLines(Buffer.from("")), 0);
  assert.equal(countLines(Buffer.from([1, 0, 10])), 0);
});

test("readDiffstat counts untracked files in a repo without commits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "footer-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(join(dir, "a.txt"), "one\ntwo\n");
    await writeFile(join(dir, ".gitignore"), "ignored\n");
    await writeFile(join(dir, "ignored"), "x\n");
    assert.deepEqual(await readDiffstat(dir), {
      files: 2,
      insertions: 3,
      deletions: 0,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
