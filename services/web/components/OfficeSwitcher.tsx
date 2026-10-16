'use client';

import { useRouter } from 'next/navigation';
import type { Office } from '@/lib/types';

export default function OfficeSwitcher({ offices, current }: { offices: Office[]; current: string }) {
  const router = useRouter();
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">Office</span>
      <select
        className="input w-auto py-1.5 text-sm"
        value={current}
        onChange={(e) => {
          document.cookie = `office=${e.target.value}; path=/; max-age=31536000; samesite=lax`;
          router.refresh();
        }}
      >
        {offices.map((o) => (
          <option key={o.slug} value={o.slug}>{o.name}</option>
        ))}
      </select>
    </label>
  );
}
