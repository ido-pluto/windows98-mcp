import { appendFile, mkdir, stat, rename } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export class JsonlLogger {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly maxBytes = 5 * 1024 * 1024
  ) {}

  async initialize(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
  }

  write(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    const record = {
      time: new Date().toISOString(),
      level,
      event,
      ...sanitize(fields)
    };
    this.writeChain = this.writeChain
      .then(async () => {
        await this.rotateIfNeeded();
        await appendFile(this.path, `${JSON.stringify(record)}\n`, {
          encoding: "utf8",
          mode: 0o600
        });
      })
      .catch(() => {
        // Logging must never take the broker down.
      });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.path);
      if (info.size < this.maxBytes) {
        return;
      }
      await rename(this.path, `${this.path}.1`).catch(() => undefined);
    } catch {
      // A missing file is the normal first-write case.
    }
  }
}

function sanitize(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/psk|secret|password|token|mac$/iu.test(key)) {
      result[key] = "[redacted]";
    } else if (item instanceof Error) {
      result[key] = { name: item.name, message: item.message };
    } else {
      result[key] = item;
    }
  }
  return result;
}
