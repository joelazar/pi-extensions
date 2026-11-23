# web-tools

Pi extension that registers two public-web tools:

- `webfetch` — fetch one public URL as markdown, text, html, or an inline raster image, or summarize it (Kagi for pages, the local `summarize` CLI for YouTube)
- `websearch` — search the public web through the local [kagi-cli](https://github.com/kagisearch) binary

`websearch` and page summaries shell out to the local `kagi` binary; YouTube summaries shell out to the
local [`summarize`](https://github.com/steipete/summarize) CLI. No credentials live in this extension.
The `research` skill in `~/.agents/skills/research` covers multi-source research and raw transcripts.

## Tools

### `webfetch`

Parameters:

- `url` — required
- `format` — optional: `markdown`, `text`, `html`
- `summarize` — optional: `summary`, `keypoints`, `eli5` (summarizes instead of fetching)
- `timeout` — optional timeout in seconds, clamped to `1..120` for fetches and `1..600` for summaries

Current defaults:

- `defaultFormat`: `markdown`
- `timeoutSeconds`: `30`
- `summarizeTimeoutSeconds`: `300`
- `maxResponseBytes`: `5 MB`
- `blockPrivateHosts`: `true`
- `maxRedirects`: `5`
- `fallbackUserAgent`: `opencode`

Behavior notes:

- only `http://` and `https://` URLs are supported
- URL userinfo credentials (`https://user:pass@example.com`) are rejected and redacted in diagnostics
- private/local hosts and IPs are blocked by default
- raster images (`png`, `jpeg`, `gif`, `webp`) are returned inline as images
- HTML is converted to markdown or text when requested
- binary content is rejected
- if a site returns `403` with `cf-mitigated: challenge`, the tool retries with the fallback user agent
- network failures name the error code, e.g. `Request failed (ENOTFOUND: DNS lookup failed, the host does not exist)`
- HTML pages over 5 KB that yield under 200 chars of text get a hint that the page is likely JavaScript-rendered

Summarize notes:

- `summarize` bypasses the HTTP fetch entirely; `format` is ignored and output is always markdown
- YouTube URLs (`youtube.com`, `youtu.be`) run `summarize <url> --json --length xl` (keypoints: `--length long`
  with a bullet-list prompt, eli5: a plain-language prompt). It summarizes the transcript, so the result is
  several KB, not a short blurb. Videos without a transcript fail with `No transcript available for this video`
- other URLs run `kagi summarize --subscriber --error-format json --summary-type <type> --url <url>`, so this
  also works on JS-heavy or paywalled articles. HTML in the response is converted to markdown

### `websearch`

Parameters:

- `query` — required
- `maxResults` — optional, clamped to `1..20`
- `recency` — optional: `any`, `day`, `week`, `month`, `year`

Current defaults:

- `timeoutSeconds`: `60`
- `defaultMaxResults`: `8`
- `defaultRecency`: `any`

Behavior notes:

- runs `kagi search --format json --error-format json --no-color --limit <n> [--time <recency>] -- <query>`
- the child process is spawned without a shell, with `cwd` set to the home directory so kagi-cli finds `~/.kagi.toml`
- `recency` other than `any` is forwarded as `--time`
- related-search entries (`t != 0`) and non-HTTP(S) URLs are dropped
- snippets are whitespace-collapsed and the trailing `Summarize` affordance is stripped
- CLI output is limited to `1 MB`
- on non-zero exit, the `message` field of the CLI's JSON error is surfaced as the tool error

Requirements:

- `kagi` on `PATH` with credentials (`KAGI_SESSION_TOKEN` in the environment pi starts from, or `kagi auth`)
- `summarize` on `PATH` for YouTube summaries

## Configuration

Defaults are hardcoded in `settings.ts`; per-call parameters override format, summarize, timeout, maxResults and recency.

## Source of truth

- extension entry: `index.ts`
- settings/defaults: `settings.ts`
- fetch Pi adapter: `webfetch.ts`
- fetch service: `fetch-page.ts`
- public web adapter: `network.ts`
- search Pi adapter: `websearch.ts`
- search service: `search-web.ts`
- Kagi search adapter: `providers/kagi.ts`
- Kagi summarizer adapter: `providers/kagi-summarize.ts`
- YouTube summarizer adapter: `providers/summarize-cli.ts`
- Kagi result parser: `providers/kagi-results.ts`
- command runner port: `providers/command.ts`
- tool output projection: `tool-output.ts`
