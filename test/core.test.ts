import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONTEXT_KINDS,
  DEFAULT_ROTATE_BYTES,
  assembledRecord,
  createWriter,
  defaultFile,
  httpRecord,
  isEnabled,
  resolveFile,
  resolveRotateBytes,
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
  test("defaults to the per-user state directory of the OS", () => {
    expect(resolveFile({})).toBe(defaultFile())
    expect(resolveFile({ http: false })).toBe(defaultFile())
    expect(resolveFile({}).endsWith(join("opencode", "prompts.ndjson"))).toBe(true)
    // The log never lands in a shared temp directory, on any OS.
    for (const platform of ["win32", "darwin", "linux"]) {
      expect(defaultFile({}, platform).startsWith(tmpdir())).toBe(false)
    }
  })

  test("resolves the state directory for Windows", () => {
    expect(defaultFile({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, "win32")).toBe(
      join("C:\\Users\\me\\AppData\\Local", "opencode", "prompts.ndjson"),
    )
    // Without LOCALAPPDATA the home fallback still points at AppData\Local.
    expect(defaultFile({}, "win32")).toBe(
      join(homedir(), "AppData", "Local", "opencode", "prompts.ndjson"),
    )
  })

  test("resolves the state directory for macOS", () => {
    expect(defaultFile({}, "darwin")).toBe(
      join(homedir(), "Library", "Application Support", "opencode", "prompts.ndjson"),
    )
  })

  test("resolves the state directory for Linux, honouring XDG_STATE_HOME", () => {
    expect(defaultFile({ XDG_STATE_HOME: "/home/me/.state" }, "linux")).toBe(
      join("/home/me/.state", "opencode", "prompts.ndjson"),
    )
    expect(defaultFile({}, "linux")).toBe(
      join(homedir(), ".local", "state", "opencode", "prompts.ndjson"),
    )
  })

  test("honours an explicit file", () => {
    expect(resolveFile({ file: "/var/log/prompts.ndjson" })).toBe("/var/log/prompts.ndjson")
  })

  test("logs HTTP bodies unless explicitly disabled", () => {
    expect(shouldLogHttp({})).toBe(true)
    expect(shouldLogHttp({ http: true })).toBe(true)
    expect(shouldLogHttp({ http: false })).toBe(false)
  })

  test("is enabled unless explicitly disabled", () => {
    expect(isEnabled({})).toBe(true)
    expect(isEnabled({ file: "/tmp/x.ndjson" })).toBe(true)
    expect(isEnabled({ enabled: true })).toBe(true)
    expect(isEnabled({ enabled: false })).toBe(false)
  })

  test("rotates at 256 MiB unless configured otherwise", () => {
    expect(DEFAULT_ROTATE_BYTES).toBe(256 * 1024 * 1024)
    expect(resolveRotateBytes({})).toBe(DEFAULT_ROTATE_BYTES)
    expect(resolveRotateBytes({ rotateBytes: 1024 })).toBe(1024)
    expect(resolveRotateBytes({ rotateBytes: 1024.9 })).toBe(1024)
    expect(resolveRotateBytes({ rotateBytes: false })).toBe(0)
    expect(resolveRotateBytes({ rotateBytes: 0 })).toBe(0)
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

  test("creates the parent directory private to the user", () => {
    const dir = join(ROOT, "private")
    const write = createWriter(join(dir, "prompts.ndjson"))
    write({ type: "assembled" })

    if (process.platform !== "win32") {
      // mode is ignored on Windows; the directory is per-user there anyway.
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
    expect(readRecords(join(dir, "prompts.ndjson"))).toHaveLength(1)
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

  test("rotates to a single backup once rotateBytes is passed", () => {
    const file = join(ROOT, "rotate.ndjson")
    const write = createWriter(file, 1) // every record passes the limit

    write({ type: "assembled", n: 1 })
    write({ type: "assembled", n: 2 })
    write({ type: "assembled", n: 3 })

    expect(readRecords(file).map((record) => record.n)).toEqual([3])
    expect(readRecords(`${file}.1`).map((record) => record.n)).toEqual([2])
  })

  test("keeps one growing file when rotation is off", () => {
    const file = join(ROOT, "no-rotate.ndjson")
    const write = createWriter(file, 0)

    for (let n = 0; n < 5; n++) write({ type: "assembled", n })

    expect(readRecords(file)).toHaveLength(5)
    expect(existsSync(`${file}.1`)).toBe(false)
  })

  test("still writes the record when rotation fails", () => {
    const file = join(ROOT, "blocked.ndjson")
    mkdirSync(`${file}.1`, { recursive: true }) // the backup path is a directory
    const write = createWriter(file, 1)
    const spy = spyOn(console, "error").mockImplementation(() => {})

    try {
      write({ type: "assembled", n: 1 })
      write({ type: "assembled", n: 2 })

      expect(readRecords(file).map((record) => record.n)).toEqual([1, 2])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(String(spy.mock.calls[0]?.[0])).toContain("rotation failed")
    } finally {
      spy.mockRestore()
    }
  })
})
