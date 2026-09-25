import { Plugin } from "@opencode/plugin"
import {
  CONTEXT_KINDS,
  assembledRecord,
  createWriter,
  httpRecord,
  isEnabled,
  resolveFile,
  resolveMaxBytes,
  shouldLogHttp,
  type Options,
} from "./core"

/**
 * Capture what is actually sent to the model: `event.system` is the fully
 * assembled system prompt (agent prompt + environment + AGENTS.md + skills),
 * and the `http.request` body is the provider-level payload after lowering.
 * Both are read-only observations; nothing is rewritten.
 */
export default Plugin.define({
  id: "prompt-logger",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Options

    // Disabled means idle: no hooks and no output file.
    if (!isEnabled(options)) return

    const write = createWriter(resolveFile(options), resolveMaxBytes(options))

    for (const kind of CONTEXT_KINDS) {
      await ctx.session.hook(kind, (event) => {
        write(assembledRecord(kind, event))
      })
    }

    if (shouldLogHttp(options)) {
      await ctx.session.hook("http.request", async (event) => {
        write(await httpRecord(event))
      })
    }
  },
})
