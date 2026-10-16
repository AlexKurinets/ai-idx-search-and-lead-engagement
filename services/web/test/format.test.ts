import { describe, expect, it } from 'vitest';
import { chipsFor, isRefinement, localTime, money, seconds, shortMoney } from '../lib/format';
import type { SearchFilters } from '../lib/types';

const base: SearchFilters = {
  price_min: null, price_max: null, beds_min: null, baths_min: null, sqft_min: null, property_types: [],
  statuses: ['Active', 'ComingSoon'], features: [], location: null, keywords: [], max_days_on_market: null, sort: 'relevance',
};

describe('chips', () => {
  it('turns every interpreted filter into a removable chip', () => {
    const f: SearchFilters = {
      ...base, beds_min: 3, price_max: 600000, features: ['large_yard'], keywords: ['natural light'],
      location: { kind: 'place', id: 'ecm-ellery-river', name: 'Ellery River' },
    };
    const chips = chipsFor(f);
    expect(chips.map((c) => c.label)).toEqual(['Near Ellery River', 'Under $600K', '3+ beds', 'Yard', '"natural light"']);
    const withoutYard = chips.find((c) => c.key === 'feature:large_yard')!.remove(f);
    expect(withoutYard.features).toEqual([]);
    expect(withoutYard.beds_min).toBe(3);
  });

  it('shows no chips for the default search', () => {
    expect(chipsFor(base)).toEqual([]);
  });

  it('labels ranges, studios and status changes', () => {
    const labels = chipsFor({ ...base, price_min: 300000, price_max: 1250000, beds_min: 0, statuses: ['ComingSoon'] }).map((c) => c.label);
    expect(labels).toEqual(['$300K to $1.25M', 'Studio+', 'Coming soon']);
  });
});

describe('refinement detection', () => {
  it('refines only when there is something to refine', () => {
    expect(isRefinement('cheaper', true)).toBe(true);
    expect(isRefinement('with a pool', true)).toBe(true);
    expect(isRefinement('with a pool', false)).toBe(false);
    expect(isRefinement('3 bed in Old Quay', true)).toBe(false);
  });
});

describe('formatting', () => {
  it('formats money, durations and office-local times', () => {
    expect(money(485000)).toBe('$485,000');
    expect(shortMoney(2_000_000)).toBe('$2M');
    expect(seconds(1.42)).toBe('1.4 s');
    expect(seconds(95)).toBe('2 min');
    expect(localTime('2026-10-17T14:00:00Z', 'America/New_York', { hour: 'numeric' })).toBe('10 AM');
  });
});
