import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const required = [
  "dist/src/cli.js"
];

await Promise.all(required.map((file) => access(path.join(root, file))));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (manifest.name !== "windows98-mcp" || manifest.private === true) {
  throw new Error("package.json is not publishable as windows98-mcp");
}
