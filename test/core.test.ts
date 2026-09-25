import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONTEXT_KINDS,
  DEFAULT_FILE,
  assembledRecord,
  createWriter,
  httpRecord,
  resolveFile,
  shouldLogHttp,
} from "../src/core"

const ROOT = mkdtempSync(join(tmpdir(), "prompt-logger-core-"))

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

function readRecords(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("options", () => {
  test("defaults to the documented destination", () => {
    expect(DEFAULT_FILE).toBe("/tmp/opencode/prompts.ndjson")
    expect(resolveFile({})).toBe(DEFAULT_FILE)
    expect(resolveFile({ http: false })).toBe(DEFAULT_FILE)
  })

  test("honours an explicit file", () => {
    expect(resolveFile({ file: "/var/log/prompts.ndjson" })).toBe("/var/log/prompts.ndjson")
  })

  test("logs HTTP bodies unless explicitly disabled", () => {
    expect(shouldLogHttp({})).toBe(true)
    expect(shouldLogHttp({ http: true })).toBe(true)
    expect(shouldLogHttp({ http: false })).toBe(false)
  })

  test("captures every model request kind", () => {
    expect([...CONTEXT_KINDS]).toEqual(["context", "compaction", "generate", "title"])
  })
})

describe("assembledRecord", () => {
  const event = {
    sessionID: "ses_1",
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
    system: [{ type: "text", text: "You are an agent." }],
    messages: [{ role: "user", parts: [] }],
    tools: { read: { description: "Read a file" }, write: { description: "Write a file" } },
  }

  test("records the assembled prompt for the agent loop", () => {
    const record = assembledRecord("context", event)
    expect(record).toEqual({
      type: "assembled",
      kind: "context",
      sessionID: "ses_1",
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      system: [{ type: "text", text: "You are an agent." }],
      messages: [{ role: "user", parts: [] }],
      tools: ["read", "write"],
    })
  })

  test("keeps the kind of the request it observed", () => {
    expect(assembledRecord("compaction", event).kind).toBe("compaction")
    expect(assembledRecord("generate", event).kind).toBe("generate")
  })

  test("tolerates a title event with no agent and no tools", () => {
    const record = assembledRecord("title", {
      sessionID: "ses_2",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      system: [],
      messages: [],
    })
    expect(record.kind).toBe("title")
    expect(record.agent).toBeUndefined()
    expect(record.tools).toEqual([])
  })
})

describe("httpRecord", () => {
  const base = {
    kind: "primary",
    sessionID: "ses_1",
    agent: "plan",
    model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
  }

  test("reads the body of a cloned request", async () => {
    const request = new Request("https://api.example.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ max_tokens: 100 }),
    })
    const record = await httpRecord({ ...base, request })
    expect(record).toEqual({
      type: "http",
      kind: "primary",
      sessionID: "ses_1",
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      url: "https://api.example.com/v1/messages",
      body: JSON.stringify({ max_tokens: 100 }),
    })
    // The original body is untouched: the plugin only observes.
    await expect(request.clone().text()).resolves.toBe(JSON.stringify({ max_tokens: 100 }))
  })

  test("reports an unreadable body instead of throwing", async () => {
    const request = {
      url: "https://api.example.com/v1/messages",
      clone: () => ({ text: () => Promise.reject(new Error("boom")) }),
    } as unknown as Request
    const record = await httpRecord({ ...base, request })
    expect(record.body).toContain("unreadable:")
    expect(record.body).toContain("boom")
  })
})

describe("createWriter", () => {
  test("appends one JSON line per record and creates the parent directory", () => {
    const file = join(ROOT, "nested", "deeper", "prompts.ndjson")
    const write = createWriter(file)

    write({ type: "assembled", kind: "context" })
    write({ type: "http", kind: "primary" })

    const records = readRecords(file)
    expect(records).toHaveLength(2)
    expect(records[0]?.type).toBe("assembled")
    expect(records[1]?.type).toBe("http")
    for (const record of records) {
      const at = record.at
      expect(typeof at).toBe("string")
      expect(new Date(at as string).toISOString()).toBe(at as string)
    }
  })

  test("never lets a failed write escape", () => {
    const directory = join(ROOT, "not-a-file")
    mkdirSync(directory, { recursive: true })
    const spy = spyOn(console, "error").mockImplementation(() => {})

    try {
      const write = createWriter(directory)
      expect(() => write({ type: "assembled" })).not.toThrow()
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain("prompt-logger:")
    } finally {
      spy.mockRestore()
    }
  })
})
