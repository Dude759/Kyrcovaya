-- New release only: 001-004 and their snapshots remain unchanged.
ALTER TABLE bookings DROP CONSTRAINT bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK(status IN ('confirmed','used','cancelled'));
CREATE OR REPLACE FUNCTION booking_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR
    (NEW.status IS DISTINCT FROM OLD.status AND NOT(OLD.status='confirmed' AND NEW.status IN ('used','cancelled'))) THEN
    RAISE EXCEPTION 'Booking snapshot and terminal status are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
ALTER TABLE bookings ADD CONSTRAINT booking_session_snapshot UNIQUE(id,payment_id,user_id,organization_id,station_id,connector_id,connector_type,start_at,end_at,amount_kopecks,payment_attempt_id);
ALTER TABLE payments ADD CONSTRAINT payment_session_tariff UNIQUE(id,quoted_tariff_kopecks,amount_kopecks);

CREATE TABLE charging_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE,
  payment_id uuid NOT NULL,
  funding_attempt_id uuid NOT NULL,
  user_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  station_id text NOT NULL,
  connector_id uuid NOT NULL,
  connector_type text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  prepaid_kopecks bigint NOT NULL CHECK(prepaid_kopecks>=0),
  tariff_kopecks integer NOT NULL CHECK(tariff_kopecks>=0),
  energy_budget_wh bigint NOT NULL CHECK(energy_budget_wh>0),
  allocated_power_w bigint NOT NULL CHECK(allocated_power_w>0),
  battery_capacity_kwh numeric(6,2) NOT NULL,
  status text NOT NULL DEFAULT 'starting' CHECK(status IN ('starting','active','stopping','completed','failed')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  ended_at timestamptz,
  energy_wh bigint NOT NULL DEFAULT 0 CHECK(energy_wh>=0 AND energy_wh<=energy_budget_wh),
  last_sequence bigint NOT NULL DEFAULT -1,
  measured_at timestamptz,
  telemetry_gap boolean NOT NULL DEFAULT false,
  stop_reason text CHECK(stop_reason IN ('user','prepayment_budget','reservation_end','local_limit','start_rejected')),
  CHECK(window_end>window_start),
  CHECK((status IN ('completed','failed'))=(ended_at IS NOT NULL)),
  FOREIGN KEY(booking_id,payment_id,user_id,organization_id,station_id,connector_id,connector_type,window_start,window_end,prepaid_kopecks,funding_attempt_id)
    REFERENCES bookings(id,payment_id,user_id,organization_id,station_id,connector_id,connector_type,start_at,end_at,amount_kopecks,payment_attempt_id),
  UNIQUE(id,user_id),
  UNIQUE(id,payment_id,funding_attempt_id,tariff_kopecks,prepaid_kopecks),
  FOREIGN KEY(payment_id,tariff_kopecks,prepaid_kopecks) REFERENCES payments(id,quoted_tariff_kopecks,amount_kopecks)
);
CREATE UNIQUE INDEX one_unfinished_port_session ON charging_sessions(connector_id) WHERE status IN ('starting','active','stopping');
CREATE UNIQUE INDEX one_unfinished_driver_session ON charging_sessions(user_id) WHERE status IN ('starting','active','stopping');
CREATE INDEX sessions_organization_idx ON charging_sessions(organization_id,requested_at DESC);
CREATE INDEX sessions_user_idx ON charging_sessions(user_id,requested_at DESC);

