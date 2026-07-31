import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
  win32
} from "node:path";
import type { GuestResponse } from "../shared/types.js";

const TRANSFER_CHUNK_BYTES = 64 * 1024;
const MAX_WIN98_FILE_BYTES = 2_147_483_647;
const CRC32_TABLE = makeCrc32Table();

export const TRANSFER_METHODS = new Set([
  "file_push",
  "file_pull",
  "directory_push",
  "directory_pull"
]);

export interface TransferProgress {
  direction: "host-to-guest" | "guest-to-host";
  files: number;
  directories: number;
  bytes: number;
  chunks: number;
  skipped: number;
  resumedBytes?: number;
  source: string;
  destination: string;
  sha256?: string;
  totalBytes?: number;
  totalFiles?: number;
  currentPath?: string;
}

export type GuestRequester = (
  sessionId: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
) => Promise<GuestResponse>;

interface ActiveTransfer {
  operationId: string;
  sessionId: string;
  cancelled: boolean;
  guestTransferId: string | undefined;
  hostTempPath: string | undefined;
  hostMetaPath: string | undefined;
  done: Promise<void>;
  resolveDone: () => void;
}

interface HostEntry {
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
  size: number;
}

interface GuestEntry {
  relativePath: string;
  guestPath: string;
  isDirectory: boolean;
}

interface PullPartial {
  file: Awaited<ReturnType<typeof open>>;
  offset: number;
  expectedSize: number | undefined;
}

export class TransferCoordinator {
  private readonly active = new Map<string, Set<ActiveTransfer>>();
  private readonly activeHostDestinations = new Set<string>();
  private readonly retainedHostPartials = new Map<string, Set<string>>();

  constructor(
    private readonly requestGuest: GuestRequester,
    private readonly onResourceOpened: (sessionId: string, resource: string) => void,
    private readonly onResourceClosed: (sessionId: string, resource: string) => void,
    private readonly requestTimeoutMs: number,
    private readonly onProgress: (sessionId: string, progress: TransferProgress) => void = () => undefined
  ) {
  }

  private report(sessionId: string, progress: TransferProgress): void {
    this.onProgress(sessionId, { ...progress });
  }

  async execute(
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<TransferProgress> {
    const transfer = this.register(sessionId);
    try {
      if (method === "file_push") {
        return await this.pushFileOperation(sessionId, params, transfer);
      }
      if (method === "file_pull") {
        return await this.pullFileOperation(sessionId, params, transfer);
      }
      if (method === "directory_push") {
        return await this.pushDirectoryOperation(sessionId, params, transfer);
      }
      if (method === "directory_pull") {
        return await this.pullDirectoryOperation(sessionId, params, transfer);
      }
      throw new Error(`TRANSFER_METHOD_INVALID:${method}`);
    } finally {
      this.unregister(transfer);
    }
  }

  async abortSession(sessionId: string): Promise<void> {
    const transfers = [...(this.active.get(sessionId) ?? [])];
    const hostPartials = [
      ...transfers.flatMap((transfer) =>
        [transfer.hostTempPath, transfer.hostMetaPath].filter(
          (value): value is string => value !== undefined
        )
      ),
      ...(this.retainedHostPartials.get(sessionId) ?? [])
    ];
    this.retainedHostPartials.delete(sessionId);
    for (const transfer of transfers) {
      transfer.cancelled = true;
    }
    await Promise.allSettled(
      transfers.map(async (transfer) => {
        if (transfer.guestTransferId) {
          await this.requestGuest(
            sessionId,
            "file_write_abort",
            { transferId: transfer.guestTransferId },
            this.requestTimeoutMs
          );
        }
      })
    );
    await Promise.all(transfers.map((transfer) => transfer.done));
    await Promise.allSettled(
      hostPartials.map((partial) => rm(partial, { force: true }))
    );
  }

  async abortAll(): Promise<void> {
    const sessionIds = new Set([
      ...this.active.keys(),
      ...this.retainedHostPartials.keys()
    ]);
    await Promise.allSettled(
      [...sessionIds].map((sessionId) => this.abortSession(sessionId))
    );
  }

  private async pushFileOperation(
    sessionId: string,
    params: Record<string, unknown>,
    transfer: ActiveTransfer
  ): Promise<TransferProgress> {
    const hostPath = requireString(params, "host_path");
    const guestPath = requireString(params, "guest_path");
    const overwrite = params["overwrite"] === true;
    const source = await this.resolveHostPath(hostPath, true);
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error("HOST_SYMLINK_REJECTED");
    }
    if (!sourceInfo.isFile()) {
      throw new Error("HOST_SOURCE_NOT_FILE");
    }
    const summary = { ...emptyProgress("host-to-guest", source, guestPath), totalBytes: sourceInfo.size, totalFiles: 1, currentPath: source };
    this.report(sessionId, summary);
    const result = await this.pushOneFile(
      sessionId,
      source,
      guestPath,
      overwrite,
      transfer,
      (bytes, chunks) => { summary.bytes = bytes; summary.chunks = chunks; this.report(sessionId, summary); }
    );
    summary.files = 1;
    summary.bytes = result.bytes;
    summary.chunks = result.chunks;
    summary.sha256 = result.sha256;
    this.report(sessionId, summary);
    return summary;
  }

