-- Tenant tables. A tenant is one brokerage office with its own search site, phone
-- number, agents and lead pool. Every table below carries tenant_id and is protected
-- by row-level security, so a query that forgets a WHERE clause still cannot read or
-- write another office's rows.

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  name            text NOT NULL,
  timezone        text NOT NULL,
  sms_number      text NOT NULL UNIQUE,
  brand_color     text NOT NULL DEFAULT '#0f766e',
  office_location geometry(Point, 4326),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Which MLS feeds an office participates in. IDX display is limited to these.
CREATE TABLE tenant_mls (
  tenant_id uuid NOT NULL REFERENCES tenants ON DELETE CASCADE,
  mls_code  text NOT NULL REFERENCES mls_sources,
  PRIMARY KEY (tenant_id, mls_code)
);

CREATE TABLE agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants,
  first_name     text NOT NULL,
  last_name      text NOT NULL,
  phone          text NOT NULL,
  email          text NOT NULL,
  capacity       integer NOT NULL DEFAULT 10,
  showing_hours  integer[] NOT NULL DEFAULT '{10,12,14,16}',
  work_days      integer[] NOT NULL DEFAULT '{1,2,3,4,5,6}',
  active         boolean NOT NULL DEFAULT true,
  last_assigned_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agents_tenant ON agents (tenant_id);

CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants,
  assigned_agent_id uuid REFERENCES agents,
  first_name        text NOT NULL,
  last_name         text,
  phone             text,
  email             text,
  source            text NOT NULL,
  stage             text NOT NULL DEFAULT 'new',
  timezone          text NOT NULL,
  consent_sms       boolean NOT NULL DEFAULT false,
  consent_email     boolean NOT NULL DEFAULT false,
  consent_at        timestamptz,
  consent_text      text,
  opted_out_at      timestamptz,
  home_location     geometry(Point, 4326),
  qualification     jsonb NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone)
);
CREATE INDEX contacts_tenant_agent ON contacts (tenant_id, assigned_agent_id);
CREATE INDEX contacts_home ON contacts USING gist (home_location);

CREATE TABLE contact_activity (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants,
  contact_id  uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  kind        text NOT NULL,
  listing_id  uuid,
  meta        jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX contact_activity_recent ON contact_activity (contact_id, occurred_at DESC);

CREATE TABLE saved_searches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants,
  contact_id      uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  name            text NOT NULL,
  query_text      text,
  filters         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_alert_at   timestamptz
);

CREATE TABLE search_alerts (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants,
  saved_search_id uuid NOT NULL REFERENCES saved_searches ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  listing_id      uuid NOT NULL REFERENCES listings,
  reason          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (saved_search_id, listing_id, reason)
);

CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants,
  contact_id         uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  agent_id           uuid REFERENCES agents,
  channel            text NOT NULL DEFAULT 'sms',
  status             text NOT NULL DEFAULT 'ai_active'
                     CHECK (status IN ('ai_active', 'handed_off', 'agent_owned', 'booked', 'opted_out', 'closed')),
  workflow_id        text,
  handoff_reason     text,
  inquiry_listing_id uuid REFERENCES listings,
  first_inquiry_at   timestamptz,
  first_response_at  timestamptz,
  proposed_slots     jsonb NOT NULL DEFAULT '[]',
  last_message_at    timestamptz,
  next_followup_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_id, channel)
);

CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants,
  conversation_id uuid NOT NULL REFERENCES conversations ON DELETE CASCADE,
  direction       text NOT NULL CHECK (direction IN ('in', 'out')),
  kind            text NOT NULL,
  body            text NOT NULL,
  intent          text,
  provider_sid    text,
  idempotency_key text,
  status          text NOT NULL,
  meta            jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, provider_sid)
);
CREATE INDEX messages_conversation ON messages (conversation_id, created_at);

CREATE TABLE appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants,
  contact_id      uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents,
  listing_id      uuid REFERENCES listings,
  conversation_id uuid REFERENCES conversations,
  starts_at       timestamptz NOT NULL,
  duration_min    integer NOT NULL DEFAULT 45,
  status          text NOT NULL DEFAULT 'booked',
  source          text NOT NULL CHECK (source IN ('ai', 'agent')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX appointments_agent_slot ON appointments (agent_id, starts_at) WHERE status = 'booked';

CREATE TABLE relationship_scores (
  contact_id         uuid PRIMARY KEY REFERENCES contacts ON DELETE CASCADE,
  tenant_id          uuid NOT NULL REFERENCES tenants,
  score              integer NOT NULL,
  band               text NOT NULL,
  components         jsonb NOT NULL,
  next_action        text NOT NULL,
  next_action_reason text NOT NULL,
  computed_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationship_scores_rank ON relationship_scores (tenant_id, score DESC);

CREATE TABLE farm_areas (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants,
  agent_id   uuid NOT NULL REFERENCES agents,
  name       text NOT NULL,
  geom       geometry(Polygon, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX farm_areas_geom ON farm_areas USING gist (geom);

CREATE TABLE farm_reports (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants,
  farm_area_id   uuid NOT NULL REFERENCES farm_areas ON DELETE CASCADE,
  period_start   date NOT NULL,
  period_end     date NOT NULL,
  stats          jsonb NOT NULL,
  body           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('draft', 'needs_review', 'sent')),
  validation     jsonb NOT NULL,
  attempts       integer NOT NULL,
  model          text NOT NULL,
  audience_count integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);
CREATE INDEX farm_reports_area ON farm_reports (farm_area_id, created_at DESC);

CREATE TABLE outbound_email (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants,
  contact_id uuid NOT NULL REFERENCES contacts ON DELETE CASCADE,
  kind       text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants,
  agent_id   uuid REFERENCES agents,
  kind       text NOT NULL,
  body       text NOT NULL,
  ref_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_sync_log (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants,
  event_type   text NOT NULL,
  contact_id   uuid,
  payload      jsonb NOT NULL,
  delivered_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE search_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants,
  query_text text,
  parser     text NOT NULL,
  took_ms    integer NOT NULL,
  parse_ms   integer,
  total      integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX search_log_recent ON search_log (created_at DESC);

-- NULLIF matters: once SET LOCAL has been used on a pooled connection the setting
-- reads back as '' rather than NULL, and ''::uuid would raise instead of matching nothing.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agents', 'contacts', 'contact_activity', 'saved_searches', 'search_alerts', 'conversations',
    'messages', 'appointments', 'relationship_scores', 'farm_areas', 'farm_reports',
    'outbound_email', 'notifications', 'crm_sync_log', 'search_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;

GRANT SELECT ON mls_sources, neighborhoods, places, listings, tenants, tenant_mls, neighborhood_insights TO idx_app;
GRANT INSERT ON outbox, sandbox_sms TO idx_app;
GRANT SELECT ON sandbox_sms TO idx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  agents, contacts, contact_activity, saved_searches, search_alerts, conversations, messages,
  appointments, relationship_scores, farm_areas, farm_reports, outbound_email, notifications,
  crm_sync_log, search_log
TO idx_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO idx_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO idx_platform;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO idx_platform;
