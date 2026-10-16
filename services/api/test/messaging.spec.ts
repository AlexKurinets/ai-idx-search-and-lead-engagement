import { isFictional, toE164 } from '../src/common/phone';
import { localParts, nextLocalHour, zonedTime } from '../src/common/time';
import { pickByLoad } from '../src/leads/routing';
import { evaluate, keyword, PolicyInput } from '../src/messaging/policy';
import { availableSlots } from '../src/messaging/slots';
import { twilioSignature, verifyTwilioSignature } from '../src/messaging/twilio-signature';

const TZ = 'America/New_York';
const at = (h: number, m = 0) => zonedTime(2026, 10, 14, h, m, TZ); // a Wednesday

const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  kind: 'followup',
  now: at(14),
  timezone: TZ,
  consentSms: true,
  optedOutAt: null,
  inquiryAt: null,
  lastInboundAt: null,
  proactiveSentToday: 0,
  ...over,
});

describe('sending policy', () => {
  it('blocks opted-out and unconsented contacts, but always allows the STOP confirmation', () => {
    expect(evaluate(input({ optedOutAt: new Date() }))).toEqual({ action: 'block', reason: 'opted_out' });
    expect(evaluate(input({ consentSms: false }))).toEqual({ action: 'block', reason: 'no_consent' });
    expect(evaluate(input({ kind: 'confirmation', optedOutAt: new Date() }))).toEqual({ action: 'send', responsive: true });
  });

  it('defers proactive follow-ups in quiet hours to 8 a.m. local', () => {
    const d = evaluate(input({ now: at(22) }));
    expect(d.action).toBe('defer');
    if (d.action !== 'defer') return;
    const local = localParts(d.until, TZ);
    expect([local.hour, local.minute, local.day]).toEqual([8, 0, 15]);
    expect(evaluate(input({ now: at(7, 59) })).action).toBe('defer');
    expect(evaluate(input({ now: at(8) })).action).toBe('send');
  });

  it('answers a lead who just wrote at any hour', () => {
    const now = at(23);
    expect(evaluate(input({ kind: 'first_touch', now, inquiryAt: new Date(now.getTime() - 60_000) }))).toEqual({
      action: 'send',
      responsive: true,
    });
    expect(evaluate(input({ kind: 'reply', now, lastInboundAt: new Date(now.getTime() - 10 * 60_000) }))).toEqual({
      action: 'send',
      responsive: true,
    });
    expect(evaluate(input({ kind: 'reply', now, lastInboundAt: new Date(now.getTime() - 3 * 3600_000) })).action).toBe('defer');
  });

  it('caps proactive messages per local day and defers the rest to tomorrow', () => {
    const d = evaluate(input({ now: at(9), proactiveSentToday: 2 }));
    expect(d.action).toBe('defer');
    if (d.action !== 'defer') return;
    expect(d.reason).toBe('daily_cap');
    expect(localParts(d.until, TZ).day).toBe(15);
  });

  it('matches carrier keywords on the whole message only', () => {
    expect(keyword('STOP')).toBe('stop');
    expect(keyword(' stop. ')).toBe('stop');
    expect(keyword('Unsubscribe')).toBe('stop');
    expect(keyword('start')).toBe('start');
    expect(keyword('HELP')).toBe('help');
    expect(keyword('please stop by saturday')).toBeNull();
    expect(keyword('yes')).toBeNull();
  });
});

describe('Twilio signatures', () => {
  const url = 'https://example.com/webhooks/sms/inbound?foo=1&bar=2';
  const params = { MessageSid: 'SM1234567890ABCDE', Body: 'Yes, Saturday works', From: '+12025550142', To: '+12025550188', NumMedia: '0' };

  it('matches a vector computed independently with HMAC-SHA1 (URL + sorted params)', () => {
    expect(twilioSignature('12345', url, params)).toBe('BykQvYaCs5xrDVlsjbXaUaVhsLY=');
  });

  it('rejects a tampered body, a wrong URL or a missing header', () => {
    const sig = twilioSignature('12345', url, params);
    expect(verifyTwilioSignature('12345', url, params, sig)).toBe(true);
    expect(verifyTwilioSignature('12345', url, { ...params, Body: 'STOP' }, sig)).toBe(false);
    expect(verifyTwilioSignature('12345', `${url}&x=1`, params, sig)).toBe(false);
    expect(verifyTwilioSignature('12345', url, params, undefined)).toBe(false);
  });
});

describe('showing slots', () => {
  const hours = { showingHours: [10, 14], workDays: [1, 2, 3, 4, 5, 6] };

  it('offers working-hour slots at least two hours out, skipping booked ones and days off', () => {
    const now = at(9, 30);
    const booked = [zonedTime(2026, 10, 15, 10, 0, TZ)];
    const slots = availableSlots(hours, TZ, now, booked, { days: 4, max: 10 });
    const labels = slots.map((s) => {
      const p = localParts(new Date(s), TZ);
      return `${p.day} ${p.hour}`;
    });
    // Wed 10:00 is too soon; Thu 10:00 is booked; Sunday 18th is not a work day.
    expect(labels).toEqual(['14 14', '15 14', '16 10', '16 14', '17 10', '17 14']);
  });

  it('handles the DST change in November', () => {
    const fall = zonedTime(2026, 11, 2, 10, 0, TZ);
    expect(localParts(fall, TZ).hour).toBe(10);
    expect(nextLocalHour(zonedTime(2026, 10, 31, 22, 0, TZ), 8, TZ).toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });
});

describe('lead routing fallback', () => {
  it('weights recent load by capacity, then prefers whoever was assigned least recently', () => {
    const t = (iso: string) => new Date(iso);
    const pick = pickByLoad([
      { id: 'a', recent: 4, capacity: 10, lastAssignedAt: t('2026-10-16T10:00:00Z') },
      { id: 'b', recent: 9, capacity: 20, lastAssignedAt: t('2026-10-16T09:00:00Z') },
      { id: 'c', recent: 4, capacity: 10, lastAssignedAt: t('2026-10-16T08:00:00Z') },
    ]);
    expect(pick?.id).toBe('c');
    expect(pickByLoad([])).toBeNull();
  });
});

describe('phone numbers', () => {
  it('normalizes to E.164 and recognizes the fictional 555-01xx block', () => {
    expect(toE164('(202) 555-0143')).toBe('+12025550143');
    expect(toE164('1-202-555-0143')).toBe('+12025550143');
    expect(toE164('555-0143')).toBeNull();
    expect(isFictional('+12025550143')).toBe(true);
    expect(isFictional('+10000000000')).toBe(false);
  });
});
