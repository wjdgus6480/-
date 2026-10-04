export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ak = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const bk = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();

/** 시각(instant)을 지정 시간대의 달력 날짜(YYYY-MM-DD)로 변환한다. */
export function instantToLocalDate(iso: string, tz: string): string {
  let fmt = dateFmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFmtCache.set(tz, fmt);
  }
  return fmt.format(new Date(iso));
}

function zonedParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute'), s: g('second') };
}

/** 'YYYY-MM-DDTHH:mm' (해당 시간대의 벽시계 시각) → ISO 시각 */
export function zonedLocalToIso(local: string, tz: string): string {
  const [date, time = '00:00'] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    guess += wall - asUtc;
  }
  return new Date(guess).toISOString();
}

/** ISO 시각 → 해당 시간대의 'YYYY-MM-DDTHH:mm' */
export function isoToZonedLocal(iso: string, tz: string): string {
  const p = zonedParts(Date.parse(iso), tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function formatInstant(iso: string | null | undefined, tz: string, withTime = true): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(new Date(iso));
}
