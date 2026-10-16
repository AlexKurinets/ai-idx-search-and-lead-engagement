'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/console', label: 'Overview' },
  { href: '/console/conversations', label: 'Conversations' },
  { href: '/console/relationships', label: 'Relationships' },
  { href: '/console/farms', label: 'Farm reports' },
  { href: '/console/pipeline', label: 'IDX pipeline' },
  { href: '/console/phone', label: 'Sandbox phone' },
];

export default function ConsoleNav() {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto" aria-label="Console">
      {LINKS.map((l) => {
        const active = l.href === '/console' ? path === '/console' : path.startsWith(l.href);
        return (
          <Link
            key={l.href}
            href={l.href}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium ${active ? 'bg-accent-soft text-ink' : 'text-ink2 hover:bg-page'}`}
            aria-current={active ? 'page' : undefined}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
