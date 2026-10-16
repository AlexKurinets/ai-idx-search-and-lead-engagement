/** Normalizes a North American number to E.164 (+1XXXXXXXXXX), or returns null. */
export function toE164(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** The fictional 555-01xx block reserved for examples; the sandbox only texts these. */
export function isFictional(e164: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(e164);
}
