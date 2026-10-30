-- Derived simulator history; raw readings, settlements and operator audit stay unchanged.
ALTER TABLE stations ADD CONSTRAINT station_monitoring_identity UNIQUE(id,organization_id);
CREATE INDEX measurement_sampled_idx ON session_measurements(sampled_at,session_id);
CREATE INDEX network_limit_history_idx ON network_events(station_id,created_at DESC,id DESC) WHERE action IN ('station_created','station_updated');
CREATE INDEX sessions_station_requested_idx ON charging_sessions(station_id,requested_at DESC,id DESC);
CREATE INDEX measurement_gap_idx ON session_measurements(sampled_at DESC,id) WHERE gap;
CREATE TABLE power_measurements (
 station_id text NOT NULL,
 organization_id uuid NOT NULL,
 interval_start timestamptz NOT NULL,
 interval_end timestamptz NOT NULL,
 measured_energy_wh bigint CHECK(measured_energy_wh>=0),
 average_power_w numeric(18,3) CHECK(average_power_w>=0),
 measured_subset_average_w numeric(18,3) CHECK(measured_subset_average_w>=0),
 active_sessions integer NOT NULL CHECK(active_sessions>=0),
 local_limit_kw numeric(12,2) NOT NULL CHECK(local_limit_kw>=0),
 source text NOT NULL DEFAULT 'simulator' CHECK(source='simulator'),
 quality text NOT NULL CHECK(quality IN ('complete','partial','missing')),
 observed_ms bigint NOT NULL CHECK(observed_ms BETWEEN 0 AND 3600000),
 covered_session_ms bigint NOT NULL CHECK(covered_session_ms>=0),
 expected_session_ms bigint NOT NULL CHECK(expected_session_ms>=0),
 sample_count integer NOT NULL CHECK(sample_count>=0),
 gap_count integer NOT NULL CHECK(gap_count>=0),
 boundary_count integer NOT NULL CHECK(boundary_count>=0),
 unattributed_energy_wh bigint NOT NULL CHECK(unattributed_energy_wh>=0),
 first_sample_at timestamptz,
 last_sample_at timestamptz,
 rule text NOT NULL DEFAULT 'strict-adjacent-v1' CHECK(rule='strict-adjacent-v1'),
 built_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(station_id,interval_start),
 FOREIGN KEY(station_id,organization_id) REFERENCES stations(id,organization_id),
 CHECK(interval_end=interval_start+interval '1 hour'),
 CHECK(mod(extract(epoch FROM interval_start)::numeric,3600)=0),
 CHECK((quality='complete')=(average_power_w IS NOT NULL)),
 CHECK(quality<>'missing' OR (sample_count=0 AND observed_ms=0 AND measured_energy_wh IS NULL)),
 CHECK(quality<>'complete' OR (observed_ms=3600000 AND covered_session_ms>=expected_session_ms AND gap_count=0 AND boundary_count=0))
);
CREATE INDEX power_history_org_page ON power_measurements(organization_id,interval_start DESC,station_id);
