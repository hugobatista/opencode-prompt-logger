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
- Rotates at `maxBytes` (256 MiB by default), keeping the previous copy as
  `<file>.1`, so a forgotten log cannot fill the disk unbounded.
- Is **enabled by default** after installation, and can be turned off with the
  `enabled` option without uninstalling.
- Swallows write and rotation failures: they are reported on stderr and never
  break a model request.

## Sensitive data

Every record is plain, **unredacted** JSON. A log contains:

- the fully assembled system prompt, including your `AGENTS.md` files,
  environment details, and skill instructions;
- the whole message history, which usually carries file contents, command
  output, and other tool results;
- the raw request body sent to the provider, including the tool schemas;
- session, agent, model, and URL identifiers.

Logging prompts is a **troubleshooting tool**, not a permanent feature. Use it
to audit what actually reaches the context, analyse context and token usage,
debug a prompt, investigate why the model saw (or did not see) something, and
compare two runs. That is what it is for.

Do not leave it running as everyday logging:

- **Regulated or personal data** — if a session handles PII, PHI, secrets, or
  client data, the log reproduces all of it in a single file.
- **Credentials in context** — anything that reached the model (API keys in
  tool output, tokens, private keys) lands in the file, including in
  `<file>.1`.
- **Shared machines** — the default destination lives in `/tmp`, readable by
  every user on the host.
- **Sharing** — never paste the file, a line, or a record into an issue, a
  chat, or a support ticket without redacting it first.

Enable it while you investigate, disable it when you are done, and delete the
file afterwards.

## Disk usage

The log grows fast. Measured on one machine running agent sessions:

| Measurement          | Value                                     |
| -------------------- | ----------------------------------------- |
| Average record       | ~500 KB                                   |
| Largest record       | 676 KB                                    |
| Observed growth      | 12 MB → 46 MB in 6 minutes of one session |

Two things drive that growth:

- Every `assembled` record carries the whole message history, so a record is
  as large as the conversation at that point. Records grow with the session.
- Every model request writes two records: the `assembled` view plus the `http`
  body, which repeats the payload. Roughly 2× per request.

A busy agent therefore writes tens of MB per hour, and a forgotten log fills
the disk in hours to days. A full disk does not only break the log: it breaks
everything else on the host, including OpenCode's own database and logs.

### Rotation

By default the plugin rotates at 256 MiB. The current file is renamed to
`<file>.1` and logging continues in a fresh file; only one backup is kept, so
the plugin never uses much more than twice `maxBytes`.

```jsonc
"options": {
  "maxBytes": 1073741824,  // 1 GiB
  // "maxBytes": false     // never rotate: one file grows until the disk is full
}
```

The limit is approximate: a record is never cut in half, so a file can
overshoot by up to one record (~500 KB).

### Monitor

```sh
ls -lh /tmp/opencode/prompts.ndjson*
wc -l /tmp/opencode/prompts.ndjson
```

### Truncate

Safe to run while OpenCode is up: the plugin only appends.

```sh
# empty the current log and keep the file
truncate -s 0 /tmp/opencode/prompts.ndjson

# free the current log and the rotated backup
rm -f /tmp/opencode/prompts.ndjson /tmp/opencode/prompts.ndjson.1
```

Both files are recreated on the next model request.

### Keep it small

- Set `"enabled": false` when the investigation is over. Cheapest fix, and
  nothing else is written.
- Set `"http": false` to drop the duplicate payload: roughly half the volume.
- Point `file` at a volume with room, not at a small `/tmp`.

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

