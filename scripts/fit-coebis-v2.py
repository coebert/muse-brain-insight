#!/usr/bin/env python3
"""Model search for a from-scratch COEBIS index.

Reads the local corpus written by scripts/build-coebis-corpus.ts (one JSONL
file per case: full spectral feature vector + the bedside monitor's BIS) and
grades candidate depth models against the monitor with *patient-level*
cross-validation: every case is held out in turn, so no fit is ever graded on
a patient it saw.

Candidates
  raw        the current OpenIBIS-derived app index, uncalibrated
  affine     that index rescaled (gain/offset) on the training cases
  ridge      a from-scratch linear model on the full spectral feature set
  ridge+link the same, squashed through a fitted logistic link
  boosted    small gradient-boosted stumps, as a headroom estimate only

Nothing here writes to the database.
"""
import glob
import json
import sys

import numpy as np

import os
BOOSTED = os.environ.get("BOOSTED") == "1"
CORPUS = sys.argv[1] if len(sys.argv) > 1 else "/tmp/coebis-corpus"

files = sorted(glob.glob(f"{CORPUS}/case-*.jsonl"))
if not files:
    raise SystemExit("no corpus files")

rows, keys = [], None
for path in files:
    with open(path) as fh:
        for line in fh:
            r = json.loads(line)
            if keys is None:
                keys = sorted(r["f"].keys())
            rows.append(r)

print(f"{len(rows)} paired seconds from {len(files)} cases, {len(keys)} raw features")

cases = np.array([r["caseRef"] for r in rows])
times = np.array([r["t"] for r in rows], dtype=float)
y = np.array([r["bis"] for r in rows], dtype=float)
raw = np.array([r["appIndex"] if r["appIndex"] is not None else np.nan for r in rows])
X0 = np.array([[r["f"][k] for k in keys] for r in rows], dtype=float)
age = np.array([r["cov"]["age"] if r["cov"]["age"] is not None else 55 for r in rows], float)
male = np.array([r["cov"]["sexMale"] if r["cov"]["sexMale"] is not None else 0.5 for r in rows], float)

ok = np.isfinite(y) & np.isfinite(X0).all(axis=1)
rows = None
cases, times, y, raw, X0, age, male = cases[ok], times[ok], y[ok], raw[ok], X0[ok], age[ok], male[ok]
print(f"{ok.sum()} usable rows, {len(set(cases))} cases")


def design(X0, age, male, keys):
    """Feature matrix: the raw descriptors, a few squared terms, suppression
    interactions and the two covariates that are always recorded."""
    cols, names = [], []
    for i, k in enumerate(keys):
        cols.append(X0[:, i])
        names.append(k)
    idx = {k: i for i, k in enumerate(keys)}
    sr = X0[:, idx["sr60"]] / 100.0
    for k in ("betaRatio", "syncFastSlow", "sef95", "entState", "relDelta", "relBeta"):
        v = X0[:, idx[k]]
        cols.append(v * v)
        names.append(f"{k}^2")
        cols.append(v * sr)
        names.append(f"{k}*sr")
    cols += [sr * sr, (age - 55) / 20.0, male]
    names += ["sr^2", "ageZ", "male"]
    return np.column_stack(cols), names


X, names = design(X0, age, male, keys)


def add_history(X, names, cases, times, keys_to_lag, taus=(15.0, 60.0)):
    """Trailing exponential means and their deviations, per case.

    Depth of anaesthesia is a trend, not a 4 s snapshot: the bedside monitor
    averages over tens of seconds, so the model gets the same memory.
    """
    idx = [names.index(k) for k in keys_to_lag]
    extra = np.zeros((X.shape[0], len(idx) * len(taus) * 2))
    for c in sorted(set(cases)):
        m = np.where(cases == c)[0]
        m = m[np.argsort(times[m])]
        for ti, tau in enumerate(taus):
            acc = None
            prev = None
            for i in m:
                v = X[i, idx]
                dt = 1.0 if prev is None else max(times[i] - prev, 1.0)
                a = 1 - np.exp(-dt / tau)
                acc = v.copy() if acc is None else acc + a * (v - acc)
                base = ti * len(idx) * 2
                extra[i, base:base + len(idx)] = acc
                extra[i, base + len(idx):base + 2 * len(idx)] = v - acc
                prev = times[i]
    new_names = []
    for tau in taus:
        new_names += [f"{k}~{int(tau)}s" for k in keys_to_lag]
        new_names += [f"{k}d{int(tau)}s" for k in keys_to_lag]
    return np.column_stack([X, extra]), names + new_names


