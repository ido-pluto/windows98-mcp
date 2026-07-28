import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { extname, resolve } from "node:path";

export interface StoredArtifact {
  id: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  path: string;
}

export class ArtifactStore {
  private maintenanceChain: Promise<void> = Promise.resolve();

  constructor(
    readonly directory: string,
    readonly maxArtifactBytes: number,
    readonly maxTotalBytes = Math.max(
      maxArtifactBytes,
      256 * 1024 * 1024
    )
  ) {}

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.runMaintenance(async () => this.evictFor(0));
  }

  async put(data: Buffer, mimeType: string, preferredExtension?: string): Promise<StoredArtifact> {
    if (data.length > this.maxArtifactBytes) {
      throw new Error(`ARTIFACT_TOO_LARGE:${data.length}:${this.maxArtifactBytes}`);
    }
    if (data.length > this.maxTotalBytes) {
      throw new Error(
        `ARTIFACT_TOTAL_LIMIT_EXCEEDED:${data.length}:${this.maxTotalBytes}`
      );
    }
    let stored: StoredArtifact | undefined;
    await this.runMaintenance(async () => {
      await this.evictFor(data.length);
      const id = randomUUID();
      const extension = safeExtension(
        preferredExtension ?? extensionForMime(mimeType)
      );
      const path = resolve(this.directory, `${id}${extension}`);
      const createdAt = new Date().toISOString();
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
      stored = {
        id,
        mimeType,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
        createdAt,
        path
      };
    });
    if (!stored) {
      throw new Error("ARTIFACT_STORE_FAILED");
    }
    return stored;
  }

  async get(id: string): Promise<Buffer> {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) {
      throw new Error("ARTIFACT_ID_INVALID");
    }
    const candidates = [".png", ".bin", ".txt"];
    for (const extension of candidates) {
      try {
        return await readFile(resolve(this.directory, `${id}${extension}`));
      } catch {
        // Continue to the next known extension.
      }
    }
    throw new Error("ARTIFACT_NOT_FOUND");
  }

  private async runMaintenance(operation: () => Promise<void>): Promise<void> {
    const result = this.maintenanceChain.then(operation);
    this.maintenanceChain = result.catch(() => undefined);
    await result;
  }

  private async evictFor(reservedBytes: number): Promise<void> {
    const entries = await readdir(this.directory, { withFileTypes: true });
    const artifacts = await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && isArtifactFileName(entry.name)
        )
        .map(async (entry) => {
          const path = resolve(this.directory, entry.name);
          const info = await stat(path);
          return {
            path,
            name: entry.name,
            bytes: info.size,
            modifiedAt: info.mtimeMs
          };
        })
    );
    let totalBytes = artifacts.reduce(
      (total, artifact) => total + artifact.bytes,
      0
    );
    artifacts.sort(
      (left, right) =>
        left.modifiedAt - right.modifiedAt ||
        left.name.localeCompare(right.name)
    );
    for (const artifact of artifacts) {
      if (totalBytes + reservedBytes <= this.maxTotalBytes) {
        break;
      }
      await unlink(artifact.path);
      totalBytes -= artifact.bytes;
    }
    if (totalBytes + reservedBytes > this.maxTotalBytes) {
      throw new Error(
        `ARTIFACT_TOTAL_LIMIT_EXCEEDED:${
          totalBytes + reservedBytes
        }:${this.maxTotalBytes}`
      );
    }
  }
}

function safeExtension(value: string): string {
  const extension = extname(value) || value;
  return /^\.[a-z0-9]{1,8}$/iu.test(extension) ? extension.toLowerCase() : ".bin";
}

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/png") {
    return ".png";
  }
  if (mimeType.startsWith("text/")) {
    return ".txt";
  }
  return ".bin";
}

function isArtifactFileName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|bin|txt)$/iu.test(
    name
  );
}