With no options the plugin is **enabled**, writes to
`/tmp/opencode/prompts.ndjson`, logs the HTTP body of every request, and
rotates at 256 MiB.

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
        "enabled": true,
        "file": "/home/me/.local/state/opencode/prompts.ndjson",
        "http": true,
        "maxBytes": 268435456
      }
    }
  ]
}
```

| Option      | Type             | Default                        | Description                                                                             |
| ----------- | ---------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `enabled`   | boolean          | `true`                         | `false` keeps the plugin installed but idle: no hooks, no file.                          |
| `file`      | string           | `/tmp/opencode/prompts.ndjson` | NDJSON destination. Parent directories are created on first write.                       |
| `http`      | boolean          | `true`                         | Log the raw provider body. `false` keeps only the `assembled` records.                   |
| `maxBytes`  | number or false  | `268435456` (256 MiB)          | Rotate at this size, keeping `<file>.1`. `false` disables rotation.                      |

## Enabling, disabling and uninstalling

### Enable

Enabled is the default: after installing, the plugin starts logging on the
next model request. `enabled: true` is optional and only useful to make the
intent explicit in a shared config.

### Disable

Both ways below need a config reload: `opencode service restart`, or wait for
the config watcher to reload it.

**1. The `enabled` option (recommended).** The plugin stays installed and
loaded but idle: it registers no hooks, creates no file, and writes nothing.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-prompt-logger",
      "options": { "enabled": false }
    }
  ]
}
```

Set `"enabled": true` again (or remove the option) to go back to logging.

**2. The plugin ID in `plugins`.** OpenCode processes `plugins` entries in
order, and an ID prefixed with `-` disables everything registered so far. The
line therefore has to come **after** the package entry:

```jsonc
{
  "plugins": [
    { "package": "opencode-prompt-logger", "options": {} },
    "-prompt-logger"
  ]
}
```

To re-enable, remove the `-prompt-logger` line — or put the package entry
after it, because a later entry for the same ID re-enables the plugin. This
ordering is easy to get wrong: a `-prompt-logger` line left in place silently
keeps the plugin off. Run `opencode plugin list` to see whether it is active.

### Uninstall

```sh
opencode plugin remove opencode-prompt-logger
```

Or remove the package entry from `plugins` in your `opencode.json(c)` and
restart OpenCode. Then delete the log, which the plugin will not touch again:

```sh
rm -f /tmp/opencode/prompts.ndjson /tmp/opencode/prompts.ndjson.1
```

## NDJSON format

Every line is one JSON object with an `at` ISO-8601 timestamp, a `type`, and
the `kind` of the model request: `context`, `compaction`, `generate`, or
`title`. After a rotation, `<file>.1` holds the previous file in the same
format.

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

## Analysing the log with jq

The examples use `/tmp/opencode/prompts.ndjson`; add `.1` to read the rotated
copy too (`cat file.1 file`). Records are one JSON object per line, so `jq -c`
keeps them on a single line — that matters whenever you pipe into `tail`.

### Overview

```sh
# records per type and kind
jq -r '[.type, .kind] | join("/")' /tmp/opencode/prompts.ndjson | sort | uniq -c

# largest records first: type, kind, size in characters
jq -r '[.type, .kind, (tostring | length)] | @tsv' /tmp/opencode/prompts.ndjson |
  sort -k3 -rn | head

# how many requests a session produced
jq -r '[.sessionID, .type] | @tsv' /tmp/opencode/prompts.ndjson | sort | uniq -c
```

### System prompt

```sh
# the system prompt of the last agent-loop request
jq -c 'select(.type == "assembled" and .kind == "context")' /tmp/opencode/prompts.ndjson |
  tail -1 | jq -r '.system[]?.text'

# its size in characters
jq -c 'select(.type == "assembled" and .kind == "context")' /tmp/opencode/prompts.ndjson |
  tail -1 | jq '[.system[]?.text // ""] | join("\n") | length'

# did an instruction file reach the model?
jq -c 'select(.type == "assembled")' /tmp/opencode/prompts.ndjson |
  grep -c 'AGENTS.md'
```

To diff two moments (before and after a config change), extract into files and
compare:

```sh
jq -c 'select(.type == "assembled" and .kind == "context")' /tmp/opencode/prompts.ndjson |
  tail -1 | jq -r '.system[]?.text' > after.txt
diff -u before.txt after.txt
```

### Messages and tools

```sh
# message count of the last agent-loop request
jq -c 'select(.type == "assembled" and .kind == "context")' /tmp/opencode/prompts.ndjson |
  tail -1 | jq '.messages | length'

# roles across the whole log
jq -r '.messages[]?.role // empty' /tmp/opencode/prompts.ndjson | sort | uniq -c

# transcript size per request
jq -r 'select(.type == "assembled") | [.at, (.messages | tostring | length)] | @tsv' \
  /tmp/opencode/prompts.ndjson

# tools offered in the last agent-loop request
jq -c 'select(.type == "assembled" and .kind == "context")' /tmp/opencode/prompts.ndjson |
  tail -1 | jq -r '.tools | join(", ")'

# how the tool set changed over the session
jq -c 'select(.type == "assembled") | { at, tools }' /tmp/opencode/prompts.ndjson | tail -20
```

