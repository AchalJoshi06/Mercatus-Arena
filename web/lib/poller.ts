/**
 * Shared polling manager — consolidates all independent setInterval timers
 * into a single base tick. Components register with desired intervals as
 * multiples of the 1000ms base tick.
 */

type UnsubscribeFn = () => void;

interface Subscriber {
  fn: () => void;
  every: number; // fire every N base ticks
}

class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private subs = new Map<string, Subscriber>();
  private tick = 0;
  private baseMs = 1000;

  /**
   * Register a polling callback.
   * @param key   Unique key (duplicate keys are replaced)
   * @param fn    Callback to invoke
   * @param intervalMs  Desired interval; rounded up to nearest baseMs multiple
   * @returns     Unsubscribe function
   */
  register(key: string, fn: () => void, intervalMs: number): UnsubscribeFn {
    const every = Math.max(1, Math.round(intervalMs / this.baseMs));
    this.subs.set(key, { fn, every });
    this.ensureRunning();
    return () => {
      this.subs.delete(key);
      if (this.subs.size === 0) this.stop();
    };
  }

  private ensureRunning() {
    if (this.timer) return;
    this.tick = 0;
    this.timer = setInterval(() => {
      this.tick++;
      for (const sub of this.subs.values()) {
        if (this.tick % sub.every === 0) {
          try {
            sub.fn();
          } catch {}
        }
      }
    }, this.baseMs);
  }

  private stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.tick = 0;
  }
}

export const poller = new Poller();
