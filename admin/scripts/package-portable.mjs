import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This packaging script must run on native macOS Apple Silicon.");
}

const adminRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = process.argv[2] ?? "0.0.0";
const sidecar = resolve(adminRoot, "src-tauri/resources/broker-sidecar/windows98-mcp-broker");
const app = resolve(adminRoot, "src-tauri/target/release/bundle/macos/Windows 98 MCP Admin.app");
const portableName = `windows98-mcp-admin-${version}-macos-arm64`;
const output = resolve(adminRoot, "out");
const bundle = resolve(output, portableName);
const archive = resolve(output, `${portableName}.zip`);

try { await readFile(sidecar); } catch { throw new Error(`Broker sidecar not found: ${sidecar}`); }
execFileSync("npx", ["--no-install", "tauri", "build", "--bundles", "app"], {
  cwd: adminRoot,
  stdio: "inherit"
});
try { if (!(await stat(app)).isDirectory()) throw new Error("not a directory"); } catch { throw new Error(`Tauri app bundle not found: ${app}`); }

await rm(bundle, { recursive: true, force: true });
await rm(archive, { force: true });
await mkdir(bundle, { recursive: true });
await cp(app, resolve(bundle, "Windows 98 MCP Admin.app"), { recursive: true });
await cp(resolve(adminRoot, "README.md"), resolve(bundle, "README.TXT"));
execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", bundle, archive], { stdio: "inherit" });
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(`${archive}.sha256`, `${digest}  ${portableName}.zip\n`, "ascii");
console.log(`Portable bundle: ${archive}`);
