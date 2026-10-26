-- 001-003 are immutable. Only this release adds the atomic business finalization.
ALTER TABLE payments DROP CONSTRAINT payment_stage3b_status;
ALTER TABLE payments ADD CONSTRAINT payment_stage3b_status CHECK(status IN ('pending','failed','cancelled','succeeded'));
ALTER TABLE payments ADD COLUMN booking_id uuid;
ALTER TABLE payments ADD COLUMN finalized_at timestamptz;
ALTER TABLE payments ADD COLUMN finalization_reason text;
ALTER TABLE payments ADD CONSTRAINT payment_booking_status CHECK((status='succeeded')=(booking_id IS NOT NULL));
ALTER TABLE payments ADD CONSTRAINT payment_booking_snapshot UNIQUE(id,user_id,organization_id,station_id,connector_id,requested_connector_type,start_at,end_at,amount_kopecks,method);
ALTER TABLE connector_reservations ADD CONSTRAINT reservation_booking_snapshot UNIQUE(id,payment_id,connector_id,start_at,end_at);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL UNIQUE,
  reservation_id uuid NOT NULL UNIQUE,
  payment_attempt_id uuid NOT NULL UNIQUE REFERENCES payment_attempts(id),
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  station_id text NOT NULL,
  connector_id uuid NOT NULL,
  connector_type text NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  amount_kopecks bigint NOT NULL,
  method text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK(status='confirmed'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,payment_id),
  UNIQUE(id,reservation_id,payment_id),
  FOREIGN KEY(payment_id,user_id,organization_id,station_id,connector_id,connector_type,start_at,end_at,amount_kopecks,method)
    REFERENCES payments(id,user_id,organization_id,station_id,connector_id,requested_connector_type,start_at,end_at,amount_kopecks,method),
  FOREIGN KEY(reservation_id,payment_id,connector_id,start_at,end_at)
    REFERENCES connector_reservations(id,payment_id,connector_id,start_at,end_at)
);
CREATE INDEX bookings_user_start_idx ON bookings(user_id,start_at DESC);
ALTER TABLE payments ADD CONSTRAINT payment_booking_fk FOREIGN KEY(booking_id,id) REFERENCES bookings(id,payment_id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE connector_reservations ADD COLUMN booking_id uuid;
ALTER TABLE connector_reservations ADD CONSTRAINT reservation_booking_fk FOREIGN KEY(booking_id,id,payment_id)
  REFERENCES bookings(id,reservation_id,payment_id) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION booking_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; p payments; b bookings; r connector_reservations; a payment_attempts;
BEGIN
  FOR pid IN SELECT DISTINCT value::uuid FROM unnest(ARRAY[
    CASE WHEN TG_TABLE_NAME='payments' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'payment_id' END,
    CASE WHEN TG_TABLE_NAME='payments' THEN to_jsonb(OLD)->>'id' ELSE to_jsonb(OLD)->>'payment_id' END
  ]) value WHERE value IS NOT NULL LOOP
    SELECT * INTO p FROM payments WHERE id=pid;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO b FROM bookings WHERE payment_id=pid;
    SELECT * INTO r FROM connector_reservations WHERE payment_id=pid;
    IF p.status='succeeded' OR b.id IS NOT NULL OR r.booking_id IS NOT NULL OR r.state='confirmed' THEN
      SELECT * INTO a FROM payment_attempts WHERE id=b.payment_attempt_id;
      IF p.status<>'succeeded' OR b.id IS NULL OR p.booking_id IS DISTINCT FROM b.id OR
        r.state IS DISTINCT FROM 'confirmed' OR r.id IS DISTINCT FROM b.reservation_id OR
        r.booking_id IS DISTINCT FROM b.id OR p.finalized_at IS NULL OR p.provider_success_received_at IS NULL OR
        a.payment_id IS DISTINCT FROM p.id OR a.status IS DISTINCT FROM 'succeeded' THEN
        RAISE EXCEPTION 'Payment, booking and confirmed reservation must commit together' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER payment_booking_consistency AFTER INSERT OR UPDATE OR DELETE ON payments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_consistency();
CREATE CONSTRAINT TRIGGER reservation_booking_consistency AFTER INSERT OR UPDATE OR DELETE ON connector_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_consistency();
CREATE CONSTRAINT TRIGGER booking_payment_consistency AFTER INSERT OR UPDATE OR DELETE ON bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_consistency();
CREATE CONSTRAINT TRIGGER attempt_booking_consistency AFTER UPDATE OR DELETE ON payment_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_consistency();

CREATE FUNCTION booking_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Confirmed booking snapshot is immutable in Stage 3C' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER booking_immutable BEFORE UPDATE ON bookings FOR EACH ROW EXECUTE FUNCTION booking_immutable();

CREATE TABLE payment_compensations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id),
  attempt_id uuid NOT NULL UNIQUE REFERENCES payment_attempts(id),
  amount_kopecks bigint NOT NULL CHECK(amount_kopecks>=0),
  reason text NOT NULL CHECK(reason IN ('hold_expired','hold_released','port_unavailable','port_conflict','attempt_not_current','extra_success')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','succeeded')),
  provider_refund_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  deliveries integer NOT NULL DEFAULT 0,
  CHECK((status='succeeded')=(confirmed_at IS NOT NULL))
);
CREATE INDEX compensations_recovery_idx ON payment_compensations(created_at) WHERE status<>'succeeded';
-- Durable test-adapter receipt, separate from the application's refund intent.
CREATE TABLE test_refund_receipts (
  provider_refund_id uuid PRIMARY KEY REFERENCES payment_compensations(provider_refund_id),
  compensation_id uuid NOT NULL UNIQUE REFERENCES payment_compensations(id),
  amount_kopecks bigint NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION compensation_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c payment_compensations; p payments; a payment_attempts; receipt test_refund_receipts;
BEGIN
  SELECT * INTO c FROM payment_compensations WHERE id=COALESCE(NEW.id,OLD.id);
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO p FROM payments WHERE id=c.payment_id;
  SELECT * INTO a FROM payment_attempts WHERE id=c.attempt_id;
  SELECT * INTO receipt FROM test_refund_receipts WHERE compensation_id=c.id;
  IF a.payment_id IS DISTINCT FROM p.id OR c.amount_kopecks<>p.amount_kopecks OR p.provider_success_received_at IS NULL OR
    (c.status='succeeded' AND (receipt.provider_refund_id IS DISTINCT FROM c.provider_refund_id OR receipt.amount_kopecks IS DISTINCT FROM c.amount_kopecks OR receipt.confirmed_at IS DISTINCT FROM c.confirmed_at)) THEN
    RAISE EXCEPTION 'Refund requires matching order, provider success and actual test-adapter receipt' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER compensation_consistency AFTER INSERT OR UPDATE ON payment_compensations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compensation_consistency();

ALTER TABLE test_refund_receipts ADD CONSTRAINT refund_receipt_proof UNIQUE(provider_refund_id,amount_kopecks,confirmed_at);
ALTER TABLE payment_compensations ADD CONSTRAINT compensation_receipt_fk FOREIGN KEY(provider_refund_id,amount_kopecks,confirmed_at)
  REFERENCES test_refund_receipts(provider_refund_id,amount_kopecks,confirmed_at) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION compensation_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.payment_id,NEW.attempt_id,NEW.amount_kopecks,NEW.reason,NEW.provider_refund_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.payment_id,OLD.attempt_id,OLD.amount_kopecks,OLD.reason,OLD.provider_refund_id,OLD.created_at)
    OR (OLD.status='succeeded' AND NEW IS DISTINCT FROM OLD)
    OR (OLD.status='submitted' AND NEW.status='pending') THEN
    RAISE EXCEPTION 'Compensation snapshot and confirmed receipt cannot be rewritten' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER compensation_snapshot_immutable BEFORE UPDATE ON payment_compensations FOR EACH ROW EXECUTE FUNCTION compensation_snapshot_immutable();

ALTER TABLE payment_events DROP CONSTRAINT payment_events_result_check;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_result_check CHECK(result IN ('received','awaiting_booking','applied','ignored_terminal','late_success','finalized','compensation_pending'));
