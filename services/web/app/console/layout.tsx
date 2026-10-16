import Link from 'next/link';
import ConsoleNav from '@/components/ConsoleNav';
import OfficeSwitcher from '@/components/OfficeSwitcher';
import { api, currentOffice } from '@/lib/server-api';
import type { Office } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [offices, current] = await Promise.all([api<Office[]>('/v1/offices').catch(() => [] as Office[]), currentOffice()]);
  const office = offices.find((o) => o.slug === current);
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 rounded-full" style={{ background: office?.brand_color ?? 'var(--accent)' }} aria-hidden />
            <Link href="/console" className="font-semibold">Agent console</Link>
            <span className="hidden text-xs text-muted sm:inline">synthetic data</span>
          </div>
          <div className="flex items-center gap-3">
            {office && <Link href={`/s/${office.slug}`} className="text-sm text-accent underline">Search site</Link>}
            {offices.length > 0 && <OfficeSwitcher offices={offices} current={current} />}
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-3 pb-2">
          <ConsoleNav />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
