CREATE TABLE network_events (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 actor_id uuid NOT NULL REFERENCES users(id),
 station_id text NOT NULL REFERENCES stations(id),
 connector_id uuid REFERENCES connectors(id),
 action text NOT NULL CHECK(action IN ('station_created','station_updated','station_archived','connector_created','connector_updated','connector_archived')),
 before_data jsonb,
 after_data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX network_events_org_page ON network_events(organization_id,id DESC);
CREATE TABLE operator_requests (
 organization_id uuid NOT NULL REFERENCES organizations(id),
 idempotency_key text NOT NULL,
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 result jsonb NOT NULL,
 PRIMARY KEY(organization_id,idempotency_key)
);
CREATE TRIGGER immutable_network_event BEFORE UPDATE OR DELETE ON network_events FOR EACH ROW EXECUTE FUNCTION immutable_session_result();
CREATE FUNCTION operator_object_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sid text; busy boolean; reserved boolean; load numeric;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Archive infrastructure instead of deleting history' USING ERRCODE='23514'; END IF;
 IF current_setting('app.operator_management',true) IS DISTINCT FROM 'on' THEN RETURN NEW; END IF;
 sid=CASE WHEN TG_TABLE_NAME='stations' THEN to_jsonb(OLD)->>'id' ELSE to_jsonb(OLD)->>'station_id' END;
 PERFORM id FROM stations WHERE id=sid FOR UPDATE;
 IF TG_TABLE_NAME='stations' THEN
  IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR (OLD.archived_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Infrastructure identity is immutable' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.id<>OLD.id OR NEW.station_id<>OLD.station_id OR (OLD.archived_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
   RAISE EXCEPTION 'Infrastructure identity is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 -- Trusted device/maintenance SQL can report an external fault (covered by 3D tests).
 -- Operator API sets this transaction-local flag; no client SQL access exists.
 IF current_setting('app.operator_management',true) IS DISTINCT FROM 'on' THEN RETURN NEW; END IF;
 SELECT EXISTS(SELECT 1 FROM charging_sessions s WHERE s.station_id=sid AND s.status IN ('starting','active','stopping') AND (TG_TABLE_NAME='stations' OR s.connector_id=(CASE WHEN TG_TABLE_NAME='connectors' THEN OLD.id::text::uuid ELSE NULL END))) INTO busy;
 SELECT EXISTS(SELECT 1 FROM connector_reservations r JOIN connectors c ON c.id=r.connector_id WHERE c.station_id=sid
  AND (TG_TABLE_NAME='stations' OR c.id=(CASE WHEN TG_TABLE_NAME='connectors' THEN OLD.id::text::uuid ELSE NULL END)) AND r.state IN ('held','confirmed') AND r.end_at>clock_timestamp()
  AND (r.state='confirmed' OR r.expires_at>clock_timestamp())) INTO reserved;
 IF (NEW.archived_at IS DISTINCT FROM OLD.archived_at OR (NEW.operating_state<>OLD.operating_state AND NEW.operating_state IN ('offline','service'))) AND (busy OR reserved) THEN
  RAISE EXCEPTION 'Live reservations or unfinished sessions block service/archive' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(allocated_power_w),0)/1000.0 INTO load FROM charging_sessions s WHERE s.station_id=sid AND s.status IN ('starting','active','stopping') AND (TG_TABLE_NAME='stations' OR s.connector_id=(CASE WHEN TG_TABLE_NAME='connectors' THEN OLD.id::text::uuid ELSE NULL END));
 IF NEW.max_power_kw<load OR (TG_TABLE_NAME='stations' AND (to_jsonb(NEW)->>'limit_kw')::numeric<load) THEN
  RAISE EXCEPTION 'Local power below unfinished allocations' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
-- Separate guards avoid casting legacy text station IDs to UUID in the port predicate.
CREATE TRIGGER operator_station_guard BEFORE UPDATE OR DELETE ON stations FOR EACH ROW EXECUTE FUNCTION operator_object_guard();
CREATE TRIGGER operator_connector_guard BEFORE UPDATE OR DELETE ON connectors FOR EACH ROW EXECUTE FUNCTION operator_object_guard();
