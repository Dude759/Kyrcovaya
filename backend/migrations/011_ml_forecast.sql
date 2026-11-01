-- Informational synthetic experiment only; never used by dispatch or billing.
CREATE TABLE forecast_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id),
 model_version text NOT NULL, source text NOT NULL CHECK(source IN ('synthetic','actual')),
 mode text NOT NULL CHECK(mode='historical_replay'), origin timestamptz NOT NULL,
 generated_at timestamptz NOT NULL, quality text NOT NULL CHECK(quality='synthetic_experiment_only'),
 artifact_checksum text NOT NULL CHECK(artifact_checksum ~ '^[a-f0-9]{64}$'),
 dataset_hash text NOT NULL CHECK(dataset_hash ~ '^[a-f0-9]{64}$'),
 metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(source='synthetic'), UNIQUE(organization_id,model_version,origin), UNIQUE(id,organization_id),
 CHECK(mod(extract(epoch FROM origin)::numeric,3600)=0)
);
CREATE TABLE load_predictions (
 run_id uuid NOT NULL REFERENCES forecast_runs(id), organization_id uuid NOT NULL,
 horizon integer NOT NULL CHECK(horizon BETWEEN 1 AND 24), target_at timestamptz NOT NULL,
 power_kw numeric NOT NULL CHECK(power_kw>=0 AND power_kw<'Infinity'::numeric),
 last_kw numeric CHECK(last_kw>=0 AND last_kw<'Infinity'::numeric),
 weekly_kw numeric CHECK(weekly_kw>=0 AND weekly_kw<'Infinity'::numeric),
 PRIMARY KEY(run_id,horizon), UNIQUE(run_id,target_at),
 FOREIGN KEY(run_id,organization_id) REFERENCES forecast_runs(id,organization_id)
);
CREATE TRIGGER immutable_forecast_run BEFORE UPDATE OR DELETE ON forecast_runs FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE TRIGGER immutable_load_prediction BEFORE UPDATE OR DELETE ON load_predictions FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE FUNCTION forecast_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid; r forecast_runs;
BEGIN
 rid=CASE WHEN TG_TABLE_NAME='forecast_runs' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'run_id')::uuid END;
 SELECT * INTO r FROM forecast_runs WHERE id=rid;
 IF (SELECT count(*) FROM load_predictions WHERE run_id=rid)<>24 OR EXISTS(
  SELECT 1 FROM load_predictions WHERE run_id=rid AND target_at<>r.origin+horizon*interval '1 hour') THEN
  RAISE EXCEPTION 'Forecast requires exactly 24 consecutive hourly points' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER consistent_forecast_run AFTER INSERT ON forecast_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION forecast_consistency();
CREATE CONSTRAINT TRIGGER consistent_load_prediction AFTER INSERT ON load_predictions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION forecast_consistency();
