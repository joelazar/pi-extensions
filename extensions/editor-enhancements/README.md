# editor-enhancements

A composite custom editor that combines several `setEditorComponent()`-based UX tweaks in one place so they remain compatible with each other. Copied from [w-winter/dot314](https://github.com/w-winter/dot314/tree/main/extensions/editor-enhancements), with my former `cwd-history` extension merged in.

This extension currently provides:
- prompt history seeded with recent prompts from other sessions in the same cwd
- editor border color follows the thinking level, or bash mode for `!` input
- `@`-triggered file picking for inserting `@path` refs at the cursor
- `alt+v` raw clipboard paste that bypasses Pi's large-paste markers

## Usage

This extension does not add a slash command. Its behavior is integrated directly into the editor.

- Type `@` at token start to open the file picker
- In the file picker, `space` queues or unqueues the highlighted file, or enters the highlighted directory
- In the file picker, `enter` inserts the highlighted item plus any queued selections, while `esc` at the root inserts only queued selections
- In the file picker, `tab` replaces the query with the strongest scoped fuzzy match
- Paths containing spaces are inserted quoted, as `@"dir with spaces/file.md"`
- The file picker's search box uses Pi's shared `Input` editing behavior for word/home/end cursor movement and related text editing shortcuts
- Press `alt+v` to paste clipboard text raw into the editor

## Notes

- Because this extension owns `setEditorComponent()`, any other extension that calls it will replace this editor
