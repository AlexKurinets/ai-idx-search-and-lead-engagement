import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import SearchApp from '@/components/SearchApp';
import { api } from '@/lib/server-api';
import type { Office } from '@/lib/types';

export const dynamic = 'force-dynamic';

async function load(slug: string) {
  return api<Office>(`/v1/t/${encodeURIComponent(slug)}`).catch(() => null);
}

export async function generateMetadata({ params }: { params: Promise<{ office: string }> }): Promise<Metadata> {
  const office = await load((await params).office);
  return { title: office ? `Homes for sale · ${office.name}` : 'Search' };
}

export default async function OfficeSearch({ params }: { params: Promise<{ office: string }> }) {
  const office = await load((await params).office);
  if (!office) notFound();
  return <SearchApp office={office} />;
}
