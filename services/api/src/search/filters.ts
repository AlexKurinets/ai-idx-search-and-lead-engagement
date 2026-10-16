import { z } from 'zod';

/**
 * The search filter contract. The natural-language parser in the AI service produces
 * exactly this shape, the UI edits it as chips, saved searches store it, and the query
 * builder is the only code that turns it into OpenSearch DSL. Nothing else writes queries.
 */
export const FEATURES = [
  'pool', 'fireplace', 'garage', 'waterfront', 'river_view', 'park_view', 'hardwood', 'updated_kitchen',
  'kitchen_island', 'open_floorplan', 'home_office', 'large_yard', 'deck', 'finished_basement', 'solar',
] as const;
export const SUB_TYPES = ['single_family', 'condo', 'townhouse'] as const;
export const STATUSES = ['Active', 'ComingSoon', 'ActiveUnderContract', 'Pending'] as const;
export const SORTS = ['relevance', 'newest', 'price_asc', 'price_desc', 'price_drop'] as const;

export const LocationRef = z.object({
  kind: z.enum(['neighborhood', 'place', 'city']),
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(80),
});

export const SearchFilters = z.object({
  price_min: z.number().int().min(0).max(50_000_000).nullable().default(null),
  price_max: z.number().int().min(0).max(50_000_000).nullable().default(null),
  beds_min: z.number().int().min(0).max(10).nullable().default(null),
  baths_min: z.number().min(0).max(10).nullable().default(null),
  sqft_min: z.number().int().min(0).max(20_000).nullable().default(null),
  property_types: z.array(z.enum(SUB_TYPES)).max(3).default([]),
  statuses: z.array(z.enum(STATUSES)).min(1).max(4).default(['Active', 'ComingSoon']),
  features: z.array(z.enum(FEATURES)).max(8).default([]),
  location: LocationRef.nullable().default(null),
  keywords: z.array(z.string().min(2).max(40)).max(8).default([]),
  max_days_on_market: z.number().int().min(1).max(365).nullable().default(null),
  sort: z.enum(SORTS).default('relevance'),
});

export type SearchFilters = z.infer<typeof SearchFilters>;

export const emptyFilters = (): SearchFilters => SearchFilters.parse({});

/** Swaps an inverted price range rather than returning nothing. */
export function normalizeFilters(f: SearchFilters): SearchFilters {
  const out = { ...f };
  if (out.price_min !== null && out.price_max !== null && out.price_min > out.price_max) {
    [out.price_min, out.price_max] = [out.price_max, out.price_min];
  }
  out.features = [...new Set(out.features)];
  out.keywords = [...new Set(out.keywords.map((k) => k.toLowerCase()))];
  return out;
}
