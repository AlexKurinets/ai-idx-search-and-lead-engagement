import { NextRequest, NextResponse } from 'next/server';
import { API, currentOffice, tokenFor } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/**
 * Browser calls go through this proxy. Public search, lead and sandbox routes pass
 * straight through; console and ops routes get the right bearer token attached here, so
 * no token ever reaches the browser. Internal routes are never proxied.
 */
async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const allowed = (path[0] === 'v1' && path[1] !== 'auth') || path[0] === 'sandbox';
  if (!allowed) return NextResponse.json({ message: 'not found' }, { status: 404 });

  const headers: Record<string, string> = { 'content-type': req.headers.get('content-type') ?? 'application/json' };
  if (path[1] === 'console') headers.authorization = `Bearer ${await tokenFor(await currentOffice())}`;
  if (path[1] === 'ops') headers.authorization = `Bearer ${await tokenFor('platform')}`;

  const res = await fetch(`${API}/${path.map(encodeURIComponent).join('/')}${req.nextUrl.search}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
    cache: 'no-store',
  });
  return new NextResponse(await res.text(), {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export { proxy as GET, proxy as POST };
