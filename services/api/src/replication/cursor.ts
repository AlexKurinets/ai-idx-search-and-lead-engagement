/**
 * The replication cursor is the pair (ModificationTimestamp, ListingKey).
 *
 * A timestamp-only watermark ("ModificationTimestamp gt W") silently skips records when
 * a page boundary lands inside a group of records sharing one timestamp, which is what
 * MLS bulk updates produce. Ordering on both fields and resuming strictly after the last
 * (timestamp, key) pair lets a page end anywhere without losing a record. Each request is
 * built from the cursor rather than from an offset-based next link, because offsets shift
 * when records change between requests.
 */
export interface Cursor {
  ts: string;
  key: string;
}

export const EPOCH_CURSOR: Cursor = { ts: '1970-01-01T00:00:00.000Z', key: '' };

const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** RESO timestamps compare at the precision the server emits: milliseconds. */
export function formatTs(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toISOString();
}

export function cursorFilter(c: Cursor): string {
  const ts = formatTs(c.ts);
  return `ModificationTimestamp gt ${ts} or (ModificationTimestamp eq ${ts} and ListingKey gt ${quote(c.key)})`;
}

export const CURSOR_ORDER = 'ModificationTimestamp asc,ListingKey asc';

export function advance(c: Cursor, page: { ModificationTimestamp: string; ListingKey: string }[]): Cursor {
  if (page.length === 0) return c;
  const last = page[page.length - 1];
  return { ts: formatTs(last.ModificationTimestamp), key: last.ListingKey };
}

export function keyScanFilter(afterKey: string): string | undefined {
  return afterKey ? `ListingKey gt ${quote(afterKey)}` : undefined;
}
