-- Platform tables: MLS sources, shared listing data, geography, replication state and
-- the transactional outbox. None of these hold tenant data, so none carry RLS.

CREATE EXTENSION IF NOT EXISTS postgis;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'idx_app') THEN
    CREATE ROLE idx_app LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'idx_platform') THEN
    CREATE ROLE idx_platform LOGIN BYPASSRLS;
  END IF;
END $$;

CREATE TABLE mls_sources (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  city        text NOT NULL,
  timezone    text NOT NULL,
  base_url    text NOT NULL
);

CREATE TABLE neighborhoods (
  id        text PRIMARY KEY,
  mls_code  text NOT NULL REFERENCES mls_sources,
  name      text NOT NULL,
  geom      geometry(Polygon, 4326) NOT NULL
);
CREATE INDEX neighborhoods_geom ON neighborhoods USING gist (geom);

-- Named places a buyer can search near. near_m is how close counts as "near".
CREATE TABLE places (
  id        text PRIMARY KEY,
  mls_code  text NOT NULL REFERENCES mls_sources,
  kind      text NOT NULL CHECK (kind IN ('river', 'park')),
  name      text NOT NULL,
  geom      geometry(Geometry, 4326) NOT NULL,
  near_m    integer NOT NULL
);
CREATE INDEX places_geog ON places USING gist ((geom::geography));

CREATE TABLE listings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mls_code            text NOT NULL REFERENCES mls_sources,
  listing_key         text NOT NULL,
  listing_id          text,
  status              text NOT NULL,
  property_sub_type   text,
  list_price          integer,
  original_list_price integer,
  close_price         integer,
  close_date          date,
  beds                smallint,
  baths               numeric(4, 1),
  living_area_sqft    integer,
  lot_acres           numeric(8, 2),
  year_built          smallint,
  address_line        text,
  city                text,
  subdivision         text,
  geom                geometry(Point, 4326),
  neighborhood_id     text REFERENCES neighborhoods,
  place_ids           text[] NOT NULL DEFAULT '{}',
  remarks             text,
  features            text[] NOT NULL DEFAULT '{}',
  idx_entire          boolean NOT NULL DEFAULT true,
  idx_address         boolean NOT NULL DEFAULT true,
  list_office_name    text,
  list_agent_name     text,
  photos_count        integer,
  association_fee     integer,
  original_entry_ts   timestamptz,
  modification_ts     timestamptz NOT NULL,
  price_change_ts     timestamptz,
  status_change_ts    timestamptz,
  replicated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  removed_at          timestamptz,
  raw                 jsonb NOT NULL,
  UNIQUE (mls_code, listing_key)
);
CREATE INDEX listings_geom ON listings USING gist (geom);
CREATE INDEX listings_market_status ON listings (mls_code, status) WHERE removed_at IS NULL;
CREATE INDEX listings_hood_status ON listings (neighborhood_id, status) WHERE removed_at IS NULL;
CREATE INDEX listings_closed ON listings (close_date) WHERE status = 'Closed';

-- The replication cursor is the pair (cursor_ts, cursor_key), never the timestamp alone.
CREATE TABLE replication_state (
  mls_code             text PRIMARY KEY REFERENCES mls_sources,
  cursor_ts            timestamptz NOT NULL DEFAULT 'epoch',
  cursor_key           text NOT NULL DEFAULT '',
  backfill_complete    boolean NOT NULL DEFAULT false,
  records_total        bigint NOT NULL DEFAULT 0,
  throttled_total      bigint NOT NULL DEFAULT 0,
  last_run_at          timestamptz,
  last_success_at      timestamptz,
  last_error           text,
  last_reconcile_at    timestamptz,
  removed_by_reconcile bigint NOT NULL DEFAULT 0
);

CREATE TABLE replication_runs (
  id          bigserial PRIMARY KEY,
  mls_code    text NOT NULL REFERENCES mls_sources,
  kind        text NOT NULL CHECK (kind IN ('incremental', 'backfill', 'reconcile')),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  pages       integer NOT NULL DEFAULT 0,
  records     integer NOT NULL DEFAULT 0,
  throttled   integer NOT NULL DEFAULT 0,
  removed     integer NOT NULL DEFAULT 0,
  error       text
);
CREATE INDEX replication_runs_recent ON replication_runs (mls_code, started_at DESC);

-- Lookup values a mapping file did not recognize. Logged, never guessed.
CREATE TABLE mapping_issues (
  mls_code           text NOT NULL REFERENCES mls_sources,
  field              text NOT NULL,
  value              text NOT NULL,
  occurrences        bigint NOT NULL DEFAULT 1,
  sample_listing_key text,
  first_seen         timestamptz NOT NULL DEFAULT now(),
  last_seen          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mls_code, field, value)
);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;

-- One row per incremental change that reached the search index, for lag measurement.
CREATE TABLE pipeline_lag_samples (
  id              bigserial PRIMARY KEY,
  listing_id      uuid NOT NULL,
  mls_code        text NOT NULL,
  mls_modified_at timestamptz NOT NULL,
  replicated_at   timestamptz NOT NULL,
  indexed_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pipeline_lag_recent ON pipeline_lag_samples (indexed_at DESC);

CREATE TABLE neighborhood_insights (
  neighborhood_id text NOT NULL REFERENCES neighborhoods,
  as_of           date NOT NULL,
  stats           jsonb NOT NULL,
  body            text NOT NULL,
  validation      jsonb NOT NULL,
  model           text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (neighborhood_id, as_of)
);

-- The sandbox carrier: every SMS the sandbox adapter "sends" or "receives".
CREATE TABLE sandbox_sms (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid,
  direction    text NOT NULL CHECK (direction IN ('to_handset', 'from_handset')),
  handset      text NOT NULL,
  brokerage_number text NOT NULL,
  body         text NOT NULL,
  provider_sid text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sandbox_sms_handset ON sandbox_sms (handset, id);
