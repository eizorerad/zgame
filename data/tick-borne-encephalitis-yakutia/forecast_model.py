#!/usr/bin/env python3
"""
Forecast of tick-bite exposure in Yakutia to 2030 -- scenario approach.

WHY SCENARIOS, NOT ONE MODEL
----------------------------
We have only ~8 reliable yearly points, a metric that mixes seasons, and one
disputed year. A single point forecast would be false precision. The dominant
question is which growth REGIME continues:

  * 2001->2010 was an explosive COLONIZATION phase (2 -> 109 bites). Fitting an
    exponential across that spike gives ~+26%/yr and ~4800 bites by 2030. This
    almost certainly OVERSTATES the future: tick populations saturate (limited
    suitable habitat and human exposure), and recent years already show the
    growth decelerating (2022->2023 was nearly flat).
  * 2015 onward reflects an ESTABLISHED population. Its growth is ~13%/yr, which
    lands near ~1500 by 2030.

So we report a bracket and recommend the established-growth / saturating range,
not the colonization extrapolation.

NOTE ON TEMPERATURE: model_ready.csv's temp_anomaly_modeled_c is a deterministic
linear function of time (0.06*t_index), so it is perfectly collinear with the
time trend and CANNOT be used as an independent predictor. A real temperature
EFFECT needs an observed year-by-year station series (see README "what to add").

Deps: numpy, pandas; optional scipy (logistic + intervals), matplotlib (plot).
Run: python forecast_model.py
"""
import numpy as np
import pandas as pd

CSV = "model_ready.csv"
HORIZON = 2030
FORECAST_YEARS = np.arange(2025, HORIZON + 1)


def observed(df):
    o = df.dropna(subset=["tick_bites_registered"]).copy()
    o["tick_bites_registered"] = o["tick_bites_registered"].astype(float)
    return o


def loglinear(o, label):
    """Fit log(y)=a+b*t. Return (predict_fn, b)."""
    t = o["t_index"].to_numpy(float)
    y = np.log(o["tick_bites_registered"].to_numpy(float))
    b, a = np.polyfit(t, y, 1)
    cagr = np.exp(b) - 1
    print(f"[{label}] n={len(o)}  growth={cagr:+.1%}/yr  doubling={np.log(2)/b:.1f}yr")
    return (lambda tt: np.exp(a + b * np.asarray(tt, float))), a, b, t, y


def loglinear_PI(a, b, t, y, t_new, level=0.80):
    """80% prediction interval for a new point on the log-linear fit."""
    n = len(t)
    resid = y - (a + b * t)
    s = np.sqrt(np.sum(resid**2) / (n - 2))
    tbar, Sxx = t.mean(), np.sum((t - t.mean())**2)
    se = s * np.sqrt(1 + 1/n + (t_new - tbar)**2 / Sxx)
    try:
        from scipy.stats import t as tdist
        crit = tdist.ppf(0.5 + level/2, n - 2)
    except ImportError:
        crit = 1.28  # ~80% normal approx
    center = a + b * t_new
    return np.exp(center - crit*se), np.exp(center + crit*se)


def logistic_fixedK(o, K):
    """y = K/(1+exp(-r*(t-t0))) with K FIXED (a scenario ceiling assumption)."""
    t = o["t_index"].to_numpy(float)
    y = o["tick_bites_registered"].to_numpy(float)
    try:
        from scipy.optimize import curve_fit
        f = lambda tt, r, t0: K / (1 + np.exp(-r * (tt - t0)))
        (r, t0), _ = curve_fit(f, t, y, p0=[0.3, 20], maxfev=10000)
        return lambda tt: K / (1 + np.exp(-r * (np.asarray(tt, float) - t0)))
    except Exception as e:
        print(f"  (logistic K={K} skipped: {e})")
        return None


