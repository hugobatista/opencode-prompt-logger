// Build the npm plugin entrypoint: dist/index.js + dist/index.d.ts.
// @opencode/plugin is host-provided, so it stays external.
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

const proc = Bun.spawnSync(["tsc", "-p", "tsconfig.build.json"], {
  stdio: ["ignore", "inherit", "inherit"],
})
if (proc.exitCode !== 0) {
  console.error("tsc declarations failed")
  process.exit(1)
}

console.log("built dist/index.js + dist/index.d.ts")
