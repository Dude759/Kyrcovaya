import hashlib
import json
import math
from datetime import datetime, timedelta, timezone

HOUR = timedelta(hours=1)


def instant(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timezone required")
    return parsed.astimezone(timezone.utc)


def stamp(value):
    # Never round an availability timestamp backwards across a forecast origin.
    return value.isoformat(timespec="microseconds" if value.microsecond else "seconds").replace("+00:00", "Z")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n"


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def validate(rows):
    previous = None
    for row in rows:
        end = instant(row["end"])
        if previous is not None and end - previous != HOUR:
            raise ValueError("Series must be unique, sorted, contiguous hourly grid")
        if end.minute or end.second or end.microsecond:
            raise ValueError("UTC hour boundary required")
        previous = end
        if row["quality"] not in ("complete", "partial", "missing"):
            raise ValueError("Unknown quality")
        if row["source"] not in ("server_simulator", "synthetic"):
            raise ValueError("Unknown provenance")
        value = row["load_kw"]
        if (row["quality"] == "complete") != (value is not None):
            raise ValueError("Incomplete network load must be null")
        if value is not None and (not math.isfinite(value) or value < 0):
            raise ValueError("Invalid target")
        if row["available_at"] is not None and instant(row["available_at"]) < end:
            raise ValueError("Hourly average cannot be known before hour ends")
        if value is not None and row["available_at"] is None:
            raise ValueError("Known target requires availability timestamp")
    return rows


def export_network(snapshot):
    if snapshot["schema_version"] != "ml-snapshot-v1" or snapshot["source"] != "server_simulator":
        raise ValueError("Unsupported snapshot")
    hours = snapshot["hours"] or []
    if not hours:
        return []
    index = {(r["station_id"], instant(r["end"])): r for r in hours}
    if len(index) != len(hours):
        raise ValueError("Duplicate station hour")
    end = min(instant(r["end"]) for r in hours)
    cutoff = instant(snapshot["captured_at"]).replace(minute=0, second=0, microsecond=0)
    rows = []
    while end <= cutoff:
        start = end - HOUR
        roster = [s for s in snapshot["stations"] if instant(s["created_at"]) < end and
                  (s["archived_at"] is None or instant(s["archived_at"]) > start)]
        parts = [index.get((s["id"], end)) for s in roster]
        counts = {q: sum(p is not None and p["quality"] == q for p in parts)
                  for q in ("complete", "partial", "missing")}
        absent = sum(p is None for p in parts)
        # Complete requires the full historically expected roster, closed hour and conservative coverage.
        complete = bool(parts) and all(p is not None and p["quality"] == "complete" and
                      p["average_kw"] is not None and p["observed_ms"] == 3600000 and
                      p["covered_session_ms"] >= p["expected_session_ms"] and
                      p["gap_count"] == 0 and p["boundary_count"] == 0 and
                      p["rule"] == "strict-adjacent-v1" for p in parts)
        quality = "complete" if complete else "partial" if counts["complete"] + counts["partial"] else "missing"
        available = max([end] + [instant(p["built_at"]) for p in parts]) if complete else None
        known_grid = [g for g in snapshot["grid"] or [] if g["received_at"] and
                      g["validity"] == "fresh" and g["budget_w"] is not None and
                      instant(g["created_at"]) <= end and
                      0 <= (end - instant(g["received_at"])).total_seconds() <= g["freshness_seconds"]]
        rows.append({"end": stamp(end), "available_at": stamp(available) if available else None,
                     "source": "server_simulator", "quality": quality,
                     "load_kw": round(sum(float(p["average_kw"]) for p in parts), 6) if complete else None,
                     "expected_stations": len(roster), "station_quality": counts,
                     "absent_station_hours": absent,
                     "known_grid_budget_kw": float(known_grid[-1]["budget_w"]) / 1000 if known_grid else None,
                     "rule": "network-all-stations-v1/strict-adjacent-v1"})
        end += HOUR
    return validate(rows)


def quality_report(rows):
    counts = {q: sum(r["quality"] == q for r in rows) for q in ("complete", "partial", "missing")}
    return {"hours": len(rows), "counts": counts,
            "percent": {q: round(100 * n / len(rows), 4) if rows else None for q, n in counts.items()},
            "first_end": rows[0]["end"] if rows else None, "last_end": rows[-1]["end"] if rows else None,
            "known_grid_hours": sum(r["known_grid_budget_kw"] is not None for r in rows),
            "decision": "NEEDS_MORE_DATA" if counts["complete"] < 24 * 56 else "CANDIDATE_REQUIRES_TEMPORAL_REVIEW"}


def prediction(rows, origin, horizon, method):
    if not 1 <= horizon <= 24 or method not in ("last", "weekly"):
        raise ValueError("Invalid baseline request")
    known = [r for r in rows if r["quality"] == "complete" and r["load_kw"] is not None and
             r["available_at"] and instant(r["available_at"]) <= origin and instant(r["end"]) <= origin]
    if method == "last":
        return max(known, key=lambda r: r["end"])["load_kw"] if known else None
    desired = origin + horizon * HOUR - 168 * HOUR
    return next((r["load_kw"] for r in known if instant(r["end"]) == desired), None)


def split_ranges(start):
    # Half-open target blocks. A full day between blocks purges overlapping 24h labels.
    return {"train": (start, start + timedelta(days=120)),
            "validation": (start + timedelta(days=121), start + timedelta(days=149)),
            "test": (start + timedelta(days=150), start + timedelta(days=180))}


def forecast(rows, origin, method):
    return {"origin": stamp(origin), "method": method, "kind": "fixed_baseline_not_trained_model",
            "points": [{"h": h, "end": stamp(origin+h*HOUR), "power_kw": prediction(rows,origin,h,method)} for h in range(1,25)]}


def origins(rows, bounds):
    low, high = bounds
    # Every h=1..24 target must be strictly inside the same target block.
    return [instant(r["end"]) for r in rows if low <= instant(r["end"]) and instant(r["end"]) + 24 * HOUR < high]


def metrics(pairs):
    if not pairs:
        return {"n": 0, "mae_kw": None, "rmse_kw": None}
    errors = [a - b for a, b in pairs]
    return {"n": len(errors), "mae_kw": round(sum(abs(e) for e in errors) / len(errors), 6),
            "rmse_kw": round(math.sqrt(sum(e * e for e in errors) / len(errors)), 6)}


def evaluate(rows, ranges):
    validate(rows)
    by_end = {instant(r["end"]): r for r in rows}
    output = {}
    observations = [(instant(r["end"]), instant(r["available_at"]), r["load_kw"]) for r in rows
                    if r["quality"] == "complete" and r["available_at"]]
    # Fixed methods only: no fitting, tuning, selection or preprocessing sees test labels.
    for split, bounds in ranges.items():
        eligible = origins(rows, bounds)
        per_h = {h: {m: [] for m in ("last", "weekly")} for h in range(1, 25)}
        usable = set()
        for origin in eligible:
            known = {end: value for end, available, value in observations if end <= origin and available <= origin}
            last = known[max(known)] if known else None
            for h in range(1, 25):
                actual = by_end.get(origin + h * HOUR)
                if not actual or actual["quality"] != "complete":
                    continue
                predictions = {"last": last, "weekly": known.get(origin + h * HOUR - 168 * HOUR)}
                if any(v is None for v in predictions.values()):
                    continue
                usable.add(origin)
                for m, value in predictions.items():
                    per_h[h][m].append((value, actual["load_kw"]))
        output[split] = {"target_block": [stamp(v) for v in bounds], "candidate_origins": len(eligible),
                         "origins_with_common_scores": len(usable),
                         "first_origin": stamp(eligible[0]) if eligible else None,
                         "last_origin": stamp(eligible[-1]) if eligible else None,
                         "horizons": {str(h): {m: metrics(p) for m, p in methods.items()} for h, methods in per_h.items()},
                         "aggregate": {m: metrics([pair for methods in per_h.values() for pair in methods[m]])
                                       for m in ("last", "weekly")}}
    return output
