-- Application history is separate from the sealed 5A shadow plans.
CREATE TABLE power_dispatch_settings (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 enabled boolean NOT NULL DEFAULT false,
 changed_by uuid REFERENCES users(id),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE power_dispatch_plans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 sample_id bigint,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 input jsonb NOT NULL,
 assignments jsonb NOT NULL,
 budget_w bigint CHECK(budget_w>=0),
 source text NOT NULL DEFAULT 'live-simulator' CHECK(source='live-simulator'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,organization_id),
 FOREIGN KEY(sample_id,organization_id) REFERENCES grid_samples(id,organization_id)
);
CREATE INDEX dispatch_plans_latest ON power_dispatch_plans(organization_id,created_at DESC,id DESC);
CREATE TABLE session_power_state (
 session_id uuid PRIMARY KEY REFERENCES charging_sessions(id),
 managed boolean NOT NULL DEFAULT false,
 requested_w bigint NOT NULL CHECK(requested_w>0),
 acknowledged_w bigint NOT NULL DEFAULT 0 CHECK(acknowledged_w>=0 AND acknowledged_w<=requested_w),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 issued_revision bigint NOT NULL DEFAULT 0 CHECK(issued_revision>=revision),
 effective_at timestamptz,
 reconciliation text NOT NULL DEFAULT 'pending' CHECK(reconciliation IN ('pending','acknowledged','rejected','degraded')),
 reconciled_at timestamptz
);
CREATE TABLE power_commands (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 provider_command_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 session_id uuid NOT NULL REFERENCES session_power_state(session_id),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 plan_id uuid NOT NULL,
 revision bigint NOT NULL CHECK(revision>0),
 target_power_w bigint NOT NULL CHECK(target_power_w>=0),
 source text NOT NULL DEFAULT 'live-simulator' CHECK(source='live-simulator'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','acknowledged','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ready_at timestamptz NOT NULL,
 confirmed_at timestamptz,
 deliveries integer NOT NULL DEFAULT 0 CHECK(deliveries>=0),
 UNIQUE(session_id,revision), UNIQUE(id,session_id),
 FOREIGN KEY(plan_id,organization_id) REFERENCES power_dispatch_plans(id,organization_id)
);
CREATE INDEX power_commands_pending ON power_commands(created_at) WHERE status IN ('pending','submitted');
CREATE TABLE power_command_receipts (
 command_id uuid PRIMARY KEY,
 session_id uuid NOT NULL,
 accepted boolean NOT NULL,
 power_w bigint NOT NULL CHECK(power_w>=0),
 effective_at timestamptz NOT NULL,
 measurement_id uuid REFERENCES session_measurements(id) DEFERRABLE INITIALLY DEFERRED,
 reason text,
 source text NOT NULL DEFAULT 'simulator' CHECK(source='simulator'),
 FOREIGN KEY(command_id,session_id) REFERENCES power_commands(id,session_id),
 CHECK(accepted=(reason IS NULL)), CHECK(NOT accepted OR measurement_id IS NOT NULL)
);
CREATE TABLE session_power_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES session_power_state(session_id),
 revision bigint NOT NULL CHECK(revision>=0),
 power_w bigint NOT NULL CHECK(power_w>=0),
 effective_at timestamptz NOT NULL,
 power_command_id uuid UNIQUE,
 charging_command_id uuid UNIQUE,
 CHECK(num_nonnulls(power_command_id,charging_command_id)=1),
 FOREIGN KEY(power_command_id,session_id) REFERENCES power_commands(id,session_id),
 FOREIGN KEY(charging_command_id,session_id) REFERENCES charging_commands(id,session_id),
 UNIQUE(session_id,revision)
);
CREATE INDEX power_history_time ON session_power_history(session_id,effective_at DESC,id DESC);
CREATE TABLE power_dispatch_actions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id), actor_id uuid NOT NULL REFERENCES users(id),
 enabled boolean NOT NULL, idempotency_key text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(organization_id,idempotency_key)
);
ALTER TABLE simulator_devices ADD COLUMN reject_power boolean NOT NULL DEFAULT false;

