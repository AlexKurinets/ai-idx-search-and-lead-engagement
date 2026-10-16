import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'yaml';
import { config } from '../config';

type Source = Record<string, unknown>;

type FieldSpec =
  | string
  | { from: string; type?: 'integer' | 'number' | 'boolean' | 'string'; lookup?: string; default?: unknown }
  | { sum: { from: string; weight?: number }[] };

type Condition =
  | { from: string; equals?: unknown; gte?: number; contains?: string }
  | { any: Condition[] };

interface MappingFile {
  mls?: string;
  extends?: string;
  fields?: Record<string, FieldSpec>;
  lookups?: Record<string, Record<string, string>>;
  features?: Record<string, Condition>;
}

export interface Mapping {
  mls: string;
  fields: Record<string, FieldSpec>;
  lookups: Record<string, Record<string, string>>;
  features: Record<string, Condition>;
}

export interface CanonicalListing {
  mls_code: string;
  listing_key: string;
  listing_id: string | null;
  status: string;
  property_sub_type: string | null;
  list_price: number | null;
  original_list_price: number | null;
  close_price: number | null;
  close_date: string | null;
  beds: number | null;
  baths: number | null;
  living_area_sqft: number | null;
  lot_acres: number | null;
  year_built: number | null;
  address_line: string | null;
  city: string | null;
  subdivision: string | null;
  lat: number | null;
  lon: number | null;
  remarks: string | null;
  features: string[];
  idx_entire: boolean;
  idx_address: boolean;
  list_office_name: string | null;
  list_agent_name: string | null;
  photos_count: number | null;
  association_fee: number | null;
  original_entry_ts: string | null;
  modification_ts: string;
  price_change_ts: string | null;
  status_change_ts: string | null;
  raw: Source;
}

export interface MappingIssue {
  field: string;
  value: string;
  listing_key: string;
}

export const UNMAPPED = 'Unmapped';

function readFile(name: string, dir: string): MappingFile {
  return parse(fs.readFileSync(path.join(dir, `${name}.yaml`), 'utf8')) as MappingFile;
}

export function loadMapping(mls: string, dir = config.mappingsDir): Mapping {
  const own = readFile(mls.toLowerCase(), dir);
  const base: MappingFile = own.extends ? readFile(own.extends, dir) : {};
  const lookups: Record<string, Record<string, string>> = {};
  for (const key of new Set([...Object.keys(base.lookups ?? {}), ...Object.keys(own.lookups ?? {})])) {
    lookups[key] = { ...(base.lookups?.[key] ?? {}), ...(own.lookups?.[key] ?? {}) };
  }
  return {
    mls: own.mls ?? mls.toUpperCase(),
    fields: { ...(base.fields ?? {}), ...(own.fields ?? {}) },
    lookups,
    features: { ...(base.features ?? {}), ...(own.features ?? {}) },
  };
}

function coerce(value: unknown, type?: string): unknown {
  if (value === undefined || value === null || value === '') return null;
  switch (type) {
    case 'integer': {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? n : null;
    }
    case 'number': {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 'Y' || value === 1;
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

function matches(cond: Condition, src: Source): boolean {
  if ('any' in cond) return cond.any.some((c) => matches(c, src));
  const v = src[cond.from];
  if (cond.equals !== undefined) return v === cond.equals || coerce(v, 'boolean') === cond.equals;
  if (cond.gte !== undefined) return v !== null && v !== undefined && Number(v) >= cond.gte;
  if (cond.contains !== undefined) return Array.isArray(v) && v.includes(cond.contains);
  return false;
}

/**
 * Maps one raw RESO record to the canonical model. A lookup value the mapping does not
 * know becomes "Unmapped" and is reported as an issue; the record is still stored but
 * never displayed, so a feed change shows up as a review item rather than a wrong listing.
 */
export function mapRecord(mapping: Mapping, src: Source): { listing: CanonicalListing; issues: MappingIssue[] } {
  const issues: MappingIssue[] = [];
  const out: Record<string, unknown> = {};
  const key = String(src.ListingKey ?? '');

  for (const [target, spec] of Object.entries(mapping.fields)) {
    if (typeof spec === 'string') {
      out[target] = coerce(src[spec]);
    } else if ('sum' in spec) {
      let total = 0;
      let seen = false;
      for (const part of spec.sum) {
        const v = coerce(src[part.from], 'number') as number | null;
        if (v !== null) {
          total += v * (part.weight ?? 1);
          seen = true;
        }
      }
      out[target] = seen ? total : null;
    } else {
      let v = coerce(src[spec.from], spec.lookup ? 'string' : spec.type);
      if (v === null && spec.default !== undefined) v = spec.default;
      if (spec.lookup && v !== null) {
        const table = mapping.lookups[spec.lookup] ?? {};
        const mapped = table[v as string];
        if (mapped === undefined) {
          issues.push({ field: spec.from, value: String(v), listing_key: key });
          v = UNMAPPED;
        } else {
          v = mapped;
        }
      }
      out[target] = v;
    }
  }

  const features = Object.entries(mapping.features)
    .filter(([, cond]) => matches(cond, src))
    .map(([name]) => name)
    .sort();

  return {
    listing: {
      ...(out as Omit<CanonicalListing, 'mls_code' | 'features' | 'raw'>),
      mls_code: mapping.mls,
      listing_key: key,
      status: (out.status as string) ?? UNMAPPED,
      features,
      raw: src,
    } as CanonicalListing,
    issues,
  };
}
