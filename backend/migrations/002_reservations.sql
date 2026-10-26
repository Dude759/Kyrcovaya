-- public keeps extension ownership outside disposable test schemas.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE connector_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES connectors(id),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'held' CHECK (state IN ('held','confirmed','released','expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT reservation_end_after_start CHECK (
    isfinite(start_at) AND isfinite(end_at) AND end_at > start_at
  ),
  CONSTRAINT reservation_expiry CHECK (
    (expires_at IS NULL OR isfinite(expires_at)) AND
    (state <> 'held' OR (expires_at IS NOT NULL AND expires_at > created_at AND expires_at <= start_at))
  ),
  CONSTRAINT reservation_no_overlap EXCLUDE USING gist (
    connector_id WITH =,
    tstzrange(start_at,end_at,'[)') WITH &&
  ) WHERE (state IN ('held','confirmed'))
);

CREATE INDEX reservations_expiry_idx ON connector_reservations(expires_at,connector_id) WHERE state='held';
