import copy
import json
import unittest
from datetime import timedelta
from pathlib import Path
from readiness.core import (HOUR, digest, evaluate, export_network, forecast, instant, metrics, origins,
                            prediction, split_ranges, validate)
from readiness.synthetic import DEFAULTS, allocate, generate


class ReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows, cls.manifest = generate()
        cls.start = instant(DEFAULTS['start'])

    def test_repeatable_hash_and_metrics(self):
        rows, _ = generate()
        self.assertEqual(digest(rows), digest(self.rows))
        a=evaluate(rows,split_ranges(self.start))
        stored=json.loads(Path('results/baseline-metrics.json').read_text())
        self.assertEqual(a,stored)

    def test_seed_changes_dataset(self):
        rows,_=generate({**DEFAULTS,'seed':DEFAULTS['seed']+1})
        self.assertNotEqual(digest(rows),digest(self.rows))

    def test_quality_never_invents_zero(self):
        for r in self.rows:
            self.assertEqual(r['source'],'synthetic')
            self.assertEqual(r['load_kw'] is not None,r['quality']=='complete')
            if r['load_kw'] is not None:
                self.assertLessEqual(r['load_kw'],r['known_grid_budget_kw'])
        with self.assertRaises(ValueError):
            validate([{**self.rows[0],'quality':'partial','load_kw':0}])

    def test_roster_export_missing_station_and_partial_are_not_network_total(self):
        snapshot=json.loads(Path('data/server-snapshot.json').read_text())
        exported=export_network(snapshot)
        self.assertTrue(exported)
        self.assertTrue(all(r['load_kw'] is None for r in exported))
        # A complete station is still insufficient if another expected station is absent.
        end='2026-01-01T01:00:00Z'
        snapshot.update(captured_at=end,stations=[{'id':i,'created_at':'2025-01-01T00:00:00Z','archived_at':None} for i in ['a','b']],grid=[])
        snapshot['hours']=[{'station_id':'a','end':end,'quality':'complete','average_kw':5,'observed_ms':3600000,'covered_session_ms':3600000,'expected_session_ms':3600000,'gap_count':0,'boundary_count':0,'rule':'strict-adjacent-v1','built_at':end}]
        row=export_network(snapshot)[0]
        self.assertEqual(row['quality'],'partial');self.assertIsNone(row['load_kw'])
        snapshot['hours'].append({**snapshot['hours'][0],'station_id':'b','average_kw':7})
        self.assertEqual(export_network(snapshot)[0]['load_kw'],12)
        snapshot['hours'][0]['built_at']='2026-01-01T01:00:00.500000Z'
        exported=export_network(snapshot)
        self.assertEqual(exported[0]['available_at'],'2026-01-01T01:00:00.500000Z')
        self.assertIsNone(prediction(exported,instant(end),1,'last'))

    def test_split_labels_disjoint_and_purged(self):
        ranges=split_ranges(self.start)
        for left,right in [('train','validation'),('validation','test')]:
            a,b=origins(self.rows,ranges[left]),origins(self.rows,ranges[right])
            self.assertLess(a[-1]+24*HOUR,b[0])
            self.assertGreaterEqual(ranges[right][0]-ranges[left][1],24*HOUR)
        for bounds in ranges.values():
            for origin in origins(self.rows,bounds):
                self.assertGreaterEqual(origin,bounds[0]);self.assertLess(origin+24*HOUR,bounds[1])

    def test_last_baseline_uses_available_not_future_or_delayed_observation(self):
        origin=self.start+10*HOUR
        rows=[{**self.rows[0],'end':(origin-HOUR).isoformat(),'available_at':origin.isoformat(),'quality':'complete','load_kw':5},
              {**self.rows[0],'end':origin.isoformat(),'available_at':(origin+HOUR).isoformat(),'quality':'complete','load_kw':999}]
        self.assertEqual(prediction(rows,origin,24,'last'),5)
        self.assertIsNone(prediction([],origin,1,'last'))

    def test_weekly_exact_hour_and_missing_no_fallback(self):
        origin=self.start+200*HOUR
        row={**self.rows[0],'end':(origin+24*HOUR-168*HOUR).isoformat(),'available_at':(origin-HOUR).isoformat(),'quality':'complete','load_kw':42}
        self.assertEqual(prediction([row],origin,24,'weekly'),42)
        self.assertIsNone(prediction([row],origin,1,'weekly'))

    def test_future_perturbation_does_not_change_prediction(self):
        origin=self.start+200*HOUR
        a=[prediction(self.rows,origin,h,m) for h in (1,24) for m in ('last','weekly')]
        changed=[{**r,'load_kw':999999} if instant(r['end'])>origin and r['quality']=='complete' else r for r in self.rows]
        self.assertEqual(a,[prediction(changed,origin,h,m) for h in (1,24) for m in ('last','weekly')])

    def test_metrics_common_support_and_units(self):
        self.assertEqual(metrics([(2,1),(4,1)]),{'n':2,'mae_kw':2.0,'rmse_kw':2.236068})
        self.assertIsNone(metrics([])['rmse_kw'])
        scores=json.loads(Path('results/baseline-metrics.json').read_text())
        for block in scores.values():
            for v in [block['aggregate'],*block['horizons'].values()]:
                self.assertEqual(v['last']['n'],v['weekly']['n'])

    def test_integer_physical_allocation(self):
        self.assertEqual(allocate([100000,80000,60000,50000],150000),[37500]*4)
        self.assertEqual(allocate([1000,5000],3000),[1000,2000])

    def test_forecast_24_consecutive_nullable_points(self):
        value=forecast([],self.start,'weekly')
        self.assertEqual([p['h'] for p in value['points']],list(range(1,25)))
        self.assertTrue(all(p['power_kw'] is None for p in value['points']))
        self.assertEqual(instant(value['points'][-1]['end'])-self.start,24*HOUR)

    def test_export_availability_and_grid_cannot_come_from_future(self):
        snapshot=json.loads(Path('data/server-snapshot.json').read_text())
        for r in export_network(snapshot):
            if r['known_grid_budget_kw'] is not None:
                self.assertTrue(any(g['received_at'] and g['budget_w'] is not None and g['validity']=='fresh' and instant(g['created_at'])<=instant(r['end']) and 0<=(instant(r['end'])-instant(g['received_at'])).total_seconds()<=g['freshness_seconds'] for g in snapshot['grid']))


if __name__=='__main__':unittest.main()
