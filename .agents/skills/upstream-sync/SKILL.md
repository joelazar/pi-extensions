---
name: upstream-sync
description: Check extensions in this repo against the upstream code they were copied from and propose changes worth porting. Use when Joe asks to check, sync, or compare extensions with upstream.
---

# upstream-sync

Tracked extensions have a first-line header pinning the upstream file or directory at the commit last synced:

```
// Source: https://github.com/<owner>/<repo>/blob/<sha>/<path>
// Source: https://github.com/<owner>/<repo>/tree/<sha>/<dir>
```

Upstream clones live at `$(git config --global gj.root)/github.com/<owner>/<repo>` and are cloned with `gj get <owner>/<repo>`.

## Steps

1. Run `.agents/skills/upstream-sync/status.sh [ext...]`. It fetches each upstream and prints, per extension, `up to date`, `removed upstream`, or the new commits plus the exact `git log -p` command for them.
2. For each extension with new commits, run the printed `git log -p` command and read the local extension files.
3. Classify every upstream change into one of:
   - **port**: a bug fix or feature that applies to the local code
   - **skip**: irrelevant here, e.g. touches code Joe removed, only reformats, or changes packaging/docs he does not keep
   - **conflict**: overlaps a local change; describe both sides
4. Present a table per extension: commit, one-line summary, verdict, one-line reason. Rank ports first. Do not edit code yet.
5. After Joe picks what to port, apply it in the local style. Local conventions win over upstream ones (no comments, no backwards compatibility, dead code deleted).
6. Bump `<sha>` in the header to the upstream `origin/HEAD` commit you reviewed up to, even if nothing was ported, so the next run only shows newer commits.
7. For `removed upstream`, tell Joe and ask whether to keep tracking; if not, replace the header with `// Source: https://github.com/<owner>/<repo>` (no sha, no longer tracked).

## Adding a new tracked extension

Put the `// Source:` permalink with the upstream commit it was copied from on line 1 of the extension's `index.ts` (or `src/index.ts`).
