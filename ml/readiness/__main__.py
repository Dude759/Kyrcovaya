import argparse
import csv
import json
import platform
from html import escape
from pathlib import Path
from .core import canonical, digest, evaluate, export_network, forecast, instant, quality_report, split_ranges
from .synthetic import DEFAULTS, generate


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(canonical(value), encoding="utf-8")


def plot(rows, path, title):
    rows = rows[-168:]
    maximum = max([r["load_kw"] for r in rows if r["load_kw"] is not None] + [1])
    segments, current = [], []
    missing = []
    for i, r in enumerate(rows):
        x = 70 + 870 * i / max(1, len(rows)-1)
        if r["load_kw"] is None:
            if current:
                segments.append(current)
                current = []
            missing.append(f'<rect x="{x:.2f}" y="60" width="{max(1,870/max(1,len(rows))):.2f}" height="210" fill="#e9ecef"/>')
        else:
            current.append(f'{x:.2f},{270-200*r["load_kw"]/maximum:.2f}')
    if current:
        segments.append(current)
    curves = ''.join(f'<polyline points="{" ".join(s)}" fill="none" stroke="#17664c" stroke-width="1.7"/>' for s in segments)
    curves += ''.join(f'<circle cx="{s[0].split(",")[0]}" cy="{s[0].split(",")[1]}" r="2" fill="#17664c"/>' for s in segments if len(s)==1)
    body = f'''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="360" viewBox="0 0 1000 360">
<rect width="1000" height="360" fill="white"/><g font-family="sans-serif" fill="#22332c">
<text x="30" y="30" font-size="18">{escape(title)}</text><text x="30" y="50" font-size="12">кВт · средняя суммарная измеренная мощность за час · UTC</text>
{''.join(missing)}<path d="M70 60V270H950" fill="none" stroke="#78847e"/>{curves}
<text x="25" y="65" font-size="12">{maximum:.1f}</text><text x="45" y="273" font-size="12">0</text>
<text x="70" y="295" font-size="11">{rows[0]['end'] if rows else 'Нет данных'}</text><text x="740" y="295" font-size="11">{rows[-1]['end'] if rows else ''}</text>
<text x="70" y="320" font-size="12">Зелёный: complete target. Серый: partial/missing, значение не вычислено.</text>
<text x="70" y="342" font-size="12">{'Нет полных сетевых наблюдений: линия нагрузки отсутствует.' if not curves else 'Показаны последние 168 часов; разрывы не соединяются и не заменяются нулём.'}</text></g></svg>'''
    path.write_text(body, encoding="utf-8")


def prepare(snapshot_path, out):
    snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
    actual = export_network(snapshot)
    synthetic, manifest = generate()
    ranges = split_ranges(instant(DEFAULTS["start"]))
    scores = evaluate(synthetic, ranges)
    write(out / "actual-network.json", actual)
    write(out / "synthetic-network.json", synthetic)
    write(out / "generator-manifest.json", {**manifest, "python": platform.python_version(),
          "synthetic_sha256": digest(synthetic), "snapshot_sha256": digest(snapshot),
          "actual_sha256": digest(actual), "split_policy": "target-blocks-v1; 24h purge; h=1..24; fixed methods; no tuning"})
    write(out / "baseline-metrics.json", scores)
    write(out / "baseline-example.json", {m:forecast(synthetic,ranges["validation"][0],m) for m in ("last","weekly")})
    report = {"actual": quality_report(actual), "synthetic": quality_report(synthetic),
              "real_training": "NEEDS_MORE_DATA", "synthetic_experiment": "READY_FOR_CONTROLLED_6B_EXPERIMENT_ONLY",
              "baseline_protocol": "paired complete targets with both predictions available; equal n for both; pooled origin/horizon MAE and RMSE, kW",
              "baseline_results": scores}
    write(out / "readiness-report.json", report)
    # Same source/time/quality columns in both CSV exports. No identifiers of drivers or payments.
    for name, rows in (("actual", actual), ("synthetic", synthetic)):
        with (out / f"{name}-network.csv").open("w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["end", "source", "quality", "load_kw", "available_at", "known_grid_budget_kw"], lineterminator="\n")
            writer.writeheader()
            writer.writerows({k:r[k] for k in writer.fieldnames} for r in rows)
        plot(rows, out / f"{name}-load.svg", f'{name.upper()} — {"фактическая история серверного имитатора" if name=="actual" else "синтетический учебный набор, не реальная сеть"}')
    # Real history also goes through the exact same evaluators; missing predictions remain absent.
    actual_scores = evaluate(actual, {"audit_period": (instant(actual[0]["end"]), instant(actual[-1]["end"]))}) if actual else {}
    write(out / "actual-baseline-metrics.json", actual_scores)
    return report


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    all_cmd = sub.add_parser("prepare")
    all_cmd.add_argument("--snapshot", type=Path, default=Path("data/server-snapshot.json"))
    all_cmd.add_argument("--out", type=Path, default=Path("results"))
    for command in ("audit", "export", "validate", "baseline"):
        p = sub.add_parser(command)
        p.add_argument("--input", type=Path, required=True)
        p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("forecast")
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--origin", required=True)
    p.add_argument("--method", choices=["last","weekly"], required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        report = prepare(args.snapshot, args.out)
        print(canonical({"actual":report["actual"], "synthetic":report["synthetic"], "real_training":report["real_training"]}),end="")
        return
    value = json.loads(args.input.read_text(encoding="utf-8"))
    if args.command in ("export", "audit"):
        value = export_network(value)
        if args.command == "audit":
            value = quality_report(value)
    elif args.command == "forecast":
        value = forecast(value,instant(args.origin),args.method)
    elif args.command == "baseline":
        value = evaluate(value, split_ranges(instant(DEFAULTS["start"])))
    else:
        from .core import validate
        validate(value)
        value = {"sha256": digest(value), **quality_report(value)}
    write(args.out,value)


if __name__ == "__main__":
    main()
