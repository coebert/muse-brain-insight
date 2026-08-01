import json, numpy as np
ref=json.load(open("reference.json")); cand=json.load(open("new_filtered.json"))
buck={}
for name in ref:
    rt=np.array(ref[name]["t"]); ri=np.array([np.nan if v is None else v for v in ref[name]["idx"]])
    ct=np.array(cand[name]["t"]); ci=np.array([np.nan if v is None else v for v in cand[name]["idx"]],dtype=float)
    r=np.interp(ct, rt[~np.isnan(ri)], ri[~np.isnan(ri)], left=np.nan, right=np.nan)
    lbl=ref[name]["labels"]
    for k,(a,b,tt) in enumerate(zip(r,ci,ct)):
        if np.isnan(a) or np.isnan(b): continue
        s=lbl[min(int(tt),len(lbl)-1)]
        buck.setdefault(s,[]).append((a,b))
print(f"{'state':20s}{'n':>6s}{'ref mean':>10s}{'bias':>8s}{'sd':>7s}{'95% LoA':>18s}")
for s,v in buck.items():
    A=np.array([x[0] for x in v]); B=np.array([x[1] for x in v]); D=B-A
    print(f"{s:20s}{len(A):6d}{A.mean():10.1f}{D.mean():8.2f}{D.std(ddof=1):7.2f}   {D.mean()-1.96*D.std(ddof=1):6.1f} to {D.mean()+1.96*D.std(ddof=1):5.1f}")
