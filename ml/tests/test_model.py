import copy,json,unittest
from pathlib import Path
import numpy as np
from model.features import History,FEATURES,features,matrix
from model.train import HASH,SEED,GRID,load_rows,pipeline,trusted_load,verify,versions
from readiness.core import HOUR,instant,digest,split_ranges
from readiness.synthetic import DEFAULTS

class ModelTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.rows=load_rows();cls.history=History(cls.rows);cls.origin=instant('2026-05-02T00:00:00Z')
  cls.root=Path('models/rf-v1');cls.manifest=json.loads((cls.root/'manifest.json').read_text())
 def test_locked_versions_and_features(self):
  self.assertEqual(versions(),self.manifest['versions']);self.assertEqual(FEATURES,self.manifest['features'])
  self.assertEqual(len(FEATURES),len(set(FEATURES)));self.assertEqual(SEED,self.manifest['randomState'])
 def test_future_and_delayed_measurements_cannot_change_features(self):
  before=features(self.history,self.origin,24)
  changed=[{**r,'load_kw':999999,'known_grid_budget_kw':999999} if instant(r['end'])>self.origin else r for r in self.rows]
  np.testing.assert_allclose(before,features(History(changed),self.origin,24),equal_nan=True)
  old=[r for r in self.rows if instant(r['end'])<=self.origin]
  delayed=[{**r,'available_at':(self.origin+HOUR).isoformat()} if r['quality']=='complete' else r for r in old]
  f=features(History(delayed),self.origin,1)
  self.assertTrue(all(f[FEATURES.index(k)]==1 for k in ['lag1_missing','lag24_missing','lag48_missing','lag168_missing']))
  self.assertTrue(np.isnan(f[FEATURES.index('last')]))
 def test_train_only_imputer_and_reproducible_fit(self):
  x=np.ones((40,len(FEATURES)));x[:,6]=np.nan;x[0,6]=5;y=np.arange(40)
  a=pipeline(dict(n_estimators=4,max_depth=3,min_samples_leaf=2));b=pipeline(dict(n_estimators=4,max_depth=3,min_samples_leaf=2))
  a.fit(x,y);b.fit(x,y);self.assertEqual(a['imputer'].statistics_[6],5)
  a.predict(np.full((1,len(FEATURES)),999));self.assertEqual(a['imputer'].statistics_[6],5)
  np.testing.assert_array_equal(a.predict(x),b.predict(x))
 def test_model_reload_and_bundle_parity(self):verify(self.root)
 def test_reject_wrong_dataset_version_or_untrusted_path(self):
  for key,value in [('datasetHash','wrong'),('modelVersion','wrong'),('features',list(reversed(FEATURES))),('modelSha256','0'*64)]:
   m=copy.deepcopy(self.manifest);m[key]=value
   with self.assertRaises(ValueError):trusted_load(self.root/'forest.joblib',m)
  with self.assertRaises(ValueError):trusted_load(Path('untrusted-user-file.joblib'),self.manifest)
 def test_common_support_and_horizon_metrics_match_6a(self):
  scores=json.loads((self.root/'metrics.json').read_text());base=json.loads(Path('results/baseline-metrics.json').read_text())
  for split in ['validation','test']:
   for m in ['last','weekly']:self.assertEqual(scores[split]['aggregate'][m],base[split]['aggregate'][m])
   self.assertEqual(set(scores[split]['horizons']),{str(h) for h in range(1,25)})
   self.assertEqual(scores[split]['aggregate']['rf']['n'],base[split]['aggregate']['last']['n'])
   self.assertEqual(scores[split]['pairs'],sum(v['rf']['n'] for v in scores[split]['horizons'].values()))
 def test_split_and_training_configuration_locked(self):
  selection=json.loads((self.root/'selection.json').read_text())
  self.assertEqual(selection['datasetHash'],HASH);self.assertEqual([g['params'] for g in selection['grid']],GRID)
  best=min(range(len(GRID)),key=lambda i:selection['grid'][i]['validation']['aggregate']['rf']['mae_kw'])
  self.assertEqual(selection['selected'],best);self.assertEqual(selection['params'],self.manifest['params'])
 def test_serialized_forecast_24_dates_and_sources(self):
  b=json.loads((self.root/'demo-forecast.json').read_text());self.assertEqual(b['source'],'synthetic');self.assertEqual(b['mode'],'historical_replay')
  self.assertEqual(len(b['points']),24)
  for i,p in enumerate(b['points']):self.assertEqual(instant(p['time']),instant(b['origin'])+(i+1)*HOUR)
  self.assertEqual(b['origin'],'2026-05-02T00:00:00Z')

if __name__=='__main__':unittest.main()
