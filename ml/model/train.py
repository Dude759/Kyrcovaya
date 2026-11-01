import argparse,hashlib,json,platform
from datetime import datetime,timezone
from pathlib import Path
import joblib,numpy as np,scipy,sklearn
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from readiness.core import canonical,digest,instant,metrics,split_ranges,stamp,HOUR
from readiness.synthetic import DEFAULTS
from .features import History,FEATURES,features,matrix
from .trust import MODEL_VERSION,MODEL_SHA256,BUNDLE_SHA256

HASH='2f39bfa1271973d03c3231ec148b7c868afa5f94730d8895e654480ddac9583e'
GRID=[dict(n_estimators=32,max_depth=8,min_samples_leaf=20),dict(n_estimators=64,max_depth=10,min_samples_leaf=20),dict(n_estimators=64,max_depth=12,min_samples_leaf=10)]
SEED=20261101
def write(p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(canonical(v),encoding='utf8',newline='\n')
def versions():return {'python':platform.python_version(),'sklearn':sklearn.__version__,'numpy':np.__version__,'scipy':scipy.__version__,'joblib':joblib.__version__}
def load_rows():
    rows=json.loads(Path('results/synthetic-network.json').read_text(encoding='utf8'))
    if digest(rows)!=HASH:raise ValueError('Dataset checksum mismatch')
    return rows
def pipeline(params):return Pipeline([('imputer',SimpleImputer(strategy='median',keep_empty_features=True)),('forest',RandomForestRegressor(**params,random_state=SEED,n_jobs=1))])
def score(pred,y,keys,baselines,bounds):
    methods={'rf':pred,'last':[b[0] for b in baselines],'weekly':[b[1] for b in baselines]}
    candidate=int((bounds[1]-bounds[0]).total_seconds()/3600)-24
    return {'aggregate':{m:metrics(list(zip(p,y))) for m,p in methods.items()},'origins':len(set(k[0] for k in keys)),
            'pairs':len(keys),'candidate_pairs':candidate*24,'coverage':len(keys)/(candidate*24),
            'horizons':{str(h):{m:metrics([(p[i],y[i]) for i,k in enumerate(keys) if k[1]==h]) for m,p in methods.items()} for h in range(1,25)}}
def trusted_load(path,manifest):
    trusted=Path(__file__).resolve().parents[1]/'models/rf-v1/forest.joblib'
    if path.resolve()!=trusted or manifest.get('modelVersion')!=MODEL_VERSION or manifest.get('modelSha256')!=MODEL_SHA256 or manifest.get('bundleSha256')!=BUNDLE_SHA256:raise ValueError('Artifact provenance mismatch')
    if manifest['datasetHash']!=HASH or manifest['features']!=FEATURES or manifest['versions']!=versions():raise ValueError('Incompatible trusted model manifest')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=manifest['modelSha256']:raise ValueError('Model checksum mismatch')
    return joblib.load(path) # Only repository-owned artifact after hash/provenance verification. No user paths in HTTP.
def train(out):
    rows=load_rows();history=History(rows);ranges=split_ranges(instant(DEFAULTS['start']))
    tx,ty,tk,tb=matrix(history,ranges['train']);vx,vy,vk,vb=matrix(history,ranges['validation'],True)
    choices=[];models=[]
    for params in GRID:
        model=pipeline(params);model.fit(tx,ty);pred=model.predict(vx);models.append(model)
        choices.append({'params':params,'validation':score(pred,vy,vk,vb,ranges['validation'])})
    chosen=min(range(len(choices)),key=lambda i:choices[i]['validation']['aggregate']['rf']['mae_kw'])
    selection={'datasetHash':HASH,'features':FEATURES,'randomState':SEED,'grid':choices,'selected':chosen,
               'params':GRID[chosen],'splits':{k:[stamp(v) for v in b] for k,b in ranges.items()},'policy':'validation MAE only; test evaluation only after selection.json persisted'}
    write(out/'selection.json',selection)
    model=models[chosen];joblib.dump(model,out/'forest.joblib',compress=3)
    # First and final test evaluation, after selection manifest was committed to disk. No further tuning.
    x,y,keys,base=matrix(history,ranges['test'],True);pred=model.predict(x)
    report={'validation':choices[chosen]['validation'],'test':score(pred,y,keys,base,ranges['test'])}
    write(out/'metrics.json',report)
    origin=ranges['validation'][0];demoX=np.array([features(history,origin,h) for h in range(1,25)])
    rf=model.predict(demoX);known=history.at(origin);last=known[max(known)]['load_kw']
    model_version='rf-synthetic-v1-'+digest({'data':HASH,'features':FEATURES,'params':GRID[chosen],'seed':SEED})[:12]
    generated=stamp(datetime.now(timezone.utc))
    bundle={'organizationId':'00000000-0000-4000-8000-000000000001','modelVersion':model_version,'source':'synthetic',
            'mode':'historical_replay','origin':stamp(origin),'generatedAt':generated,'quality':'synthetic_experiment_only',
            'datasetHash':HASH,'metrics':report,'points':[{'h':h,'time':stamp(origin+h*HOUR),'powerKw':float(rf[h-1]),'lastKw':last,
            'weeklyKw':known.get(origin+(h-168)*HOUR,{}).get('load_kw')} for h in range(1,25)]}
    write(out/'demo-forecast.json',bundle)
    manifest={**{k:v for k,v in selection.items() if k!='grid'},'modelVersion':model_version,'generatedAt':generated,'versions':versions(),
              'modelSha256':hashlib.sha256((out/'forest.joblib').read_bytes()).hexdigest(),
              'bundleSha256':hashlib.sha256(canonical(bundle).strip().encode()).hexdigest(),
              'trainRows':len(ty),'imputerStatistics':model.named_steps['imputer'].statistics_.tolist(),
              'replay':{'origin':stamp(origin),'predictions':rf.tolist()},'inference':'Python offline; Render serves verified JSON replay; no Python/ONNX assumed'}
    write(out/'manifest.json',manifest);return manifest
def verify(out,retrain=False):
    manifest=json.loads((out/'manifest.json').read_text());model=trusted_load(out/'forest.joblib',manifest)
    rows=load_rows();history=History(rows);origin=instant(manifest['replay']['origin'])
    x=np.array([features(history,origin,h) for h in range(1,25)]);pred=model.predict(x)
    np.testing.assert_allclose(pred,manifest['replay']['predictions'],rtol=0,atol=1e-8)
    bundle=json.loads((out/'demo-forecast.json').read_text())
    assert hashlib.sha256(canonical(bundle).strip().encode()).hexdigest()==manifest['bundleSha256']
    np.testing.assert_allclose(pred,[p['powerKw'] for p in bundle['points']],rtol=0,atol=1e-8)
    if retrain:
        ranges=split_ranges(instant(DEFAULTS['start']));tx,ty,*_=matrix(history,ranges['train'])
        for params in GRID:
            fit=pipeline(params);fit.fit(tx,ty)
            vx,vy,vk,vb=matrix(history,ranges['validation'],True)
            expected=next(c['validation'] for c in json.loads((out/'selection.json').read_text())['grid'] if c['params']==params)
            assert score(fit.predict(vx),vy,vk,vb,ranges['validation'])==expected
            if params==manifest['params']:np.testing.assert_allclose(fit.predict(x),pred,rtol=0,atol=1e-8)
        # Frozen experiment replay only, not parameter selection based on test outcomes.
        ex,ey,ek,eb=matrix(history,ranges['test'],True)
        assert score(model.predict(ex),ey,ek,eb,ranges['test'])==json.loads((out/'metrics.json').read_text())['test']
    print(json.dumps({'verified':True,'modelVersion':manifest['modelVersion'],'versions':versions(),'retrained':retrain}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['train','verify']);p.add_argument('--out',type=Path,default=Path('models/rf-v1'));p.add_argument('--retrain',action='store_true');args=p.parse_args()
    if args.command=='train':train(args.out)
    else:verify(args.out,args.retrain)
