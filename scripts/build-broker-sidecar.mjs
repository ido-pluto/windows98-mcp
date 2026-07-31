import { build } from "esbuild";
import { inject } from "postject";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isWindows = process.platform === "win32";
const isMac = process.platform === "darwin";
const sidecarName = isWindows ? "windows98-mcp-broker.exe" : "windows98-mcp-broker";
const output = resolve(
  process.argv[2] ??
    `${root}/admin/src-tauri/resources/broker-sidecar/${sidecarName}`
);
const work = resolve(root, "out/broker-sidecar-build");

await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
await mkdir(dirname(output), { recursive: true });

await build({
  entryPoints: [resolve(root, "dist/src/cli.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: resolve(work, "broker.cjs")
});

await writeFile(
  resolve(work, "sea-config.json"),
  JSON.stringify({
    main: "broker.cjs",
    output: "broker.blob",
    disableExperimentalSEAWarning: true
  }),
  "utf8"
);
const sea = spawnSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], {
  cwd: work,
  stdio: "inherit"
});
if (sea.status !== 0) throw new Error("Node SEA blob generation failed");

await copyFile(process.execPath, output);
if (!isWindows) await chmod(output, 0o755);
if (isMac) {
  // Node's official SEA process requires removing the signature before
  // postject changes the Mach-O file, then signing it again after injection.
  const removed = spawnSync("codesign", ["--remove-signature", output], {
    stdio: "inherit"
  });
  if (removed.status !== 0) throw new Error("Could not remove the macOS Node signature before SEA injection");
}
await inject(output, "NODE_SEA_BLOB", await readFile(resolve(work, "broker.blob")), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(isMac ? { machoSegmentName: "NODE_SEA" } : {})
});
if (isMac) {
  const signed = spawnSync("codesign", ["--sign", "-", output], {
    stdio: "inherit"
  });
  if (signed.status !== 0) throw new Error("Could not sign the macOS SEA sidecar");
}
console.log(`Broker sidecar built: ${output}`);
