import { localParts, nextLocalHour } from '../common/time';

export type MessageKind = 'first_touch' | 'reply' | 'followup' | 'confirmation' | 'agent';

export interface PolicyInput {
  kind: MessageKind;
  now: Date;
  timezone: string;
  consentSms: boolean;
  optedOutAt: Date | null;
  /** When the lead submitted the inquiry that started this conversation. */
  inquiryAt: Date | null;
  /** The lead's most recent inbound message, if any. */
  lastInboundAt: Date | null;
  /** Proactive (non-responsive) automated messages already sent today, local time. */
  proactiveSentToday: number;
}

export type PolicyDecision =
  | { action: 'send'; responsive: boolean }
  | { action: 'defer'; until: Date; reason: 'quiet_hours' | 'daily_cap' }
  | { action: 'block'; reason: 'opted_out' | 'no_consent' };

export const QUIET_START = 21;
export const QUIET_END = 8;
export const DAILY_PROACTIVE_CAP = 2;
export const RESPONSIVE_INQUIRY_MS = 5 * 60_000;
export const RESPONSIVE_REPLY_MS = 15 * 60_000;
export const MAX_SMS_CHARS = 306;

/**
 * Sending rules enforced in code, not in the prompt.
 *
 * Opt-outs and missing consent block outright. A message that answers the lead, a
 * first touch within five minutes of their inquiry or a reply within fifteen minutes of
 * their text, goes out at any hour, because they just asked. Everything else is
 * proactive and respects quiet hours (8 a.m. to 9 p.m. in the lead's time zone) and a
 * daily cap; when either applies the caller gets a time to retry, which the workflow
 * turns into a durable timer.
 */
export function evaluate(p: PolicyInput): PolicyDecision {
  // The one message allowed after STOP is the confirmation of it.
  if (p.kind === 'confirmation') return { action: 'send', responsive: true };
  if (p.optedOutAt) return { action: 'block', reason: 'opted_out' };
  if (!p.consentSms) return { action: 'block', reason: 'no_consent' };

  const nowMs = p.now.getTime();
  const responsive =
    p.kind === 'agent' ||
    (p.kind === 'first_touch' && p.inquiryAt !== null && nowMs - p.inquiryAt.getTime() <= RESPONSIVE_INQUIRY_MS) ||
    (p.kind === 'reply' && p.lastInboundAt !== null && nowMs - p.lastInboundAt.getTime() <= RESPONSIVE_REPLY_MS);
  if (responsive) return { action: 'send', responsive: true };

  const local = localParts(p.now, p.timezone);
  if (local.hour >= QUIET_START || local.hour < QUIET_END) {
    return { action: 'defer', until: nextLocalHour(p.now, QUIET_END, p.timezone), reason: 'quiet_hours' };
  }
  if (p.proactiveSentToday >= DAILY_PROACTIVE_CAP) {
    const msToMidnight = ((24 - local.hour) * 60 - local.minute) * 60_000;
    const tomorrow = new Date(p.now.getTime() + msToMidnight + 60_000);
    return { action: 'defer', until: nextLocalHour(tomorrow, QUIET_END + 2, p.timezone), reason: 'daily_cap' };
  }
  return { action: 'send', responsive: false };
}

const STOP = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT']);
const START = new Set(['START', 'UNSTOP']);
const HELP = new Set(['HELP', 'INFO']);

/** Carrier keywords are matched on the whole message, case-insensitively. */
export function keyword(body: string): 'stop' | 'start' | 'help' | null {
  const word = body.trim().toUpperCase().replace(/[.!]+$/, '');
  if (STOP.has(word)) return 'stop';
  if (START.has(word)) return 'start';
  if (HELP.has(word)) return 'help';
  return null;
}
