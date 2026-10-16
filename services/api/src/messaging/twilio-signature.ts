import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Twilio's webhook signature: HMAC-SHA1, keyed with the account auth token, over the
 * full request URL followed by every POST parameter name and value, sorted by name,
 * base64 encoded. The sandbox handset signs its webhook calls the same way, so the
 * same verification path runs in development and production.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
