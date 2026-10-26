CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  network_limit_kw numeric(12,2) NOT NULL CHECK (network_limit_kw BETWEEN 0 AND 1000000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(trim(email_normalized)) AND length(email_normalized) BETWEEN 3 AND 254),
  password_hash text NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 100),
  phone text NOT NULL DEFAULT '' CHECK (length(phone) <= 32),
  role text NOT NULL CHECK (role IN ('driver', 'operator')),
  organization_id uuid REFERENCES organizations(id),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_role_organization CHECK ((role = 'driver' AND organization_id IS NULL) OR (role = 'operator' AND organization_id IS NOT NULL)),
  UNIQUE (id, role)
);

CREATE TABLE driver_profiles (
  user_id uuid PRIMARY KEY,
  role text NOT NULL DEFAULT 'driver' CHECK (role = 'driver'),
  vehicle_name text NOT NULL DEFAULT '' CHECK (length(vehicle_name) <= 100),
  plate text NOT NULL DEFAULT '' CHECK (length(plate) <= 20),
  preferred_connector_type text NOT NULL CHECK (preferred_connector_type IN ('CCS2', 'CHAdeMO', 'Type 2')),
  battery_capacity_kwh numeric(6,2) NOT NULL CHECK (battery_capacity_kwh BETWEEN 10 AND 250),
  FOREIGN KEY (user_id, role) REFERENCES users(id, role) ON DELETE CASCADE
);

CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  booking_alerts boolean NOT NULL DEFAULT true,
  receipts boolean NOT NULL DEFAULT true,
  network_alerts boolean NOT NULL DEFAULT false,
  critical_alerts boolean NOT NULL DEFAULT true,
  load_alerts boolean NOT NULL DEFAULT true,
  reports boolean NOT NULL DEFAULT false
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);

CREATE TABLE stations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 80),
  organization_id uuid NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  address text NOT NULL CHECK (length(trim(address)) BETWEEN 2 AND 300),
  district text NOT NULL CHECK (length(district) <= 120),
  longitude numeric(10,7) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  latitude numeric(10,7) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  max_power_kw numeric(12,2) NOT NULL CHECK (max_power_kw > 0 AND max_power_kw <= 1000000),
  limit_kw numeric(12,2) NOT NULL CHECK (limit_kw BETWEEN 0 AND max_power_kw),
  price_per_kwh_kopecks integer NOT NULL CHECK (price_per_kwh_kopecks BETWEEN 0 AND 1000000),
  operating_state text NOT NULL CHECK (operating_state IN ('online', 'offline', 'service')),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stations_organization_idx ON stations(organization_id) WHERE archived_at IS NULL;

CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  station_id text NOT NULL REFERENCES stations(id),
  label text NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
  type text NOT NULL CHECK (type IN ('CCS2', 'CHAdeMO', 'Type 2')),
  max_power_kw numeric(12,2) NOT NULL CHECK (max_power_kw > 0 AND max_power_kw <= 1000000),
  operating_state text NOT NULL CHECK (operating_state IN ('idle', 'offline', 'service')),
  archived_at timestamptz,
  UNIQUE (station_id, label)
);
CREATE INDEX connectors_station_type_idx ON connectors(station_id, type) WHERE archived_at IS NULL;
