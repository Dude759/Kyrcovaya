import math
import numpy as np
from readiness.core import HOUR,instant,origins

FEATURES=['h','target_hour_sin','target_hour_cos','target_weekday_sin','target_weekday_cos','weekend',
          'lag1','lag24','lag48','lag168','lag1_missing','lag24_missing','lag48_missing','lag168_missing',
          'mean24','std24','min24','max24','count24','mean168','std168','min168','max168','count168',
          'last','last_age_hours','partial24','missing24']

class History:
    def __init__(self,rows):
        self.rows={instant(r['end']):r for r in rows}
    def at(self,origin):
        return {t:r for t,r in self.rows.items() if t<=origin and r['available_at'] and instant(r['available_at'])<=origin and r['quality']=='complete'}

def features(history,origin,h):
    if not 1<=h<=24 or origin.minute or origin.second or origin.microsecond:raise ValueError('Hourly origin and h1..24 required')
    known=history.at(origin);target=origin+h*HOUR
    lags=[known.get(origin-l*HOUR,{}).get('load_kw',np.nan) for l in (1,24,48,168)]
    values=[h,math.sin(target.hour*math.pi/12),math.cos(target.hour*math.pi/12),math.sin(target.weekday()*math.pi/3.5),math.cos(target.weekday()*math.pi/3.5),int(target.weekday()>=5),*lags,*[int(math.isnan(v)) for v in lags]]
    for window in (24,168):
        a=[r['load_kw'] for t,r in known.items() if origin-window*HOUR<t<=origin]
        values.extend([float(np.mean(a)),float(np.std(a)),min(a),max(a),len(a)] if a else [np.nan]*4+[0])
    last=max(known) if known else None
    recent=[r for t,r in history.rows.items() if origin-24*HOUR<t<=origin]
    # Missing/past quality never exposes future observations; delayed complete readings count as unavailable.
    values.extend([known[last]['load_kw'] if last else np.nan,(origin-last).total_seconds()/3600 if last else np.nan,
                   sum(r['quality']=='partial' for r in recent),sum(r['quality']=='missing' for r in recent)])
    return values

def matrix(history,bounds,common=False):
    xs,ys,keys,baseline=[],[],[],[]
    for origin in origins(list(history.rows.values()),bounds):
        known=history.at(origin);last=known[max(known)]['load_kw'] if known else None
        # History computation is pure/as-of; targets are used only for labels and scoring support.
        base=features(history,origin,1)
        for h in range(1,25):
            target=history.rows.get(origin+h*HOUR)
            if not target or target['quality']!='complete':continue
            weekly=known.get(origin+(h-168)*HOUR,{}).get('load_kw')
            if common and (last is None or weekly is None):continue
            f=base.copy();future=origin+h*HOUR
            f[:6]=[h,math.sin(future.hour*math.pi/12),math.cos(future.hour*math.pi/12),math.sin(future.weekday()*math.pi/3.5),math.cos(future.weekday()*math.pi/3.5),int(future.weekday()>=5)]
            xs.append(f);ys.append(target['load_kw']);keys.append((origin.isoformat(),h));baseline.append((last,weekly))
    return np.array(xs,dtype=float),np.array(ys),keys,baseline