  private async pullFileOperation(
    sessionId: string,
    params: Record<string, unknown>,
    transfer: ActiveTransfer
  ): Promise<TransferProgress> {
    const guestPath = requireString(params, "guest_path");
    const hostPath = requireString(params, "host_path");
    const overwrite = params["overwrite"] === true;
    const destination = await this.resolveHostPath(hostPath, false);
    const summary = { ...emptyProgress("guest-to-host", guestPath, destination), totalFiles: 1, currentPath: guestPath };
    this.report(sessionId, summary);
    const result = await this.pullOneFile(
      sessionId,
      guestPath,
      destination,
      overwrite,
      transfer,
      (bytes, chunks, totalBytes) => {
        summary.bytes = bytes;
        summary.chunks = chunks;
        if (totalBytes !== undefined) summary.totalBytes = totalBytes;
        this.report(sessionId, summary);
      }
    );
    summary.files = 1;
    summary.bytes = result.bytes;
    summary.chunks = result.chunks;
    summary.sha256 = result.sha256;
    this.report(sessionId, summary);
    return summary;
  }

  private async pushDirectoryOperation(
    sessionId: string,
    params: Record<string, unknown>,
    transfer: ActiveTransfer
  ): Promise<TransferProgress> {
    const hostPath = requireString(params, "host_path");
    const guestPath = requireString(params, "guest_path");
    const overwrite = params["overwrite"] === true;
    const source = await this.resolveHostPath(hostPath, true);
    const sourceInfo = await lstat(source);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error("HOST_SYMLINK_REJECTED");
    }
    if (!sourceInfo.isDirectory()) {
      throw new Error("HOST_SOURCE_NOT_DIRECTORY");
    }
    const entries = await collectHostTree(source, () => this.assertActive(transfer));
    this.assertActive(transfer);
    const files = entries.filter((item) => !item.isDirectory);
    const summary = { ...emptyProgress("host-to-guest", source, guestPath), totalFiles: files.length, totalBytes: files.reduce((total, entry) => total + entry.size, 0) };
    this.report(sessionId, summary);
    await this.guestOk(sessionId, "fs_mkdir", {
      path: guestPath,
      recursive: true
    });
    for (const entry of entries.filter((item) => item.isDirectory)) {
      this.assertActive(transfer);
      await this.guestOk(sessionId, "fs_mkdir", {
        path: joinGuestPath(guestPath, entry.relativePath),
        recursive: true
      });
      summary.directories += 1;
    }
    let completedBytes = 0;
    let completedChunks = 0;
    for (const entry of files) {
      this.assertActive(transfer);
      const result = await this.pushOneFile(
        sessionId,
        entry.absolutePath,
        joinGuestPath(guestPath, entry.relativePath),
        overwrite,
        transfer,
        (bytes, chunks) => { summary.currentPath = entry.relativePath; summary.bytes = completedBytes + bytes; summary.chunks = completedChunks + chunks; this.report(sessionId, summary); }
      );
      summary.files += 1;
      completedBytes += result.bytes;
      completedChunks += result.chunks;
      summary.bytes = completedBytes;
      summary.chunks = completedChunks;
      this.report(sessionId, summary);
    }
    return summary;
  }

  private async pullDirectoryOperation(
    sessionId: string,
    params: Record<string, unknown>,
    transfer: ActiveTransfer
  ): Promise<TransferProgress> {
    const guestPath = requireString(params, "guest_path");
    const hostPath = requireString(params, "host_path");
    const overwrite = params["overwrite"] === true;
    const destination = await this.resolveHostPath(hostPath, false);
    await rejectCaseConflict(destination);
    await ensureDirectoryDestination(destination);
    const entries = await this.collectGuestTree(sessionId, guestPath, transfer);
    this.assertActive(transfer);
    const files = entries.filter((item) => !item.isDirectory);
    const summary = { ...emptyProgress("guest-to-host", guestPath, destination), totalFiles: files.length };
    this.report(sessionId, summary);
    for (const entry of entries.filter((item) => item.isDirectory)) {
      this.assertActive(transfer);
      const target = resolveRelative(destination, entry.relativePath);
      await rejectCaseConflict(target);
      await mkdir(target, { recursive: true });
      summary.directories += 1;
    }
    let completedBytes = 0;
    let completedChunks = 0;
    for (const entry of files) {
      this.assertActive(transfer);
      const target = resolveRelative(destination, entry.relativePath);
      await rejectCaseConflict(target);
      const result = await this.pullOneFile(
        sessionId,
        entry.guestPath,
        target,
        overwrite,
        transfer,
        (bytes, chunks, totalBytes) => {
          summary.currentPath = entry.relativePath;
          summary.bytes = completedBytes + bytes;
          summary.chunks = completedChunks + chunks;
          // The current file reports its expected length. Combine it with
          // completed files instead of adding it again for every chunk.
          if (totalBytes !== undefined) summary.totalBytes = completedBytes + totalBytes;
          this.report(sessionId, summary);
        }
      );
      summary.files += 1;
      completedBytes += result.bytes;
      completedChunks += result.chunks;
      summary.bytes = completedBytes;
      summary.chunks = completedChunks;
      this.report(sessionId, summary);
    }
    return summary;
  }

  private async pushOneFile(
    sessionId: string,
    hostPath: string,
    guestPath: string,
    overwrite: boolean,
    transfer: ActiveTransfer,
    onProgress?: (bytes: number, chunks: number) => void
  ): Promise<{ bytes: number; chunks: number; sha256: string }> {
    const sourceInfo = await lstat(hostPath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error("HOST_SYMLINK_REJECTED");
    }
    if (!sourceInfo.isFile()) {
      throw new Error("HOST_SOURCE_NOT_FILE");
    }
    if (sourceInfo.size > MAX_WIN98_FILE_BYTES) {
      throw new Error("FILE_TOO_LARGE_FOR_WIN98");
    }
    const parent = win32.dirname(guestPath);
    if (parent !== guestPath) {
      await this.guestOk(sessionId, "fs_mkdir", {
        path: parent,
        recursive: true
      });
    }
    const source = await open(hostPath, "r");
    let offset = 0;
    let chunks = 0;
    try {
      this.assertActive(transfer);
      const sha256 = await hashOpenFile(source, sourceInfo.size);
      const afterHash = await source.stat();
      if (
        afterHash.size !== sourceInfo.size ||
        afterHash.mtimeMs !== sourceInfo.mtimeMs
      ) {
        throw new Error("HOST_FILE_CHANGED_DURING_TRANSFER");
      }
      const begin = await this.guestOk(sessionId, "file_write_begin", {
        path: guestPath,
        size: sourceInfo.size,
        sha256,
        overwrite
      });
      const transferId = stringField(begin, "transferId");
      const resumeOffset = numberField(begin, "resumeOffset");
      if (
        !Number.isSafeInteger(resumeOffset) ||
        resumeOffset < 0 ||
        resumeOffset > sourceInfo.size
      ) {
        throw new Error("TRANSFER_RESUME_OFFSET_INVALID");
      }
      transfer.guestTransferId = transferId;
      offset = resumeOffset;
      onProgress?.(offset, chunks);
      const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
      while (offset < sourceInfo.size) {
        this.assertActive(transfer);
        const wanted = Math.min(buffer.length, sourceInfo.size - offset);
        const read = await source.read(buffer, 0, wanted, offset);
        if (read.bytesRead <= 0) {
          throw new Error("HOST_FILE_CHANGED_DURING_TRANSFER");
        }
        const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
        const chunkResult = await this.guestOk(
          sessionId,
          "file_write_chunk",
          {
            transferId,
            offset,
            dataBase64: chunk.toString("base64"),
            crc32: crc32(chunk)
          }
        );
        const nextOffset = numberField(chunkResult, "nextOffset");
        if (nextOffset !== offset + chunk.length) {
          throw new Error("TRANSFER_OFFSET_MISMATCH");
        }
        offset = nextOffset;
        chunks += 1;
        onProgress?.(offset, chunks);
      }
      await this.guestOk(sessionId, "file_write_commit", {
        transferId,
        sha256
      });
      transfer.guestTransferId = undefined;
      const after = await source.stat();
      if (
        after.size !== sourceInfo.size ||
        after.mtimeMs !== sourceInfo.mtimeMs
      ) {
        throw new Error("HOST_FILE_CHANGED_DURING_TRANSFER");
      }
      return { bytes: offset, chunks, sha256 };
    } catch (error) {
      // Keep a verified sibling partial so a retry can resume. Explicit
      // session cleanup/forced unlock still sends file_write_abort.
      throw error;
    } finally {
      await source.close();
      transfer.guestTransferId = undefined;
    }
  }

  private async pullOneFile(
    sessionId: string,
    guestPath: string,
    hostPath: string,
    overwrite: boolean,
    transfer: ActiveTransfer,
    onProgress?: (bytes: number, chunks: number, totalBytes?: number) => void
  ): Promise<{ bytes: number; chunks: number; sha256: string }> {
    await this.prepareHostDestination(hostPath, overwrite);
    const tempPath = resolve(
      dirname(hostPath),
      `.${basename(hostPath)}.win98mcp.partial`
    );
    const metaPath = `${tempPath}.json`;
    if (this.activeHostDestinations.has(hostPath)) {
      throw new Error("HOST_DESTINATION_TRANSFER_ACTIVE");
    }
    this.activeHostDestinations.add(hostPath);
    const resumed = await openPullPartial(tempPath, metaPath, guestPath);
    const destination = resumed.file;
    transfer.hostTempPath = tempPath;
    transfer.hostMetaPath = metaPath;
    this.retainHostPartial(sessionId, tempPath, metaPath);
    const hash = createHash("sha256");
    let offset = resumed.offset;
    let chunks = 0;
    let expectedSize = resumed.expectedSize;
    let guestSha256: string | undefined;
    try {
      await updateOpenFileHash(hash, destination, offset);
      for (;;) {
        this.assertActive(transfer);
        const response = await this.guestOk(sessionId, "file_read_chunk", {
          path: guestPath,
          offset,
          length: TRANSFER_CHUNK_BYTES
        });
        const responseOffset = numberField(response, "offset");
        const nextOffset = numberField(response, "nextOffset");
        const size = numberField(response, "size");
        const eof = booleanField(response, "eof");
        if (responseOffset !== offset || size > MAX_WIN98_FILE_BYTES) {
          throw new Error("TRANSFER_OFFSET_MISMATCH");
        }
        expectedSize ??= size;
        if (expectedSize !== size) {
          throw new Error("GUEST_FILE_CHANGED_DURING_TRANSFER");
        }
        if (offset > expectedSize) {
          throw new Error("TRANSFER_RESUME_OFFSET_INVALID");
        }
        if (resumed.expectedSize === undefined) {
          await writePullMetadata(metaPath, guestPath, expectedSize);
          resumed.expectedSize = expectedSize;
        }
        onProgress?.(offset, chunks, expectedSize);
        const data = base64Field(response, "dataBase64");
        if (
          data.length > TRANSFER_CHUNK_BYTES ||
          nextOffset !== offset + data.length ||
          (!eof && data.length === 0)
        ) {
          throw new Error("TRANSFER_CHUNK_INVALID");
        }
        if (data.length > 0) {
          const write = await destination.write(data, 0, data.length, offset);
          if (write.bytesWritten !== data.length) {
            throw new Error("HOST_SHORT_WRITE");
          }
          hash.update(data);
          offset = nextOffset;
          chunks += 1;
          onProgress?.(offset, chunks, expectedSize);
        }
        if (eof) {
          if (offset !== expectedSize) {
            throw new Error("TRANSFER_SIZE_MISMATCH");
          }
          const advertisedHash = response["sha256"];
          if (
            typeof advertisedHash !== "string" ||
            !/^[0-9a-f]{64}$/u.test(advertisedHash)
          ) {
            throw new Error("GUEST_RESPONSE_INVALID:sha256");
          }
          guestSha256 = advertisedHash;
          break;
        }
      }
      await destination.sync();
      await destination.close();
      const sha256 = hash.digest("hex");
      if (sha256 !== guestSha256) {
        throw new Error("TRANSFER_HASH_MISMATCH");
      }
      this.assertActive(transfer);
      await rename(tempPath, hostPath);
      await rm(metaPath, { force: true });
      this.releaseHostPartial(sessionId, tempPath, metaPath);
      transfer.hostTempPath = undefined;
      transfer.hostMetaPath = undefined;
      return { bytes: offset, chunks, sha256 };
    } catch (error) {
      await destination.close().catch(() => undefined);
      if (discardHostPartial(error)) {
        await Promise.allSettled([
          rm(tempPath, { force: true }),
          rm(metaPath, { force: true })
        ]);
        this.releaseHostPartial(sessionId, tempPath, metaPath);
      }
      throw error;
    } finally {
      transfer.hostTempPath = undefined;
      transfer.hostMetaPath = undefined;
      this.activeHostDestinations.delete(hostPath);
    }
  }

  private async collectGuestTree(
    sessionId: string,
    root: string,
    transfer: ActiveTransfer
  ): Promise<GuestEntry[]> {
    const entries: GuestEntry[] = [];
    const queue: Array<{ path: string; relativePath: string }> = [
      { path: root, relativePath: "" }
    ];
    while (queue.length > 0) {
      this.assertActive(transfer);
      const current = queue.shift();
      if (!current) {
        break;
      }
      const result = await this.guestOk(sessionId, "fs_list", {
        path: current.path,
        recursive: false
      });
      const rawEntries = result["entries"];
      if (!Array.isArray(rawEntries)) {
        throw new Error("GUEST_DIRECTORY_LIST_INVALID");
      }
      const names = new Set<string>();
      for (const raw of rawEntries) {
        if (!isRecord(raw)) {
          throw new Error("GUEST_DIRECTORY_ENTRY_INVALID");
        }
        const name = stringField(raw, "name");
        validateGuestEntryName(name);
        const folded = name.toLowerCase();
        if (names.has(folded)) {
          throw new Error(`CASE_INSENSITIVE_COLLISION:${current.path}:${name}`);
        }
        names.add(folded);
        const isDirectory = booleanField(raw, "isDirectory");
        const relativePath = current.relativePath
          ? `${current.relativePath}/${name}`
          : name;
        const guestPath = win32.join(current.path, name);
        entries.push({ relativePath, guestPath, isDirectory });
        if (isDirectory) {
          queue.push({ path: guestPath, relativePath });
        }
      }
    }
    return entries;
  }

  private async resolveHostPath(
    input: string,
    mustExist: boolean
  ): Promise<string> {
    const candidate = resolve(input);
    if (mustExist) await lstat(candidate);
    return candidate;
  }

  private async prepareHostDestination(
    hostPath: string,
    overwrite: boolean
  ): Promise<void> {
    const parent = dirname(hostPath);
    await mkdir(parent, { recursive: true });
    await rejectCaseConflict(hostPath);
    try {
      const info = await lstat(hostPath);
      if (info.isSymbolicLink()) {
        throw new Error("HOST_SYMLINK_REJECTED");
      }
      if (info.isDirectory()) {
        throw new Error("HOST_DESTINATION_IS_DIRECTORY");
      }
      if (!overwrite) {
        throw new Error("HOST_DESTINATION_EXISTS");
      }
    } catch (error) {
      if (!isMissing(error)) {
        throw error;
      }
    }
  }

  private async guestOk(
    sessionId: string,
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.requestGuest(
      sessionId,
      method,
      params,
      this.requestTimeoutMs
    );
    if (!response.ok) {
      throw new Error(`${response.code}:${response.message}`);
    }
    return isRecord(response.data) ? response.data : {};
  }

  private register(sessionId: string): ActiveTransfer {
    let resolveDone = (): void => undefined;
    const done = new Promise<void>((resolveDonePromise) => {
      resolveDone = resolveDonePromise;
    });
    const transfer: ActiveTransfer = {
      operationId: randomUUID(),
      sessionId,
      cancelled: false,
      guestTransferId: undefined,
      hostTempPath: undefined,
      hostMetaPath: undefined,
      done,
      resolveDone
    };
    let set = this.active.get(sessionId);
    if (!set) {
      set = new Set();
      this.active.set(sessionId, set);
    }
    set.add(transfer);
    this.onResourceOpened(sessionId, `transfer:${transfer.operationId}`);
    return transfer;
  }

  private unregister(transfer: ActiveTransfer): void {
    const set = this.active.get(transfer.sessionId);
    set?.delete(transfer);
    if (set?.size === 0) {
      this.active.delete(transfer.sessionId);
    }
    this.onResourceClosed(
      transfer.sessionId,
      `transfer:${transfer.operationId}`
    );
    transfer.resolveDone();
  }

  private assertActive(transfer: ActiveTransfer): void {
    if (transfer.cancelled) {
      throw new Error("TRANSFER_CANCELLED");
    }
  }

  private retainHostPartial(
    sessionId: string,
    tempPath: string,
    metaPath: string
  ): void {
    let partials = this.retainedHostPartials.get(sessionId);
    if (!partials) {
      partials = new Set();
      this.retainedHostPartials.set(sessionId, partials);
    }
    partials.add(tempPath);
    partials.add(metaPath);
  }

  private releaseHostPartial(
    sessionId: string,
    tempPath: string,
    metaPath: string
  ): void {
    const partials = this.retainedHostPartials.get(sessionId);
    partials?.delete(tempPath);
    partials?.delete(metaPath);
    if (partials?.size === 0) {
      this.retainedHostPartials.delete(sessionId);
    }
  }
}