CREATE TABLE session_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES charging_sessions(id),
  sequence_no bigint NOT NULL CHECK(sequence_no>=0),
  sampled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  energy_wh bigint NOT NULL CHECK(energy_wh>=0),
  power_w bigint NOT NULL CHECK(power_w>=0),
  source text NOT NULL DEFAULT 'simulator' CHECK(source='simulator'),
  gap boolean NOT NULL DEFAULT false,
  final boolean NOT NULL DEFAULT false,
  UNIQUE(session_id,sequence_no),
  UNIQUE(id,session_id,energy_wh)
);
CREATE FUNCTION measurement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s charging_sessions; previous session_measurements; duplicate session_measurements;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Meter readings are immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO s FROM charging_sessions WHERE id=NEW.session_id FOR UPDATE;
  SELECT * INTO duplicate FROM session_measurements WHERE session_id=NEW.session_id AND sequence_no=NEW.sequence_no;
  IF duplicate.id IS NOT NULL THEN
    IF ROW(duplicate.sampled_at,duplicate.energy_wh,duplicate.power_w,duplicate.source,duplicate.gap,duplicate.final)
      IS DISTINCT FROM ROW(NEW.sampled_at,NEW.energy_wh,NEW.power_w,NEW.source,NEW.gap,NEW.final) THEN
      RAISE EXCEPTION 'Sequence reused with different reading' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO previous FROM session_measurements WHERE session_id=NEW.session_id ORDER BY sequence_no DESC LIMIT 1;
  IF s.id IS NULL OR s.status IN ('completed','failed') OR NEW.energy_wh>s.energy_budget_wh OR NEW.power_w>s.allocated_power_w OR
    (previous.id IS NOT NULL AND (NEW.sequence_no<=previous.sequence_no OR NEW.energy_wh<previous.energy_wh OR NEW.sampled_at<previous.sampled_at)) THEN
    RAISE EXCEPTION 'Nonmonotone or invalid meter reading' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER measurement_guard BEFORE INSERT OR UPDATE OR DELETE ON session_measurements FOR EACH ROW EXECUTE FUNCTION measurement_guard();

CREATE TABLE charging_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES charging_sessions(id),
  kind text NOT NULL CHECK(kind IN ('start','stop')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','acknowledged','rejected')),
  provider_command_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  deliveries integer NOT NULL DEFAULT 0,
  UNIQUE(session_id,kind),
  UNIQUE(id,session_id),
  UNIQUE(id,session_id,kind)
);
CREATE TABLE charging_command_requests (
  user_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 128),
  request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  command_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,idempotency_key),
  FOREIGN KEY(session_id,user_id) REFERENCES charging_sessions(id,user_id),
  FOREIGN KEY(command_id,session_id,kind) REFERENCES charging_commands(id,session_id,kind)
);
CREATE TABLE simulator_devices (
  connector_id uuid PRIMARY KEY REFERENCES connectors(id),
  online boolean NOT NULL DEFAULT true,
  reject_start boolean NOT NULL DEFAULT false,
  command_delay_ms integer NOT NULL DEFAULT 1000 CHECK(command_delay_ms BETWEEN 0 AND 60000)
);
CREATE TABLE simulator_session_state (
  session_id uuid PRIMARY KEY REFERENCES charging_sessions(id),
  state text NOT NULL DEFAULT 'idle' CHECK(state IN ('idle','charging','stopped')),
  energy_wh bigint NOT NULL DEFAULT 0 CHECK(energy_wh>=0),
  remainder_watt_ms bigint NOT NULL DEFAULT 0 CHECK(remainder_watt_ms BETWEEN 0 AND 3599999),
  sequence_no bigint NOT NULL DEFAULT -1,
  last_tick_at timestamptz,
  epoch uuid
);
CREATE TABLE simulator_command_receipts (
  command_id uuid PRIMARY KEY REFERENCES charging_commands(id),
  session_id uuid NOT NULL REFERENCES charging_sessions(id),
  accepted boolean NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  measurement_id uuid NOT NULL REFERENCES session_measurements(id),
  reason text,
  FOREIGN KEY(command_id,session_id) REFERENCES charging_commands(id,session_id)
);

