import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"
import type { Options } from "../src/core"

type Event = Record<string, unknown>
type Callback = (event: Event) => Promise<void> | void

const ROOT = mkdtempSync(join(tmpdir(), "prompt-logger-plugin-"))

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Minimal plugin context: records every registered session hook. */
async function createHarness(options: Options) {
  const hooks = new Map<string, Callback[]>()
  const ctx = {
    options,
    session: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(name, [...(hooks.get(name) ?? []), callback])
        return { dispose: async () => {} }
      },
    },
  }

  await plugin.setup(ctx as never)

  return {
    names: [...hooks.keys()],
    async run(name: string, event: Event) {
      for (const callback of hooks.get(name) ?? []) await callback(event)
    },
  }
}

function readRecords(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("prompt-logger plugin", () => {
  test("registers one hook per model request kind plus the HTTP hook", async () => {
    const harness = await createHarness({ file: join(ROOT, "hooks.ndjson") })
    expect(harness.names).toEqual(["context", "compaction", "generate", "title", "http.request"])
  })

  test("skips the HTTP hook when http is disabled", async () => {
    const harness = await createHarness({ file: join(ROOT, "no-http.ndjson"), http: false })
    expect(harness.names).toEqual(["context", "compaction", "generate", "title"])
    expect(harness.names).not.toContain("http.request")
  })

  test("registers nothing and creates no file when disabled", async () => {
    const file = join(ROOT, "disabled-dir", "prompts.ndjson")
    const harness = await createHarness({ file, enabled: false })

    expect(harness.names).toEqual([])
    expect(existsSync(file)).toBe(false)
    expect(existsSync(join(ROOT, "disabled-dir"))).toBe(false)
  })

  test("registers every hook when explicitly enabled", async () => {
    const harness = await createHarness({ file: join(ROOT, "enabled.ndjson"), enabled: true })
    expect(harness.names).toEqual(["context", "compaction", "generate", "title", "http.request"])
  })

  test("rotates the log through the configured rotateBytes", async () => {
    const file = join(ROOT, "rotate.ndjson")
    const harness = await createHarness({ file, rotateBytes: 1 })

    for (const sessionID of ["ses_1", "ses_2", "ses_3"]) {
      await harness.run("context", {
        sessionID,
        agent: "plan",
        model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
        system: [],
        messages: [],
        tools: {},
      })
    }

    expect(readRecords(file).map((record) => record.sessionID)).toEqual(["ses_3"])
    expect(readRecords(`${file}.1`).map((record) => record.sessionID)).toEqual(["ses_2"])
  })

  test("writes the assembled prompt of the agent loop", async () => {
    const file = join(ROOT, "context.ndjson")
    const harness = await createHarness({ file })

    await harness.run("context", {
      sessionID: "ses_1",
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      system: [{ type: "text", text: "You are an agent." }],
      messages: [{ role: "user", parts: [] }],
      tools: { read: { description: "Read a file" } },
    })

    const [record, ...rest] = readRecords(file)
    expect(rest).toHaveLength(0)
    expect(record).toMatchObject({
      type: "assembled",
      kind: "context",
      sessionID: "ses_1",
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      system: [{ type: "text", text: "You are an agent." }],
      tools: ["read"],
    })
    expect(typeof record?.at).toBe("string")
  })

  test("writes title requests without agent or tools", async () => {
    const file = join(ROOT, "title.ndjson")
    const harness = await createHarness({ file })

    await harness.run("title", {
      sessionID: "ses_2",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      system: [],
      messages: [],
    })

    const [record] = readRecords(file)
    expect(record).toMatchObject({ type: "assembled", kind: "title", tools: [] })
    expect(record?.agent).toBeUndefined()
  })

  test("writes the raw provider body", async () => {
    const file = join(ROOT, "http.ndjson")
    const harness = await createHarness({ file })

    await harness.run("http.request", {
      kind: "primary",
      sessionID: "ses_1",
      agent: "plan",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      request: new Request("https://api.example.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({ max_tokens: 100 }),
      }),
    })

    const [record] = readRecords(file)
    expect(record).toMatchObject({
      type: "http",
      kind: "primary",
      sessionID: "ses_1",
      url: "https://api.example.com/v1/messages",
      body: JSON.stringify({ max_tokens: 100 }),
    })
  })

  test("creates missing parent directories", async () => {
    const file = join(ROOT, "creates", "parents", "prompts.ndjson")
    const harness = await createHarness({ file })

    await harness.run("generate", {
      sessionID: "ses_3",
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-6" },
      system: [],
      messages: [],
      tools: {},
    })

    expect(readRecords(file)).toHaveLength(1)
  })
})
