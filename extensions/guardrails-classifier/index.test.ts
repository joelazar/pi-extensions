import assert from "node:assert/strict";
import { test } from "node:test";
import { decide } from "./index.ts";

const outcome = (auth: string, p: number, impact: number) => ({
	stopReason: "stop",
	answers: {
		context_sufficiency: { type: "bool" as const, probability: 0.95 },
		authorization: { type: "choice" as const, choice: auth, probabilities: { [auth]: p } },
		impact: { type: "score" as const, score: impact, confidence: 0.9 },
	},
});

test("in-scope low-impact actions are allowed", () => {
	assert.equal(decide(outcome("in_scope", 0.9, 1), { hasTaskContext: true }).verdict, "allow");
});

test("destructive or unclear actions still prompt", () => {
	assert.equal(decide(outcome("in_scope", 0.9, 3), { hasTaskContext: true }).verdict, "ask");
	assert.equal(decide(outcome("unclear", 0.9, 1), { hasTaskContext: true }).verdict, "ask");
	assert.equal(decide(outcome("in_scope", 0.9, 1), { hasTaskContext: false }).verdict, "ask");
});

test("confident out-of-scope impactful actions are blocked", () => {
	assert.equal(decide(outcome("out_of_scope", 0.9, 3), { hasTaskContext: true }).verdict, "block");
});

test("API errors escalate to the prompt", () => {
	assert.equal(decide({ stopReason: "error", errorMessage: "401" }, { hasTaskContext: true }).verdict, "ask");
});
