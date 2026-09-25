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
- Creates missing parent directories for the output file, with `0700`
  permissions on POSIX, because the log holds unredacted prompts.
- Writes to the per-user state directory of your OS by default — no shared
  temp directory. Windows uses `%LOCALAPPDATA%\opencode\`, macOS
  `~/Library/Application Support/opencode/`, and Linux
  `$XDG_STATE_HOME/opencode/`. Override it with the `file` option.
- Rotates at `rotateBytes` (256 MiB by default), keeping the previous copy as
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
- **Shared machines** — the default destination is a per-user state
  directory, private to your account on Windows and macOS and created with
  `0700` permissions on POSIX. It is still a file on a disk someone else may
  have access to: don't set `file` to a shared or world-readable location.
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
the plugin never uses much more than twice `rotateBytes`.

`rotateBytes` is a rotation point, not a size cap. A file grows past it and is
then renamed, so what bounds the disk is roughly twice the value — the current
file plus the one backup.

```jsonc
"options": {
  "rotateBytes": 1073741824,  // rotate at 1 GiB
  // "rotateBytes": false     // never rotate: one file grows until the disk is full
}
```

The limit is approximate: a record is never cut in half, so a file can
overshoot by up to one record (~500 KB).

### Monitor

Set the log path once; every command below uses it.

```sh
# Linux (default)
export LOG="$HOME/.local/state/opencode/prompts.ndjson"
# macOS (default)
# export LOG="$HOME/Library/Application Support/opencode/prompts.ndjson"
# Windows, Git Bash or WSL (%LOCALAPPDATA% is usually C:\Users\you\AppData\Local)
# export LOG="$LOCALAPPDATA/opencode/prompts.ndjson"
# Override: set LOG to whatever the `file` option says.

ls -lh "$LOG"*      # the current log and its .1 backup
wc -l "$LOG"
```

```powershell
# Windows (PowerShell)
$LOG = "$env:LOCALAPPDATA\opencode\prompts.ndjson"
Get-Item "$LOG*"
(Get-Content $LOG | Measure-Object -Line).Lines
```

### Truncate

Safe to run while OpenCode is up: the plugin only appends.

```sh
# empty the current log and keep the file
truncate -s 0 "$LOG"

# free the current log and the rotated backup
rm -f "$LOG" "$LOG.1"
```

```powershell
# Windows (PowerShell)
Clear-Content $LOG -ErrorAction SilentlyContinue
Remove-Item $LOG, "$LOG.1" -ErrorAction SilentlyContinue
```

Both files are recreated on the next model request.

### Keep it small

- Set `"enabled": false` when the investigation is over. Cheapest fix, and
  nothing else is written.
- Set `"http": false` to drop the duplicate payload: roughly half the volume.
- Point `file` at a volume with room, not at a small or memory-backed one.

## Requirements

- **OpenCode V2.** The V2 release changed the plugin API; V1 plugin
  implementations do not run in V2.
- **Windows, macOS, and Linux.** The default log path follows the state
  directory of your OS; nothing in the plugin is POSIX-specific.
- Nothing else at runtime. [Bun](https://bun.sh) is needed to develop the
  plugin, not to use it. `jq` is only needed for the analysis examples.

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

With no options the plugin is **enabled**, writes to the per-user state
directory of your OS (see the default paths in
[Configuration](#configuration)), logs the HTTP body of every request, and
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
        "file": "/home/me/.local/state/opencode/prompts.ndjson", // Linux default
        "http": true,
        "rotateBytes": 268435456
      }
    }
  ]
}
```