### Raw HTTP bodies

```sh
# last body sent to the provider, pretty-printed
jq -c 'select(.type == "http")' /tmp/opencode/prompts.ndjson |
  tail -1 | jq -r '.body' | jq .

# requests per endpoint
jq -r 'select(.type == "http") | .url' /tmp/opencode/prompts.ndjson | sort | uniq -c

# which protocol each body was lowered to (chat completions vs responses)
jq -r 'select(.type == "http") | .body' /tmp/opencode/prompts.ndjson |
  jq -r 'if has("messages") then "chat/completions" elif has("input") then "responses" else "unknown" end' |
  sort | uniq -c

# reasoning settings sent to the model
jq -r 'select(.type == "http") | .body' /tmp/opencode/prompts.ndjson |
  jq -r 'if has("reasoning") then (.reasoning | tostring) else empty end' | sort | uniq -c
```

### Sessions, agents, and models

```sh
# lines per session
jq -r '.sessionID' /tmp/opencode/prompts.ndjson | sort | uniq -c | sort -rn | head

# requests per model
jq -r '.model | if . == null then "unknown" else (.providerID + "/" + .id) end' \
  /tmp/opencode/prompts.ndjson | sort | uniq -c

# requests per agent
jq -r '.agent // "unknown"' /tmp/opencode/prompts.ndjson | sort | uniq -c

# timeline of one session
jq -c 'select(.sessionID == "ses_…") | { at, type, kind }' /tmp/opencode/prompts.ndjson

# everything recorded in one hour
jq -c 'select(.at >= "2026-09-25T17:00:00" and .at < "2026-09-25T18:00:00")' \
  /tmp/opencode/prompts.ndjson
```

### Searching and exporting

```sh
# any record mentioning a string, anywhere in the payload
jq -c 'select(tostring | contains("opencode-branch-guard"))' /tmp/opencode/prompts.ndjson

# faster on very large files: search the raw lines first, then parse one line
grep -n 'opencode-branch-guard' /tmp/opencode/prompts.ndjson | head -5

# keep only the assembled records (drops the duplicate payloads)
jq -c 'select(.type == "assembled")' /tmp/opencode/prompts.ndjson > assembled.ndjson

# keep only the most recent 1000 records
tail -1000 /tmp/opencode/prompts.ndjson > recent.ndjson

# records of one session, ready to share after redacting
jq -c 'select(.sessionID == "ses_…")' /tmp/opencode/prompts.ndjson > one-session.ndjson
```

`jq` reads the file line by line, so it stays usable on large logs. For a
first pass over a multi-hundred-MB file, `grep` or `rg` is faster.

## Verify

After configuring, restart OpenCode and check:

1. `opencode plugin list` includes `prompt-logger`.
2. Send one prompt to the agent.
3. `tail -1 /tmp/opencode/prompts.ndjson | jq .type` prints `assembled` (and
   `http` when the HTTP hook ran).
4. With `"http": false`, no `type: "http"` record appears.
5. With `"enabled": false`, no new line appears after another prompt, and no
   output directory is created; `opencode plugin list` still lists the plugin.
6. With a small `"maxBytes"`, a `<file>.1` copy appears once the limit is
   passed, and the current file starts again at one record.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # unit (options, records, writer, rotation) + functional (mocked plugin context)
bun run build       # dist/index.js + dist/index.d.ts (npm entrypoint)
```

- `src/core.ts` — pure logic: option resolution (`enabled`, `file`, `http`,
  `maxBytes`), record building, and the append-only NDJSON writer with
  rotation to `<file>.1`. No OpenCode imports. Fully unit-tested.
- `src/index.ts` — the plugin (`id: "prompt-logger"`), a
  `Plugin.define({ id, setup })` from `@opencode/plugin`. It returns early when
  disabled, otherwise registers the four model-request hooks plus
  `http.request` and delegates to `core`.
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
