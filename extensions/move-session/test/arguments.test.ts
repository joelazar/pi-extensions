import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
    getMainWorktreeRootFromWorktreeList,
    isMainWorktreeTarget,
    MAIN_WORKTREE_TOKEN,
    normalizeTargetCwd,
} from "../normalize-target-cwd.ts";
import { parseMoveArguments } from "../arguments.ts";

describe("move-session arguments", () => {
    test("parses family moves and retains spaces in the target path", () => {
        assert.deepEqual(parseMoveArguments(" --family /work/my project "), {
            scope: "family", targetCwd: "/work/my project",
        });
        assert.deepEqual(parseMoveArguments("--family $main-worktree"), {
            scope: "family", targetCwd: "$main-worktree",
        });
    });

    test("keeps single-session paths intact", () => {
        assert.deepEqual(parseMoveArguments(" ~/my project "), { scope: "session", targetCwd: "~/my project" });
        assert.deepEqual(parseMoveArguments("./--family"), { scope: "session", targetCwd: "./--family" });
    });

    test("requires a target", () => {
        assert.throws(() => parseMoveArguments(""), (e) => e instanceof Error && e.message.includes("Usage"));
        assert.throws(() => parseMoveArguments("--family"), (e) => e instanceof Error && e.message.includes("Usage"));
    });
});

describe("normalizeTargetCwd", () => {
    test("resolves relative target paths to absolute paths", () => {
        assert.equal(normalizeTargetCwd("../foo", {}, "/tmp/work/project"), "/tmp/work/foo");
    });

    test("expands ~ before resolving the target path", () => {
        assert.equal(normalizeTargetCwd("~/code", { HOME: "/Users/tester" }, "/tmp/work/project"), 
            "/Users/tester/code",
        );
    });

    test("identifies the main worktree token", () => {
        assert.equal(isMainWorktreeTarget(MAIN_WORKTREE_TOKEN), true);
        assert.equal(isMainWorktreeTarget("$root"), false);
    });

    test("reads the main worktree root from the first worktree list entry", () => {
        const worktreeListOutput = [
            "worktree /Users/tester/project",
            "HEAD 1234567890abcdef",
            "branch refs/heads/main",
            "",
            "worktree /Users/tester/project-feature",
            "HEAD abcdef1234567890",
            "branch refs/heads/feature",
            "",
        ].join("\n");

        assert.equal(getMainWorktreeRootFromWorktreeList(worktreeListOutput), "/Users/tester/project");
    });

    test("rejects bare repositories without a main worktree", () => {
        assert.throws(() => getMainWorktreeRootFromWorktreeList("worktree /Users/tester/project.git\nbare\n"), (e) => e instanceof Error && e.message.includes(
            "Cannot determine main git worktree",
        ));
    });
});
