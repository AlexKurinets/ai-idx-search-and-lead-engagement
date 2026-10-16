import Link from 'next/link';
import { baths, FEATURE_LABELS, money, STATUS_LABELS } from '@/lib/format';
import type { Card, Feature } from '@/lib/types';
import HomeArt from './HomeArt';

export default function ListingCard({ office, card, selected }: { office: string; card: Card; selected?: boolean }) {
  const isNew = card.list_date && Date.now() - new Date(card.list_date).getTime() < 7 * 86_400_000;
  return (
    <Link
      href={`/s/${office}/listing/${card.id}`}
      id={`card-${card.id}`}
      className={`card flex gap-3 overflow-hidden p-2 transition hover:border-accent ${selected ? 'border-accent ring-2 ring-accent/30' : ''}`}
    >
      <HomeArt id={card.id} subType={card.sub_type} className="h-24 w-28 flex-none rounded-lg" />
      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-lg font-bold tracking-tight">{money(card.price)}</p>
          <div className="flex flex-none gap-1">
            {card.status !== 'Active' && <span className="rounded bg-page px-1.5 py-0.5 text-[11px] font-medium text-ink2">{STATUS_LABELS[card.status] ?? card.status}</span>}
            {card.price_reduced && <span className="rounded bg-page px-1.5 py-0.5 text-[11px] font-medium text-ink2">Price drop</span>}
            {isNew && <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-ink">New</span>}
          </div>
        </div>
        <p className="text-sm text-ink2">
          {card.beds ?? 0} bd · {baths(card.baths)} ba · {card.sqft?.toLocaleString('en-US')} sq ft
        </p>
        <p className="truncate text-sm">{card.address ?? 'Address withheld by seller'}</p>
        <p className="truncate text-xs text-muted">
          {card.neighborhood}, {card.city}
          {card.features.length > 0 && ` · ${card.features.slice(0, 2).map((f) => FEATURE_LABELS[f as Feature] ?? f).join(', ')}`}
        </p>
      </div>
    </Link>
  );
}
