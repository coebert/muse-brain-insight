import json, sys, numpy as np
ref = json.load(open("reference.json")); cand = json.load(open(sys.argv[1]))
rows=[]; allr=[]; alld=[]
for name in ref:
    rt=np.array(ref[name]["t"]); ri=np.array([np.nan if v is None else v for v in ref[name]["idx"]])
    ct=np.array(cand[name]["t"]); ci=np.array([np.nan if v is None else v for v in cand[name]["idx"]],dtype=float)
    # align candidate times onto reference grid
    r_on_c=np.interp(ct, rt[~np.isnan(ri)], ri[~np.isnan(ri)], left=np.nan, right=np.nan)
    m=~np.isnan(r_on_c)&~np.isnan(ci)
    a,b=r_on_c[m],ci[m]
    if len(a)<10: continue
    d=b-a; r=np.corrcoef(a,b)[0,1]
    rows.append((name,len(a),r,d.mean(),d.std(ddof=1),np.sqrt((d**2).mean())))
    allr.append(a); alld.append(b)
A=np.concatenate(allr); B=np.concatenate(alld); D=B-A
print(f"{'session':20s} {'n':>5s} {'r':>6s} {'bias':>7s} {'sd':>6s} {'rmse':>6s}")
for n,c,r,bi,sd,rm in rows: print(f"{n:20s} {c:5d} {r:6.3f} {bi:7.2f} {sd:6.2f} {rm:6.2f}")
print(f"{'POOLED':20s} {len(A):5d} {np.corrcoef(A,B)[0,1]:6.3f} {D.mean():7.2f} {D.std(ddof=1):6.2f} {np.sqrt((D**2).mean()):6.2f}")
print(f"95% limits of agreement: {D.mean()-1.96*D.std(ddof=1):.1f} to {D.mean()+1.96*D.std(ddof=1):.1f} index units")
print(f"within +/-10: {100*np.mean(np.abs(D)<=10):.1f}%   within +/-15: {100*np.mean(np.abs(D)<=15):.1f}%")
