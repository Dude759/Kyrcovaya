-- Prior 001-005 history is immutable. Payment remains paid after cancellation; refund is separate.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK(status IN ('confirmed','used','cancelled','expired'));
CREATE OR REPLACE FUNCTION booking_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR
    (NEW.status IS DISTINCT FROM OLD.status AND NOT(OLD.status='confirmed' AND NEW.status IN ('used','cancelled','expired'))) THEN
    RAISE EXCEPTION 'Booking snapshot and terminal status are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE FUNCTION booking_start_deadline(start_at timestamptz,end_at timestamptz) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE STRICT AS $$ SELECT LEAST(start_at+interval '15 minutes',end_at) $$;
ALTER TABLE bookings ADD CONSTRAINT booking_refund_snapshot UNIQUE(id,payment_id,payment_attempt_id,amount_kopecks);
CREATE TABLE booking_closures (
  booking_id uuid PRIMARY KEY REFERENCES bookings(id),
  reason text NOT NULL CHECK(reason IN ('driver','no_show')),
  closed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE booking_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES booking_closures(booking_id),
  payment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  amount_kopecks bigint NOT NULL CHECK(amount_kopecks>=0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','succeeded')),
  provider_refund_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  deliveries integer NOT NULL DEFAULT 0 CHECK(deliveries>=0),
  CHECK((status='succeeded')=(confirmed_at IS NOT NULL)),
  FOREIGN KEY(booking_id,payment_id,attempt_id,amount_kopecks) REFERENCES bookings(id,payment_id,payment_attempt_id,amount_kopecks)
);
CREATE INDEX booking_refunds_recovery_idx ON booking_refunds(created_at) WHERE status<>'succeeded';
CREATE TABLE test_booking_refund_receipts (
  provider_refund_id uuid PRIMARY KEY REFERENCES booking_refunds(provider_refund_id),
  refund_id uuid NOT NULL UNIQUE REFERENCES booking_refunds(id),
  amount_kopecks bigint NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(provider_refund_id,amount_kopecks,confirmed_at)
);
ALTER TABLE booking_refunds ADD CONSTRAINT booking_refund_receipt_fk FOREIGN KEY(provider_refund_id,amount_kopecks,confirmed_at)
  REFERENCES test_booking_refund_receipts(provider_refund_id,amount_kopecks,confirmed_at) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER immutable_booking_closure BEFORE UPDATE OR DELETE ON booking_closures FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_booking_receipt BEFORE UPDATE OR DELETE ON test_booking_refund_receipts FOR EACH ROW EXECUTE FUNCTION immutable_remainder_receipt();
CREATE FUNCTION booking_refund_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Booking refund intent is immutable' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['status','submitted_at','confirmed_at','deliveries']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','submitted_at','confirmed_at','deliveries'])
    OR (OLD.status='succeeded' AND NEW IS DISTINCT FROM OLD) OR (OLD.status='submitted' AND NEW.status='pending')
    OR NEW.deliveries<OLD.deliveries THEN
    RAISE EXCEPTION 'Booking refund intent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER booking_refund_immutable BEFORE UPDATE OR DELETE ON booking_refunds FOR EACH ROW EXECUTE FUNCTION booking_refund_immutable();

CREATE OR REPLACE FUNCTION booking_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
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
        r.id IS DISTINCT FROM b.reservation_id OR r.booking_id IS DISTINCT FROM b.id OR
        p.finalized_at IS NULL OR p.provider_success_received_at IS NULL OR
        a.payment_id IS DISTINCT FROM p.id OR a.status IS DISTINCT FROM 'succeeded' OR
        (b.status IN ('confirmed','used') AND r.state IS DISTINCT FROM 'confirmed') OR
        (b.status='cancelled' AND r.state IS DISTINCT FROM 'released') OR
        (b.status='expired' AND r.state IS DISTINCT FROM 'expired') THEN
        RAISE EXCEPTION 'Paid booking and lifecycle reservation must remain consistent' USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END; $$;

