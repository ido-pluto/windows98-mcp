import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeQemuKey, qemuAccelerationPlan, QemuManager, qemuSendKey } from "../src/host/qemu.js";

async function managerFixture(): Promise<{ manager: QemuManager; root: string; disk: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "win98-mcp-qemu-test-"));
  const disk = path.join(root, "source.qcow2");
  await writeFile(disk, "qcow2 test fixture");
  const manager = new QemuManager({ root });
  await manager.initialize();
  return { manager, root, disk };
}

describe("QemuManager", () => {
  it("selects a same-ISA platform accelerator with TCG fallback for auto", () => {
    expect(qemuAccelerationPlan("auto", "i386", "win32", "x64")).toEqual(["whpx", "tcg"]);
    expect(qemuAccelerationPlan("auto", "i386", "linux", "x64")).toEqual(["kvm", "tcg"]);
    expect(qemuAccelerationPlan("auto", "x86_64", "darwin", "x64")).toEqual(["hvf", "tcg"]);
    expect(qemuAccelerationPlan("auto", "i386", "darwin", "arm64")).toEqual(["tcg"]);
    expect(qemuAccelerationPlan("kvm", "i386", "win32", "x64")).toEqual(["kvm"]);
  });

  it("keeps the Windows-safe machine flags and portable TCP user network in every built-in profile", async () => {
    const { manager, disk } = await managerFixture();
    const expectedMachines = {
      win98: "pc",
      winxp: "pc-i440fx-7.2",
      win10: "q35",
      generic: "pc"
    } as const;
    for (const [profile, machine] of Object.entries(expectedMachines)) {
      const vmId = `safe-${profile}`;
      expect((await manager.execute("qemu_vm_create", { vm_id: vmId, name: vmId, disk_path: disk, profile }))?.ok).toBe(true);
      const preview = await manager.execute("qemu_vm_command_preview", { vm_id: vmId });
      const args = preview?.data?.args as string[];
      expect(args).toContain("-M");
      expect(args.some((argument) => argument.includes(`${machine},accel=`))).toBe(true);
      expect(args.some((argument) => argument.includes("hpet=off,kernel-irqchip=off,usb=off"))).toBe(true);
      expect(args).toEqual(expect.arrayContaining(["-netdev", "user,id=net0"]));
      expect(args.join(" ")).not.toContain("guestfwd");
    }
  });

  it("maps Windows paths, punctuation, uppercase text, and named keys to QEMU keys", () => {
    expect([..."D:\\Install.BAT"].map(qemuSendKey)).toEqual([
      "shift-d", "shift-semicolon", "backslash", "shift-i", "n", "s", "t", "a", "l", "l", "dot", "shift-b", "shift-a", "shift-t"
    ]);
    expect(normalizeQemuKey("ENTER")).toBe("ret");
    expect(normalizeQemuKey("Page Down")).toBe("pgdn");
    expect(() => qemuSendKey("₪")).toThrow("QEMU_KEY_UNSUPPORTED");
  });

  it("creates a managed qcow2 VM and previews broker-owned QMP", async () => {
    const { manager, disk } = await managerFixture();
    const created = await manager.execute("qemu_vm_create", { name: "Windows 98 Test", disk_path: disk, profile: "win98" });
    expect(created).toMatchObject({ ok: true, data: { vm: { id: "windows-98-test", profile: "win98", architecture: "i386", memory: "256M", cpus: 1 } } });
    const preview = await manager.execute("qemu_vm_command_preview", { vm_id: "windows-98-test" });
    expect(preview).toMatchObject({ ok: true, data: { args: expect.arrayContaining(["-display", "none", "-vga", "cirrus", "-smp", "1", "-cpu", "pentium2", "-netdev", "rtl8139,netdev=net0"]) } });
    const defaultAcceleration = "auto";
    const localAccelerators = qemuAccelerationPlan(defaultAcceleration, "i386");
    expect(preview?.data?.args).toEqual(expect.arrayContaining(["-M", `pc,accel=${localAccelerators.join(":")},hpet=off,kernel-irqchip=off,usb=off`]));
    expect(created?.data?.vm).toMatchObject({ acceleration: defaultAcceleration, resolvedAcceleration: localAccelerators });
    const listed = await manager.execute("qemu_vm_list", {});
    expect(listed?.data?.vms).toEqual([expect.objectContaining({ id: "windows-98-test" })]);
  });

  it("retains only the newest three deleted VM entries and can restore one", async () => {
    const { manager, disk } = await managerFixture();
    for (const id of ["one", "two", "three", "four"]) {
      await manager.execute("qemu_vm_create", { vm_id: id, name: id, disk_path: disk });
      await manager.execute("qemu_vm_delete", { vm_id: id });
    }
    const trash = await manager.execute("qemu_vm_trash_list", {});
    expect(trash?.data?.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: "two" }), expect.objectContaining({ id: "three" }), expect.objectContaining({ id: "four" })]));
    expect(trash?.data?.entries).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "one" })]));
    const restored = await manager.execute("qemu_vm_restore", { vm_id: "four" });
    expect(restored).toMatchObject({ ok: true, data: { vm: { id: "four" } } });
  });

  it("rejects a fifth live managed VM and tells the caller to delete first", async () => {
    const { manager, disk } = await managerFixture();
    for (const id of ["one", "two", "three", "four"]) {
      expect((await manager.execute("qemu_vm_create", { vm_id: id, name: id, disk_path: disk }))?.ok).toBe(true);
    }
    const rejected = await manager.execute("qemu_vm_create", { vm_id: "five", name: "five", disk_path: disk });
    expect(rejected).toMatchObject({ ok: false, code: "QEMU_VM_LIMIT_REACHED" });
    expect(rejected?.message).toContain("Delete a VM first");
  });

  it("enforces the four-VM cap for concurrent create requests", async () => {
    const { manager, disk } = await managerFixture();
    const results = await Promise.all(["one", "two", "three", "four", "five"].map((id) => manager.execute("qemu_vm_create", { vm_id: id, name: id, disk_path: disk })));
    expect(results.filter((result) => result?.ok)).toHaveLength(4);
    expect(results.find((result) => result?.code === "QEMU_VM_LIMIT_REACHED")).toBeDefined();
  });

  it("rejects managed-QMP option conflicts and snapshot mutation while a VM is running", async () => {
    const { manager, disk } = await managerFixture();
    const invalid = await manager.execute("qemu_vm_create", { name: "bad", disk_path: disk, extra_args: ["-qmp", "stdio"] });
    expect(invalid).toMatchObject({ ok: false, code: "QEMU_ARGUMENT_CONFLICT" });
    await manager.execute("qemu_vm_create", { name: "snapshot", disk_path: disk });
    const list = await manager.execute("qemu_snapshot_list", { vm_id: "snapshot" });
    // qemu-img is intentionally not needed for manager state; an unavailable
    // host binary returns a clear error instead of claiming a snapshot exists.
    expect(["OK", "QEMU_COMMAND_FAILED", "QEMU_NOT_FOUND"]).toContain(list?.code);
  });

  it("rejects traversal and protected process options from every profile component", async () => {
    const { manager, disk } = await managerFixture();
    const traversal = await manager.execute("qemu_vm_create", { vm_id: "../escape", name: "escape", disk_path: disk });
    expect(traversal).toMatchObject({ ok: false, code: "INVALID_ARGUMENT" });
    const protectedComponent = await manager.execute("qemu_vm_create", {
      name: "protected", disk_path: disk, profile_overrides: { custom: ["-daemonize"] }
    });
    expect(protectedComponent).toMatchObject({ ok: false, code: "QEMU_ARGUMENT_CONFLICT" });
  });

  it("does not leave a cap-consuming VM after a failed disk import and enforces the cap on restore", async () => {
    const { manager, disk } = await managerFixture();
    const failed = await manager.execute("qemu_vm_create", { vm_id: "broken", name: "broken", disk_path: `${disk}.missing` });
    expect(failed).toMatchObject({ ok: false, code: "QEMU_DISK_NOT_FOUND" });
    expect((await manager.execute("qemu_vm_list", {}))?.data?.vms).toEqual([]);
    for (const id of ["one", "two", "three", "four"]) {
      await manager.execute("qemu_vm_create", { vm_id: id, name: id, disk_path: disk });
    }
    await manager.execute("qemu_vm_delete", { vm_id: "four" });
    await manager.execute("qemu_vm_create", { vm_id: "five", name: "five", disk_path: disk });
    const restored = await manager.execute("qemu_vm_restore", { vm_id: "four" });
    expect(restored).toMatchObject({ ok: false, code: "QEMU_VM_LIMIT_REACHED" });
  });

  it("uses scalar machine, memory, and CPU updates in the generated command", async () => {
    const { manager, disk } = await managerFixture();
    await manager.execute("qemu_vm_create", { vm_id: "scalar", name: "scalar", disk_path: disk });
    await manager.execute("qemu_vm_update", { vm_id: "scalar", machine: "pc", memory: "640M", cpus: 2 });
    const preview = await manager.execute("qemu_vm_command_preview", { vm_id: "scalar" });
    const defaultAcceleration = "auto";
    expect(preview?.data?.args).toEqual(expect.arrayContaining(["-machine", `pc,accel=${qemuAccelerationPlan(defaultAcceleration, "i386").join(":")}`, "-m", "640M", "-smp", "2"]));
    await manager.execute("qemu_vm_update", { vm_id: "scalar", profile_overrides: { machine: ["-M", "pc,hpet=off,kernel-irqchip=off,usb=off"] } });
    const overridden = await manager.execute("qemu_vm_command_preview", { vm_id: "scalar" });
    expect(overridden?.data?.args).toEqual(expect.arrayContaining(["-M", `pc,accel=${qemuAccelerationPlan(defaultAcceleration, "i386").join(":")},hpet=off,kernel-irqchip=off,usb=off`]));
  });

  it("imports, persistently mounts, ejects, and deletes managed ISO media", async () => {
    const { manager, root, disk } = await managerFixture();
    const iso = path.join(root, "guest-tools.iso");
    await writeFile(iso, "iso fixture");
    await manager.execute("qemu_vm_create", { vm_id: "media", name: "media", disk_path: disk });
    const pushed = await manager.execute("qemu_media_push", { vm_id: "media", source_path: iso, media_id: "guest-tools" });
    expect(pushed).toMatchObject({ ok: true, data: { media: { id: "guest-tools", mounted: false } } });
    const mounted = await manager.execute("qemu_media_mount", { vm_id: "media", media_id: "guest-tools" });
    expect(mounted).toMatchObject({ ok: true, data: { media: { mounted: true }, live: false } });
    expect(await manager.execute("qemu_vm_update", { vm_id: "media", memory: "256M" })).toMatchObject({ ok: true });
    const preview = await manager.execute("qemu_vm_command_preview", { vm_id: "media" });
    expect(preview?.data?.args).toEqual(expect.arrayContaining(["-drive", expect.stringContaining("media=cdrom")]));
    const blocked = await manager.execute("qemu_media_delete", { vm_id: "media", media_id: "guest-tools" });
    expect(blocked).toMatchObject({ ok: false, code: "QEMU_MEDIA_MOUNTED" });
    expect(await manager.execute("qemu_media_eject", { vm_id: "media" })).toMatchObject({ ok: true, data: { live: false } });
    expect(await manager.execute("qemu_media_delete", { vm_id: "media", media_id: "guest-tools" })).toMatchObject({ ok: true });
  });
});
