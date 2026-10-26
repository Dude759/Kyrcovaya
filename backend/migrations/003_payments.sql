ALTER TABLE stations ADD CONSTRAINT stations_id_organization_unique UNIQUE(id,organization_id);
ALTER TABLE connectors ADD CONSTRAINT connectors_id_station_type_unique UNIQUE(id,station_id,type);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  user_role text NOT NULL DEFAULT 'driver' CHECK(user_role='driver'),
  organization_id uuid NOT NULL,
  station_id text NOT NULL,
  connector_id uuid NOT NULL,
  requested_connector_type text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  method text NOT NULL CHECK(method IN ('card','sbp')),
  amount_kopecks bigint NOT NULL CHECK(amount_kopecks BETWEEN 0 AND 100000000000),
  quoted_tariff_kopecks integer NOT NULL CHECK(quoted_tariff_kopecks BETWEEN 0 AND 1000000),
  quoted_energy_kwh numeric(12,3) NOT NULL CHECK(quoted_energy_kwh BETWEEN 0 AND 250),
  status text NOT NULL DEFAULT 'pending',
  CONSTRAINT payment_stage3b_status CHECK(status IN ('pending','failed','cancelled')),
  failure_code text CHECK(failure_code IN ('provider_failed','cancelled','expired')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  provider_success_received_at timestamptz,
  requires_reconciliation boolean NOT NULL DEFAULT false,
  CHECK(isfinite(start_at) AND isfinite(end_at) AND end_at>start_at),
  CHECK(isfinite(expires_at) AND expires_at>created_at AND expires_at<=start_at),
  FOREIGN KEY(user_id,user_role) REFERENCES users(id,role),
  FOREIGN KEY(station_id,organization_id) REFERENCES stations(id,organization_id),
  FOREIGN KEY(connector_id,station_id,requested_connector_type) REFERENCES connectors(id,station_id,type),
  UNIQUE(user_id,idempotency_key),
  UNIQUE(id,connector_id,start_at,end_at)
);
CREATE INDEX payments_user_created_idx ON payments(user_id,created_at DESC);
CREATE INDEX payments_pending_expiry_idx ON payments(expires_at) WHERE status='pending';

ALTER TABLE connector_reservations ADD COLUMN payment_id uuid;
ALTER TABLE connector_reservations ADD CONSTRAINT reservation_one_payment UNIQUE(payment_id);
ALTER TABLE connector_reservations ADD CONSTRAINT reservation_payment_interval_fk
  FOREIGN KEY(payment_id,connector_id,start_at,end_at) REFERENCES payments(id,connector_id,start_at,end_at);

CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  attempt_no integer NOT NULL CHECK(attempt_no>0),
  retry_key text CHECK(length(retry_key) BETWEEN 16 AND 128),
  provider text NOT NULL DEFAULT 'test' CHECK(provider='test'),
  provider_payment_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','succeeded','failed','cancelled','expired')),
  -- Capability signatures are reconstructed by the adapter; no secret query token is stored.
  confirmation_url text NOT NULL CHECK(confirmation_url LIKE 'https://%'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE(payment_id,attempt_no),
  UNIQUE(payment_id,retry_key),
  UNIQUE(provider,provider_payment_id)
);
CREATE UNIQUE INDEX one_pending_attempt_per_payment ON payment_attempts(payment_id) WHERE status='pending';

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES payment_attempts(id),
  provider text NOT NULL DEFAULT 'test' CHECK(provider='test'),
  provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK(kind IN ('succeeded','failed','cancelled')),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result text NOT NULL CHECK(result IN ('received','awaiting_booking','applied','ignored_terminal','late_success')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  processed_at timestamptz,
  UNIQUE(provider,provider_event_id)
);
CREATE INDEX payment_events_attempt_idx ON payment_events(attempt_id,received_at);

CREATE FUNCTION payment_order_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.user_role,NEW.organization_id,NEW.station_id,NEW.connector_id,
    NEW.requested_connector_type,NEW.start_at,NEW.end_at,NEW.method,NEW.amount_kopecks,
    NEW.quoted_tariff_kopecks,NEW.quoted_energy_kwh,NEW.idempotency_key,NEW.request_hash,NEW.expires_at,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.user_role,OLD.organization_id,OLD.station_id,OLD.connector_id,
    OLD.requested_connector_type,OLD.start_at,OLD.end_at,OLD.method,OLD.amount_kopecks,
    OLD.quoted_tariff_kopecks,OLD.quoted_energy_kwh,OLD.idempotency_key,OLD.request_hash,OLD.expires_at,OLD.created_at) THEN
    RAISE EXCEPTION 'Payment order is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.provider_success_received_at IS NOT NULL AND NEW.provider_success_received_at IS DISTINCT FROM OLD.provider_success_received_at THEN
    RAISE EXCEPTION 'Provider success cannot be forgotten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_order_immutable BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION payment_order_immutable();