async function hashOpenFile(
  file: Awaited<ReturnType<typeof open>>,
  size: number
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const wanted = Math.min(buffer.length, size - offset);
    const read = await file.read(buffer, 0, wanted, offset);
    if (read.bytesRead <= 0) {
      throw new Error("HOST_FILE_CHANGED_DURING_TRANSFER");
    }
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  return hash.digest("hex");
}

async function openPullPartial(
  tempPath: string,
  metaPath: string,
  guestPath: string
): Promise<PullPartial> {
  const [tempInfo, metaInfo] = await Promise.all([
    optionalLstat(tempPath),
    optionalLstat(metaPath)
  ]);
  if (tempInfo?.isSymbolicLink() || metaInfo?.isSymbolicLink()) {
    throw new Error("HOST_SYMLINK_REJECTED");
  }
  const tempSize = tempInfo ? Number(tempInfo.size) : 0;
  if (
    tempInfo?.isFile() &&
    metaInfo?.isFile() &&
    Number.isSafeInteger(tempSize) &&
    tempSize <= MAX_WIN98_FILE_BYTES
  ) {
    try {
      const metadata = JSON.parse(await readFile(metaPath, "utf8")) as unknown;
      const metadataSize = isRecord(metadata)
        ? metadata["expectedSize"]
        : undefined;
      if (
        isRecord(metadata) &&
        metadata["version"] === 1 &&
        metadata["guestPath"] === guestPath &&
        typeof metadataSize === "number" &&
        Number.isSafeInteger(metadataSize) &&
        metadataSize >= tempSize &&
        metadataSize <= MAX_WIN98_FILE_BYTES
      ) {
        return {
          file: await open(tempPath, "r+"),
          offset: tempSize,
          expectedSize: metadataSize
        };
      }
    } catch {
      // Invalid/crash-truncated metadata is safely restarted below.
    }
  }
  await Promise.allSettled([
    rm(tempPath, { force: true }),
    rm(metaPath, { force: true })
  ]);
  return {
    file: await open(tempPath, "wx+", 0o600),
    offset: 0,
    expectedSize: undefined
  };
}

