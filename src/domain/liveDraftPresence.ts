export const LIVE_DRAFT_HEARTBEAT_MS = 5_000;
export const LIVE_DRAFT_ONLINE_MS = 15_000;

type Presence = {
  lastSeenAt: number;
  pingMs: number | null;
};

const presenceByEmail = new Map<string, Presence>();

function normalizeEmail(email: string): string {
  return email.trim().toLocaleLowerCase();
}

export function parsePingMs(value: unknown): number | null {
  if (value == null || value === "") return null;
  const ping = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(ping)) return null;
  const rounded = Math.round(ping);
  if (rounded < 0 || rounded > 120_000) return null;
  return rounded;
}

export function recordLiveDraftHeartbeat(
  email: string,
  pingMs: unknown,
  now = Date.now(),
): Presence {
  const key = normalizeEmail(email);
  const previous = presenceByEmail.get(key);
  const parsed = parsePingMs(pingMs);
  const next: Presence = {
    lastSeenAt: now,
    pingMs: parsed ?? previous?.pingMs ?? null,
  };
  presenceByEmail.set(key, next);
  return next;
}

export function liveDraftPresence(email: string, now = Date.now()): {
  online: boolean;
  pingMs: number | null;
} {
  const row = presenceByEmail.get(normalizeEmail(email));
  if (!row) return { online: false, pingMs: null };
  const online = now - row.lastSeenAt <= LIVE_DRAFT_ONLINE_MS;
  return {
    online,
    pingMs: online ? row.pingMs : null,
  };
}

export function resetLiveDraftPresence(): void {
  presenceByEmail.clear();
}
