/** Local wall-clock parts for an instant in an IANA time zone. */
export function localParts(at: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    isoWeekday: weekdays.indexOf(parts.weekday) + 1,
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

/** The UTC instant for a local wall-clock time in a time zone (DST-safe to the minute). */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const target = Date.UTC(year, month - 1, day, hour, minute);
    guess += target - asUtc;
  }
  return new Date(guess);
}

/** Next local occurrence of `hour`:00 strictly after `at`. */
export function nextLocalHour(at: Date, hour: number, timeZone: string): Date {
  const p = localParts(at, timeZone);
  let candidate = zonedTime(p.year, p.month, p.day, hour, 0, timeZone);
  if (candidate.getTime() <= at.getTime()) {
    const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day) + 86_400_000);
    candidate = zonedTime(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, 0, timeZone);
  }
  return candidate;
}
