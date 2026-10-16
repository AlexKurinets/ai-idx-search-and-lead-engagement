import type { Feature, SearchFilters } from './types';

export const FEATURE_LABELS: Record<Feature, string> = {
  pool: 'Pool',
  fireplace: 'Fireplace',
  garage: 'Garage',
  waterfront: 'Waterfront',
  river_view: 'River view',
  park_view: 'Park view',
  hardwood: 'Hardwood floors',
  updated_kitchen: 'Updated kitchen',
  kitchen_island: 'Kitchen island',
  open_floorplan: 'Open floor plan',
  home_office: 'Home office',
  large_yard: 'Yard',
  deck: 'Deck',
  finished_basement: 'Basement',
  solar: 'Solar',
};

const TYPE_LABELS = { single_family: 'House', condo: 'Condo', townhouse: 'Townhouse' } as const;
const SORT_LABELS = { relevance: 'Best match', newest: 'Newest', price_asc: 'Lowest price', price_desc: 'Highest price', price_drop: 'Price drops' };

export function money(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** $485K, $1.25M */
export function shortMoney(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2).replace(/0$/, '')}M`;
  return `$${Math.round(n / 1000)}K`;
}

export function baths(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function seconds(s: number | null | undefined): string {
  if (s === null || s === undefined) return '–';
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export interface Chip {
  key: string;
  label: string;
  remove: (f: SearchFilters) => SearchFilters;
}

/** Every interpreted filter becomes a chip the buyer can remove with one tap. */
export function chipsFor(f: SearchFilters): Chip[] {
  const out: Chip[] = [];
  if (f.location) out.push({ key: 'location', label: f.location.kind === 'place' ? `Near ${f.location.name}` : f.location.name, remove: (x) => ({ ...x, location: null }) });
  if (f.price_min !== null && f.price_max !== null) {
    out.push({ key: 'price', label: `${shortMoney(f.price_min)} to ${shortMoney(f.price_max)}`, remove: (x) => ({ ...x, price_min: null, price_max: null }) });
  } else if (f.price_max !== null) {
    out.push({ key: 'price', label: `Under ${shortMoney(f.price_max)}`, remove: (x) => ({ ...x, price_max: null }) });
  } else if (f.price_min !== null) {
    out.push({ key: 'price', label: `Over ${shortMoney(f.price_min)}`, remove: (x) => ({ ...x, price_min: null }) });
  }
  if (f.beds_min !== null) out.push({ key: 'beds', label: f.beds_min === 0 ? 'Studio+' : `${f.beds_min}+ beds`, remove: (x) => ({ ...x, beds_min: null }) });
  if (f.baths_min !== null) out.push({ key: 'baths', label: `${baths(f.baths_min)}+ baths`, remove: (x) => ({ ...x, baths_min: null }) });
  if (f.sqft_min !== null) out.push({ key: 'sqft', label: `${f.sqft_min.toLocaleString('en-US')}+ sq ft`, remove: (x) => ({ ...x, sqft_min: null }) });
  for (const t of f.property_types) {
    out.push({ key: `type:${t}`, label: TYPE_LABELS[t], remove: (x) => ({ ...x, property_types: x.property_types.filter((p) => p !== t) }) });
  }
  for (const feat of f.features) {
    out.push({ key: `feature:${feat}`, label: FEATURE_LABELS[feat] ?? feat, remove: (x) => ({ ...x, features: x.features.filter((p) => p !== feat) }) });
  }
  for (const k of f.keywords) {
    out.push({ key: `kw:${k}`, label: `"${k}"`, remove: (x) => ({ ...x, keywords: x.keywords.filter((p) => p !== k) }) });
  }
  if (f.max_days_on_market !== null) {
    out.push({ key: 'dom', label: `Listed in last ${f.max_days_on_market} days`, remove: (x) => ({ ...x, max_days_on_market: null }) });
  }
  const statuses = [...f.statuses].sort().join(',');
  if (statuses !== 'Active,ComingSoon') {
    out.push({ key: 'status', label: f.statuses.length === 1 && f.statuses[0] === 'ComingSoon' ? 'Coming soon' : 'Incl. pending', remove: (x) => ({ ...x, statuses: ['Active', 'ComingSoon'] }) });
  }
  if (f.sort !== 'relevance') out.push({ key: 'sort', label: SORT_LABELS[f.sort], remove: (x) => ({ ...x, sort: 'relevance' }) });
  return out;
}

const REFINE = /^(cheaper|with|without|no|also|and|add|more|bigger|larger|smaller|plus|only|but|anywhere|any price|less|under|over|near)\b/i;

/** A follow-up like "cheaper" or "with a pool" refines the current search instead of replacing it. */
export function isRefinement(q: string, hasFilters: boolean): boolean {
  return hasFilters && REFINE.test(q.trim());
}

export const STATUS_LABELS: Record<string, string> = {
  Active: 'Active',
  ComingSoon: 'Coming soon',
  ActiveUnderContract: 'Under contract',
  Pending: 'Pending',
};

/** A timestamp in the office's own time zone, never the server's. */
export function localTime(iso: string | null | undefined, timeZone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  if (!iso) return '–';
  return new Intl.DateTimeFormat('en-US', { timeZone, ...opts }).format(new Date(iso));
}
