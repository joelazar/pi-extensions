# pi-extensions

My personal collection of extensions for the [pi coding agent](https://pi.dev). This is not a curated product, it is the pile of things I actually use every day, kept in one repo so `pi install` needs a single entry in my settings.

Extensions that turned out to be generally useful get their own repo and go up on [pi.dev/packages](https://pi.dev/packages) instead:

- [pi-tuicr](https://github.com/joelazar/pi-tuicr)
- [pi-lazygit](https://github.com/joelazar/pi-lazygit)
- [pi-copy-block](https://github.com/joelazar/pi-copy-block)

## Install

```bash
git clone https://github.com/joelazar/pi-extensions.git
cd pi-extensions
npm install
pi install "$PWD"
```

`npm install` matters: `web-tools` and `sandbox` have real runtime dependencies, and pi does not install them for you when a package comes from a local path.

## What's in here

| Extension         | Trigger                       | What it does                                                                           |
| ----------------- | ----------------------------- | -------------------------------------------------------------------------------------- |
| `anthropic-extra` | provider `anthropic-extra`    | A second Anthropic OAuth provider, so two Claude subscriptions can coexist             |
| `btw`             | `/btw`                        | Side-chat popover for a quick question that shouldn't derail the main thread           |
| `commit`          | `/commit`, `/atomic-commit`   | Writes commit messages that match the repo's existing style                            |
| `context`         | `/context`                    | Shows what is loaded in the session: extensions, skills, prompts, MCP servers          |
| `cwd-history`     | prompt history                | Seeds editor history with prompts from other sessions in the same directory            |
| `export-md`       | `/md`, `ctrl+shift+m`         | Renders the session to Markdown and opens it                                           |
| `footer`          | TUI footer                    | Two-line footer: cwd, model, context/cost/tok-s, branch and changed files               |
| `pr-create`       | `/pr-create`                  | Front-end for my `pr-create` script using pi's dialogs instead of gum                  |
| `rtk`             | bash rewriting                | Rewrites bash calls through `rtk` to cut token usage on large outputs                  |
| `sandbox`         | `/sandbox`, `--sandbox`       | Routes built-in tools into a Gondolin micro-VM with `cwd` mounted at `/workspace`      |
| `save-md`         | `/save-md`                    | Saves the latest assistant response as a Markdown file                                 |
| `skill-toggle`    | `/toggle-skills`              | Enables and disables skills from a picker instead of editing frontmatter               |
| `spawn`           | `/spawn`                      | Opens a new pi session in a Ghostty tab or split                                       |
| `split-fork`      | `/split-fork`                 | Forks the current session into a new tab or split, carrying the history over           |
| `thinking-back`   | `alt+shift+t`                 | Cycles the thinking level backwards, since the built-in binding only goes forward      |
| `web-tools`       | `webfetch`, `websearch` tools | Web search and page fetching through Kagi, with markdown, text, html, and image output |

Some of these started as other people's code. `btw`, `context`, and `split-fork` come from [mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff), and `anthropic-extra` and `sandbox` started from examples in [pi-mono](https://github.com/earendil-works/pi-mono). Each file keeps a `Source:` header pointing at where it came from.

## Layout

The repo is an npm workspace. Extensions with dependencies or tests of their own get a `package.json` under `extensions/<name>/`, and everything else is a bare `index.ts`. The root `package.json` lists every entry point under its `pi` key, which is what pi reads.

```bash
npm run typecheck   # tsc across every workspace that has it
npm test            # node:test across every workspace that has it
```

## License

MIT
