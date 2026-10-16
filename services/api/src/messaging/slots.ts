import { localParts, zonedTime } from '../common/time';

export interface AgentHours {
  showingHours: number[];
  workDays: number[];
}

/**
 * Real showing slots from an agent's working pattern minus booked appointments, at
 * least two hours out, over the next few days. The texting agent can only offer times
 * from this list, so it can never propose a time nobody is free.
 */
export function availableSlots(
  hours: AgentHours,
  timezone: string,
  now: Date,
  booked: Date[],
  opts: { days?: number; max?: number; leadMs?: number } = {},
): string[] {
  const days = opts.days ?? 4;
  const max = opts.max ?? 6;
  const leadMs = opts.leadMs ?? 2 * 3600_000;
  const taken = new Set(booked.map((d) => d.getTime()));
  const out: string[] = [];
  const today = localParts(now, timezone);
  for (let d = 0; d <= days && out.length < max; d++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day) + d * 86_400_000);
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const dd = day.getUTCDate();
    const weekday = localParts(zonedTime(y, m, dd, 12, 0, timezone), timezone).isoWeekday;
    if (!hours.workDays.includes(weekday)) continue;
    for (const h of [...hours.showingHours].sort((a, b) => a - b)) {
      const at = zonedTime(y, m, dd, h, 0, timezone);
      if (at.getTime() - now.getTime() < leadMs || taken.has(at.getTime())) continue;
      out.push(at.toISOString());
      if (out.length >= max) break;
    }
  }
  return out;
}
