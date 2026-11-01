"""Independent latent-demand simulator. Future latent inputs are never model features."""
import math
import random
from datetime import timedelta
from .core import HOUR, instant, stamp, validate

DEFAULTS = {"version": "synthetic-network-v1", "seed": 20261101, "start": "2026-01-01T00:00:00Z", "days": 180,
            "stations": 8, "demand_noise_sigma": 0.24, "missing_probability": 0.005,
            "partial_probability": 0.012, "network_outage_probability": 0.02, "units": "kW hourly average", "timezone": "UTC"}


def allocate(demands, budget):
    # Whole-watt progressive max-min, independent of prediction functions.
    result = [0] * len(demands)
    left = int(budget)
    while left:
        live = [i for i, d in enumerate(demands) if result[i] < d]
        if not live:
            break
        step = min(left // len(live), min(demands[i] - result[i] for i in live))
        if step:
            for i in live:
                result[i] += step
                left -= step
        else:
            for i in live[:left]:
                result[i] += 1
                left -= 1
    return result


def generate(config=None):
    cfg = dict(DEFAULTS if config is None else config)
    if cfg["version"] != DEFAULTS["version"] or cfg["days"] < 1 or cfg["stations"] < 1:
        raise ValueError("Invalid generator configuration")
    if any(not 0 <= cfg[k] <= 1 for k in ("missing_probability", "partial_probability", "network_outage_probability")):
        raise ValueError("Invalid quality probability")
    if cfg["missing_probability"] + cfg["partial_probability"] > 1:
        raise ValueError("Quality probabilities overlap")
    demand_rng, quality_rng = random.Random(cfg["seed"]), random.Random(cfg["seed"] + 1)
    start = instant(cfg["start"])
    if start.minute or start.second or start.microsecond:
        raise ValueError("UTC hour start required")
    station_specs = [{"id": f"synthetic-{i+1}", "ports": 3 + i % 4, "port_limit_w": 22000 if i % 3 else 50000,
                      "station_limit_w": 65000 + 15000 * i, "activity": 0.65 + i * 0.09}
                     for i in range(cfg["stations"])]
    rows = []
    for n in range(cfg["days"] * 24):
        time = start + n * HOUR
        day = n // 24
        # Multi-day stress events followed by a recovery ramp, not a known future feature.
        event = day % 35
        budget = 140000 if 21 <= event < 24 else (220000 + 80000 * (event-24)) if 24 <= event < 27 else 650000
        counts, demands = [], []
        for i, s in enumerate(station_specs):
            daily = 0.55 + 0.35 * math.sin((time.hour - 8 - i % 3) * math.pi / 12)
            weekday = 0.74 if time.weekday() >= 5 else 1.0
            probability = min(0.96, max(0.04, daily * weekday * s["activity"]))
            sessions = sum(demand_rng.random() < probability for _ in range(s["ports"]))
            counts.append(sessions)
            noise = demand_rng.lognormvariate(-cfg["demand_noise_sigma"] ** 2 / 2, cfg["demand_noise_sigma"])
            requested = round(sessions * s["port_limit_w"] * demand_rng.uniform(0.45, 0.95) * noise)
            demands.append(min(requested, sessions * s["port_limit_w"], s["station_limit_w"]))
        assigned = allocate(demands, budget)
        assert sum(assigned) <= budget and all(0 <= w <= d for w, d in zip(assigned, demands))
        outage = quality_rng.random() < cfg["network_outage_probability"] or (day % 53 == 40 and 3 <= time.hour < 8)
        qualities = []
        for _ in station_specs:
            q = quality_rng.random()
            qualities.append("missing" if outage or q < cfg["missing_probability"] else
                             "partial" if q < cfg["missing_probability"] + cfg["partial_probability"] else "complete")
        quality = "complete" if all(q == "complete" for q in qualities) else "missing" if all(q == "missing" for q in qualities) else "partial"
        rows.append({"end": stamp(time + HOUR), "available_at": stamp(time + HOUR) if quality == "complete" else None,
                     "source": "synthetic", "quality": quality, "load_kw": sum(assigned) / 1000 if quality == "complete" else None,
                     "expected_stations": len(station_specs), "station_quality": {q: qualities.count(q) for q in ("complete", "partial", "missing")},
                     "absent_station_hours": 0, "known_grid_budget_kw": None if outage else budget / 1000,
                     "rule": cfg["version"]})
    return validate(rows), {"parameters": cfg, "station_specs": station_specs,
                            "latent_inputs": "session counts, demand, future Grid and noise are not exported as features"}
