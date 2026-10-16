import { Logger } from '@nestjs/common';

export interface ResoPage<T = Record<string, unknown>> {
  value: T[];
  throttled: number;
}

export interface ResoQuery {
  filter?: string;
  orderby?: string;
  top: number;
  select?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal RESO Web API client: OAuth2 client credentials, token refresh on 401,
 * Retry-After on 429, and bounded exponential backoff on 5xx and network errors.
 */
export class ResoClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly log: Logger;

  constructor(
    readonly mls: string,
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.log = new Logger(`reso:${mls}`);
  }

  private async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - 30_000 > Date.now()) return this.token.value;
    const res = await this.fetchImpl(`${this.baseUrl}/${this.mls}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`token request failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  async property<T = Record<string, unknown>>(q: ResoQuery): Promise<ResoPage<T>> {
    const params = new URLSearchParams({ $top: String(q.top) });
    if (q.filter) params.set('$filter', q.filter);
    if (q.orderby) params.set('$orderby', q.orderby);
    if (q.select) params.set('$select', q.select);
    const url = `${this.baseUrl}/${this.mls}/odata/Property?${params.toString()}`;

    let throttled = 0;
    let refreshed = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.accessToken()}` } });
      } catch (err) {
        await sleep(Math.min(8_000, 250 * 2 ** attempt));
        if (attempt >= 4) throw err;
        continue;
      }
      if (res.status === 200) {
        const body = (await res.json()) as { value: T[] };
        return { value: body.value, throttled };
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.accessToken(true);
        continue;
      }
      if (res.status === 429) {
        throttled++;
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        if (throttled === 1) this.log.warn(`throttled, honoring Retry-After ${retryAfter}s`);
        await sleep(Math.max(1, retryAfter) * 1000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(Math.min(8_000, 250 * 2 ** attempt));
        continue;
      }
      throw new Error(`RESO request failed: ${res.status} ${await res.text()}`);
    }
    throw new Error('RESO request gave up after retries');
  }
}
