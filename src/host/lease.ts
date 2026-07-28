import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_WAIT_TICKET_TTL_MS,
  UNLOCK_REMINDER,
  type LeaseSnapshot,
  type WaitTicket
} from "../shared/types.js";

export interface LeaseOwner {
  sessionId: string;
  label: string;
  acquiredAt: number;
  lastActivityAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  ticket?: WaitTicket;
  queuePosition?: number;
}

interface Waiter {
  ticket: WaitTicket;
  label: string;
  resolve: ((result: AcquireResult) => void) | undefined;
  waitTimer: NodeJS.Timeout | undefined;
  ticketTimer: NodeJS.Timeout;
}

export class LeaseManager extends EventEmitter {
  private owner: LeaseOwner | undefined;
  private readonly waiters: Waiter[] = [];
  private expirationTimer: NodeJS.Timeout | undefined;
  private blocked = false;

  constructor(
    readonly ttlMs = DEFAULT_LEASE_TTL_MS,
    readonly ticketTtlMs = DEFAULT_WAIT_TICKET_TTL_MS
  ) {
    super();
  }

  get currentOwner(): Readonly<LeaseOwner> | undefined {
    return this.owner;
  }

  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (!blocked) {
      this.grantNext();
    }
  }

  acquire(sessionId: string, label: string, enqueue = true): AcquireResult {
    this.expireIfDue();
    if (this.owner?.sessionId === sessionId) {
      this.touch(sessionId);
      return { acquired: true };
    }
    if (!this.owner && !this.blocked && this.firstEligibleSession() === sessionId) {
      this.removeWaitersForSession(sessionId);
      this.assignOwner(sessionId, label);
      return { acquired: true };
    }
    if (!this.owner && !this.blocked && this.waiters.length === 0) {
      this.assignOwner(sessionId, label);
      return { acquired: true };
    }
    const existing = this.waiters.find((waiter) => waiter.ticket.sessionId === sessionId);
    if (existing) {
      const queuePosition = this.queuePosition(existing.ticket.id);
      return {
        acquired: false,
        ticket: existing.ticket,
        ...(queuePosition !== undefined ? { queuePosition } : {})
      };
    }
    if (!enqueue) {
      return { acquired: false };
    }
    const now = Date.now();
    const ticket: WaitTicket = {
      id: randomUUID(),
      sessionId,
      createdAt: now,
      expiresAt: now + this.ticketTtlMs
    };
    // vm_lock creates a durable queue ticket. vm_wait attaches a resolver later.
    // A durable ticket is never auto-granted unless its owner is actively
    // waiting; otherwise an abandoned call could silently own the VM.
    const ticketTimer = setTimeout(
      () => this.expireTicket(ticket.id),
      this.ticketTtlMs
    );
    ticketTimer.unref();
    this.waiters.push({
      ticket,
      label,
      resolve: undefined,
      waitTimer: undefined,
      ticketTimer
    });
    this.emit("queued", ticket);
    const queuePosition = this.queuePosition(ticket.id);
    return {
      acquired: false,
      ticket,
      ...(queuePosition !== undefined ? { queuePosition } : {})
    };
  }

  wait(
    sessionId: string,
    label: string,
    waitMs: number,
    ticketId?: string
  ): Promise<AcquireResult> {
    const immediate = this.acquire(sessionId, label, true);
    if (immediate.acquired) {
      return Promise.resolve(immediate);
    }
    const waiter = this.waiters.find(
      (candidate) =>
        candidate.ticket.sessionId === sessionId &&
        (ticketId === undefined || candidate.ticket.id === ticketId)
    );
    if (!waiter) {
      return Promise.resolve({ acquired: false });
    }
    if (waiter.resolve) {
      const queuePosition = this.queuePosition(waiter.ticket.id);
      return Promise.resolve({
        acquired: false,
        ticket: waiter.ticket,
        ...(queuePosition !== undefined ? { queuePosition } : {})
      });
    }
    return new Promise<AcquireResult>((resolve) => {
      let settled = false;
      waiter.resolve = (result) => {
        if (!settled) {
          settled = true;
          if (waiter.waitTimer) {
            clearTimeout(waiter.waitTimer);
            waiter.waitTimer = undefined;
          }
          waiter.resolve = undefined;
          resolve(result);
        }
      };
      waiter.waitTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          waiter.resolve = undefined;
          waiter.waitTimer = undefined;
          const queuePosition = this.queuePosition(waiter.ticket.id);
          resolve({
            acquired: false,
            ticket: waiter.ticket,
            ...(queuePosition !== undefined ? { queuePosition } : {})
          });
        }
      }, waitMs);
      waiter.waitTimer.unref();
    });
  }

  touch(sessionId: string): boolean {
    if (this.owner?.sessionId !== sessionId) {
      return false;
    }
    this.owner.lastActivityAt = Date.now();
    this.scheduleExpiration();
    return true;
  }

  release(sessionId: string): boolean {
    if (this.owner?.sessionId !== sessionId) {
      this.removeWaitersForSession(sessionId);
      return false;
    }
    const old = this.owner;
    this.owner = undefined;
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer);
      this.expirationTimer = undefined;
    }
    this.emit("released", old);
    this.grantNext();
    return true;
  }

  disconnect(sessionId: string): "owner" | "waiter" | "none" {
    if (this.owner?.sessionId === sessionId) {
      return "owner";
    }
    return this.removeWaitersForSession(sessionId) ? "waiter" : "none";
  }

  snapshot(sessionId?: string): LeaseSnapshot {
    this.expireIfDue();
    if (!this.owner) {
      return {
        held: false,
        heldByCaller: false
      };
    }
    const expiresAt = this.owner.lastActivityAt + this.ttlMs;
    return {
      held: true,
      heldByCaller: this.owner.sessionId === sessionId,
      ownerLabel: this.owner.label,
      acquiredAt: new Date(this.owner.acquiredAt).toISOString(),
      lastActivityAt: new Date(this.owner.lastActivityAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
      ...(this.owner.sessionId === sessionId
        ? { reminder: UNLOCK_REMINDER }
        : {})
    };
  }

  queuePosition(ticketId: string): number | undefined {
    const index = this.waiters.findIndex((waiter) => waiter.ticket.id === ticketId);
    return index < 0 ? undefined : index + 1;
  }

  close(): void {
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer);
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.ticketTimer);
      if (waiter.waitTimer) {
        clearTimeout(waiter.waitTimer);
      }
      waiter.resolve?.({ acquired: false });
    }
  }

  private assignOwner(sessionId: string, label: string): void {
    const now = Date.now();
    this.owner = {
      sessionId,
      label,
      acquiredAt: now,
      lastActivityAt: now
    };
    this.scheduleExpiration();
    this.emit("acquired", this.owner);
  }

  private scheduleExpiration(): void {
    if (this.expirationTimer) {
      clearTimeout(this.expirationTimer);
    }
    if (!this.owner) {
      return;
    }
    const delay = Math.max(1, this.owner.lastActivityAt + this.ttlMs - Date.now());
    this.expirationTimer = setTimeout(() => this.expireIfDue(), delay);
    this.expirationTimer.unref();
  }

  private expireIfDue(): void {
    if (!this.owner || Date.now() < this.owner.lastActivityAt + this.ttlMs) {
      return;
    }
    const expired = this.owner;
    this.owner = undefined;
    this.expirationTimer = undefined;
    this.blocked = true;
    this.emit("expired", expired);
  }

  private grantNext(): void {
    if (this.blocked || this.owner) {
      return;
    }
    const now = Date.now();
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (!waiter) {
        return;
      }
      if (waiter.ticket.expiresAt <= now) {
        this.waiters.shift();
        clearTimeout(waiter.ticketTimer);
        if (waiter.waitTimer) {
          clearTimeout(waiter.waitTimer);
        }
        waiter.resolve?.({ acquired: false });
        continue;
      }
      if (!waiter.resolve) {
        // Preserve FIFO order without silently assigning a lease to a caller
        // that is no longer inside vm_wait.
        return;
      }
      this.waiters.shift();
      clearTimeout(waiter.ticketTimer);
      if (waiter.waitTimer) {
        clearTimeout(waiter.waitTimer);
      }
      this.assignOwner(waiter.ticket.sessionId, waiter.label);
      waiter.resolve({ acquired: true });
      return;
    }
  }

  private firstEligibleSession(): string | undefined {
    const now = Date.now();
    while (this.waiters[0] && this.waiters[0].ticket.expiresAt <= now) {
      const expired = this.waiters.shift();
      if (expired) {
        clearTimeout(expired.ticketTimer);
        if (expired.waitTimer) {
          clearTimeout(expired.waitTimer);
        }
        expired.resolve?.({ acquired: false });
      }
    }
    return this.waiters[0]?.ticket.sessionId;
  }

  private expireTicket(ticketId: string): void {
    const index = this.waiters.findIndex((waiter) => waiter.ticket.id === ticketId);
    if (index < 0) {
      return;
    }
    const [waiter] = this.waiters.splice(index, 1);
    if (waiter) {
      clearTimeout(waiter.ticketTimer);
      if (waiter.waitTimer) {
        clearTimeout(waiter.waitTimer);
      }
      waiter.resolve?.({ acquired: false });
      this.emit("ticketExpired", waiter.ticket);
    }
  }

  private removeWaitersForSession(sessionId: string): boolean {
    let removed = false;
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (waiter?.ticket.sessionId === sessionId) {
        this.waiters.splice(index, 1);
        clearTimeout(waiter.ticketTimer);
        if (waiter.waitTimer) {
          clearTimeout(waiter.waitTimer);
        }
        waiter.resolve?.({ acquired: false });
        removed = true;
      }
    }
    return removed;
  }
}
