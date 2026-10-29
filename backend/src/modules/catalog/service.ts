import { z } from "zod";
import type { Connection } from "../../db/pool.js";
import type { Identity } from "../auth/middleware.js";
import { connectorType } from "../users/validation.js";
import { HttpError } from "../../middleware/errors.js";

const filters = z
  .object({
    q: z.string().trim().max(100).optional(),
    connector: connectorType.optional(),
    minPowerKw: z.coerce.number().finite().min(0).max(1000000).optional(),
    availableOnly: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(80).optional(),
  })
  .strict();

export async function listStations(
  db: Connection,
  identity?: Identity,
  raw: unknown = {},
  id?: string,
) {
  const input = filters.parse(raw);
  const scope = identity?.role === "operator" ? identity.organizationId : null;
  const { rows } = await db.query(
    `SELECT s.*, COALESCE(ports.items,'[]'::jsonb) AS connectors
    FROM stations s LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('type', g.type,'powerKw',g.max_power_kw,'total',g.total,'available',g.available)
        ORDER BY g.max_power_kw DESC,g.type) AS items
      FROM (SELECT c.type,c.max_power_kw,count(*)::int AS total,
        count(*) FILTER (WHERE c.operating_state='idle' AND s.operating_state='online'
          AND NOT EXISTS(SELECT 1 FROM charging_sessions cs WHERE cs.connector_id=c.id AND cs.status IN ('starting','active','stopping'))
          AND NOT EXISTS(SELECT 1 FROM connector_reservations r WHERE r.connector_id=c.id
            AND (r.state='confirmed' OR (r.state='held' AND r.expires_at>clock_timestamp()))
            AND r.start_at<=clock_timestamp() AND r.end_at>clock_timestamp()))::int AS available
        FROM connectors c WHERE c.station_id=s.id AND (c.archived_at IS NULL OR $2::text IS NOT NULL) GROUP BY c.type,c.max_power_kw) g
    ) ports ON true
    WHERE (s.archived_at IS NULL OR $2::text IS NOT NULL) AND ($1::uuid IS NULL OR s.organization_id=$1)
      AND ($2::text IS NULL OR s.id=$2)
      AND ($3::text IS NULL OR position(lower($3) in lower(s.name||' '||s.address||' '||s.district))>0)
      AND ($4::text IS NULL OR s.id>$4)
      AND (($5::text IS NULL AND $6=0 AND NOT $7::boolean) OR EXISTS (SELECT 1 FROM connectors c WHERE c.station_id=s.id AND c.archived_at IS NULL
        AND ($5::text IS NULL OR c.type=$5) AND c.max_power_kw >= $6
        AND (NOT $7::boolean OR (c.operating_state='idle' AND s.operating_state='online'))))
    ORDER BY s.id LIMIT $8`,
    [
      scope,
      id ?? null,
      input.q ?? null,
      input.cursor ?? null,
      input.connector ?? null,
      input.minPowerKw ?? 0,
      input.availableOnly === "true",
      input.limit + 1,
    ],
  );
  const items = rows.slice(0, input.limit).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    address: row.address as string,
    district: row.district as string,
    archivedAt: row.archived_at?.toISOString() ?? null,
    coordinates: [Number(row.longitude), Number(row.latitude)],
    status: row.archived_at
      ? "service"
      : row.operating_state === "online"
        ? row.connectors.some((c: { available: number }) => c.available > 0)
          ? "available"
          : "busy"
        : row.operating_state,
    loadPercent: null,
    limitKw: Number(row.limit_kw),
    maxPowerKw: Number(row.max_power_kw),
    pricePerKwh: Number(row.price_per_kwh_kopecks) / 100,
    connectors: row.connectors as {
      type: string;
      powerKw: number;
      total: number;
      available: number;
    }[],
  }));
  return {
    items,
    nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
  };
}

export async function stationDetail(
  db: Connection,
  identity: Identity | undefined,
  id: string,
) {
  const { items } = await listStations(db, identity, {}, id);
  if (!items[0]) throw new HttpError(404, "Станция не найдена.");
  return items[0];
}

export async function physicalConnectors(
  db: Connection,
  identity: Identity | undefined,
  id: string,
) {
  await stationDetail(db, identity, id);
  const { rows } = await db.query(
    `SELECT id,station_id AS "stationId",label,type,max_power_kw::float8 AS "maxPowerKw",
    operating_state AS "operatingState" FROM connectors WHERE station_id=$1 AND archived_at IS NULL ORDER BY label`,
    [id],
  );
  return rows;
}