CREATE TABLE session_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE,
  payment_id uuid NOT NULL,
  funding_attempt_id uuid NOT NULL,
  energy_wh bigint NOT NULL CHECK(energy_wh>=0),
  tariff_kopecks integer NOT NULL CHECK(tariff_kopecks>=0),
  prepaid_kopecks bigint NOT NULL,
  final_cost_kopecks bigint NOT NULL CHECK(final_cost_kopecks>=0 AND final_cost_kopecks<=prepaid_kopecks),
  unused_kopecks bigint NOT NULL CHECK(unused_kopecks=prepaid_kopecks-final_cost_kopecks),
  final_measurement_id uuid NOT NULL,
  terminal_command_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'simulator' CHECK(source='simulator'),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(final_cost_kopecks=(energy_wh*tariff_kopecks+999)/1000),
  FOREIGN KEY(session_id,payment_id,funding_attempt_id,tariff_kopecks,prepaid_kopecks)
    REFERENCES charging_sessions(id,payment_id,funding_attempt_id,tariff_kopecks,prepaid_kopecks),
  FOREIGN KEY(final_measurement_id,session_id,energy_wh) REFERENCES session_measurements(id,session_id,energy_wh),
  FOREIGN KEY(terminal_command_id,session_id) REFERENCES charging_commands(id,session_id),
  UNIQUE(id,session_id,payment_id,funding_attempt_id,unused_kopecks)
);
CREATE TABLE session_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL UNIQUE,
  settlement_id uuid NOT NULL UNIQUE,
  payment_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  amount_kopecks bigint NOT NULL CHECK(amount_kopecks>0),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','succeeded')),
  provider_refund_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  confirmed_at timestamptz,
  deliveries integer NOT NULL DEFAULT 0,
  CHECK((status='succeeded')=(confirmed_at IS NOT NULL)),
  FOREIGN KEY(settlement_id,session_id,payment_id,attempt_id,amount_kopecks)
    REFERENCES session_settlements(id,session_id,payment_id,funding_attempt_id,unused_kopecks)
);
CREATE TABLE test_session_refund_receipts (
  provider_refund_id uuid PRIMARY KEY REFERENCES session_refunds(provider_refund_id),
  refund_id uuid NOT NULL UNIQUE REFERENCES session_refunds(id),
  amount_kopecks bigint NOT NULL,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(provider_refund_id,amount_kopecks,confirmed_at)
);
ALTER TABLE session_refunds ADD CONSTRAINT session_refund_receipt_fk FOREIGN KEY(provider_refund_id,amount_kopecks,confirmed_at)
  REFERENCES test_session_refund_receipts(provider_refund_id,amount_kopecks,confirmed_at) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION charging_session_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','started_at','ended_at','energy_wh','last_sequence','measured_at','telemetry_gap','stop_reason'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','started_at','ended_at','energy_wh','last_sequence','measured_at','telemetry_gap','stop_reason'])
    OR (OLD.status IN ('completed','failed') AND NEW IS DISTINCT FROM OLD)
    OR NEW.energy_wh<OLD.energy_wh OR NEW.last_sequence<OLD.last_sequence
    OR (NEW.status<>OLD.status AND NOT ((OLD.status='starting' AND NEW.status IN ('active','stopping','failed')) OR (OLD.status='active' AND NEW.status='stopping') OR (OLD.status='stopping' AND NEW.status='completed')))
    OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'Invalid session transition or changed snapshot' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER charging_session_guard BEFORE UPDATE ON charging_sessions FOR EACH ROW EXECUTE FUNCTION charging_session_guard();
CREATE FUNCTION session_result_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; s charging_sessions; x session_settlements; r simulator_command_receipts; c charging_commands; m session_measurements;
BEGIN
  sid=CASE WHEN TG_TABLE_NAME='charging_sessions' THEN COALESCE(to_jsonb(NEW)->>'id',to_jsonb(OLD)->>'id')::uuid ELSE COALESCE(to_jsonb(NEW)->>'session_id',to_jsonb(OLD)->>'session_id')::uuid END;
  SELECT * INTO s FROM charging_sessions WHERE id=sid;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO x FROM session_settlements WHERE session_id=sid;
  IF s.status='active' THEN
    SELECT receipt.* INTO r FROM simulator_command_receipts receipt JOIN charging_commands command ON command.id=receipt.command_id WHERE command.session_id=sid AND command.kind='start';
    IF r.accepted IS DISTINCT FROM true OR s.started_at IS DISTINCT FROM r.confirmed_at OR NOT EXISTS(SELECT 1 FROM bookings WHERE id=s.booking_id AND status='used') THEN
      RAISE EXCEPTION 'Active session needs confirmed simulator start' USING ERRCODE='23514';
    END IF;
  END IF;
  IF s.status IN ('completed','failed') OR x.id IS NOT NULL THEN
    SELECT * INTO c FROM charging_commands WHERE id=x.terminal_command_id;
    SELECT * INTO r FROM simulator_command_receipts WHERE command_id=c.id;
    SELECT * INTO m FROM session_measurements WHERE id=x.final_measurement_id;
    IF s.status NOT IN ('completed','failed') OR x.id IS NULL OR r.command_id IS NULL OR r.measurement_id IS DISTINCT FROM m.id OR
      m.final IS DISTINCT FROM true OR m.energy_wh IS DISTINCT FROM s.energy_wh OR m.session_id IS DISTINCT FROM s.id OR
      s.ended_at IS DISTINCT FROM r.confirmed_at OR
      (s.status='completed' AND (c.kind<>'stop' OR c.status<>'acknowledged' OR r.accepted IS DISTINCT FROM true)) OR
      (s.status='failed' AND (c.kind<>'start' OR c.status<>'rejected' OR r.accepted IS DISTINCT FROM false OR m.energy_wh<>0)) THEN
      RAISE EXCEPTION 'Terminal session requires adapter acknowledgement, final meter reading and settlement' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER session_result_consistency AFTER INSERT OR UPDATE ON charging_sessions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION session_result_consistency();
