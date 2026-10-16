import 'server-only';
import { cookies } from 'next/headers';

export const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4100';
export const DEFAULT_OFFICE = 'old-quay';

const tokens = new Map<string, { token: string; at: number }>();

/**
 * Console pages run as an office admin, the pipeline page as the platform admin. The
 * API's dev issuer mints those tokens; the browser never sees them, because every
 * console call goes through this server or the /api proxy route.
 */
export async function tokenFor(scope: string): Promise<string> {
  const hit = tokens.get(scope);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.token;
  const body = scope === 'platform' ? { platform: true } : { tenant_slug: scope };
  const res = await fetch(`${API}/v1/auth/dev-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`dev token failed: ${res.status}`);
  const { token } = (await res.json()) as { token: string };
  tokens.set(scope, { token, at: Date.now() });
  return token;
}

export async function currentOffice(): Promise<string> {
  const jar = await cookies();
  return jar.get('office')?.value ?? DEFAULT_OFFICE;
}

export async function api<T>(path: string, opts: { auth?: 'office' | 'platform'; method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth) headers.authorization = `Bearer ${await tokenFor(opts.auth === 'platform' ? 'platform' : await currentOffice())}`;
  const res = await fetch(`${API}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export async function officeInfo(): Promise<{ slug: string; name: string; timezone: string; sms_number: string }> {
  const slug = await currentOffice();
  return api(`/v1/t/${encodeURIComponent(slug)}`);
}
