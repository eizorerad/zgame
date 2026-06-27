#!/usr/bin/env python3
"""
Forecast of tick-bite exposure in Yakutia to 2030 -- scenario approach.

DATA NOW SPANS 2000-2024 (21 reliable yearly points). The 2006-2018 block and
its per-100k values come from a peer-reviewed source (Vladimirov et al.,
Atmosphere 2021, 12, 233, using Rospotrebnadzor RS(Ya) data); 2000-2005 from
Nikiforov et al. 2015; 2021-2024 from news/Rospotrebnadzor season reports.

IMPORTANT: the series is NON-MONOTONIC. It rose to a local peak in 2016 (360),
DIPPED in 2017-2018 (340, 254), then surged again (2022: 565). Year-to-year
variation is driven by warm-season weather (the published model found
Selyaninov's hydrothermal coefficient significant). So a single smooth curve
cannot reproduce the wiggles; we forecast the TREND and give a scenario range.

Published negative-binomial model (Atmosphere 2021, Table 2; district-level,
exponentiated coefficients):
    avg annual temperature : x1.75 per +1 C   (95% CI 1.59-1.93)
    Selyaninov's HTC       : x3.42             (2.62-4.54)
    observation year       : x1.22 per year    (1.17-1.29)
We use the published year- and temperature-multipliers as an external,
literature-anchored growth estimate, alongside our own fits.

Deps: numpy, pandas; optional scipy, matplotlib.
Run: python forecast_model.py
"""
import numpy as np
import pandas as pd

CSV = "model_ready.csv"
HORIZON = 2030
WARM_RATE = 0.058           # observed central-Yakutia warming, degC/yr (Atmosphere 2021)
NB_YEAR = 1.22              # published year multiplier
NB_TEMP = 1.75             # published per-degC multiplier


def observed(df):
    o = df.dropna(subset=["tick_bites_registered"]).copy()
    o["tick_bites_registered"] = o["tick_bites_registered"].astype(float)
    return o


def loglinear(o, label):
    t = o["t_index"].to_numpy(float)
    y = np.log(o["tick_bites_registered"].to_numpy(float))
    b, a = np.polyfit(t, y, 1)
    print(f"[{label}] n={len(o)}  growth={np.exp(b)-1:+.1%}/yr  doubling={np.log(2)/b:.1f}yr")
    return (lambda tt: np.exp(a + b*np.asarray(tt, float))), a, b, t, y


def PI(a, b, t, y, t_new, level=0.80):
    n = len(t); resid = y-(a+b*t); s = np.sqrt(np.sum(resid**2)/(n-2))
    se = s*np.sqrt(1+1/n+(t_new-t.mean())**2/np.sum((t-t.mean())**2))
    try:
        from scipy.stats import t as td; crit = td.ppf(0.5+level/2, n-2)
    except ImportError:
        crit = 1.28
    return np.exp(a+b*t_new-crit*se), np.exp(a+b*t_new+crit*se)


def logistic_fixedK(o, K):
    t = o["t_index"].to_numpy(float); y = o["tick_bites_registered"].to_numpy(float)
    try:
        from scipy.optimize import curve_fit
        f = lambda tt, r, t0: K/(1+np.exp(-r*(tt-t0)))
        (r, t0), _ = curve_fit(f, t, y, p0=[0.3, 18], maxfev=20000)
        return lambda tt: K/(1+np.exp(-r*(np.asarray(tt, float)-t0)))
    except Exception as e:
        print(f"  (logistic K={K} skipped: {e})"); return None


