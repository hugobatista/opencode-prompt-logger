# opencode-prompt-logger 📝

[![GitHub Tag](https://img.shields.io/github/v/tag/hugobatista/opencode-prompt-logger?logo=github&label=latest)](https://go.hugobatista.com/gh/opencode-prompt-logger/releases)
[![Lint](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-prompt-logger/lint.yml?label=Lint)](https://go.hugobatista.com/gh/opencode-prompt-logger/actions/workflows/lint.yml)
[![Test](https://img.shields.io/github/actions/workflow/status/hugobatista/opencode-prompt-logger/test.yml?label=Test)](https://go.hugobatista.com/gh/opencode-prompt-logger/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/opencode-prompt-logger.svg)](https://www.npmjs.com/package/opencode-prompt-logger)

OpenCode plugin. Appends what is actually sent to the model — the fully
assembled system prompt and the raw provider request body — to an NDJSON file,
one line per model request. Nothing is rewritten; the plugin only observes.

> **Requires OpenCode V2.** OpenCode V2 changed the plugin API; V1 plugin
> implementations do not run in V2. This plugin is built against
> `@opencode/plugin` V2 only.

## Motivation

The session transcript shows your message and the model's answer. It does not
show what the model actually received:

- The **assembled system prompt** is the agent prompt plus the environment
  block, every `AGENTS.md` in scope, and the descriptions of the loaded skills.
  It changes whenever an instruction file changes, and it is easy to write a
  config that silently never reaches the model.
- The **raw request body** is the provider-level payload after OpenCode lowers
  it to the selected protocol. It carries the real tool schemas, the resolved
  model parameters, and the message layout the API sees.

Both matter when you are debugging a prompt, estimating context size, or
diffing two runs that behaved differently. This plugin records both, per model
request, in a file you can search with `jq`.

## What it does

- Registers `ctx.session.hook(kind, …)` for `context` (the agent loop,
  including tool-driven continuations), `compaction`, `generate`, and `title`,
  and writes one `assembled` record per request with `system`, `messages`,
  `model`, `sessionID`, and the names of the available `tools`.
- Registers `ctx.session.hook("http.request", …)` and writes one `http` record
  with the request `url` and the raw body. Bodies are one-shot streams, so the
  plugin reads a clone and leaves the original untouched.
- Creates missing parent directories for the output file.
- Swallows write failures: a full disk or a bad path is reported on stderr and
  never breaks a model request.

## Requirements

- **OpenCode V2.** The V2 release changed the plugin API; V1 plugin
  implementations do not run in V2.
- Nothing else at runtime. [Bun](https://bun.sh) is needed to develop the
  plugin, not to use it.

## Install

```sh
opencode plugin add opencode-prompt-logger
```

Or add the package to `opencode.json(c)` (project or
`~/.config/opencode/opencode.jsonc`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-prompt-logger"]
}
```

With no options the plugin writes to `/tmp/opencode/prompts.ndjson` and logs
the HTTP body of every request.

> This is a **server** plugin. Configure it in `opencode.json(c)`. Terminal-only
> plugins belong in `cli.json`.

## Configuration

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-prompt-logger",
      "options": {
        "file": "/home/me/.local/state/opencode/prompts.ndjson",
        "http": true
      }
    }
  ]
}
```

| Option  | Type    | Default                       | Description                                                                   |
| ------- | ------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `file`  | string  | `/tmp/opencode/prompts.ndjson` | NDJSON destination. Parent directories are created on first write.            |
| `http`  | boolean | `true`                        | Log the raw provider body. `false` keeps only the `assembled` records.        |

## NDJSON format

Every line is one JSON object with an `at` ISO-8601 timestamp, a `type`, and
the `kind` of the model request: `context`, `compaction`, `generate`, or
`title`.

### `assembled`

| Field       | Notes                                                        |
| ----------- | ------------------------------------------------------------ |
| `type`      | `"assembled"`                                                |
| `kind`      | `context`, `compaction`, `generate`, or `title`              |
| `sessionID` | Session that issued the request                              |
| `agent`     | Absent on `title` requests                                   |
| `model`     | `{ providerID, id, variant? }`                               |
| `system`    | The assembled system prompt parts, in order                  |
| `messages`  | The message array sent to the model                          |
| `tools`     | Names of the available tools; `[]` on `title` requests       |

### `http`

| Field       | Notes                                                        |
| ----------- | ------------------------------------------------------------ |
| `type`      | `"http"`                                                     |
| `kind`      | `primary`, `compaction`, `title`, or `generate`              |
| `sessionID` | Session that issued the request                              |
| `agent`     | Agent that issued the request                                |
| `model`     | `{ providerID, id, variant? }`                               |
| `url`       | Request URL                                                  |
| `body`      | Raw body as text; `unreadable: …` if the clone could not be read |

### Examples

Records per request kind:

```sh
jq -r '.kind' /tmp/opencode/prompts.ndjson | sort | uniq -c
```

The system prompt of the last agent-loop request:

```sh
jq -r 'select(.type == "assembled" and .kind == "context") | .system[]?.text' \
  /tmp/opencode/prompts.ndjson | tail -1
```

Raw bodies, one per line:

```sh
jq -r 'select(.type == "http") | .body' /tmp/opencode/prompts.ndjson
```

Requests issued by one session:

```sh
jq -c 'select(.sessionID == "ses_…") | {at, type, kind, model}' \
  /tmp/opencode/prompts.ndjson
```

> **The log is sensitive.** It contains your full prompts, your instruction
> files, and the raw request bodies. The default destination lives in `/tmp`,
> which is readable by every user on a multi-user machine, and the file is
> appended forever. Point `file` at a private directory and clear it when you
> are done.

## Verify

After configuring, restart OpenCode and check:

1. `opencode plugin list` includes `prompt-logger`.
2. Send one prompt to the agent.
3. `tail -1 /tmp/opencode/prompts.ndjson | jq .type` prints `assembled` (and
   `http` when the HTTP hook ran).
4. With `"http": false`, no `type: "http"` record appears.

## Uninstall

```sh
opencode plugin remove opencode-prompt-logger
```

Or remove the entry from `plugins` in your `opencode.json(c)` and restart
OpenCode.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # unit (record building, writer) + functional (mocked plugin context)
bun run build       # dist/index.js + dist/index.d.ts (npm entrypoint)
```

- `src/core.ts` — pure logic: option resolution, record building, and the
  append-only NDJSON writer. No OpenCode imports. Fully unit-tested.
- `src/index.ts` — the plugin (`id: "prompt-logger"`), a
  `Plugin.define({ id, setup })` from `@opencode/plugin`. It registers the four
  model-request hooks plus `http.request` and delegates to `core`.
- `scripts/build.ts` — bundles `src/index.ts` to `dist/index.js` with
  `@opencode/plugin` external, then emits declarations with `tsc`.

To run the plugin straight from a checkout, point `plugins` at the source
instead of the npm package:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-prompt-logger/src",
      "options": { "file": "/tmp/opencode/prompts.ndjson" }
    }
  ]
}
```

## Pre-release checklist

```sh
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

Inspect the pack list (`dist/`, `README.md`, `LICENSE` only). Scan for secrets
before `npm publish` — the test fixtures and this README must not contain real
prompts.

## License

MIT — see [LICENSE](./LICENSE). Author: Hugo Batista
(<https://github.com/hugobatista>).