-- Existing sessions are never enrolled in managed mode. Reconstruct only acknowledged history.
INSERT INTO session_power_state(session_id,requested_w,acknowledged_w,revision,issued_revision,effective_at,reconciliation)
 SELECT s.id,s.allocated_power_w,CASE WHEN s.ended_at IS NULL AND r.accepted THEN s.allocated_power_w ELSE 0 END,
 CASE WHEN s.ended_at IS NOT NULL THEN 2 WHEN r.accepted THEN 1 ELSE 0 END,
 CASE WHEN s.ended_at IS NOT NULL THEN 2 WHEN r.accepted THEN 1 ELSE 0 END,
 COALESCE(s.ended_at,CASE WHEN r.accepted THEN r.confirmed_at END),CASE WHEN r.command_id IS NOT NULL THEN 'acknowledged' ELSE 'pending' END
 FROM charging_sessions s LEFT JOIN charging_commands c ON c.session_id=s.id AND c.kind='start'
 LEFT JOIN simulator_command_receipts r ON r.command_id=c.id;
INSERT INTO session_power_history(session_id,revision,power_w,effective_at,charging_command_id)
 SELECT s.id,1,s.allocated_power_w,r.confirmed_at,c.id FROM charging_sessions s JOIN charging_commands c ON c.session_id=s.id AND c.kind='start'
 JOIN simulator_command_receipts r ON r.command_id=c.id WHERE r.accepted;
INSERT INTO session_power_history(session_id,revision,power_w,effective_at,charging_command_id)
 SELECT s.id,2,0,s.ended_at,c.id FROM charging_sessions s JOIN charging_commands c ON c.session_id=s.id
 JOIN simulator_command_receipts r ON r.command_id=c.id
 WHERE s.ended_at IS NOT NULL AND r.confirmed_at=s.ended_at;

CREATE FUNCTION initialize_power_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO session_power_state(session_id,managed,requested_w)
 VALUES(NEW.id,COALESCE((SELECT enabled FROM power_dispatch_settings WHERE organization_id=NEW.organization_id),false),NEW.allocated_power_w);
 RETURN NEW;
END; $$;
CREATE TRIGGER initialize_power_state AFTER INSERT ON charging_sessions FOR EACH ROW EXECUTE FUNCTION initialize_power_state();
CREATE TRIGGER immutable_dispatch_plan BEFORE UPDATE OR DELETE ON power_dispatch_plans FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_power_receipt BEFORE UPDATE OR DELETE ON power_command_receipts FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_power_history BEFORE UPDATE OR DELETE ON session_power_history FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_dispatch_action BEFORE UPDATE OR DELETE ON power_dispatch_actions FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE FUNCTION power_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR ROW(NEW.session_id,NEW.managed,NEW.requested_w) IS DISTINCT FROM ROW(OLD.session_id,OLD.managed,OLD.requested_w)
 OR NEW.revision<OLD.revision OR NEW.issued_revision<OLD.issued_revision THEN
 RAISE EXCEPTION 'Power snapshot and revision are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER power_state_guard BEFORE UPDATE OR DELETE ON session_power_state FOR EACH ROW EXECUTE FUNCTION power_state_guard();
CREATE FUNCTION power_command_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['status','confirmed_at','deliveries']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','confirmed_at','deliveries'])
 OR (OLD.status IN ('acknowledged','rejected') AND NEW IS DISTINCT FROM OLD) THEN
 RAISE EXCEPTION 'Power command intent is immutable' USING ERRCODE='23514'; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER power_command_guard BEFORE UPDATE OR DELETE ON power_commands FOR EACH ROW EXECUTE FUNCTION power_command_guard();
CREATE FUNCTION power_history_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM session_power_history WHERE session_id=NEW.session_id AND (revision>=NEW.revision OR effective_at>NEW.effective_at)) THEN
 RAISE EXCEPTION 'Late power transition cannot overwrite confirmed history' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER power_history_order_guard BEFORE INSERT ON session_power_history FOR EACH ROW EXECUTE FUNCTION power_history_order_guard();
