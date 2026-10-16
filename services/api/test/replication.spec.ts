import { advance, cursorFilter, EPOCH_CURSOR, formatTs, keyScanFilter } from '../src/replication/cursor';
import { loadMapping, mapRecord, UNMAPPED } from '../src/replication/mapping';
import { ResoClient } from '../src/replication/reso-client';

const base = {
  ListingKey: 'X000000001',
  ListingId: 'X1',
  StandardStatus: 'Active',
  PropertySubType: 'SingleFamilyResidence',
  ListPrice: 485000,
  OriginalListPrice: 499000,
  BedroomsTotal: 3,
  BathroomsFull: 2,
  BathroomsHalf: 1,
  LivingArea: 1850,
  LotSizeAcres: 0.31,
  YearBuilt: 1998,
  UnparsedAddress: '412 Gannet Way',
  City: 'Port Ellery',
  SubdivisionName: 'Old Quay',
  Latitude: 35.4,
  Longitude: -77.9,
  PublicRemarks: 'Bright home.',
  InternetEntireListingDisplayYN: true,
  InternetAddressDisplayYN: false,
  ModificationTimestamp: '2026-10-16T12:00:00.123Z',
  PoolPrivateYN: true,
  FireplaceYN: false,
  GarageSpaces: 2,
  WaterfrontYN: false,
  View: ['River'],
  InteriorFeatures: ['Hardwood Floors', 'Home Office'],
  ExteriorFeatures: [],
  Basement: [],
  GreenEnergyGeneration: [],
};

describe('replication cursor', () => {
  it('resumes strictly after the last (timestamp, key) pair', () => {
    expect(cursorFilter({ ts: '2026-10-16T12:00:00.123Z', key: "ECM'1" })).toBe(
      "ModificationTimestamp gt 2026-10-16T12:00:00.123Z or (ModificationTimestamp eq 2026-10-16T12:00:00.123Z and ListingKey gt 'ECM''1')",
    );
  });

  it('starts at the epoch and advances to the last record of a page', () => {
    expect(EPOCH_CURSOR).toEqual({ ts: '1970-01-01T00:00:00.000Z', key: '' });
    const page = [
      { ModificationTimestamp: '2026-10-16T12:00:00.000Z', ListingKey: 'A' },
      { ModificationTimestamp: '2026-10-16T12:00:00.000Z', ListingKey: 'B' },
    ];
    expect(advance(EPOCH_CURSOR, page)).toEqual({ ts: '2026-10-16T12:00:00.000Z', key: 'B' });
    expect(advance(EPOCH_CURSOR, [])).toBe(EPOCH_CURSOR);
  });

  it('formats timestamps at millisecond precision', () => {
    expect(formatTs(new Date(Date.UTC(2026, 9, 16, 12, 0, 0, 7)))).toBe('2026-10-16T12:00:00.007Z');
    expect(keyScanFilter('')).toBeUndefined();
    expect(keyScanFilter('K9')).toBe("ListingKey gt 'K9'");
  });
});

describe('per-MLS mapping', () => {
  it('maps a canonical feed and derives features from RESO fields', () => {
    const { listing, issues } = mapRecord(loadMapping('ECM'), base);
    expect(issues).toEqual([]);
    expect(listing).toMatchObject({
      mls_code: 'ECM',
      status: 'Active',
      property_sub_type: 'single_family',
      list_price: 485000,
      baths: 2.5,
      living_area_sqft: 1850,
      subdivision: 'Old Quay',
      idx_address: false,
      idx_entire: true,
    });
    expect(listing.features).toEqual(['garage', 'hardwood', 'home_office', 'large_yard', 'pool', 'river_view']);
  });

  it('absorbs display-name enumerations, string prices and a local neighborhood field (BVM)', () => {
    const src = {
      ...base,
      StandardStatus: 'Active Under Contract',
      PropertySubType: 'Single Family Residence',
      ListPrice: '425000.00',
      SubdivisionName: undefined,
      BVM_NeighborhoodName: 'Millrace',
    };
    const { listing, issues } = mapRecord(loadMapping('BVM'), src);
    expect(issues).toEqual([]);
    expect(listing.status).toBe('ActiveUnderContract');
    expect(listing.property_sub_type).toBe('single_family');
    expect(listing.list_price).toBe(425000);
    expect(listing.subdivision).toBe('Millrace');
  });

  it('reads the local square-footage field and logs an unknown status instead of guessing (HMR)', () => {
    const src = { ...base, LivingArea: undefined, HMR_TotalFinishedSqFt: 2210, PropertySubType: 'Townhome', StandardStatus: 'Contingent' };
    const { listing, issues } = mapRecord(loadMapping('HMR'), src);
    expect(listing.living_area_sqft).toBe(2210);
    expect(listing.property_sub_type).toBe('townhouse');
    expect(listing.status).toBe(UNMAPPED);
    expect(issues).toEqual([{ field: 'StandardStatus', value: 'Contingent', listing_key: 'X000000001' }]);
  });

  it('defaults IDX display flags to true only when the feed omits them', () => {
    const { listing } = mapRecord(loadMapping('ECM'), { ...base, InternetEntireListingDisplayYN: undefined });
    expect(listing.idx_entire).toBe(true);
    const hidden = mapRecord(loadMapping('ECM'), { ...base, InternetEntireListingDisplayYN: false }).listing;
    expect(hidden.idx_entire).toBe(false);
  });
});

describe('RESO client', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const token = () => ok({ access_token: 't', expires_in: 3600 });

  it('honors 429 Retry-After and counts throttles', async () => {
    jest.useFakeTimers();
    const calls: string[] = [];
    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/oauth/token')) return token();
      if (calls.filter((c) => c.includes('/odata/')).length === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      }
      return ok({ value: [{ ListingKey: 'A' }] });
    }) as unknown as typeof fetch;
    const client = new ResoClient('ECM', 'http://mls', 'ecm-replicator', 's', fetchImpl);
    const pending = client.property({ top: 1, filter: 'x' });
    await jest.advanceTimersByTimeAsync(1000);
    const page = await pending;
    expect(page).toEqual({ value: [{ ListingKey: 'A' }], throttled: 1 });
    jest.useRealTimers();
  });

  it('refreshes the token once on 401', async () => {
    let tokens = 0;
    let first = true;
    const fetchImpl = jest.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/oauth/token')) {
        tokens++;
        return token();
      }
      if (first) {
        first = false;
        return new Response('expired', { status: 401 });
      }
      return ok({ value: [] });
    }) as unknown as typeof fetch;
    const client = new ResoClient('ECM', 'http://mls', 'ecm-replicator', 's', fetchImpl);
    await expect(client.property({ top: 1 })).resolves.toEqual({ value: [], throttled: 0 });
    expect(tokens).toBe(2);
  });
});
