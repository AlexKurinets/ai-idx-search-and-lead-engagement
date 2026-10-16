export type Feature =
  | 'pool' | 'fireplace' | 'garage' | 'waterfront' | 'river_view' | 'park_view' | 'hardwood' | 'updated_kitchen'
  | 'kitchen_island' | 'open_floorplan' | 'home_office' | 'large_yard' | 'deck' | 'finished_basement' | 'solar';

export interface LocationRef {
  kind: 'neighborhood' | 'place' | 'city';
  id: string;
  name: string;
}

export interface SearchFilters {
  price_min: number | null;
  price_max: number | null;
  beds_min: number | null;
  baths_min: number | null;
  sqft_min: number | null;
  property_types: ('single_family' | 'condo' | 'townhouse')[];
  statuses: ('Active' | 'ComingSoon' | 'ActiveUnderContract' | 'Pending')[];
  features: Feature[];
  location: LocationRef | null;
  keywords: string[];
  max_days_on_market: number | null;
  sort: 'relevance' | 'newest' | 'price_asc' | 'price_desc' | 'price_drop';
}

export interface Card {
  id: string;
  mls: string;
  status: string;
  sub_type: string | null;
  price: number;
  original_price: number | null;
  price_reduced: boolean;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  location: { lat: number; lon: number };
  list_date: string | null;
  photos_count: number | null;
  features: string[];
  office: string | null;
}

export interface Cluster {
  key: string;
  count: number;
  lat: number;
  lon: number;
  min_price: number;
}

export interface SearchResponse {
  filters: SearchFilters;
  interpretation: {
    parser: 'rules' | 'rules+model';
    coverage: number;
    notices: string[];
    unresolved: string[];
    cached: boolean;
    parse_ms: number;
    model: string | null;
  } | null;
  total: number;
  took_ms: number;
  engine_ms: number;
  results: Card[];
  clusters: Cluster[] | null;
}

export interface Office {
  slug: string;
  name: string;
  city: string;
  mls_codes: string[];
  brand_color: string;
  center?: [number, number] | null;
  sms_number?: string;
  timezone?: string;
}