def main():
    df = pd.read_csv(CSV)
    o_all = observed(df)                       # 2001..2024 (incl disputed 2024)
    o_rec = o_all[o_all["year"] >= 2015]       # established-population era

    print("Observed points used:")
    print(o_all[["year", "tick_bites_registered", "target_quality"]]
          .to_string(index=False), "\n")

    f_all, *_ = loglinear(o_all, "exp ALL (colonization extrapolated - UPPER)")
    f_rec, a, b, t, y = loglinear(o_rec, "exp 2015+ (established growth - CENTRAL)")

    # linear trend on recent data
    lb, la = np.polyfit(o_rec["t_index"], o_rec["tick_bites_registered"], 1)
    f_lin = lambda tt: la + lb * np.asarray(tt, float)
    print(f"[linear 2015+] slope={lb:+.0f} bites/yr")

    f_logL = logistic_fixedK(o_all, 1500)
    f_logH = logistic_fixedK(o_all, 3000)

    ti = (FORECAST_YEARS - 2000).astype(float)
    table = pd.DataFrame({"year": FORECAST_YEARS})
    table["exp_ALL_upper"] = f_all(ti).round(0)
    table["exp_2015+_central"] = f_rec(ti).round(0)
    table["linear_2015+"] = f_lin(ti).round(0)
    if f_logL: table["logistic_K1500"] = f_logL(ti).round(0)
    if f_logH: table["logistic_K3000"] = f_logH(ti).round(0)
    lo, hi = loglinear_PI(a, b, t, y, 30.0)
    print("\n--- Forecast scenarios ---")
    print(table.to_string(index=False))

    c = f_rec(30.0)
    print(f"\n2030 SUMMARY")
    print(f"  Central (established exp 2015+): ~{c:.0f} bites/yr "
          f"[80% PI {lo:.0f}-{hi:.0f}]")
    print(f"  Plausible range across scenarios: "
          f"~{min(f_lin(30.0), (f_logL(30.0) if f_logL else c)):.0f}"
          f" - ~{f_logH(30.0) if f_logH else c:.0f} bites/yr")
    print(f"  Upper/unlikely (colonization extrapolated): ~{f_all(30.0):.0f} bites/yr")

    try:
        import matplotlib; matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        yrs = np.arange(2001, HORIZON + 1); tt = (yrs - 2000).astype(float)
        plt.figure(figsize=(9.5, 5.5))
        plt.scatter(o_all["year"], o_all["tick_bites_registered"], color="k",
                    zorder=5, label="observed bites")
        plt.plot(yrs, f_all(tt), "r--", lw=1, label="exp ALL (upper, unlikely)")
        plt.plot(yrs, f_rec(tt), "b-", lw=2, label="exp 2015+ (central)")
        plt.plot(yrs, f_lin(tt), "g-.", lw=1, label="linear 2015+")
        if f_logL: plt.plot(yrs, f_logL(tt), color="purple", ls=":", label="logistic K=1500")
        if f_logH: plt.plot(yrs, f_logH(tt), color="orange", ls=":", label="logistic K=3000")
        # 80% PI band around central
        band_lo = [loglinear_PI(a, b, t, y, x)[0] for x in tt]
        band_hi = [loglinear_PI(a, b, t, y, x)[1] for x in tt]
        plt.fill_between(yrs, band_lo, band_hi, color="b", alpha=0.12,
                         label="central 80% PI")
        plt.axvline(2024.5, color="grey", lw=0.8); plt.text(2024.7, 50, "forecast ->", color="grey")
        plt.ylim(0, 5200); plt.xlabel("year")
        plt.ylabel("registered tick bites / year (Yakutia)")
        plt.title("Tick-bite exposure in Yakutia: scenarios to 2030")
        plt.legend(fontsize=8); plt.tight_layout()
        plt.savefig("forecast_to_2030.png", dpi=120)
        print("\nSaved plot -> forecast_to_2030.png")
    except ImportError:
        print("\n(matplotlib not installed - skipped plot)")


if __name__ == "__main__":
    main()
