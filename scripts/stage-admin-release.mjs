import { copyFile, mkdir, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("macOS ARM64 release staging must run on native Apple Silicon.");
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? `${root}/out/release`);
const adminOutput = resolve(root, "admin/out");
const version = "0.0.0";
const stem = `windows98-mcp-admin-${version}-macos-arm64`;

execFileSync(process.execPath, [resolve(root, "scripts/build-broker-sidecar.mjs")], {
  cwd: root,
  stdio: "inherit"
});
execFileSync(process.execPath, [resolve(root, "admin/scripts/package-portable.mjs"), version], {
  cwd: root,
  stdio: "inherit"
});
await mkdir(output, { recursive: true });
const expected = [`${stem}.zip`, `${stem}.zip.sha256`];
for (const name of expected) {
  await copyFile(resolve(adminOutput, name), resolve(output, name.replace(`-${version}`, "")));
}
console.log(`Release admin bundle staged at ${output}`);