CREATE FUNCTION booking_lifecycle_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bid uuid; b bookings; c booking_closures; s charging_sessions;
BEGIN
  bid=CASE WHEN TG_TABLE_NAME='bookings' THEN COALESCE(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id')::uuid ELSE COALESCE(to_jsonb(NEW)->>'booking_id',to_jsonb(OLD)->>'booking_id')::uuid END;
  SELECT * INTO b FROM bookings WHERE id=bid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO c FROM booking_closures WHERE booking_id=bid;
  SELECT * INTO s FROM charging_sessions WHERE booking_id=bid;
  IF c.booking_id IS NOT NULL THEN
    IF s.id IS NOT NULL OR b.status IS DISTINCT FROM (CASE WHEN c.reason='driver' THEN 'cancelled' ELSE 'expired' END) OR
      (c.reason='no_show' AND c.closed_at<booking_start_deadline(b.start_at,b.end_at)) OR
      NOT EXISTS(SELECT 1 FROM booking_refunds WHERE booking_id=bid) THEN
      RAISE EXCEPTION 'Closure requires an unused booking and one full refund intent' USING ERRCODE='23514';
    END IF;
  ELSIF b.status='expired' OR EXISTS(SELECT 1 FROM booking_refunds WHERE booking_id=bid) THEN
    RAISE EXCEPTION 'No-show requires a durable closure' USING ERRCODE='23514';
  ELSIF b.status='cancelled' THEN
    IF s.id IS NULL OR s.status NOT IN ('failed','completed') OR s.started_at IS NOT NULL OR
      NOT EXISTS(SELECT 1 FROM session_settlements x WHERE x.session_id=s.id AND x.energy_wh=0) THEN
      RAISE EXCEPTION 'Session cancellation requires a zero-energy terminal settlement; never a second booking refund' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER booking_lifecycle_consistency AFTER INSERT OR UPDATE ON bookings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_lifecycle_consistency();
CREATE CONSTRAINT TRIGGER closure_consistency AFTER INSERT ON booking_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_lifecycle_consistency();
CREATE CONSTRAINT TRIGGER booking_refund_consistency AFTER INSERT OR UPDATE ON booking_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_lifecycle_consistency();
CREATE CONSTRAINT TRIGGER session_booking_closure_consistency AFTER INSERT OR UPDATE ON charging_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION booking_lifecycle_consistency();

-- Serialize phantom session/closure inserts even for SQL writers outside the HTTP services.
CREATE FUNCTION booking_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bookings;
BEGIN
  SELECT * INTO b FROM bookings WHERE id=NEW.booking_id;
  PERFORM id FROM payments WHERE id=b.payment_id FOR UPDATE;
  SELECT * INTO b FROM bookings WHERE id=NEW.booking_id FOR UPDATE;
  IF b.status IS DISTINCT FROM 'confirmed' OR
    (TG_TABLE_NAME='booking_closures' AND EXISTS(SELECT 1 FROM charging_sessions WHERE booking_id=b.id)) OR
    (TG_TABLE_NAME='charging_sessions' AND EXISTS(SELECT 1 FROM booking_closures WHERE booking_id=b.id)) THEN
    RAISE EXCEPTION 'Start and booking closure are mutually exclusive' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER booking_close_operation BEFORE INSERT ON booking_closures FOR EACH ROW EXECUTE FUNCTION booking_operation_guard();
CREATE TRIGGER booking_start_operation BEFORE INSERT ON charging_sessions FOR EACH ROW EXECUTE FUNCTION booking_operation_guard();

CREATE OR REPLACE FUNCTION refund_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; paid bigint; reserved bigint; invalid boolean;
BEGIN
  pid=COALESCE(NEW.payment_id,OLD.payment_id);
  PERFORM id FROM payments WHERE id=pid FOR UPDATE;
  SELECT COALESCE(sum(p.amount_kopecks),0) INTO paid FROM payment_attempts a JOIN payments p ON p.id=a.payment_id WHERE p.id=pid AND a.status='succeeded';
  SELECT COALESCE(sum(amount),0) INTO reserved FROM (SELECT amount_kopecks amount FROM payment_compensations WHERE payment_id=pid UNION ALL SELECT amount_kopecks FROM session_refunds WHERE payment_id=pid UNION ALL SELECT final_cost_kopecks FROM session_settlements WHERE payment_id=pid UNION ALL SELECT amount_kopecks FROM booking_refunds WHERE payment_id=pid) q;
  SELECT EXISTS(SELECT 1 FROM (SELECT attempt_id,sum(amount) amount FROM (SELECT attempt_id,amount_kopecks amount FROM payment_compensations WHERE payment_id=pid UNION ALL SELECT attempt_id,amount_kopecks FROM session_refunds WHERE payment_id=pid UNION ALL SELECT funding_attempt_id,final_cost_kopecks FROM session_settlements WHERE payment_id=pid UNION ALL SELECT attempt_id,amount_kopecks FROM booking_refunds WHERE payment_id=pid) q GROUP BY attempt_id) totals
    JOIN payment_attempts a ON a.id=totals.attempt_id JOIN payments p ON p.id=a.payment_id WHERE a.payment_id<>pid OR a.status<>'succeeded' OR totals.amount>p.amount_kopecks) INTO invalid;
  IF reserved>paid OR invalid THEN RAISE EXCEPTION 'Refunds exceed actual paid amount' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER booking_refund_budget AFTER INSERT OR UPDATE ON booking_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_budget_guard();

-- Safely release historical 3D failures only when a terminal zero-energy receipt/settlement exists.
UPDATE connector_reservations r SET state='released' FROM bookings b JOIN charging_sessions s ON s.booking_id=b.id
  JOIN session_settlements x ON x.session_id=s.id
  WHERE r.id=b.reservation_id AND b.status='cancelled' AND r.state='confirmed'
    AND s.status IN ('failed','completed') AND s.started_at IS NULL AND x.energy_wh=0;
