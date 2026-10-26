-- Only synthetic QA data. No extra station is added to the public map.
-- Run explicitly on the public demo database before public-smoke.mjs.
-- Copies the public demonstration operator's hash without exposing it.
WITH fixture_org AS (
  INSERT INTO organizations(id,name,network_limit_kw)
  VALUES ('10000000-0000-4000-8000-000000000002','Проверка изоляции (учебная)',0)
  ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name
  RETURNING id
), fixture_user AS (
  INSERT INTO users(email_normalized,password_hash,name,role,organization_id)
  SELECT 'qa.operator@energotransport.test',u.password_hash,
    'Проверка изоляции','operator',o.id
  FROM users u CROSS JOIN fixture_org o
  WHERE u.email_normalized='operator@energotransport.test'
  ON CONFLICT (email_normalized) DO NOTHING
  RETURNING id
)
INSERT INTO user_preferences(user_id)
SELECT id FROM fixture_user
ON CONFLICT DO NOTHING;
