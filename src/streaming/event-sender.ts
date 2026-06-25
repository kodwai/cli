import { createHmac } from "node:crypto";

interface SessionEvent {
  event_type: string;
  data: Record<string, unknown> | null;
  timestamp: string;
}

interface EventSender {
  send(event: SessionEvent): Promise<void>;
  flush(): Promise<void>;
  sendEnd(payload: Record<string, unknown>): Promise<void>;
}

export function createEventSender(
  sessionId: string,
  webhookSecret: string,
  baseUrl: string,
): EventSender {
  const buffer: SessionEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;

  function sign(body: string): string {
    const sig = createHmac("sha256", webhookSecret).update(body).digest("hex");
    return `sha256=${sig}`;
  }

  async function sendBatch(events: SessionEvent[]): Promise<void> {
    for (const event of events) {
      const body = JSON.stringify(event);
      try {
        const resp = await fetch(`${baseUrl}/api/sessions/${sessionId}/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Kodwai-Signature": sign(body),
            "X-Kodwai-Session": sessionId,
          },
          body,
        });
        if (!resp.ok && resp.status !== 201) {
          // Silently drop — don't crash the interview
        }
      } catch {
        // Network error — event lost, don't block interview
      }
    }
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 500);
  }

  async function flush(): Promise<void> {
    if (flushing || buffer.length === 0) return;
    flushing = true;

    const batch = buffer.splice(0, 10);
    await sendBatch(batch);

    flushing = false;

    // If there are more events, schedule another flush
    if (buffer.length > 0) {
      scheduleFlush();
    }
  }

  async function send(event: SessionEvent): Promise<void> {
    // Priority events: send immediately
    if (event.event_type === "result" || event.event_type === "system") {
      await sendBatch([event]);
      return;
    }

    buffer.push(event);

    // Flush if batch is full
    if (buffer.length >= 10) {
      await flush();
    } else {
      scheduleFlush();
    }
  }

  async function sendEnd(payload: Record<string, unknown>): Promise<void> {
    // Flush remaining events first
    await flush();

    const body = JSON.stringify(payload);
    const resp = await fetch(`${baseUrl}/api/sessions/${sessionId}/end`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Kodwai-Signature": sign(body),
        "X-Kodwai-Session": sessionId,
      },
      body,
    });

    if (!resp.ok) {
      throw new Error(`Failed to end session: ${resp.status}`);
    }
  }

  return { send, flush, sendEnd };
}
