import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/host/artifacts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("artifact retention", () => {
  it("evicts the oldest artifacts before exceeding the total byte limit", async () => {
    const directory = await temporaryDirectory();
    const store = new ArtifactStore(directory, 8, 10);
    await store.initialize();

    const first = await store.put(Buffer.from("123456"), "text/plain");
    const second = await store.put(Buffer.from("abcdef"), "text/plain");

    await expect(store.get(first.id)).rejects.toThrow("ARTIFACT_NOT_FOUND");
    await expect(store.get(second.id)).resolves.toEqual(Buffer.from("abcdef"));
    expect(await readdir(directory)).toEqual([path.basename(second.path)]);
  });

  it("applies retention to existing artifact files during initialization", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "00000000-0000-4000-8000-000000000001.bin"),
      Buffer.alloc(6, 1)
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    await writeFile(
      path.join(directory, "00000000-0000-4000-8000-000000000002.bin"),
      Buffer.alloc(6, 2)
    );

    const store = new ArtifactStore(directory, 8, 10);
    await store.initialize();

    expect(await readdir(directory)).toEqual([
      "00000000-0000-4000-8000-000000000002.bin"
    ]);
  });

  it("does not evict unrelated files", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "README.txt"), Buffer.alloc(20, 1));
    const store = new ArtifactStore(directory, 8, 10);
    await store.initialize();
    await store.put(Buffer.from("123456"), "application/octet-stream");

    expect(await readdir(directory)).toContain("README.txt");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "win98-artifacts-"));
  temporaryDirectories.push(directory);
  return directory;
}
