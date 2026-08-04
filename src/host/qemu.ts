import { randomUUID } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { PNG } from "pngjs";

export type QemuProfileName = "win98" | "winxp" | "win10" | "generic";
export type QemuAcceleration = "auto" | "tcg" | "whpx" | "kvm" | "hvf";

export interface QemuManagerConfig {
  root: string;
  binary?: string;
  logger?: (level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>) => void;
}

interface VmDefinition {
  version: 1;
  id: string;
  name: string;
  profile: QemuProfileName;
  qemuBinary?: string;
  architecture: string;
  /** auto selects a host-appropriate accelerator with TCG fallback. */
  acceleration: QemuAcceleration;
  machine?: string;
  memory: string;
  cpus: number;
  disk: { enabled: boolean; path?: string; interface?: string };
  network: { mode: "user" | "disabled" | "custom"; args?: string[] };
  /** Broker-owned, read-only ISO stored beneath this VM's media directory. */
  cdromMediaId?: string;
  /** Named QEMU argument groups inherited from the selected profile. */
  components: Record<string, string[]>;
  extraArgs: string[];
  createdAt: string;
  updatedAt: string;
}

interface RuntimeState {
  pid?: number;
  qmpPort?: number;
  startedAt?: string;
  desiredState: "stopped" | "running" | "restarting";
  generation?: string;
  lastExit?: { at: string; code: number | null; signal: NodeJS.Signals | null; expected: boolean };
}

interface TrashEntry {
  id: string;
  name: string;
  deletedAt: string;
  originalPath: string;
  reason: string;
}

export interface QemuResult {
  ok: boolean;
  code: string;
  message: string;
  data?: Record<string, unknown>;
  image?: { mimeType: "image/png"; data: string };
}

const PROFILE_DEFAULTS: Record<QemuProfileName, Omit<VmDefinition, "version" | "id" | "name" | "qemuBinary" | "disk" | "network" | "extraArgs" | "createdAt" | "updatedAt">> = {
  // Windows 98 SE defaults: a Pentium II and Cirrus SVGA are broadly
  // compatible with period drivers. HPET, in-kernel interrupt chips, and USB
  // are disabled for the period-correct PC platform. 256 MiB remains below
  // the unpatched VCache limit.
  win98: { profile: "win98", architecture: "i386", acceleration: "auto", machine: "pc", memory: "256M", cpus: 1, components: { display: ["-display", "none", "-vga", "cirrus"], machine: ["-M", "pc,hpet=off,kernel-irqchip=off,usb=off"], memory: ["-m", "256M"], cpu: ["-smp", "1", "-cpu", "pentium2"], audio: [], network: [], disk: [] } },
  winxp: { profile: "winxp", architecture: "i386", acceleration: "auto", machine: "pc-i440fx-7.2", memory: "512M", cpus: 1, components: { display: ["-display", "none"], machine: ["-M", "pc-i440fx-7.2,hpet=off,kernel-irqchip=off,usb=off"], memory: ["-m", "512M"], cpu: ["-smp", "1"], audio: [], network: [], disk: [] } },
  win10: { profile: "win10", architecture: "x86_64", acceleration: "auto", machine: "q35", memory: "2G", cpus: 2, components: { display: ["-display", "none"], machine: ["-M", "q35,hpet=off,kernel-irqchip=off,usb=off"], memory: ["-m", "2G"], cpu: ["-smp", "2"], audio: [], network: [], disk: [] } },
  generic: { profile: "generic", architecture: "i386", acceleration: "auto", machine: "pc", memory: "512M", cpus: 1, components: { display: ["-display", "none"], machine: ["-M", "pc,hpet=off,kernel-irqchip=off,usb=off"], memory: ["-m", "512M"], cpu: ["-smp", "1"], audio: [], network: [], disk: [] } }
};

/**
 * Hardware accelerators execute guest CPU instructions directly and therefore
 * require a matching host and guest ISA. `auto` always includes TCG last so a
 * missing host feature never prevents a VM from starting.
 */
export function qemuAccelerationPlan(requested: QemuAcceleration, guestArchitecture: string, hostPlatform = process.platform, hostArchitecture = process.arch): string[] {
  if (requested !== "auto") return [requested];
  const x86Guest = guestArchitecture === "i386" || guestArchitecture === "x86_64";
  if (!x86Guest || hostArchitecture !== "x64") return ["tcg"];
  if (hostPlatform === "win32") return ["whpx", "tcg"];
  if (hostPlatform === "linux") return ["kvm", "tcg"];
  if (hostPlatform === "darwin") return ["hvf", "tcg"];
  return ["tcg"];
}

/** Keep host resources bounded. */
const MAX_MANAGED_VMS = 4;

/**
 * Owns managed QEMU definitions and their local QMP endpoints.  No QMP socket
 * is ever published outside loopback; the broker is the only control peer.
 */