def main():
    df = pd.read_csv(CSV)
    o = observed(df)
    o_rec = o[o["year"] >= 2015]
    last_year = int(o["year"].max()); base = float(o.iloc[-1]["tick_bites_registered"])
    print(f"Observed: {len(o)} yrs {int(o['year'].min())}-{last_year}; "
          f"last solid value {base:.0f} ({last_year})\n")

    f_all, a, b, t, y = loglinear(o, "exp ALL 2000-2024")
    f_rec, ar, br, tr, yr_ = loglinear(o_rec, "exp 2015-2024 (recent)")
    lb, la = np.polyfit(o["t_index"], o["tick_bites_registered"], 1)
    f_lin = lambda tt: la+lb*np.asarray(tt, float)
    print(f"[linear ALL] slope={lb:+.1f} bites/yr")
    f_logL = logistic_fixedK(o, 1500); f_logH = logistic_fixedK(o, 3000)

    # published NB model: combined per-year multiplier (year term x warming term)
    nb_mult = NB_YEAR * NB_TEMP**WARM_RATE
    fc = np.arange(last_year+1, HORIZON+1)
    ti = (fc-2000).astype(float)
    tab = pd.DataFrame({"year": fc})
    tab["exp_ALL"] = f_all(ti).round(0)
    tab["exp_recent"] = f_rec(ti).round(0)
    tab["linear"] = np.clip(f_lin(ti), 0, None).round(0)
    if f_logL: tab["logistic_K1500"] = f_logL(ti).round(0)
    if f_logH: tab["logistic_K3000"] = f_logH(ti).round(0)
    tab["published_NB"] = [round(base*nb_mult**(yy-last_year)) for yy in fc]

    print(f"\n[published NB] combined multiplier {nb_mult:.3f}/yr "
          f"(year {NB_YEAR} x warming {NB_TEMP}^{WARM_RATE})")
    print("\n--- Forecast scenarios (registered tick bites/yr) ---")
    print(tab.to_string(index=False))

    lo, hi = PI(ar, br, tr, yr_, HORIZON-2000)
    vals2030 = tab[tab.year == HORIZON].iloc[0]
    print(f"\n2030 SUMMARY (registered bites/yr)")
    print(f"  recent-trend central : ~{vals2030['exp_recent']:.0f} "
          f"[80% PI {lo:.0f}-{hi:.0f}]")
    print(f"  saturating scenarios : ~{vals2030.get('logistic_K1500', float('nan')):.0f}"
          f" - {vals2030.get('logistic_K3000', float('nan')):.0f}")
    print(f"  long-run exp / published-NB (upper): "
          f"~{vals2030['exp_ALL']:.0f} / ~{vals2030['published_NB']:.0f}")
    # TBE clinical cases via published incidence anchor 0.11/100k
    pop2030 = float(df[df.year == HORIZON]["population_thousands"].iloc[0])
    print(f"  implied TBE cases @0.11/100k baseline: ~{0.11/100*pop2030:.1f}/yr "
          f"(disease, not bites)")

    try:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        yrs = np.arange(2000, HORIZON+1); tt = (yrs-2000).astype(float)
        plt.figure(figsize=(10, 5.6))
        plt.scatter(o["year"], o["tick_bites_registered"], color="k", zorder=5, label="observed")
        plt.plot(yrs, f_all(tt), "r--", lw=1, label="exp ALL (upper)")
        plt.plot(yrs, f_rec(tt), "b-", lw=2, label="exp recent (central)")
        if f_logH: plt.plot(yrs, f_logH(tt), color="orange", ls=":", label="logistic K=3000")
        if f_logL: plt.plot(yrs, f_logL(tt), color="purple", ls=":", label="logistic K=1500")
        nb = [base*nb_mult**(yy-last_year) if yy >= last_year else np.nan for yy in yrs]
        plt.plot(yrs, nb, "g-.", lw=1, label="published NB (upper)")
        blo = [PI(ar, br, tr, yr_, x)[0] for x in tt]; bhi = [PI(ar, br, tr, yr_, x)[1] for x in tt]
        plt.fill_between(yrs, blo, bhi, color="b", alpha=0.12, label="central 80% PI")
        plt.axvline(last_year+0.5, color="grey", lw=0.8)
        plt.text(last_year+0.7, 60, "forecast ->", color="grey")
        plt.ylim(0, 4200); plt.xlabel("year")
        plt.ylabel("registered tick bites / year (Yakutia)")
        plt.title("Tick-bite exposure in Yakutia 2000-2024 and forecast to 2030")
        plt.legend(fontsize=8, ncol=2); plt.tight_layout()
        plt.savefig("forecast_to_2030.png", dpi=120)
        print("\nSaved plot -> forecast_to_2030.png")
    except ImportError:
        print("\n(matplotlib not installed - skipped plot)")


if __name__ == "__main__":
    main()