LAG = ["betaRatio", "syncFastSlow", "sef95", "entState", "relDelta", "relBeta",
       "logTotal", "sr60", "logPtp"]
X, names = add_history(X, names, cases, times, LAG)
print(f"{X.shape[1]} model terms after adding trend memory")


def irls_l1_fit(Xtr, ytr, lam, iters=8):
    """Ridge refitted under an L1-like (Huber) loss, which is what MAE grades."""
    m = ridge_fit(Xtr, ytr, lam)
    for _ in range(iters):
        r = ytr - ridge_pred(m, Xtr)
        w = 1.0 / np.maximum(np.abs(r), 1.0)
        sw = np.sqrt(w)
        mu, sd = Xtr.mean(0), Xtr.std(0)
        sd[sd == 0] = 1
        Z = np.column_stack([np.ones(len(Xtr)), (Xtr - mu) / sd]) * sw[:, None]
        P = np.eye(Z.shape[1]) * lam
        P[0, 0] = 0
        beta = np.linalg.solve(Z.T @ Z + P, Z.T @ (ytr * sw))
        m = (beta, mu, sd)
    return m


def ridge_fit(Xtr, ytr, lam):
    mu, sd = Xtr.mean(0), Xtr.std(0)
    sd[sd == 0] = 1
    Z = (Xtr - mu) / sd
    Z = np.column_stack([np.ones(len(Z)), Z])
    P = np.eye(Z.shape[1]) * lam
    P[0, 0] = 0
    w = np.linalg.solve(Z.T @ Z + P, Z.T @ ytr)
    return (w, mu, sd)


def ridge_pred(m, Xte):
    w, mu, sd = m
    Z = (Xte - mu) / sd
    return np.column_stack([np.ones(len(Z)), Z]) @ w


def boosted_fit(Xtr, ytr, rounds=250, lr=0.08, depth=3, bins=32):
    """Tiny histogram gradient boosting — headroom probe, not a shipping model."""
    edges = [np.quantile(Xtr[:, j], np.linspace(0, 1, bins + 1)[1:-1]) for j in range(Xtr.shape[1])]
    B = np.column_stack([np.searchsorted(edges[j], Xtr[:, j]) for j in range(Xtr.shape[1])])
    pred = np.full(len(ytr), ytr.mean())
    trees = []
    for _ in range(rounds):
        g = ytr - pred
        tree = _grow(B, g, depth, bins)
        pred += lr * _apply(tree, B)
        trees.append(tree)
    return (trees, edges, ytr.mean(), lr)


def _grow(B, g, depth, bins):
    node = {"idx": np.arange(len(g))}
    return _split(B, g, node["idx"], depth, bins)


def _split(B, g, idx, depth, bins):
    if depth == 0 or len(idx) < 200:
        return {"leaf": float(g[idx].mean())}
    best = None
    gi = g[idx]
    tot, n = gi.sum(), len(gi)
    for j in range(B.shape[1]):
        bj = B[idx, j]
        cs = np.bincount(bj, weights=gi, minlength=bins + 1)
        cn = np.bincount(bj, minlength=bins + 1)
        sl, nl = np.cumsum(cs)[:-1], np.cumsum(cn)[:-1]
        sr, nr = tot - sl, n - nl
        valid = (nl > 50) & (nr > 50)
        if not valid.any():
            continue
        gain = np.where(valid, sl**2 / np.maximum(nl, 1) + sr**2 / np.maximum(nr, 1), -np.inf)
        t = int(np.argmax(gain))
        if best is None or gain[t] > best[0]:
            best = (gain[t], j, t)
    if best is None:
        return {"leaf": float(gi.mean())}
    _, j, t = best
    left = idx[B[idx, j] <= t]
    right = idx[B[idx, j] > t]
    if len(left) == 0 or len(right) == 0:
        return {"leaf": float(gi.mean())}
    return {"j": j, "t": t, "l": _split(B, g, left, depth - 1, bins),
            "r": _split(B, g, right, depth - 1, bins)}


def _apply(tree, B):
    out = np.zeros(len(B))
    stack = [(tree, np.arange(len(B)))]
    while stack:
        node, idx = stack.pop()
        if "leaf" in node:
            out[idx] = node["leaf"]
            continue
        m = B[idx, node["j"]] <= node["t"]
        stack.append((node["l"], idx[m]))
        stack.append((node["r"], idx[~m]))
    return out