export class QemuManager {
  private readonly running = new Map<string, ChildProcess>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, string>();
  private readonly exitCleanups = new Map<string, Promise<void>>();
  /** Inventory and trash mutations share one critical section across VM IDs. */
  private inventoryChain: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: QemuManagerConfig) {}

  async initialize(): Promise<void> {
    await Promise.all([mkdir(this.vmsDir(), { recursive: true }), mkdir(this.trashDir(), { recursive: true })]);
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.running.keys()].map((id) => this.stopVm(id, true)));
  }

  async execute(method: string, params: Record<string, unknown>): Promise<QemuResult | undefined> {
    if (!method.startsWith("qemu_")) return undefined;
    try {
      switch (method) {
        case "qemu_doctor": return await this.doctor(params);
        case "qemu_vm_list": return this.ok("Managed QEMU VMs.", { vms: await this.list() });
        case "qemu_vm_status": return await this.status(this.requireId(params));
        case "qemu_vm_command_preview": return await this.preview(params);
        case "qemu_vm_create": return await this.create(params);
        case "qemu_vm_update": return await this.update(params);
        case "qemu_vm_start": return await this.startVm(this.requireId(params));
        case "qemu_vm_shutdown": return await this.shutdownVm(this.requireId(params), false);
        case "qemu_vm_restart": return await this.restartVm(this.requireId(params));
        case "qemu_vm_force_stop": return await this.stopVm(this.requireId(params), true);
        case "qemu_vm_delete": return await this.deleteVm(this.requireId(params), params.force === true);
        case "qemu_vm_trash_list": return this.ok("QEMU trash entries.", { entries: await this.trashList() });
        case "qemu_vm_restore": return await this.restore(this.requireId(params));
        case "qemu_vm_trash_empty": return await this.emptyTrash();
        case "qemu_snapshot_list": return await this.snapshots(this.requireId(params));
        case "qemu_snapshot_create": return await this.snapshot(this.requireId(params), this.requireString(params, "name"), "create");
        case "qemu_snapshot_restore": return await this.snapshot(this.requireId(params), this.requireString(params, "name"), "restore");
        case "qemu_snapshot_delete": return await this.snapshot(this.requireId(params), this.requireString(params, "name"), "delete");
        case "qemu_vm_metrics": return await this.metrics(this.requireId(params));
        case "qemu_media_push": return await this.pushMedia(this.requireId(params), params);
        case "qemu_media_list": return await this.listMedia(this.requireId(params));
        case "qemu_media_mount": return await this.mountMedia(this.requireId(params), this.requireMediaId(params));
        case "qemu_media_eject": return await this.ejectMedia(this.requireId(params));
        case "qemu_media_delete": return await this.deleteMedia(this.requireId(params), this.requireMediaId(params), params.force === true);
        case "qemu_media_set_boot": return await this.setMediaBoot(this.requireId(params), this.requireString(params, "device"));
        case "qemu_screen_capture": return await this.capture(this.requireId(params));
        case "qemu_qmp_execute": return await this.qmpExecute(this.requireId(params), this.requireString(params, "command"), this.record(params.arguments));
        case "qemu_hmp_command": return await this.qmpExecute(this.requireId(params), "human-monitor-command", { "command-line": this.requireString(params, "command") });
        case "qemu_keyboard_key": return await this.key(this.requireId(params), params);
        case "qemu_keyboard_type": return await this.type(this.requireId(params), this.requireString(params, "text"));
        case "qemu_mouse_move": return await this.pointer(this.requireId(params), params, "move");
        case "qemu_mouse_click": return await this.pointer(this.requireId(params), params, "click");
        default: return this.error("QEMU_METHOD_UNSUPPORTED", `Unsupported QEMU method: ${method}.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^([A-Z0-9_]+):/.exec(message)?.[1] ?? "QEMU_ERROR";
      return this.error(code, message.replace(/^[A-Z0-9_]+:\s*/, ""));
    }
  }

  private async create(params: Record<string, unknown>): Promise<QemuResult> {
    return this.serialInventory(() => this.createUnlocked(params));
  }

  private async createUnlocked(params: Record<string, unknown>): Promise<QemuResult> {
    const name = this.requireString(params, "name");
    const suppliedId = typeof params.vm_id === "string" ? params.vm_id.trim() : undefined;
    if (suppliedId !== undefined && !isVmId(suppliedId)) throw new Error("INVALID_ARGUMENT: vm_id must use letters, digits, underscore, and hyphen only.");
    const id = suppliedId ?? slug(name);
    if (!id) throw new Error("INVALID_ARGUMENT: vm_id or name must contain letters or digits.");
    const destination = this.vmDir(id);
    if (await exists(destination)) return this.error("QEMU_VM_ALREADY_EXISTS", `A managed VM named ${id} already exists.`);
    const existing = await this.liveVmIds();
    if (existing.length >= MAX_MANAGED_VMS) {
      return this.error(
        "QEMU_VM_LIMIT_REACHED",
        `This broker manages at most ${MAX_MANAGED_VMS} live VMs. Delete a VM first with qemu_vm_delete, then create ${id}.`
      );
    }
    const definition = this.definitionFrom(params, id, name);
    const staging = join(this.vmsDir(), `.creating-${id}-${randomUUID()}`);
    try {
      await mkdir(join(staging, "media"), { recursive: true });
      if (definition.disk.enabled) {
        const source = this.requireString(params, "disk_path");
        if (!(await exists(source))) throw new Error("QEMU_DISK_NOT_FOUND: disk_path does not exist on the broker host.");
        const target = join(staging, "disk.qcow2");
        await this.importDisk(source, target, definition);
        definition.disk.path = "disk.qcow2";
      }
      await writeFile(join(staging, "vm.json"), `${JSON.stringify(definition, null, 2)}\n`, "utf8");
      await mkdir(join(staging, "runtime"), { recursive: true });
      await writeFile(join(staging, "runtime", "state.json"), `${JSON.stringify({ desiredState: "stopped" }, null, 2)}\n`, "utf8");
      await rename(staging, destination);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
    this.log("info", "qemu_vm_created", { id, profile: definition.profile });
    return this.ok("Managed QEMU VM created.", { vm: await this.describe(definition) });
  }

  private async update(params: Record<string, unknown>): Promise<QemuResult> {
    const id = this.requireId(params);
    return this.serial(id, async () => {
      if (await this.isRunningOrRecovered(id)) return this.error("QEMU_VM_RUNNING", "Stop the VM before changing its definition.");
      const previous = await this.readDefinition(id);
      // Keep the raw update request separate from the previous definition.
      // definitionFrom already applies previous values as fallbacks; merging
      // them here made an old scalar `machine` value overwrite an explicit
      // profile_overrides.machine component.
      const merged = this.definitionFrom({ ...params, name: typeof params.name === "string" ? params.name : previous.name }, id, typeof params.name === "string" ? params.name : previous.name, previous);
      await this.writeDefinition(merged);
      return this.ok("Managed QEMU VM definition updated.", { vm: await this.describe(merged) });
    });
  }

  private async preview(params: Record<string, unknown>): Promise<QemuResult> {
    const id = typeof params.vm_id === "string" ? params.vm_id : undefined;
    const definition = id && await exists(this.definitionPath(id))
      ? await this.readDefinition(id)
      : this.definitionFrom(params, id ?? "preview", typeof params.name === "string" ? params.name : "Preview");
    const binary = await this.resolveBinary(definition);
    const port = 0;
    return this.ok("Generated managed QEMU command.", { binary, args: this.command(definition, port), warnings: this.commandWarnings(definition) });
  }

  private async startVm(id: string): Promise<QemuResult> { return this.serial(id, () => this.startVmUnlocked(id)); }

  private async startVmUnlocked(id: string): Promise<QemuResult> {
      if (this.running.has(id)) return this.ok("QEMU VM is already running.", { vm: await this.statusData(id) });
      if (await this.hasRecoveredProcess(id)) return this.error("QEMU_VM_RECOVERY_REQUIRED", "A QEMU process from an earlier broker instance is still alive. Stop it with qemu_vm_force_stop before starting this VM again.");
      const definition = await this.readDefinition(id);
      const binary = await this.resolveBinary(definition);
      const port = await freePort();
      const args = this.command(definition, port);
      this.log("info", "qemu_vm_starting", { id, binary, qmpPort: port, args });
      await mkdir(this.runtimeDir(id), { recursive: true });
      let child: ChildProcess;
      try {
        child = spawn(binary, args, { cwd: this.vmDir(id), windowsHide: !this.visibleDisplay(definition), stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        throw error;
      }
      const generation = randomUUID();
      const runtime: RuntimeState = { ...(child.pid !== undefined ? { pid: child.pid } : {}), qmpPort: port, startedAt: new Date().toISOString(), desiredState: "running", generation };
      this.running.set(id, child);
      this.generations.set(id, generation);
      this.log("info", "qemu_vm_spawned", { id, pid: child.pid });
      await this.writeRuntime(id, runtime);
      let cleanedUp = false;
      const onTerminal = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        this.running.delete(id);
        const cleanup = this.finalizeExit(id, generation, code, signal);
        this.exitCleanups.set(id, cleanup);
        void cleanup.then(() => undefined, () => undefined).finally(() => { if (this.exitCleanups.get(id) === cleanup) this.exitCleanups.delete(id); });
        this.log(spawnError ? "error" : "warn", spawnError ? "qemu_spawn_error" : "qemu_vm_exited", { id, code, signal, ...(spawnError ? { message: spawnError.message } : {}) });
      };
      child.stdout?.on("data", (data: Buffer) => this.log("info", "qemu_stdout", { id, text: data.toString("utf8").slice(0, 4096) }));
      child.stderr?.on("data", (data: Buffer) => this.log("warn", "qemu_stderr", { id, text: data.toString("utf8").slice(0, 4096) }));
      child.once("exit", (code, signal) => onTerminal(code, signal));
      child.once("error", (error) => onTerminal(null, null, error));
      try {
        const ready = await waitFor(async () => { await this.qmp(id, "query-status"); return true; }, 8_000);
        if (!ready) throw new Error("QMP startup timed out");
      } catch (error) {
        await this.stopVmUnlocked(id, true);
        throw new Error(`QEMU_QMP_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.ok("QEMU VM started.", { vm: await this.statusData(id), command: { binary, args } });
  }

  private async shutdownVm(id: string, restart: boolean): Promise<QemuResult> { return this.serial(id, () => this.shutdownVmUnlocked(id, restart)); }

  private async shutdownVmUnlocked(id: string, restart: boolean): Promise<QemuResult> {
      if (!this.running.has(id)) {
        if (await this.hasRecoveredProcess(id)) return this.stopRecoveredVm(id, restart);
        return this.ok("QEMU VM is already stopped.", { vm: await this.statusData(id) });
      }
      const runtime = await this.readRuntime(id);
      await this.writeRuntime(id, { ...runtime, desiredState: restart ? "restarting" : "stopped" });
      await this.qmp(id, "system_powerdown").catch(() => undefined);
      const exited = await waitFor(() => !this.running.has(id), 40_000).catch(() => false);
      if (!exited) {
        await this.qmp(id, "quit").catch(() => undefined);
        await waitFor(() => !this.running.has(id), 5_000).catch(() => false);
      }
      if (this.running.has(id)) await this.kill(id);
      await this.awaitExitCleanup(id);
      if (restart) return this.startVmUnlocked(id);
      return this.ok("QEMU VM shut down.", { vm: await this.statusData(id) });
  }

  private async restartVm(id: string): Promise<QemuResult> { return this.shutdownVm(id, true); }

  private async stopVm(id: string, force: boolean): Promise<QemuResult> { return this.serial(id, () => this.stopVmUnlocked(id, force)); }

  private async stopVmUnlocked(id: string, force: boolean): Promise<QemuResult> {
      if (!this.running.has(id)) {
        if (await this.hasRecoveredProcess(id)) return this.stopRecoveredVm(id, false);
        return this.ok("QEMU VM is already stopped.", { vm: await this.statusData(id) });
      }
      if (!force) return this.shutdownVmUnlocked(id, false);
      await this.writeRuntime(id, { ...(await this.readRuntime(id)), desiredState: "stopped" });
      await this.qmp(id, "quit").catch(() => undefined);
      await waitFor(() => !this.running.has(id), 2_000).catch(() => false);
      if (this.running.has(id)) await this.kill(id);
      await this.awaitExitCleanup(id);
      return this.ok("QEMU VM force-stopped.", { vm: await this.statusData(id) });
  }

  private async deleteVm(id: string, force: boolean): Promise<QemuResult> {
    return this.serial(id, () => this.serialInventory(async () => {
      if (!(await exists(this.vmDir(id)))) return this.error("QEMU_VM_NOT_FOUND", `Managed VM ${id} does not exist.`);
      if (await this.isRunningOrRecovered(id)) {
        if (!force) return this.error("QEMU_VM_RUNNING", "Stop the VM first, or use force=true.");
        await this.stopVmUnlocked(id, true);
        await this.awaitExitCleanup(id);
      }
      const definition = await this.readDefinition(id);
      const entry: TrashEntry = { id, name: definition.name, deletedAt: new Date().toISOString(), originalPath: this.vmDir(id), reason: "user_delete" };
      const trashPath = join(this.trashDir(), `${entry.deletedAt.replace(/[:.]/g, "-")}-${id}`);
      await rename(this.vmDir(id), trashPath);
      const entries = [...await this.trashList(), entry];
      await this.writeTrash(entries);
      await this.trimTrash();
      return this.ok("QEMU VM moved to managed trash.", { entry, retained: (await this.trashList()).length });
    }));
  }

  private async restore(id: string): Promise<QemuResult> {
    return this.serialInventory(() => this.restoreUnlocked(id));
  }

  private async restoreUnlocked(id: string): Promise<QemuResult> {
    if ((await this.liveVmIds()).length >= MAX_MANAGED_VMS) return this.error("QEMU_VM_LIMIT_REACHED", `This broker manages at most ${MAX_MANAGED_VMS} live VMs. Delete a VM first before restoring ${id}.`);
    const entries = await this.trashList();
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) return this.error("QEMU_TRASH_NOT_FOUND", `No trashed VM named ${id} exists.`);
    if (await exists(this.vmDir(id))) return this.error("QEMU_VM_ALREADY_EXISTS", `A live VM named ${id} already exists.`);
    const source = join(this.trashDir(), `${entry.deletedAt.replace(/[:.]/g, "-")}-${id}`);
    if (!(await exists(source))) return this.error("QEMU_TRASH_CORRUPT", "The tracked trash directory no longer exists.");
    await rename(source, this.vmDir(id));
    await this.writeTrash(entries.filter((candidate) => candidate !== entry));
    return this.ok("QEMU VM restored from trash.", { vm: await this.statusData(id) });
  }

  private async emptyTrash(): Promise<QemuResult> {
    return this.serialInventory(async () => {
      const entries = await this.trashList();
      await Promise.all(entries.map((entry) => rm(join(this.trashDir(), `${entry.deletedAt.replace(/[:.]/g, "-")}-${entry.id}`), { recursive: true, force: true })));
      await this.writeTrash([]);
      return this.ok("QEMU trash emptied.", { deleted: entries.length });
    });
  }

  private async snapshots(id: string): Promise<QemuResult> { return this.serial(id, () => this.snapshotsUnlocked(id)); }
  private async snapshotsUnlocked(id: string): Promise<QemuResult> {
    const definition = await this.readDefinition(id);
    await this.requireStopped(id);
    const disk = this.diskPath(id, definition);
    const output = await run(await this.qemuImg(definition), ["snapshot", "-l", disk]);
    return this.ok("qcow2 snapshots.", { snapshots: parseSnapshots(output) });
  }

  private async snapshot(id: string, name: string, action: "create" | "restore" | "delete"): Promise<QemuResult> { return this.serial(id, () => this.snapshotUnlocked(id, name, action)); }
  private async snapshotUnlocked(id: string, name: string, action: "create" | "restore" | "delete"): Promise<QemuResult> {
    const definition = await this.readDefinition(id);
    await this.requireStopped(id);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error("INVALID_ARGUMENT: snapshot names use letters, digits, dot, underscore, and hyphen only.");
    const flag = action === "create" ? "-c" : action === "restore" ? "-a" : "-d";
    await run(await this.qemuImg(definition), ["snapshot", flag, name, this.diskPath(id, definition)]);
    return this.ok(`Snapshot ${action} completed.`, { name, action });
  }

  private async metrics(id: string): Promise<QemuResult> {
    const runtime = await this.readRuntime(id);
    const running = await this.isRunningOrRecovered(id);
    return this.ok("QEMU process metrics.", { pid: runtime.pid, running, startedAt: runtime.startedAt, cpuPercent: undefined, rssBytes: undefined, qmp: running ? await this.qmp(id, "query-status").catch(() => undefined) : undefined });
  }

  private async capture(id: string): Promise<QemuResult> {
    const path = join(this.runtimeDir(id), `screen-${randomUUID()}.ppm`);
    let image: Buffer;
    try {
      await this.qmp(id, "screendump", { filename: path });
      image = ppmToPng(await readFile(path));
    } finally { await rm(path, { force: true }); }
    return { ...this.ok("QEMU display captured."), image: { mimeType: "image/png", data: image.toString("base64") } };
  }

  private async key(id: string, params: Record<string, unknown>): Promise<QemuResult> {
    const key = normalizeQemuKey(this.requireString(params, "key"));
    const action = typeof params.action === "string" ? params.action : "press";
    const events = action === "press"
      ? [{ type: "key", data: { key: { type: "qcode", data: key }, down: true } }, { type: "key", data: { key: { type: "qcode", data: key }, down: false } }]
      : [{ type: "key", data: { key: { type: "qcode", data: key }, down: action === "down" } }];
    await this.qmp(id, "input-send-event", { events });
    return this.ok("QEMU key input sent.");
  }

  private async type(id: string, text: string): Promise<QemuResult> {
    for (const character of text) await this.qmp(id, "human-monitor-command", { "command-line": `sendkey ${qemuSendKey(character)}` });
    return this.ok("QEMU text input sent.");
  }

  private async pointer(id: string, params: Record<string, unknown>, kind: "move" | "click"): Promise<QemuResult> {
    const x = this.number(params, "x", 0, 65535);
    const y = this.number(params, "y", 0, 65535);
    const events: unknown[] = [{ type: "abs", data: { axis: "x", value: x } }, { type: "abs", data: { axis: "y", value: y } }];
    if (kind === "click") {
      const button = typeof params.button === "string" ? params.button : "left";
      events.push({ type: "btn", data: { button, down: true } }, { type: "btn", data: { button, down: false } });
    }
    await this.qmp(id, "input-send-event", { events });
    return this.ok(`QEMU mouse ${kind} sent.`);
  }

  private async qmpExecute(id: string, command: string, qmpArguments: Record<string, unknown>): Promise<QemuResult> {
    const value = await this.qmp(id, command, qmpArguments);
    return this.ok("QMP command completed.", { command, return: value });
  }

  /** Import an ISO into the managed VM directory so QEMU never mounts an arbitrary transient path. */
  private async pushMedia(id: string, params: Record<string, unknown>): Promise<QemuResult> {
    return this.serial(id, async () => {
      const source = this.requireString(params, "source_path");
      if (extname(source).toLowerCase() !== ".iso") throw new Error("QEMU_INVALID_MEDIA: source_path must name an .iso image.");
      const sourceInfo = await stat(source).catch(() => undefined);
      if (!sourceInfo?.isFile()) throw new Error("QEMU_MEDIA_NOT_FOUND: source_path does not exist or is not a regular file on the broker host.");
      const requested = typeof params.media_id === "string" ? params.media_id : basename(source, extname(source));
      const mediaId = this.normalizedMediaId(requested);
      const target = this.mediaPath(id, mediaId);
      if (await exists(target)) return this.error("QEMU_MEDIA_ALREADY_EXISTS", `An ISO named ${mediaId} already exists for ${id}.`);
      await mkdir(this.mediaDir(id), { recursive: true });
      await cp(source, target, { errorOnExist: true, force: false });
      return this.ok("ISO imported into managed VM media.", { media: await this.describeMedia(id, mediaId) });
    });
  }

  private async listMedia(id: string): Promise<QemuResult> {
    const definition = await this.readDefinition(id);
    const entries = await readdir(this.mediaDir(id), { withFileTypes: true }).catch(() => []);
    const media = await Promise.all(entries.filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".iso")
      .map((entry) => this.describeMedia(id, basename(entry.name, extname(entry.name)), definition.cdromMediaId)));
    return this.ok("Managed ISO media.", { media, mountedMediaId: definition.cdromMediaId ?? null });
  }

  private async mountMedia(id: string, mediaId: string): Promise<QemuResult> {
    return this.serial(id, async () => {
      const path = this.mediaPath(id, mediaId);
      if (!(await exists(path))) throw new Error("QEMU_MEDIA_NOT_FOUND: The requested ISO is not present in this VM's managed media directory.");
      const definition = await this.readDefinition(id);
      const updated: VmDefinition = { ...definition, cdromMediaId: mediaId, extraArgs: stripCdromArgs(definition.extraArgs), updatedAt: new Date().toISOString() };
      await this.writeDefinition(updated);
      if (await this.isRunningOrRecovered(id)) {
        const device = await this.cdromDevice(id);
        await this.qmp(id, "human-monitor-command", { "command-line": `change ${device} ${hmpPath(path)}` });
      }
      return this.ok("ISO mounted. It will remain mounted after VM restart.", { media: await this.describeMedia(id, mediaId, mediaId), live: await this.isRunningOrRecovered(id) });
    });
  }

  private async ejectMedia(id: string): Promise<QemuResult> {
    return this.serial(id, async () => {
      const definition = await this.readDefinition(id);
      const updated = withoutCdrom(definition, new Date().toISOString());
      await this.writeDefinition(updated);
      if (await this.isRunningOrRecovered(id)) {
        const device = await this.cdromDevice(id);
        await this.qmp(id, "human-monitor-command", { "command-line": `eject ${device}` });
      }
      return this.ok("CD-ROM ejected. It will remain empty after VM restart.", { live: await this.isRunningOrRecovered(id) });
    });
  }

  private async deleteMedia(id: string, mediaId: string, force: boolean): Promise<QemuResult> {
    return this.serial(id, async () => {
      const definition = await this.readDefinition(id);
      if (definition.cdromMediaId === mediaId) {
        if (!force) return this.error("QEMU_MEDIA_MOUNTED", "Eject this ISO first, or pass force=true to eject and delete it.");
        await this.ejectMediaUnlocked(id, definition);
      }
      const path = this.mediaPath(id, mediaId);
      if (!(await exists(path))) throw new Error("QEMU_MEDIA_NOT_FOUND: The requested ISO is not present in this VM's managed media directory.");
      await rm(path, { force: false });
      return this.ok("Managed ISO deleted.", { mediaId });
    });
  }

  private async setMediaBoot(id: string, device: string): Promise<QemuResult> {
    return this.serial(id, async () => {
      if (!new Set(["disk", "cdrom", "network"]).has(device)) throw new Error("INVALID_ARGUMENT: device must be disk, cdrom, or network.");
      if (await this.isRunningOrRecovered(id)) return this.error("QEMU_VM_RUNNING", "Stop the VM before changing persistent boot order.");
      const definition = await this.readDefinition(id);
      const order = device === "disk" ? "c" : device === "cdrom" ? "d" : "n";
      const components = { ...definition.components, boot: ["-boot", `order=${order}`] };
      await this.writeDefinition({ ...definition, components, updatedAt: new Date().toISOString() });
      return this.ok("Persistent boot device updated.", { device });
    });
  }

  private async ejectMediaUnlocked(id: string, definition: VmDefinition): Promise<void> {
    await this.writeDefinition(withoutCdrom(definition, new Date().toISOString()));
    if (await this.isRunningOrRecovered(id)) {
      const device = await this.cdromDevice(id);
      await this.qmp(id, "human-monitor-command", { "command-line": `eject ${device}` });
    }
  }

  private async cdromDevice(id: string): Promise<string> {
    const blocks = await this.qmp(id, "query-block");
    if (!Array.isArray(blocks)) throw new Error("QEMU_QMP_UNAVAILABLE: QEMU did not return block-device data.");
    const drive = blocks.find((entry) => this.record(entry).removable === true && /(?:cd|dvd|ide1)/i.test(String(this.record(entry).device ?? "")));
    const device = this.record(drive).device;
    if (typeof device !== "string" || !device) throw new Error("QEMU_CDROM_UNAVAILABLE: This VM has no QEMU CD-ROM device.");
    return device;
  }

  private normalizedMediaId(value: string): string {
    const id = value.trim().replace(/\.iso$/i, "");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) throw new Error("INVALID_ARGUMENT: media_id must use letters, digits, dot, underscore, and hyphen only.");
    return id;
  }

  private mediaDir(id: string): string { return join(this.vmDir(id), "media"); }
  private mediaPath(id: string, mediaId: string): string { return join(this.mediaDir(id), `${this.normalizedMediaId(mediaId)}.iso`); }
  private async describeMedia(id: string, mediaId: string, mountedMediaId?: string): Promise<Record<string, unknown>> {
    const info = await stat(this.mediaPath(id, mediaId));
    return { id: mediaId, file: `${mediaId}.iso`, sizeBytes: info.size, modifiedAt: info.mtime.toISOString(), mounted: mountedMediaId === mediaId };
  }

  private async qmp(id: string, command: string, qmpArguments: Record<string, unknown> = {}): Promise<unknown> {
    const runtime = await this.readRuntime(id);
    if (!runtime.qmpPort || !processAlive(runtime.pid)) throw new Error("QEMU_QMP_UNAVAILABLE: VM is not running.");
    return qmpCall(runtime.qmpPort, command, qmpArguments);
  }

  private definitionFrom(params: Record<string, unknown>, id: string, name: string, previous?: VmDefinition): VmDefinition {
    const profile = this.profile(params.profile ?? previous?.profile);
    const base = PROFILE_DEFAULTS[profile];
    const profileChanged = previous !== undefined && typeof params.profile === "string" && params.profile !== previous.profile;
    const record = this.record(params.overrides);
    const diskOverride = this.record(record.disk);
    const networkOverride = this.record(record.network);
    const componentOverrides = this.record(params.profile_overrides);
    const diskEnabled = componentOverrides.disk === false || diskOverride.enabled === false ? false : diskOverride.enabled === true ? true : previous?.disk.enabled ?? true;
    // Treat any legacy network mode as ordinary QEMU user networking so old
    // managed definitions retain their NIC and use the portable TCP route.
    const modeValue = networkOverride.mode ?? previous?.network.mode ?? "user";
    const mode = componentOverrides.network === false ? "disabled" : modeValue === "custom" || modeValue === "disabled" ? modeValue : "user";
    const extraArgs = Array.isArray(params.extra_args) ? params.extra_args.filter((value): value is string => typeof value === "string") : previous?.extraArgs ?? [];
    const components = { ...(profileChanged ? base.components : previous?.components ?? base.components) };
    for (const [name, value] of Object.entries(componentOverrides)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("INVALID_ARGUMENT: profile_overrides keys must be component names.");
      if (value === false) { delete components[name]; continue; }
      if (!Array.isArray(value) || value.some((argument) => typeof argument !== "string" || !argument)) throw new Error(`INVALID_ARGUMENT: profile_overrides.${name} must be false or a non-empty string array.`);
      components[name] = value as string[];
    }
    this.validateGuestArguments([...extraArgs, ...Object.values(components).flat()]);
    if (componentOverrides.network === false) delete components.network;
    if (componentOverrides.disk === false) delete components.disk;
    if (mode !== "disabled" && components.network === undefined) components.network = [];
    if (typeof params.machine === "string") components.machine = ["-machine", params.machine];
    if (typeof params.memory === "string") components.memory = ["-m", params.memory];
    if (typeof params.cpus === "number" && Number.isInteger(params.cpus) && params.cpus > 0) components.cpu = withCpuCount(components.cpu ?? [], params.cpus);
    return {
      version: 1, id, name, profile,
      ...(typeof params.qemu_binary === "string" ? { qemuBinary: params.qemu_binary } : previous?.qemuBinary ? { qemuBinary: previous.qemuBinary } : {}),
      architecture: typeof params.architecture === "string" ? params.architecture : profileChanged ? base.architecture : previous?.architecture ?? base.architecture,
      acceleration: this.acceleration(
        params.acceleration,
        profileChanged ? base.acceleration : previous?.acceleration ?? base.acceleration
      ),
      ...(typeof params.machine === "string" ? { machine: params.machine } : profileChanged ? base.machine ? { machine: base.machine } : {} : previous?.machine ? { machine: previous.machine } : base.machine ? { machine: base.machine } : {}),
      memory: typeof params.memory === "string" ? params.memory : profileChanged ? base.memory : previous?.memory ?? base.memory,
      cpus: typeof params.cpus === "number" && Number.isInteger(params.cpus) && params.cpus > 0 ? params.cpus : profileChanged ? base.cpus : previous?.cpus ?? base.cpus,
      disk: { enabled: diskEnabled, interface: typeof diskOverride.interface === "string" ? diskOverride.interface : previous?.disk.interface ?? "ide", ...(previous?.disk.path ? { path: previous.disk.path } : {}) },
      network: { mode, ...(Array.isArray(networkOverride.args) ? { args: networkOverride.args.filter((value): value is string => typeof value === "string") } : previous?.network.args ? { args: previous.network.args } : {}) },
      ...(previous?.cdromMediaId ? { cdromMediaId: previous.cdromMediaId } : {}),
      components,
      extraArgs,
      createdAt: previous?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString()
    };
  }

  private command(definition: VmDefinition, qmpPort: number): string[] {
    const args = ["-name", definition.name];
    const accelerators = qemuAccelerationPlan(definition.acceleration ?? "auto", definition.architecture);
    for (const name of ["display", "machine", "memory", "cpu", "firmware", "boot", "audio", "devices"]) {
      const component = definition.components[name] ?? [];
      args.push(...(name === "machine" ? this.machineWithAcceleration(component, accelerators) : component));
    }
    for (const [name, component] of Object.entries(definition.components)) if (!["display", "machine", "memory", "cpu", "firmware", "boot", "audio", "devices", "network", "disk"].includes(name)) args.push(...component);
    if (definition.disk.enabled && definition.disk.path) args.push("-drive", `file=${this.diskPath(definition.id, definition)},format=qcow2,if=${definition.disk.interface ?? "ide"}`);
    if (definition.cdromMediaId) args.push("-drive", `file=${this.mediaPath(definition.id, definition.cdromMediaId)},format=raw,media=cdrom,if=ide,id=cdrom0`);
    if (definition.network.mode === "user" && definition.components.network !== undefined) {
      // Slirp reserves 10.0.2.2 as the host gateway on every platform. The
      // guest dials the broker there, so no host LAN/VMware adapter IP needs
      // to be baked into a portable QEMU disk image.
      args.push("-netdev", "user,id=net0", "-device", definition.profile === "win98" ? "rtl8139,netdev=net0" : "e1000,netdev=net0");
    }
    if (definition.network.mode === "custom" && definition.components.network !== undefined) args.push(...(definition.network.args ?? []));
    args.push(...definition.extraArgs);
    if (qmpPort > 0) args.push("-qmp", `tcp:127.0.0.1:${qmpPort},server=on,wait=off`);
    return args;
  }

  private commandWarnings(definition: VmDefinition): string[] {
    const warnings: string[] = [];
    if (definition.network.mode === "disabled" || definition.components.network === undefined) warnings.push("Guest networking is disabled; WIN98CTL cannot reach the host broker through 10.0.2.2.");
    if (!definition.disk.enabled) warnings.push("No broker-managed primary disk is configured.");
    return warnings;
  }

  private visibleDisplay(definition: VmDefinition): boolean {
    const display = definition.components.display ?? [];
    const index = display.indexOf("-display");
    return index >= 0 && ["sdl", "gtk", "default"].includes(display[index + 1] ?? "");
  }

  /** Prevent custom profile components from replacing the broker's process/QMP ownership. */
  private validateGuestArguments(args: string[]): void {
    const forbidden = new Set(["-qmp", "-monitor", "-pidfile", "-daemonize"]);
    for (const argument of args) {
      const option = argument.split("=", 1)[0]!.toLowerCase();
      if (forbidden.has(option)) throw new Error("QEMU_ARGUMENT_CONFLICT: broker-owned QMP/process options cannot be overridden.");
    }
  }

  private async list(): Promise<Record<string, unknown>[]> {
    const entries = await readdir(this.vmsDir(), { withFileTypes: true }).catch(() => []);
    return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => this.statusData(entry.name).catch(() => ({ id: entry.name, state: "invalid" }))));
  }

  private async liveVmIds(): Promise<string[]> {
    const entries = await readdir(this.vmsDir(), { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  private async status(id: string): Promise<QemuResult> { return this.ok("Managed QEMU VM status.", { vm: await this.statusData(id) }); }

  private async statusData(id: string): Promise<Record<string, unknown>> {
    const definition = await this.readDefinition(id);
    const runtime = await this.readRuntime(id);
    const running = await this.isRunningOrRecovered(id);
    return {
      ...await this.describe(definition),
      runtime: { ...runtime, running },
      qmp: running ? await this.qmp(id, "query-status").catch(() => undefined) : undefined,
      guestTcp: definition.network.mode === "user" ? { host: "10.0.2.2", note: "QEMU user-network host gateway; set this in WIN98CTL.INI." } : undefined
    };
  }

  private async describe(definition: VmDefinition): Promise<Record<string, unknown>> { return { id: definition.id, name: definition.name, profile: definition.profile, architecture: definition.architecture, acceleration: definition.acceleration ?? "auto", resolvedAcceleration: qemuAccelerationPlan(definition.acceleration ?? "auto", definition.architecture), machine: definition.machine, memory: definition.memory, cpus: definition.cpus, disk: definition.disk, network: definition.network, components: definition.components, qemuBinary: definition.qemuBinary, extraArgs: definition.extraArgs, createdAt: definition.createdAt, updatedAt: definition.updatedAt }; }

  private async doctor(params: Record<string, unknown>): Promise<QemuResult> {
    const definition = this.definitionFrom(params, "doctor", "Doctor");
    let binary: string | undefined;
    let version: string | undefined;
    let error: string | undefined;
    try {
      binary = await this.resolveBinary(definition);
      version = (await run(binary, ["--version"])).split(/\r?\n/, 1)[0]?.trim();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    return this.ok("QEMU host diagnostics.", {
      root: this.config.root,
      platform: platform(),
      architecture: process.arch,
      binary,
      version,
      binaryError: error,
      acceleration: {
        requested: definition.acceleration ?? "auto",
        selected: qemuAccelerationPlan(definition.acceleration ?? "auto", definition.architecture),
        note: "auto uses the platform accelerator with TCG fallback."
      },
      guestTcp: { host: "10.0.2.2", note: "QEMU user-mode networking presents the host at this stable guest address." }
    });
  }

  private acceleration(value: unknown, fallback: QemuAcceleration): QemuAcceleration {
    return value === "auto" || value === "tcg" || value === "whpx" || value === "kvm" || value === "hvf" ? value : fallback;
  }

  private machineWithAcceleration(component: string[], accelerators: string[]): string[] {
    const args = [...component];
    const index = args.indexOf("-machine") >= 0 ? args.indexOf("-machine") : args.indexOf("-M");
    if (index < 0 || !args[index + 1]) return [...args, "-accel", accelerators[0] ?? "tcg"];
    const machine = args[index + 1]!;
    // A custom machine component may already specify accel=; do not override it.
    if (!/(^|,)accel=/.test(machine)) {
      const [type, ...properties] = machine.split(",");
      args[index + 1] = `${type},accel=${accelerators.join(":")}${properties.length ? `,${properties.join(",")}` : ""}`;
    }
    return args;
  }

  private async resolveBinary(definition: VmDefinition): Promise<string> {
    const requested = definition.qemuBinary ?? this.config.binary;
    if (requested) {
      const absolute = resolve(requested);
      if (!(await exists(absolute))) throw new Error(`QEMU_NOT_FOUND: ${requested}`);
      return absolute;
    }
    const suffix = process.platform === "win32" ? ".exe" : "";
    // Current Windows QEMU packages expose WHPX through the x86_64 system
    // emulator, not qemu-system-i386. The x86_64 PC emulator still runs a
    // 32-bit Pentium II guest, so select it for all x86 managed guests.
    const systemArchitecture = process.platform === "win32" && (definition.architecture === "i386" || definition.architecture === "x86_64")
      ? "x86_64"
      : definition.architecture;
    const candidate = process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "qemu", `qemu-system-${systemArchitecture}${suffix}`) : `qemu-system-${systemArchitecture}`;
    if (process.platform === "win32" && await exists(candidate)) return candidate;
    return candidate;
  }

  private async qemuImg(definition: VmDefinition): Promise<string> {
    const binary = await this.resolveBinary(definition);
    const candidate = join(dirname(binary), `qemu-img${process.platform === "win32" ? ".exe" : ""}`);
    if (await exists(candidate)) return candidate;
    return process.platform === "win32" ? "qemu-img.exe" : "qemu-img";
  }

  private async importDisk(source: string, target: string, definition: VmDefinition): Promise<void> {
    if (extname(source).toLowerCase() === ".qcow2") { await cp(source, target); return; }
    const img = await this.qemuImg(definition);
    await run(img, ["convert", "-O", "qcow2", source, target]);
  }


  private async readDefinition(id: string): Promise<VmDefinition> {
    try { return JSON.parse(await readFile(this.definitionPath(id), "utf8")) as VmDefinition; } catch { throw new Error(`QEMU_VM_NOT_FOUND: Managed VM ${id} does not exist.`); }
  }
  private async writeDefinition(definition: VmDefinition): Promise<void> { await writeFile(this.definitionPath(definition.id), `${JSON.stringify(definition, null, 2)}\n`, "utf8"); }
  private async readRuntime(id: string): Promise<RuntimeState> { try { return JSON.parse(await readFile(this.runtimePath(id), "utf8")) as RuntimeState; } catch { return { desiredState: "stopped" }; } }
  private async writeRuntime(id: string, runtime: RuntimeState): Promise<void> { await mkdir(this.runtimeDir(id), { recursive: true }); await writeFile(this.runtimePath(id), `${JSON.stringify(runtime, null, 2)}\n`, "utf8"); }
  private async trashList(): Promise<TrashEntry[]> { try { const value = JSON.parse(await readFile(this.trashIndex(), "utf8")); return Array.isArray(value) ? value as TrashEntry[] : []; } catch { return []; } }
  private async writeTrash(entries: TrashEntry[]): Promise<void> { await writeFile(this.trashIndex(), `${JSON.stringify(entries, null, 2)}\n`, "utf8"); }
  private async trimTrash(): Promise<void> { const entries = (await this.trashList()).sort((a, b) => a.deletedAt.localeCompare(b.deletedAt)); while (entries.length > 3) { const oldest = entries.shift()!; await rm(join(this.trashDir(), `${oldest.deletedAt.replace(/[:.]/g, "-")}-${oldest.id}`), { recursive: true, force: true }); } await this.writeTrash(entries); }
  private async requireStopped(id: string): Promise<void> { if (await this.isRunningOrRecovered(id)) throw new Error("QEMU_VM_MUST_BE_STOPPED: Stop the VM before modifying qcow2 snapshots."); }
  private async hasRecoveredProcess(id: string): Promise<boolean> { if (this.running.has(id)) return false; const runtime = await this.readRuntime(id); return runtime.pid !== undefined && processAlive(runtime.pid); }
  private async isRunningOrRecovered(id: string): Promise<boolean> { return this.running.has(id) || await this.hasRecoveredProcess(id); }
  private async awaitExitCleanup(id: string): Promise<void> { await this.exitCleanups.get(id)?.catch(() => undefined); }
  private async finalizeExit(id: string, generation: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> { if (this.generations.get(id) !== generation) return; await this.writeRuntime(id, { desiredState: "stopped", lastExit: { at: new Date().toISOString(), code, signal, expected: false } }); this.generations.delete(id); }
  private async stopRecoveredVm(id: string, restart: boolean): Promise<QemuResult> { const runtime = await this.readRuntime(id); if (!runtime.qmpPort) return this.error("QEMU_VM_RECOVERY_REQUIRED", "The prior broker process is gone but its QMP endpoint is unavailable; stop the VM manually before changing this VM."); await this.qmp(id, "quit").catch(() => undefined); const exited = await waitFor(() => !processAlive(runtime.pid), 5_000); if (!exited) return this.error("QEMU_VM_RECOVERY_REQUIRED", "The recovered QEMU process did not stop through QMP; stop it manually before changing this VM."); await this.writeRuntime(id, { desiredState: "stopped", lastExit: { at: new Date().toISOString(), code: null, signal: null, expected: true } }); return restart ? this.startVmUnlocked(id) : this.ok("Recovered QEMU VM stopped.", { vm: await this.statusData(id) }); }
  private async kill(id: string): Promise<void> { const child = this.running.get(id); if (child && !child.killed) child.kill("SIGKILL"); await waitFor(() => !this.running.has(id), 5_000).catch(() => undefined); }
  private requireId(params: Record<string, unknown>): string { const id = this.requireString(params, "vm_id"); if (!isVmId(id)) throw new Error("INVALID_ARGUMENT: vm_id must use letters, digits, underscore, and hyphen only."); return id; }
  private requireMediaId(params: Record<string, unknown>): string { return this.normalizedMediaId(this.requireString(params, "media_id")); }
  private requireString(params: Record<string, unknown>, key: string): string { const value = params[key]; if (typeof value !== "string" || !value.trim()) throw new Error(`INVALID_ARGUMENT: ${key} is required.`); return value.trim(); }
  private profile(value: unknown): QemuProfileName { return value === "win98" || value === "winxp" || value === "win10" || value === "generic" ? value : "win98"; }
  private record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
  private number(params: Record<string, unknown>, key: string, min: number, max: number): number { const value = params[key]; if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`INVALID_ARGUMENT: ${key} must be an integer between ${min} and ${max}.`); return value; }
  private ok(message: string, data?: Record<string, unknown>): QemuResult { return { ok: true, code: "OK", message, ...(data ? { data } : {}) }; }
  private error(code: string, message: string): QemuResult { return { ok: false, code, message }; }
  private log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void { this.config.logger?.(level, event, data); }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> { const prior = this.chains.get(id) ?? Promise.resolve(); const next = prior.catch(() => undefined).then(work); this.chains.set(id, next); const clear = (): void => { if (this.chains.get(id) === next) this.chains.delete(id); }; void next.then(clear, clear); return next; }
  private serialInventory<T>(work: () => Promise<T>): Promise<T> { const next = this.inventoryChain.catch(() => undefined).then(work); this.inventoryChain = next; return next; }
  private vmsDir(): string { return join(this.config.root, "vms"); }
  private trashDir(): string { return join(this.config.root, "trash"); }
  private trashIndex(): string { return join(this.trashDir(), "index.json"); }
  private vmDir(id: string): string { if (!isVmId(id)) throw new Error("INVALID_ARGUMENT: vm_id must use letters, digits, underscore, and hyphen only."); return containedPath(this.vmsDir(), id); }
  private definitionPath(id: string): string { return join(this.vmDir(id), "vm.json"); }
  private runtimeDir(id: string): string { return join(this.vmDir(id), "runtime"); }
  private runtimePath(id: string): string { return join(this.runtimeDir(id), "state.json"); }
  private diskPath(id: string, definition: VmDefinition): string {
    const relative = definition.disk.path ?? "disk.qcow2";
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(relative)) throw new Error("QEMU_INVALID_CONFIGURATION: managed disk path must be a simple filename.");
    return containedPath(this.vmDir(id), relative);
  }
}

async function qmpCall(port: number, command: string, qmpArguments: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolvePromise, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let buffer = "";
    let sent = false;
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("QMP_TIMEOUT")); }, 5_000);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value: Record<string, unknown>; try { value = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (value.QMP && !sent) { socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`); sent = true; continue; }
        if (sent && "return" in value && !("id" in value)) { socket.write(`${JSON.stringify({ execute: command, arguments: qmpArguments, id: "win98-mcp" })}\n`); continue; }
        if (value.id === "win98-mcp") { clearTimeout(timer); socket.end(); if (value.error) reject(new Error("QMP_ERROR")); else resolvePromise(value.return); }
      }
    });
  });
}

async function freePort(): Promise<number> { return new Promise((resolvePromise, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => typeof address === "object" && address ? resolvePromise(address.port) : reject(new Error("QMP_PORT_UNAVAILABLE"))); }); }); }
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
function processAlive(pid: number | undefined): boolean { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try { if (await check()) return true; } catch { /* A service may not have opened its socket yet. */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}
async function run(binary: string, args: string[]): Promise<string> { return new Promise((resolvePromise, reject) => { const child = spawn(binary, args, { windowsHide: true }); let output = ""; let settled = false; const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolvePromise(output); }; const append = (data: Buffer): void => { if (output.length < 1_048_576) output += data.toString().slice(0, 1_048_576 - output.length); }; const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error(`QEMU_COMMAND_TIMEOUT:${binary}`)); }, 120_000); child.stdout?.on("data", append); child.stderr?.on("data", append); child.once("error", (error) => finish(new Error((error as NodeJS.ErrnoException).code === "ENOENT" ? `QEMU_NOT_FOUND:${binary}` : `QEMU_COMMAND_FAILED:${error.message}`))); child.once("exit", (code) => finish(code === 0 ? undefined : new Error(`QEMU_COMMAND_FAILED:${binary} exited ${code}: ${output}`))); }); }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64); }
function isVmId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value); }
function containedPath(root: string, child: string): string { const rootPath = resolve(root); const output = resolve(rootPath, child); if (output !== rootPath && !output.startsWith(`${rootPath}\\`) && !output.startsWith(`${rootPath}/`)) throw new Error("INVALID_ARGUMENT: vm_id escapes managed QEMU storage."); return output; }
function parseSnapshots(value: string): Array<Record<string, string>> { return value.split(/\r?\n/).slice(2).map((line) => line.trim()).filter(Boolean).map((line) => ({ raw: line, id: line.split(/\s+/)[0] ?? "", name: line.split(/\s+/)[1] ?? "" })); }
function stripCdromArgs(args: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "-cdrom") { index += 1; continue; }
    output.push(args[index]!);
  }
  return output;
}
function withoutCdrom(definition: VmDefinition, updatedAt: string): VmDefinition {
  const { cdromMediaId: _removed, ...rest } = definition;
  return { ...rest, extraArgs: stripCdromArgs(definition.extraArgs), updatedAt };
}
function withCpuCount(args: string[], cpus: number): string[] {
  const output = [...args];
  const index = output.indexOf("-smp");
  if (index >= 0) output[index + 1] = String(cpus);
  else output.push("-smp", String(cpus));
  return output;
}
/** QEMU's HMP accepts forward-slash Windows paths and quoted arguments. */
function hmpPath(path: string): string { return `"${path.replace(/\\/g, "/").replace(/"/g, "\\\"")}"`; }
export function normalizeQemuKey(key: string): string {
  const normalized = key.trim().toUpperCase().replace(/[ _-]+/g, "_");
  const names: Record<string, string> = {
    ENTER: "ret", RETURN: "ret", ESC: "esc", ESCAPE: "esc", SPACE: "spc",
    BACKSPACE: "backspace", TAB: "tab", DELETE: "delete", INSERT: "insert",
    HOME: "home", END: "end", PAGE_UP: "pgup", PAGE_DOWN: "pgdn",
    LEFT: "left", RIGHT: "right", UP: "up", DOWN: "down",
    CTRL: "ctrl", CONTROL: "ctrl", ALT: "alt", SHIFT: "shift",
    WINDOWS: "meta_l", WIN: "meta_l", META: "meta_l"
  };
  if (names[normalized]) return names[normalized]!;
  if (/^F(?:[1-9]|1[0-2])$/.test(normalized)) return normalized.toLowerCase();
  if (/^[A-Z0-9]$/.test(normalized)) return normalized.toLowerCase();
  return key.trim().toLowerCase();
}
export function qemuSendKey(character: string): string {
  if (/^[a-z]$/.test(character)) return character;
  if (/^[A-Z]$/.test(character)) return `shift-${character.toLowerCase()}`;
  if (/^[0-9]$/.test(character)) return character;
  const keys: Record<string, string> = {
    " ": "spc", "\n": "ret", "\r": "ret",
    "-": "minus", "_": "shift-minus", "=": "equal", "+": "shift-equal",
    "[": "bracket_left", "]": "bracket_right", "{": "shift-bracket_left", "}": "shift-bracket_right",
    "\\": "backslash", "|": "shift-backslash", ";": "semicolon", ":": "shift-semicolon",
    "'": "apostrophe", "\"": "shift-apostrophe", "`": "grave_accent", "~": "shift-grave_accent",
    ",": "comma", "<": "shift-comma", ".": "dot", ">": "shift-dot", "/": "slash", "?": "shift-slash",
    "!": "shift-1", "@": "shift-2", "#": "shift-3", "$": "shift-4", "%": "shift-5",
    "^": "shift-6", "&": "shift-7", "*": "shift-8", "(": "shift-9", ")": "shift-0"
  };
  const key = keys[character];
  if (!key) throw new Error(`QEMU_KEY_UNSUPPORTED: cannot type character U+${character.codePointAt(0)?.toString(16).toUpperCase().padStart(4, "0")}`);
  return key;
}
function ppmToPng(ppm: Buffer): Buffer { const match = /^P6\s+(?:#.*\s+)*(\d+)\s+(\d+)\s+(\d+)\s/m.exec(ppm.toString("ascii", 0, Math.min(ppm.length, 4096))); if (!match || match[3] !== "255") throw new Error("QEMU_SCREENSHOT_INVALID"); const headerEnd = ppm.indexOf(0x0a, match.index + match[0].lastIndexOf(match[3])) + 1; const width = Number(match[1]); const height = Number(match[2]); const source = ppm.subarray(headerEnd); if (source.length < width * height * 3) throw new Error("QEMU_SCREENSHOT_TRUNCATED"); const image = new PNG({ width, height }); for (let index = 0, pixel = 0; pixel < width * height; pixel += 1) { image.data[index++] = source[pixel * 3]!; image.data[index++] = source[pixel * 3 + 1]!; image.data[index++] = source[pixel * 3 + 2]!; image.data[index++] = 255; } return PNG.sync.write(image); }
