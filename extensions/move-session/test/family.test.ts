import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { moveSessionFamily, type FamilyMoveOptions } from "../family.ts";

let root: string;
let options: FamilyMoveOptions;
let launched: string[];
let trashed: string[];

function session(bucket: string, id: string, parentSession?: string): string {
    const file = join(root, "sessions", `--${bucket}--`, `original_${id}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({
        type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z",
        cwd: `/work/${bucket}`, parentSession, customMetadata: "保存🪶".repeat(3000),
    }) + '\n{"type":"custom","data":"history 🪶"}\n');
    return file;
}

function read(file: string) {
    const bytes = readFileSync(file);
    const newline = bytes.indexOf(10);
    const header: SessionHeader = JSON.parse(bytes.subarray(0, newline).toString());
    return { header, body: bytes.subarray(newline + 1) };
}

function destinations(): string[] {
    if (!existsSync(options.targetSessionDir)) return [];
    return readdirSync(options.targetSessionDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(options.targetSessionDir, name));
}

beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "pi-move-family-test-")));
    mkdirSync(join(root, "trash"));
    launched = [];
    trashed = [];
    options = {
        sourceSessionFile: session("one", "selected"),
        sessionsRoot: join(root, "sessions"),
        targetCwd: join(root, "new workspace"),
        targetSessionDir: join(root, "sessions", "--target--"),
        confirm: async () => true,
        launch: async (file) => { launched.push(file); },
        trash: async (paths) => {
            for (const path of paths) {
                renameSync(path, join(root, "trash", `${trashed.length}_${basename(path)}`));
                trashed.push(path);
            }
        },
    };
    mkdirSync(options.targetCwd);
});

afterEach(() => {
    execFileSync("trash", [root]);
});

describe("family moves using real session files", () => {
    test("moves ancestors, siblings, cousins and deep descendants across buckets, preserving history and IDs", async () => {
        const ancestor = session("one", "ancestor");
        const parent = session("one", "parent", ancestor);
        const selected = session("two", "selected", parent);
        const sibling = session("three", "sibling", parent);
        const aunt = session("one", "aunt", ancestor);
        const cousin = session("three", "cousin", aunt);
        const child = session("two", "child", selected);
        const grandchild = session("two", "grandchild", child);
        const greatGrandchild = session("two", "great-grandchild", grandchild);
        const unrelated = session("three", "unrelated");
        const originals = [ancestor, parent, selected, sibling, aunt, cousin, child, grandchild, greatGrandchild];
        const before = new Map(originals.map((file) => [file, read(file)]));
        options.sourceSessionFile = selected;
        options.confirm = async (files) => {
            assert.deepEqual(new Set(files), new Set(originals));
            assert.deepEqual(destinations(), []);
            return true;
        };
        options.launch = async (file) => {
            assert.equal(originals.every(existsSync), true);
            assert.equal(destinations().length, originals.length);
            launched.push(file);
        };

        assert.equal(await moveSessionFamily(options), true);

        const moved = new Map(destinations().map((file) => [read(file).header.id, file]));
        assert.deepEqual(launched, [moved.get("selected")!]);
        assert.equal(existsSync(unrelated), true);
        for (const original of originals) {
            assert.equal(existsSync(original), false);
            const old = before.get(original)!;
            const next = read(moved.get(old.header.id)!);
            assert.deepEqual(next.body, old.body);
            const expectedHeader = { ...old.header, cwd: options.targetCwd };
            if (old.header.parentSession !== undefined) {
                expectedHeader.parentSession = moved.get(before.get(old.header.parentSession)!.header.id)!;
            }
            assert.deepEqual(next.header, expectedHeader);
        }
    });

    test("cancellation leaves all files untouched", async () => {
        const original = readFileSync(options.sourceSessionFile);
        options.confirm = async () => false;
        assert.equal(await moveSessionFamily(options), false);
        assert.deepEqual(readFileSync(options.sourceSessionFile), original);
        assert.deepEqual(destinations(), []);
        assert.deepEqual(launched, []);
        assert.deepEqual(trashed, []);
    });

    test("canonicalizes symlink paths and follows parents outside the standard store", async () => {
        const external = join(root, "custom");
        mkdirSync(external);
        const parent = session("one", "parent");
        const externalParent = join(external, basename(parent));
        renameSync(parent, externalParent);
        const alias = join(root, "alias");
        symlinkSync(external, alias);
        options.sourceSessionFile = session("one", "selected", join(alias, basename(parent)));
        await moveSessionFamily(options);
        const moved = destinations().map(read);
        assert.deepEqual(moved.map(({ header }) => header.id).sort(), ["parent", "selected"]);
        assert.equal(existsSync(externalParent), false);
    });

    test("can move a family member that is already in the target bucket", async () => {
        const parent = session("target", "parent");
        options.sourceSessionFile = session("one", "selected", parent);
        await moveSessionFamily(options);
        assert.equal(existsSync(parent), false);
        assert.equal(destinations().length, 2);
    });

    test("missing parents and cycles abort without removing sessions", async () => {
        options.sourceSessionFile = session("one", "selected", join(root, "missing.jsonl"));
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes("parent"));
        const parent = session("one", "parent", options.sourceSessionFile);
        session("one", "selected", parent);
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes("cycle"));
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.equal(existsSync(parent), true);
        assert.deepEqual(trashed, []);
        assert.deepEqual(launched, []);
    });

    test("confirmation only describes the family and leaves unrelated invalid files untouched", async () => {
        const unrelated = session("other", "unrelated");
        const broken = join(dirname(options.sourceSessionFile), "broken.jsonl");
        writeFileSync(unrelated, '{"type":"custom_message","id":"orphan"}\n');
        writeFileSync(broken, "not JSON\n");
        const invalidRoot = session("other", "invalid-root");
        writeFileSync(invalidRoot, '{"type":"session","id":12}\n');
        const child = session("one", "child", options.sourceSessionFile);
        options.confirm = async (...confirmationPaths) => {
            const [sources] = confirmationPaths;
            assert.deepEqual(new Set(sources), new Set([options.sourceSessionFile, child]));
            assert.ok(!confirmationPaths.flat().includes(unrelated));
            assert.ok(!confirmationPaths.flat().includes(broken));
            return true;
        };
        await moveSessionFamily(options);
        assert.equal(destinations().length, 2);
        assert.equal(readFileSync(unrelated, "utf8"), '{"type":"custom_message","id":"orphan"}\n');
        assert.equal(readFileSync(broken, "utf8"), "not JSON\n");
        assert.equal(readFileSync(invalidRoot, "utf8"), '{"type":"session","id":12}\n');
    });

    test("invalid metadata on a linked descendant still aborts the move", async () => {
        const child = session("other", "child", options.sourceSessionFile);
        writeFileSync(child, JSON.stringify({type: "session", id: 12, parentSession: options.sourceSessionFile}) + "\n");
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes(child));
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.deepEqual(trashed, []);
        assert.deepEqual(launched, []);
    });

    test("a referenced ancestor without a header still aborts the move", async () => {
        const parent = session("other", "parent");
        options.sourceSessionFile = session("one", "selected", parent);
        writeFileSync(parent, '{"type":"message","id":"orphan"}\n');
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes(parent));
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.deepEqual(trashed, []);
        assert.deepEqual(launched, []);
    });

    test("ignores other applications' stores alongside Pi working-directory folders", async () => {
        const foreignStore = join(options.sessionsRoot, "claude-code");
        mkdirSync(foreignStore);
        writeFileSync(join(foreignStore, "conversation.jsonl"), '{"type":"user","message":"foreign format"}\n');
        await moveSessionFamily(options);
        assert.equal(destinations().length, 1);
        assert.equal(existsSync(join(foreignStore, "conversation.jsonl")), true);
    });

    test("a source changed during confirmation aborts before launch", async () => {
        options.confirm = async () => {
            appendFileSync(options.sourceSessionFile, '{"type":"custom","data":"new work"}\n');
            return true;
        };
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes("changed"));
        assert.ok(readFileSync(options.sourceSessionFile, "utf8").includes("new work"));
        assert.deepEqual(destinations(), []);
        assert.deepEqual(launched, []);
    });

    test("a new descendant during confirmation requires another confirmation", async () => {
        options.confirm = async () => {
            session("one", "new-child", options.sourceSessionFile);
            return true;
        };
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes("changed"));
        assert.deepEqual(destinations(), []);
        assert.deepEqual(launched, []);
    });

    test("destination conflicts never overwrite existing files", async () => {
        options.confirm = async (_files, targets) => {
            mkdirSync(options.targetSessionDir, { recursive: true });
            writeFileSync(targets[0]!, "existing data");
            return true;
        };
        await assert.rejects(moveSessionFamily(options));
        assert.deepEqual(destinations().map((file) => readFileSync(file, "utf8")), ["existing data"]);
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.deepEqual(launched, []);
    });

    test("failed launch rolls back published copies and retains every original", async () => {
        const child = session("one", "child", options.sourceSessionFile);
        options.launch = async () => { throw new Error("launch failed"); };
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes("launch failed"));
        assert.deepEqual(destinations(), []);
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.equal(existsSync(child), true);
    });

    test("writes during launch keep all originals and report incomplete cleanup", async () => {
        options.launch = async (file) => {
            launched.push(file);
            appendFileSync(options.sourceSessionFile, '{"type":"custom","data":"late work"}\n');
        };
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes("changed"));
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.equal(destinations().length, 1);
        assert.ok(!trashed.includes(options.sourceSessionFile));
    });

    test("partial trash failure retains the complete destination family and reports recovery paths", async () => {
        const child = session("one", "child", options.sourceSessionFile);
        const originalTrash = options.trash;
        options.trash = async (paths) => {
            if (paths.includes(options.sourceSessionFile)) {
                await originalTrash([options.sourceSessionFile]);
                throw new Error("trash failed");
            }
            await originalTrash(paths);
        };
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes(options.targetSessionDir));
        assert.equal(destinations().length, 2);
        assert.equal(existsSync(child), true);
        assert.equal(launched.length, 1);
    });

    test("rollback failures report retained paths and keep originals", async () => {
        options.launch = async () => { throw new Error("launch failed"); };
        options.trash = async () => { throw new Error("trash unavailable"); };
        await assert.rejects(moveSessionFamily(options), (e) => e instanceof Error && e.message.includes(options.targetSessionDir));
        assert.equal(existsSync(options.sourceSessionFile), true);
        assert.equal(destinations().length, 1);
    });
});
