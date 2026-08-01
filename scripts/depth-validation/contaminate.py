import json, numpy as np, sys
FS=256
ref=json.load(open("reference.json"))
rng=np.random.default_rng(7)
summary={}
for name in ref:
    x=np.loadtxt(f"sess_{name}.csv")
    n=len(x); y=x.copy(); mask=np.zeros(n,bool)
    t=np.arange(n)/FS
    # EMG bursts: 4 s of broadband 20-45 Hz muscle every 40 s
    for s in range(20, n//FS-6, 40):
        a,b=s*FS,(s+4)*FS
        emg=rng.standard_normal(b-a)*18
        emg=np.convolve(emg,np.array([1,-1.6,0.8]),'same')  # HF-weighted
        y[a:b]+=emg; mask[a:b]=True
    # Eye blinks: 300 ms, 180 uV deflections every ~9 s
    for s in np.arange(5, n/FS-1, 9.0):
        a=int(s*FS); w=int(0.3*FS)
        y[a:a+w]+=180*np.hanning(w); mask[a:a+w]=True
    # ECG/pacing spikes: 1.2 Hz narrow spikes over one 60 s stretch
    a0=int((n/FS)*0.55)
    for s in np.arange(a0, a0+60, 1/1.2):
        a=int(s*FS)
        if a+6<n: y[a:a+6]+=120*np.array([0.2,0.8,1,-0.6,-0.2,0]); mask[a:a+6]=True
    np.savetxt(f"art_{name}.csv", y, fmt="%.4f")
    summary[name]=round(float(mask.mean()),3)
print("contaminated sample fraction:", summary)