CREATE FUNCTION power_result_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid uuid; st session_power_state; h session_power_history;
BEGIN
 sid=NEW.session_id;
 SELECT * INTO st FROM session_power_state WHERE session_id=sid;
 SELECT * INTO h FROM session_power_history WHERE session_id=sid ORDER BY revision DESC LIMIT 1;
 IF h.id IS NOT NULL AND ROW(st.revision,st.acknowledged_w,st.effective_at) IS DISTINCT FROM ROW(h.revision,h.power_w,h.effective_at) THEN
 RAISE EXCEPTION 'Power state requires matching immutable history' USING ERRCODE='23514'; END IF;
 IF h.id IS NULL AND (st.revision<>0 OR st.acknowledged_w<>0 OR st.effective_at IS NOT NULL) THEN
 RAISE EXCEPTION 'Power state without device history' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM session_power_history ph LEFT JOIN power_command_receipts r ON r.command_id=ph.power_command_id
 LEFT JOIN simulator_command_receipts cr ON cr.command_id=ph.charging_command_id
 LEFT JOIN charging_commands cc ON cc.id=ph.charging_command_id LEFT JOIN charging_sessions cs ON cs.id=ph.session_id
 WHERE ph.session_id=sid AND ((ph.power_command_id IS NOT NULL AND (r.command_id IS NULL OR NOT r.accepted OR r.power_w<>ph.power_w OR r.effective_at<>ph.effective_at))
 OR (ph.charging_command_id IS NOT NULL AND (cr.command_id IS NULL OR ph.power_w<>CASE WHEN cc.kind='start' AND cr.accepted THEN cs.allocated_power_w ELSE 0 END)))) THEN
 RAISE EXCEPTION 'Power history requires durable device receipt' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM power_commands c JOIN charging_sessions s ON s.id=c.session_id JOIN power_dispatch_plans p ON p.id=c.plan_id
 LEFT JOIN power_command_receipts r ON r.command_id=c.id
 WHERE c.session_id=sid AND (c.organization_id<>s.organization_id OR c.target_power_w>st.requested_w
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.assignments) a WHERE a->>'id'=sid::text AND (a->>'plannedW')::bigint=c.target_power_w)
 OR (c.status IN ('acknowledged','rejected') AND (r.command_id IS NULL OR (c.status='acknowledged')<>r.accepted OR c.confirmed_at IS DISTINCT FROM r.effective_at)))) THEN
 RAISE EXCEPTION 'Invalid power command result' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM power_command_receipts r JOIN power_commands c ON c.id=r.command_id
 LEFT JOIN session_measurements m ON m.id=r.measurement_id
 WHERE r.session_id=sid AND r.accepted AND (m.id IS NULL OR m.session_id<>sid OR m.sampled_at<>r.effective_at OR r.power_w<>c.target_power_w OR NOT EXISTS(SELECT 1 FROM session_power_history ph WHERE ph.power_command_id=c.id AND ph.revision=c.revision))) THEN
 RAISE EXCEPTION 'Accepted power receipt requires matching transition' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER consistent_power_state AFTER INSERT OR UPDATE ON session_power_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION power_result_consistency();
CREATE CONSTRAINT TRIGGER consistent_power_history AFTER INSERT ON session_power_history DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION power_result_consistency();
CREATE CONSTRAINT TRIGGER consistent_power_receipt AFTER INSERT ON power_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION power_result_consistency();
CREATE CONSTRAINT TRIGGER consistent_power_command AFTER INSERT OR UPDATE ON power_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION power_result_consistency();

CREATE OR REPLACE FUNCTION measurement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s charging_sessions; previous session_measurements; duplicate session_measurements; confirmed bigint;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'Meter readings are immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM charging_sessions WHERE id=NEW.session_id FOR UPDATE;
 SELECT * INTO duplicate FROM session_measurements WHERE session_id=NEW.session_id AND sequence_no=NEW.sequence_no;
 IF duplicate.id IS NOT NULL THEN
  IF ROW(duplicate.sampled_at,duplicate.energy_wh,duplicate.power_w,duplicate.source,duplicate.gap,duplicate.final)
  IS DISTINCT FROM ROW(NEW.sampled_at,NEW.energy_wh,NEW.power_w,NEW.source,NEW.gap,NEW.final) THEN
  RAISE EXCEPTION 'Sequence reused with different reading' USING ERRCODE='23514'; END IF; RETURN NEW;
 END IF;
 SELECT power_w INTO confirmed FROM session_power_history WHERE session_id=NEW.session_id AND effective_at<=NEW.sampled_at ORDER BY effective_at DESC,id DESC LIMIT 1;
 SELECT * INTO previous FROM session_measurements WHERE session_id=NEW.session_id ORDER BY sequence_no DESC LIMIT 1;
 IF s.id IS NULL OR s.status IN ('completed','failed') OR NEW.energy_wh>s.energy_budget_wh OR NEW.power_w>COALESCE(confirmed,0) OR
 (previous.id IS NOT NULL AND (NEW.sequence_no<=previous.sequence_no OR NEW.energy_wh<previous.energy_wh OR NEW.sampled_at<previous.sampled_at)) THEN
 RAISE EXCEPTION 'Nonmonotone or unconfirmed meter reading' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
