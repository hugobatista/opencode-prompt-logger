import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type Options = {
  /** NDJSON destination for captured prompts. */
  file?: string
  /** Log the raw HTTP body of every model request. */
  http?: boolean
}

/** NDJSON destination used when no `file` option is configured. */
export const DEFAULT_FILE = "/tmp/opencode/prompts.ndjson"

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
  return options.file ?? DEFAULT_FILE
}

export function shouldLogHttp(options: Options): boolean {
  return options.http !== false
}

export type Write = (record: LogRecord) => void

/**
 * Append one NDJSON line per record. A failed write is reported on stderr and
 * swallowed: a logger must never break a model request.
 */
export function createWriter(file: string): Write {
  mkdirSync(dirname(file), { recursive: true })
  return (record) => {
    try {
      appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...record }) + "\n")
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