CREATE CONSTRAINT TRIGGER settlement_session_consistency AFTER INSERT ON session_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION session_result_consistency();
CREATE FUNCTION immutable_session_result() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Financial result and device receipt are immutable' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER immutable_settlement BEFORE UPDATE OR DELETE ON session_settlements FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_charger_receipt BEFORE UPDATE OR DELETE ON simulator_command_receipts FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE FUNCTION session_refund_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.session_id,NEW.settlement_id,NEW.payment_id,NEW.attempt_id,NEW.amount_kopecks,NEW.provider_refund_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.session_id,OLD.settlement_id,OLD.payment_id,OLD.attempt_id,OLD.amount_kopecks,OLD.provider_refund_id,OLD.created_at)
    OR (OLD.status='succeeded' AND NEW IS DISTINCT FROM OLD) OR (OLD.status='submitted' AND NEW.status='pending') THEN
    RAISE EXCEPTION 'Session refund snapshot is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER session_refund_immutable BEFORE UPDATE ON session_refunds FOR EACH ROW EXECUTE FUNCTION session_refund_immutable();
CREATE FUNCTION refund_budget_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pid uuid; paid bigint; reserved bigint; invalid boolean;
BEGIN
  pid=COALESCE(NEW.payment_id,OLD.payment_id);
  PERFORM id FROM payments WHERE id=pid FOR UPDATE;
  SELECT COALESCE(sum(p.amount_kopecks),0) INTO paid FROM payment_attempts a JOIN payments p ON p.id=a.payment_id WHERE p.id=pid AND a.status='succeeded';
  SELECT COALESCE(sum(amount),0) INTO reserved FROM (SELECT amount_kopecks amount FROM payment_compensations WHERE payment_id=pid UNION ALL SELECT amount_kopecks FROM session_refunds WHERE payment_id=pid UNION ALL SELECT final_cost_kopecks FROM session_settlements WHERE payment_id=pid) q;
  SELECT EXISTS(SELECT 1 FROM (SELECT attempt_id,sum(amount) amount FROM (SELECT attempt_id,amount_kopecks amount FROM payment_compensations WHERE payment_id=pid UNION ALL SELECT attempt_id,amount_kopecks FROM session_refunds WHERE payment_id=pid UNION ALL SELECT funding_attempt_id,final_cost_kopecks FROM session_settlements WHERE payment_id=pid) q GROUP BY attempt_id) totals
    JOIN payment_attempts a ON a.id=totals.attempt_id JOIN payments p ON p.id=a.payment_id WHERE a.payment_id<>pid OR a.status<>'succeeded' OR totals.amount>p.amount_kopecks) INTO invalid;
  IF reserved>paid OR invalid THEN RAISE EXCEPTION 'Refunds exceed actual paid amount' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER session_refund_budget AFTER INSERT OR UPDATE ON session_refunds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_budget_guard();
CREATE CONSTRAINT TRIGGER compensation_total_budget AFTER INSERT OR UPDATE ON payment_compensations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_budget_guard();
CREATE CONSTRAINT TRIGGER settlement_total_budget AFTER INSERT ON session_settlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refund_budget_guard();
CREATE FUNCTION immutable_remainder_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Adapter refund receipt is immutable' USING ERRCODE='23514';
END; $$;
CREATE TRIGGER immutable_remainder_receipt BEFORE UPDATE OR DELETE ON test_session_refund_receipts FOR EACH ROW EXECUTE FUNCTION immutable_remainder_receipt();
CREATE FUNCTION charging_command_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-ARRAY['status','confirmed_at','deliveries']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','confirmed_at','deliveries'])
    OR (OLD.status IN ('acknowledged','rejected') AND NEW IS DISTINCT FROM OLD) OR NEW.deliveries<OLD.deliveries THEN
    RAISE EXCEPTION 'Command identity and acknowledged result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER charging_command_immutable BEFORE UPDATE ON charging_commands FOR EACH ROW EXECUTE FUNCTION charging_command_immutable();