async function writePullMetadata(
  metaPath: string,
  guestPath: string,
  expectedSize: number
): Promise<void> {
  await writeFile(
    metaPath,
    `${JSON.stringify({ version: 1, guestPath, expectedSize })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 }
  );
}

async function updateOpenFileHash(
  hash: ReturnType<typeof createHash>,
  file: Awaited<ReturnType<typeof open>>,
  size: number
): Promise<void> {
  const buffer = Buffer.allocUnsafe(TRANSFER_CHUNK_BYTES);
  let offset = 0;
  while (offset < size) {
    const wanted = Math.min(buffer.length, size - offset);
    const read = await file.read(buffer, 0, wanted, offset);
    if (read.bytesRead <= 0) {
      throw new Error("HOST_PARTIAL_CHANGED_DURING_TRANSFER");
    }
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
}

async function optionalLstat(
  candidate: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

function discardHostPartial(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^(?:TRANSFER_(?:HASH|SIZE|OFFSET|CHUNK|RESUME)|GUEST_(?:FILE_CHANGED|RESPONSE_INVALID)|HOST_(?:SHORT_WRITE|PARTIAL_CHANGED))/u.test(
    message
  );
}

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
}

async function collectHostTree(
  root: string,
  assertActive: () => void
): Promise<HostEntry[]> {
  const entries: HostEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    const names = new Set<string>();
    for (const child of children) {
      assertActive();
      const folded = child.name.toLowerCase();
      if (names.has(folded)) {
        throw new Error(`CASE_INSENSITIVE_COLLISION:${directory}:${child.name}`);
      }
      names.add(folded);
      const absolutePath = resolve(directory, child.name);
      const info = await lstat(absolutePath);
      if (child.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error(`HOST_SYMLINK_REJECTED:${absolutePath}`);
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name;
      if (info.isDirectory()) {
        entries.push({
          relativePath,
          absolutePath,
          isDirectory: true,
          size: 0
        });
        await visit(absolutePath, relativePath);
      } else if (info.isFile()) {
        if (info.size > MAX_WIN98_FILE_BYTES) {
          throw new Error(`FILE_TOO_LARGE_FOR_WIN98:${absolutePath}`);
        }
        entries.push({
          relativePath,
          absolutePath,
          isDirectory: false,
          size: info.size
        });
      } else {
        throw new Error(`HOST_FILE_TYPE_UNSUPPORTED:${absolutePath}`);
      }
    }
  };
  await visit(root, "");
  return entries;
}

async function ensureDirectoryDestination(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error("HOST_SYMLINK_REJECTED");
    }
    if (!info.isDirectory()) {
      throw new Error("HOST_DESTINATION_NOT_DIRECTORY");
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
    await mkdir(path, { recursive: true });
  }
}

async function rejectCaseConflict(path: string): Promise<void> {
  const parent = dirname(path);
  let entries: string[];
  try {
    entries = await readdir(parent);
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw error;
  }
  const name = basename(path);
  const collision = entries.find(
    (entry) => entry.toLowerCase() === name.toLowerCase() && entry !== name
  );
  if (collision) {
    throw new Error(`CASE_INSENSITIVE_COLLISION:${collision}:${name}`);
  }
}

function resolveRelative(root: string, portableRelativePath: string): string {
  const parts = portableRelativePath.split("/");
  const candidate = resolve(root, ...parts);
  if (!isWithin(root, candidate)) {
    throw new Error("HOST_PATH_OUTSIDE_ALLOWED_ROOTS");
  }
  return candidate;
}

/** Prevent a guest-provided directory entry from escaping its selected destination. */
function isWithin(root: string, candidate: string): boolean {
  const result = relative(resolve(root), resolve(candidate));
  return result === "" || (!result.startsWith(`..${sep}`) && result !== ".." && !isAbsolute(result));
}

function joinGuestPath(root: string, portableRelativePath: string): string {
  return win32.join(root, ...portableRelativePath.split("/"));
}

function validateGuestEntryName(name: string): void {
  if (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("\\") ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new Error("GUEST_DIRECTORY_ENTRY_INVALID");
  }
}

function emptyProgress(
  direction: TransferProgress["direction"],
  source: string,
  destination: string
): TransferProgress {
  return {
    direction,
    files: 0,
    directories: 0,
    bytes: 0,
    chunks: 0,
    skipped: 0,
    source,
    destination
  };
}

function requireString(
  params: Record<string, unknown>,
  key: string
): string {
  const value = params[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`PARAMETER_REQUIRED:${key}`);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`GUEST_RESPONSE_INVALID:${key}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`GUEST_RESPONSE_INVALID:${key}`);
  }
  return value;
}

function booleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`GUEST_RESPONSE_INVALID:${key}`);
  }
  return value;
}

function base64Field(record: Record<string, unknown>, key: string): Buffer {
  const value = stringField(record, key);
  if (value === "") {
    return Buffer.alloc(0);
  }
  const data = Buffer.from(value, "base64");
  if (
    data.toString("base64").replace(/=+$/u, "") !==
    value.replace(/=+$/u, "")
  ) {
    throw new Error(`GUEST_RESPONSE_INVALID:${key}`);
  }
  return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
