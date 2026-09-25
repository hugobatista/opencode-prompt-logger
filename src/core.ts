import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Options = {
  /** NDJSON destination for captured prompts. */
  file?: string
  /** Log the raw HTTP body of every model request. */
  http?: boolean
  /** Turn logging off: no hooks, no output file. */
  enabled?: boolean
  /**
   * Rotate the log at this many bytes, keeping the previous copy as
   * `<file>.1`. It is a rotation point, not a hard cap: with a log and its
   * backup the plugin uses up to about twice this value. `false` keeps a
   * single growing file.
   */
  rotateBytes?: number | false
}

/**
 * NDJSON destination used when no `file` option is configured: the per-user
 * state directory of the current OS, never a shared temp directory.
 *
 * - Windows: `%LOCALAPPDATA%\opencode\prompts.ndjson`
 * - macOS: `~/Library/Application Support/opencode/prompts.ndjson`
 * - Linux/other: `$XDG_STATE_HOME/opencode/prompts.ndjson`, falling back to
 *   `~/.local/state/opencode/prompts.ndjson`
 *
 * Pure by design so every OS can be asserted from any machine.
 */
export function defaultFile(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  const name = join("opencode", "prompts.ndjson")
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), name)
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", name)
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), name)
}

/** Rotation point used when no `rotateBytes` option is configured: 256 MiB. */
export const DEFAULT_ROTATE_BYTES = 256 * 1024 * 1024

/** Model request kinds captured through one hook each. */
export const CONTEXT_KINDS = ["context", "compaction", "generate", "title"] as const

export type ContextKind = (typeof CONTEXT_KINDS)[number]

export type LogRecord = Record<string, unknown>

/**
 * Structural view of the `context`, `compaction`, `generate` and `title` hook
 * events. `agent` and `tools` are only present on the kinds that carry them
 * (`title` has neither), so every field accepts the shape of the event it
 * actually receives.
 */
export type AssembledEvent = {
  readonly sessionID: string
  readonly model?: unknown
  readonly system?: unknown
  readonly messages?: unknown
  readonly agent?: unknown
  readonly tools?: Record<string, unknown>
}

/** Structural view of the `http.request` hook event. */
export type HttpEvent = {
  readonly sessionID: string
  readonly agent: unknown
  readonly model: unknown
  readonly kind: string
  readonly request: Request
}

export function resolveFile(options: Options): string {
  return options.file ?? defaultFile()
}

export function isEnabled(options: Options): boolean {
  return options.enabled !== false
}

export function shouldLogHttp(options: Options): boolean {
  return options.http !== false
}

/** Rotation point in bytes. `0` means one file that grows without a limit. */
export function resolveRotateBytes(options: Options): number {
  const value = options.rotateBytes
  if (value === false) return 0
  if (value === undefined) return DEFAULT_ROTATE_BYTES
  return value > 0 ? Math.floor(value) : 0
}

function existingSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

export type Write = (record: LogRecord) => void

/**
 * Append one NDJSON line per record, rotating to `<file>.1` once the file
 * passes `rotateBytes`. A failed write or rotation is reported on stderr and
 * swallowed: a logger must never break a model request.
 */
export function createWriter(file: string, rotateBytes: number = DEFAULT_ROTATE_BYTES): Write {
  // The log holds unredacted prompts: private to the user where POSIX allows.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const backup = `${file}.1`
  let bytes = existingSize(file)

  return (record) => {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n"
      const size = Buffer.byteLength(line, "utf8")

      if (rotateBytes > 0 && bytes > 0 && bytes + size > rotateBytes) {
        try {
          // One backup: the previous copy is replaced on every rotation.
          renameSync(file, backup)
          bytes = 0
        } catch (error) {
          console.error(`prompt-logger: rotation failed: ${String(error)}`)
        }
      }

      appendFileSync(file, line)
      bytes += size
    } catch (error) {
      console.error(`prompt-logger: ${String(error)}`)
    }
  }
}

export function assembledRecord(kind: ContextKind, event: AssembledEvent): LogRecord {
  return {
    type: "assembled",
    kind,
    sessionID: event.sessionID,
    agent: event.agent,
    model: event.model,
    system: event.system,
    messages: event.messages,
    tools: event.tools ? Object.keys(event.tools) : [],
  }
}

export async function httpRecord(event: HttpEvent): Promise<LogRecord> {
  let body: string | undefined
  try {
    // Bodies are one-shot streams; clone before reading.
    body = await event.request.clone().text()
  } catch (error) {
    body = `unreadable: ${String(error)}`
  }
  return {
    type: "http",
    kind: event.kind,
    sessionID: event.sessionID,
    agent: event.agent,
    model: event.model,
    url: event.request.url,
    body,
  }
}
