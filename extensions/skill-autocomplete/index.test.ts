import assert from "node:assert/strict";
import { test } from "node:test";
import { expandInlineSkills, suggestSkills, type SkillEntry } from "./index.ts";

const skills: SkillEntry[] = [
  { name: "pdf", description: "PDF tools", filePath: "/s/pdf/SKILL.md", baseDir: "/s/pdf" },
  { name: "review-voice", description: "Review comments", filePath: "/s/rv/SKILL.md", baseDir: "/s/rv" },
];
const read = () => "---\nname: x\n---\nBODY";
const expand = (text: string) => expandInlineSkills(text, skills, read);

test("suggest: /skill: auto-opens mid-line, bare / needs Tab", () => {
  assert.equal(suggestSkills(skills, 0, "fix /skill:pd", false)?.items[0]?.value, "/skill:pdf");
  assert.equal(suggestSkills(skills, 0, "fix /pd", false), null);
  assert.equal(suggestSkills(skills, 0, "fix /pd", true)?.prefix, "/pd");
  assert.equal(suggestSkills(skills, 2, "/skill:rev", false)?.items[0]?.label, "review-voice");
});

test("suggest: /skills: typo completes to /skill:", () => {
  const s = suggestSkills(skills, 0, "fix /skills:pd", false);
  assert.equal(s?.prefix, "/skills:pd");
  assert.equal(s?.items[0]?.value, "/skill:pdf");
});

test("suggest: leaves core slash commands and paths alone", () => {
  assert.equal(suggestSkills(skills, 0, "/skill:pd", false), null);
  assert.equal(suggestSkills(skills, 0, "cat /usr/bi", true), null);
  assert.equal(suggestSkills(skills, 0, "cat /tmp", true), null);
});

test("expand: mid-message skills get blocks, leading-only is untouched", () => {
  const out = expand("please /skill:pdf and /skill:nope, /skill:pdf");
  assert.equal(out.text.match(/<skill name="pdf"/g)?.length, 1);
  assert.ok(out.text.includes("References are relative to /s/pdf.\n\nBODY\n</skill>"));
  assert.ok(out.text.endsWith("please /skill:pdf and /skill:nope, /skill:pdf"));
  assert.deepEqual(out.unknown, ["nope"]);
  assert.equal(expand("/skill:pdf do it").text, "/skill:pdf do it");
  assert.equal(expand("a/skill:pdf").text, "a/skill:pdf");
  assert.ok(expand("/skill:pdf then /skill:review-voice").text.includes('name="review-voice"'));
});

test("expand: /skills: typo expands, unknown names are reported", () => {
  assert.ok(expand("work on CNS-1 /skills:pdf").text.startsWith('<skill name="pdf"'));
  assert.deepEqual(expand("work on CNS-1 /skills:grilling"), { text: "work on CNS-1 /skills:grilling", unknown: ["grilling"] });
  assert.deepEqual(expand("/skill:nope").unknown, ["nope"]);
});
