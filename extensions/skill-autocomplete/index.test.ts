import assert from "node:assert/strict";
import { test } from "node:test";
import { expandInlineSkills, suggestSkills, type SkillEntry } from "./index.ts";

const skills: SkillEntry[] = [
  { name: "pdf", description: "PDF tools", filePath: "/s/pdf/SKILL.md", baseDir: "/s/pdf" },
  { name: "review-voice", description: "Review comments", filePath: "/s/rv/SKILL.md", baseDir: "/s/rv" },
];
const read = () => "---\nname: x\n---\nBODY";

test("suggest: /skill: auto-opens mid-line, bare / needs Tab", () => {
  assert.equal(suggestSkills(skills, 0, "fix /skill:pd", false)?.items[0]?.value, "/skill:pdf");
  assert.equal(suggestSkills(skills, 0, "fix /pd", false), null);
  assert.equal(suggestSkills(skills, 0, "fix /pd", true)?.prefix, "/pd");
  assert.equal(suggestSkills(skills, 2, "/skill:rev", false)?.items[0]?.label, "review-voice");
});

test("suggest: leaves core slash commands and paths alone", () => {
  assert.equal(suggestSkills(skills, 0, "/skill:pd", false), null);
  assert.equal(suggestSkills(skills, 0, "cat /usr/bi", true), null);
  assert.equal(suggestSkills(skills, 0, "cat /tmp", true), null);
});

test("expand: mid-message skills get blocks, unknown and leading-only are untouched", () => {
  const out = expandInlineSkills("please /skill:pdf and /skill:nope, /skill:pdf", skills, read);
  assert.equal(out.match(/<skill name="pdf"/g)?.length, 1);
  assert.ok(out.includes("References are relative to /s/pdf.\n\nBODY\n</skill>"));
  assert.ok(out.endsWith("please /skill:pdf and /skill:nope, /skill:pdf"));
  assert.equal(expandInlineSkills("/skill:pdf do it", skills, read), "/skill:pdf do it");
  assert.equal(expandInlineSkills("a/skill:pdf", skills, read), "a/skill:pdf");
  assert.ok(expandInlineSkills("/skill:pdf then /skill:review-voice", skills, read).includes('name="review-voice"'));
});
