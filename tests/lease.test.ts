import { describe, expect, it } from "vitest";
import { LeaseManager } from "../src/host/index.js";

describe("LeaseManager FIFO safety", () => {
  it("does not silently grant an abandoned durable ticket", async () => {
    const lease = new LeaseManager(5_000, 5_000);
    try {
      expect(lease.acquire("owner", "owner").acquired).toBe(true);
      const queued = lease.acquire("waiter", "waiter");
      expect(queued.acquired).toBe(false);
      expect(queued.ticket).toBeDefined();

      const timedOut = await lease.wait(
        "waiter",
        "waiter",
        10,
        queued.ticket?.id
      );
      expect(timedOut.acquired).toBe(false);
      expect(lease.release("owner")).toBe(true);
      expect(lease.currentOwner).toBeUndefined();

      const bypass = lease.acquire("bypass", "bypass");
      expect(bypass.acquired).toBe(false);
      expect(lease.currentOwner).toBeUndefined();

      const claimed = lease.acquire("waiter", "waiter");
      expect(claimed.acquired).toBe(true);
      expect(lease.currentOwner?.sessionId).toBe("waiter");
    } finally {
      lease.close();
    }
  });

  it("grants the head ticket while vm_wait is actively pending", async () => {
    const lease = new LeaseManager(5_000, 5_000);
    try {
      expect(lease.acquire("owner", "owner").acquired).toBe(true);
      const queued = lease.acquire("waiter", "waiter");
      const waiting = lease.wait(
        "waiter",
        "waiter",
        1_000,
        queued.ticket?.id
      );
      expect(lease.release("owner")).toBe(true);
      await expect(waiting).resolves.toMatchObject({ acquired: true });
      expect(lease.currentOwner?.sessionId).toBe("waiter");
    } finally {
      lease.close();
    }
  });

  it("holds FIFO assignment while cleanup is blocked", async () => {
    const lease = new LeaseManager(5_000, 5_000);
    try {
      expect(lease.acquire("owner", "owner").acquired).toBe(true);
      const queued = lease.acquire("waiter", "waiter");
      const waiting = lease.wait(
        "waiter",
        "waiter",
        1_000,
        queued.ticket?.id
      );
      lease.setBlocked(true);
      expect(lease.release("owner")).toBe(true);
      expect(lease.currentOwner).toBeUndefined();
      lease.setBlocked(false);
      await expect(waiting).resolves.toMatchObject({ acquired: true });
    } finally {
      lease.close();
    }
  });
});
