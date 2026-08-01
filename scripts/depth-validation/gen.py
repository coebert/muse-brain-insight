import sys, json, numpy as np
sys.path.insert(0,'/tmp/valid')
import signals, openibis_ref as oi
from scipy.signal import decimate
out = {}
for i,(name,spec) in enumerate(signals.SESSIONS):
    x = signals.build_session(spec, 100+i)
    np.savetxt(f"/tmp/valid/sess_{name}.csv", x, fmt="%.4f")
    x128 = decimate(x, 2, zero_phase=False)
    idx, bsr = oi.openibis(x128)
    # reference epoch n (1-based, stride .5s) centre time: PSD segment starts (n+4)*0.5s, 4s long
    t = np.array([(n+4)*0.5 + 4 for n in range(1, len(idx)+1)])
    lbl = []
    for s,sec in spec: lbl += [s]*sec
    out[name] = {"t": t.tolist(), "idx": [None if np.isnan(v) else round(float(v),3) for v in idx],
                 "bsr": [round(float(v),3) for v in bsr], "labels": lbl,
                 "seconds": len(x)//signals.FS}
json.dump(out, open("/tmp/valid/reference.json","w"))
print({k: (len(v["t"]), v["seconds"]) for k,v in out.items()})
