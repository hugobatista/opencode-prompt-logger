// Build the npm plugin entrypoint: dist/index.js + dist/index.d.ts.
// @opencode/plugin is host-provided, so it stays external.
import { join } from "node:path"

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  naming: "index.js",
  target: "bun",
  format: "esm",
  sourcemap: "external",
  external: ["@opencode/plugin"],
})

for (const log of result.logs) {
  if (log.level === "error") console.error(log.message)
}
if (!result.success) {
  console.error("bun build failed")
  process.exit(1)
}

// Run the TypeScript entry directly: `tsc` on PATH depends on node_modules/.bin
// and resolves to a .cmd shim on Windows, which spawn cannot execute.
const tsc = join(import.meta.dir, "..", "node_modules", "typescript", "lib", "tsc.js")
const proc = Bun.spawnSync([process.execPath, tsc, "-p", "tsconfig.build.json"], {
  cwd: join(import.meta.dir, ".."),
  stdio: ["ignore", "inherit", "inherit"],
})
if (proc.exitCode !== 0) {
  console.error("tsc declarations failed")
  process.exit(1)
}

console.log("built dist/index.js + dist/index.d.ts")
