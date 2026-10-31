-- Shadow planning only. No changes to device power, raw readings or financial history.
CREATE TABLE grid_states (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id),
 scenario text NOT NULL CHECK(scenario IN ('normal','deficit','deep_deficit','recovery','offline','stale','missing')),
 workload text NOT NULL CHECK(workload IN ('live','training')),
 version bigint NOT NULL CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE grid_samples (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 sample_key text NOT NULL,
 state_version bigint NOT NULL,
 scenario text NOT NULL,
 source text NOT NULL DEFAULT 'simulator' CHECK(source='simulator'),
 status text NOT NULL CHECK(status IN ('online','offline')),
 received_at timestamptz,
 available_power_w bigint CHECK(available_power_w>=0),
 base_load_w bigint CHECK(base_load_w>=0),
 operator_limit_w bigint NOT NULL CHECK(operator_limit_w>=0),
 budget_w bigint CHECK(budget_w>=0 AND budget_w<=operator_limit_w),
 validity text NOT NULL CHECK(validity IN ('fresh','offline','stale','missing','invalid')),
 freshness_seconds integer NOT NULL CHECK(freshness_seconds BETWEEN 5 AND 3600),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((validity='fresh')=(budget_w IS NOT NULL)),
 UNIQUE(organization_id,sample_key), UNIQUE(id,organization_id)
);
CREATE INDEX grid_samples_org_page ON grid_samples(organization_id,id DESC);
CREATE TABLE power_plan_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL,
 sample_id bigint NOT NULL,
 version text NOT NULL DEFAULT 'max-min-integer-v1' CHECK(version='max-min-integer-v1'),
 mode text NOT NULL DEFAULT 'shadow' CHECK(mode='shadow'),
 workload text NOT NULL CHECK(workload IN ('live','training')),
 budget_w bigint CHECK(budget_w>=0),
 input jsonb NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(sample_id,organization_id) REFERENCES grid_samples(id,organization_id),
 UNIQUE(id,organization_id)
);
CREATE INDEX power_plan_org_latest ON power_plan_runs(organization_id,created_at DESC,id DESC);
CREATE TABLE power_plan_assignments (
 run_id uuid NOT NULL,
 organization_id uuid NOT NULL,
 subject_id text NOT NULL,
 station_key text NOT NULL,
 requested_w bigint NOT NULL CHECK(requested_w>=0),
 port_limit_w bigint NOT NULL CHECK(port_limit_w>=0),
 station_limit_w bigint NOT NULL CHECK(station_limit_w>=0),
 planned_w bigint CHECK(planned_w>=0 AND planned_w<=requested_w AND planned_w<=port_limit_w),
 acknowledged_w bigint CHECK(acknowledged_w IS NULL),
 measured_w bigint CHECK(measured_w>=0),
 current_allocated_w bigint CHECK(current_allocated_w>=0),
 PRIMARY KEY(run_id,subject_id),
 FOREIGN KEY(run_id,organization_id) REFERENCES power_plan_runs(id,organization_id)
);
CREATE TABLE grid_requests (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 idempotency_key text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 PRIMARY KEY(organization_id,idempotency_key)
);
CREATE TABLE grid_actions (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 before_data jsonb,
 after_data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER immutable_grid_sample BEFORE UPDATE OR DELETE ON grid_samples FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_power_plan BEFORE UPDATE OR DELETE ON power_plan_runs FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_power_assignment BEFORE UPDATE OR DELETE ON power_plan_assignments FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_grid_action BEFORE UPDATE OR DELETE ON grid_actions FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE FUNCTION grid_assignment_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM power_plan_runs WHERE id=NEW.run_id AND organization_id=NEW.organization_id AND created_xid=pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Assignments must be sealed in the original run transaction' USING ERRCODE='23514';
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER sealed_assignment BEFORE INSERT ON power_plan_assignments FOR EACH ROW EXECUTE FUNCTION grid_assignment_insert_guard();
CREATE FUNCTION grid_plan_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; r power_plan_runs;
BEGIN
 rid=CASE WHEN TG_TABLE_NAME='power_plan_runs' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'run_id')::uuid END;
 SELECT * INTO r FROM power_plan_runs WHERE id=rid;
 IF (SELECT count(*) FROM power_plan_assignments WHERE run_id=rid)<>jsonb_array_length(r.input->'demands') OR
    EXISTS(SELECT 1 FROM power_plan_assignments a WHERE a.run_id=rid AND ((a.planned_w IS NULL)<>(r.budget_w IS NULL))) OR
    (SELECT COALESCE(sum(planned_w),0) FROM power_plan_assignments WHERE run_id=rid)>r.budget_w OR
    EXISTS(SELECT 1 FROM power_plan_assignments WHERE run_id=rid GROUP BY station_key HAVING sum(planned_w)>min(station_limit_w)) THEN
  RAISE EXCEPTION 'Invalid shadow allocation result' USING ERRCODE='23514';
 END IF; RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER consistent_grid_plan AFTER INSERT ON power_plan_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION grid_plan_consistency();
CREATE CONSTRAINT TRIGGER consistent_grid_assignment AFTER INSERT ON power_plan_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION grid_plan_consistency();
