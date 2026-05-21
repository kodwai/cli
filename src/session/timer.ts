export interface Timer {
  start(): void;
  stop(): void;
  remaining(): number;
  onExpired(callback: () => void): void;
}

export function createTimer(minutes: number, onExpired: () => void): Timer {
  const durationMs = minutes * 60 * 1000;
  const startTime = Date.now();
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let expiredCallback = onExpired;

  function remaining(): number {
    const elapsed = Date.now() - startTime;
    return Math.max(0, durationMs - elapsed);
  }

  function formatTime(ms: number): string {
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function start(): void {
    timeoutId = setTimeout(() => {
      if (intervalId) clearInterval(intervalId);
      expiredCallback();
    }, durationMs);

    // Update terminal title every 15 seconds
    intervalId = setInterval(() => {
      const r = remaining();
      if (r > 0) {
        const timeStr = formatTime(r);
        const urgency = r < 60000 ? " ⚠ HURRY!" : r < 300000 ? " ⚠" : "";
        process.stdout.write(`\x1b]0;Kodwai — ${timeStr} remaining${urgency}\x07`);
      }
    }, 15_000);
  }

  function stop(): void {
    if (timeoutId) clearTimeout(timeoutId);
    if (intervalId) clearInterval(intervalId);
    // Reset terminal title
    process.stdout.write(`\x1b]0;\x07`);
  }

  // Auto-start
  start();

  return {
    start,
    stop,
    remaining,
    onExpired(cb: () => void) {
      expiredCallback = cb;
    },
  };
}