def boosted_pred(model, Xte):
    trees, edges, base, lr = model
    B = np.column_stack([np.searchsorted(edges[j], Xte[:, j]) for j in range(Xte.shape[1])])
    pred = np.full(len(Xte), base)
    for tree in trees:
        pred += lr * _apply(tree, B)
    return pred


uniq = sorted(set(cases))
folds = np.array_split(np.array(uniq), min(6, len(uniq)))
t_sec = np.array([0.0] * len(y))
preds = {k: np.full(len(y), np.nan) for k in ("raw", "affine", "ridge", "l1", "boosted")}

for fi, held in enumerate(folds):
    te = np.isin(cases, held)
    tr = ~te
    if tr.sum() < 1000 or te.sum() == 0:
        continue
    preds["raw"][te] = raw[te]
    good = np.isfinite(raw[tr])
    A = np.column_stack([np.ones(good.sum()), raw[tr][good]])
    gb = np.linalg.lstsq(A, y[tr][good], rcond=None)[0]
    preds["affine"][te] = gb[0] + gb[1] * raw[te]
    m = ridge_fit(X[tr], y[tr], lam=len(names) * 2.0)
    preds["ridge"][te] = np.clip(ridge_pred(m, X[te]), 0, 100)
    ml = irls_l1_fit(X[tr], y[tr], lam=len(names) * 2.0)
    preds["l1"][te] = np.clip(ridge_pred(ml, X[te]), 0, 100)
    if BOOSTED:
        bm = boosted_fit(X[tr], y[tr])
        preds["boosted"][te] = np.clip(boosted_pred(bm, X[te]), 0, 100)
    print(f"  fold {fi + 1}/{len(folds)}: {len(held)} cases held out", flush=True)


def smooth(p, tau):
    """Trailing exponential smoother applied per case, on the case clock —
    the bedside monitor reports a smoothed trend, not a raw window estimate."""
    out = np.full(len(p), np.nan)
    for c in uniq:
        m = np.where(cases == c)[0]
        m = m[np.argsort(times[m])]
        acc = None
        prev = None
        for i in m:
            v = p[i]
            if not np.isfinite(v):
                continue
            dt = 1.0 if prev is None else max(times[i] - prev, 1.0)
            a = 1 - np.exp(-dt / tau)
            acc = v if acc is None else acc + a * (v - acc)
            out[i] = acc
            prev = times[i]
    return out


def report(name, p):
    m = np.isfinite(p) & np.isfinite(y)
    d = p[m] - y[m]
    mae = np.abs(d).mean()
    bias = d.mean()
    rmse = np.sqrt((d**2).mean())
    r = np.corrcoef(p[m], y[m])[0, 1]
    sx, sy = p[m].std(), y[m].std()
    ccc = 2 * r * sx * sy / (sx**2 + sy**2 + (p[m].mean() - y[m].mean()) ** 2)
    w5 = (np.abs(d) <= 5).mean() * 100
    w10 = (np.abs(d) <= 10).mean() * 100
    print(f"{name:10s} n={m.sum():7d} MAE {mae:6.2f}  RMSE {rmse:6.2f}  bias {bias:+6.2f} "
          f"r {r:5.3f}  CCC {ccc:5.3f}  within5 {w5:4.1f}%  within10 {w10:4.1f}%")


print("\nHeld-out (patient-level) agreement with the bedside monitor:")
for k in ("raw", "affine", "ridge", "l1") + (("boosted",) if BOOSTED else ()):
    report(k, preds[k])
for tau in (15, 30):
    report(f"ridge+{tau}s", smooth(preds["ridge"], tau))
    report(f"l1+{tau}s", smooth(preds["l1"], tau))

full = irls_l1_fit(X, y, lam=len(names) * 2.0)
w, mu, sd = full
order = np.argsort(-np.abs(w[1:]))
print("\nStrongest terms in the from-scratch linear model:")
for i in order[:15]:
    print(f"  {names[i]:20s} {w[i + 1]:+7.3f}")
np.save("/tmp/coebis-v2-weights.npy", np.array([w, np.append([0], mu), np.append([1], sd)], dtype=object), allow_pickle=True)
with open("/tmp/coebis-v2-model.json", "w") as fh:
    json.dump({"names": names, "w": list(map(float, w)), "mu": list(map(float, mu)),
               "sd": list(map(float, sd))}, fh)
print("\nwrote /tmp/coebis-v2-model.json")