| Option        | Type             | Default               | Description                                                                                                                                    |
| ------------- | ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`     | boolean          | `true`                | `false` keeps the plugin installed but idle: no hooks, no file.                                                                                 |
| `file`        | string           | OS state directory    | NDJSON destination. Parent directories are created on first write with `0700` on POSIX.                                                         |
| `http`        | boolean          | `true`                | Log the raw provider body. `false` keeps only the `assembled` records.                                                                          |
| `rotateBytes` | number or false  | `268435456` (256 MiB) | Rotation point: the file is renamed to `<file>.1` and a fresh one starts, so the disk is bounded at roughly twice this value. `false` never rotates. |

Default paths when `file` is not set:

| OS      | Default log path                                              |
| ------- | ------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\opencode\prompts.ndjson`                      |
| macOS   | `~/Library/Application Support/opencode/prompts.ndjson`       |
| Linux   | `$XDG_STATE_HOME/opencode/prompts.ndjson`, or `~/.local/state/opencode/prompts.ndjson` when `XDG_STATE_HOME` is unset |

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
restart OpenCode. Then delete the log, which the plugin will not touch again
(`rm -f "$LOG" "$LOG.1"` on POSIX, `Remove-Item $LOG, "$LOG.1"` in PowerShell;
see [Truncate](#truncate) for how to set `$LOG`).

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

The examples use `$LOG`, the path you configured — set it as shown in
[Monitor](#monitor). Add `.1` to read the rotated copy too (`cat "$LOG.1" "$LOG"`).
Records are one JSON object per line, so `jq -c` keeps them on a single line —
that matters whenever you pipe into `tail`.

These are POSIX shell examples (Linux, macOS, WSL, or Git Bash on Windows).
On Windows, install `jq` with `winget install jqlang.jq`.

### Overview

```sh
# records per type and kind
jq -r '[.type, .kind] | join("/")' "$LOG" | sort | uniq -c

# largest records first: type, kind, size in characters
jq -r '[.type, .kind, (tostring | length)] | @tsv' "$LOG" |
  sort -k3 -rn | head

# how many requests a session produced
jq -r '[.sessionID, .type] | @tsv' "$LOG" | sort | uniq -c
```

### System prompt

```sh
# the system prompt of the last agent-loop request
jq -c 'select(.type == "assembled" and .kind == "context")' "$LOG" |
  tail -1 | jq -r '.system[]?.text'

# its size in characters
jq -c 'select(.type == "assembled" and .kind == "context")' "$LOG" |
  tail -1 | jq '[.system[]?.text // ""] | join("\n") | length'

# did an instruction file reach the model?
jq -c 'select(.type == "assembled")' "$LOG" |
  grep -c 'AGENTS.md'
```

To diff two moments (before and after a config change), extract into files and
compare:

```sh
jq -c 'select(.type == "assembled" and .kind == "context")' "$LOG" |
  tail -1 | jq -r '.system[]?.text' > after.txt
diff -u before.txt after.txt
```

### Messages and tools

```sh
# message count of the last agent-loop request
jq -c 'select(.type == "assembled" and .kind == "context")' "$LOG" |
  tail -1 | jq '.messages | length'

# roles across the whole log
jq -r '.messages[]?.role // empty' "$LOG" | sort | uniq -c

# transcript size per request
jq -r 'select(.type == "assembled") | [.at, (.messages | tostring | length)] | @tsv' \
  "$LOG"

# tools offered in the last agent-loop request
jq -c 'select(.type == "assembled" and .kind == "context")' "$LOG" |
  tail -1 | jq -r '.tools | join(", ")'

# how the tool set changed over the session
jq -c 'select(.type == "assembled") | { at, tools }' "$LOG" | tail -20
```

### Raw HTTP bodies

```sh
# last body sent to the provider, pretty-printed
jq -c 'select(.type == "http")' "$LOG" |
  tail -1 | jq -r '.body' | jq .

# requests per endpoint
jq -r 'select(.type == "http") | .url' "$LOG" | sort | uniq -c

# which protocol each body was lowered to (chat completions vs responses)
jq -r 'select(.type == "http") | .body' "$LOG" |
  jq -r 'if has("messages") then "chat/completions" elif has("input") then "responses" else "unknown" end' |
  sort | uniq -c

# reasoning settings sent to the model
jq -r 'select(.type == "http") | .body' "$LOG" |
  jq -r 'if has("reasoning") then (.reasoning | tostring) else empty end' | sort | uniq -c
```

### Sessions, agents, and models

```sh
# lines per session
jq -r '.sessionID' "$LOG" | sort | uniq -c | sort -rn | head

# requests per model
jq -r '.model | if . == null then "unknown" else (.providerID + "/" + .id) end' \
  "$LOG" | sort | uniq -c

# requests per agent
jq -r '.agent // "unknown"' "$LOG" | sort | uniq -c

# timeline of one session
jq -c 'select(.sessionID == "ses_…") | { at, type, kind }' "$LOG"

# everything recorded in one hour
jq -c 'select(.at >= "2026-09-25T17:00:00" and .at < "2026-09-25T18:00:00")' \
  "$LOG"
```

### Searching and exporting

```sh
# any record mentioning a string, anywhere in the payload
jq -c 'select(tostring | contains("opencode-branch-guard"))' "$LOG"

# faster on very large files: search the raw lines first, then parse one line
grep -n 'opencode-branch-guard' "$LOG" | head -5

# keep only the assembled records (drops the duplicate payloads)
jq -c 'select(.type == "assembled")' "$LOG" > assembled.ndjson

# keep only the most recent 1000 records
tail -1000 "$LOG" > recent.ndjson

# records of one session, ready to share after redacting
jq -c 'select(.sessionID == "ses_…")' "$LOG" > one-session.ndjson
```

`jq` reads the file line by line, so it stays usable on large logs. For a
first pass over a multi-hundred-MB file, `grep` or `rg` is faster.

## Verify

After configuring, restart OpenCode and check:

1. `opencode plugin list` includes `prompt-logger`.
2. Send one prompt to the agent.
3. With `$LOG` set as in [Monitor](#monitor), `tail -1 "$LOG" | jq .type` prints
   `assembled` (and `http` when the HTTP hook ran).
4. With `"http": false`, no `type: "http"` record appears.
5. With `"enabled": false`, no new line appears after another prompt, and no
   output directory is created; `opencode plugin list` still lists the plugin.
6. With a small `"rotateBytes"`, a `<file>.1` copy appears once the rotation
   point is passed, and the current file starts again at one record.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit, strict
bun test            # unit (options, records, writer, rotation) + functional (mocked plugin context)
bun run build       # dist/index.js + dist/index.d.ts (npm entrypoint)
```

- `src/core.ts` — pure logic: option resolution (`enabled`, `file`,
  `defaultFile()`, `http`, `rotateBytes`), record building, and the append-only
  NDJSON writer with rotation to `<file>.1`. No OpenCode imports, and no
  POSIX-only assumptions: `defaultFile()` takes `env` and `platform` so every
  OS is unit-tested from any machine.
- `src/index.ts` — the plugin (`id: "prompt-logger"`), a
  `Plugin.define({ id, setup })` from `@opencode/plugin`. It returns early when
  disabled, otherwise registers the four model-request hooks plus
  `http.request` and delegates to `core`.
- `scripts/build.ts` — bundles `src/index.ts` to `dist/index.js` with
  `@opencode/plugin` external, then emits declarations by running
  `node_modules/typescript/lib/tsc.js` with the current runtime. Calling the
  entry file directly avoids the `.cmd` shim that `tsc` resolves to on Windows
  and that `spawn` cannot execute.

To run the plugin straight from a checkout, point `plugins` at the source
instead of the npm package:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/opencode-prompt-logger/src",
      "options": { "file": "/home/me/.local/state/opencode/prompts.ndjson" }
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

## Releasing

The first version is published by hand, because npm trusted publishing can only
be configured for a package that already exists:

```sh
npm login
npm publish --access public
```

Then configure the trusted publisher at npmjs.com: package
`opencode-prompt-logger`, repository `hugobatista/opencode-prompt-logger`,
workflow `npm.yml`. Allow the `npm publish` action explicitly — trusted
publisher configurations created after 2026-09-03 default to `npm stage
publish` only.

After that, every release is automatic:

1. Bump `version` in `package.json`, commit, and push.
2. Run `gh workflow run create_draft_release.yml`. It builds `dist/`, pushes a
   `release/vX.Y.Z` branch, and creates a **draft** GitHub release with the
   build assets.
3. Review the draft and publish it. Publishing creates the tag `vX.Y.Z` and
   triggers `npm.yml`, which publishes to npm with provenance over OIDC.

`npm.yml` skips a version that is already on npm, so publishing the release for
a version you published by hand is safe: the workflow reports a skip instead of
failing. Tags come from published releases, and the version badge in this
README reads them; pushing a tag on its own triggers nothing.

## License

MIT — see [LICENSE](./LICENSE). Author: Hugo Batista
(<https://github.com/hugobatista>).
