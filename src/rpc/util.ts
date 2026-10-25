// Small helpers shared by the RPC layer (DESIGN.md §4.11). Internal: not re-exported.

/** Longest delay `setTimeout` takes as is (larger values fire at once on most runtimes). */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/** A timeout option: a non-negative number of ms (0 = none), clamped to the timer limit. */
export function checkTimeout(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || Number.isNaN(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative number of milliseconds (0 = none)`);
  return Math.min(value, MAX_TIMER_DELAY);
}

/** A positive safe integer option. */
export function checkPositiveInt(value: unknown, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** The `validateReplies` option checked. */
export function checkMode<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!(allowed as readonly unknown[]).includes(value))
    throw new TypeError(`${name} must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`);
  return value as T;
}

/**
 * A wake-up flag for one waiting task: `notify()` before `wait()` is not lost (the next `wait()` returns at once).
 */
export class Wakeup {
  #resolve: (() => void) | undefined;
  #pending = false;

  wait(): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  notify(): void {
    const resolve = this.#resolve;
    if (resolve === undefined) {
      this.#pending = true;
      return;
    }
    this.#resolve = undefined;
    resolve();
  }
}

/** Splits `interface.Member` at the last dot (no syntax check); null without a dot. */
export function splitName(name: string): { interface: string; member: string } | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return { interface: name.slice(0, dot), member: name.slice(dot + 1) };
}
