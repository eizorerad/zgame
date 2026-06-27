#!/usr/bin/env python3
"""
Forecast of tick-bite exposure in Yakutia to 2030.

WHAT THIS VERSION FIXES
-----------------------
1. Count model: primary fit is now NEGATIVE BINOMIAL (counts are over-dispersed;
   OLS-on-log / Poisson give wrong intervals). Matches Vladimirov et al. 2021.
2. Trustworthy points only: fits use rows with season_complete==1 (full-year
   totals). Derived 2021 and mid-season 2023/2024 are EXCLUDED from fitting and
   only shown on the plot (hollow markers), because a sensitivity check showed
   the 2030 estimate swings ~835-1400 depending on how those 3 points are treated.
3. Climate-ready: if column mean_annual_temp_C is filled for enough complete
   years, the script ALSO fits a climate model (counts ~ year + annual temp) and
   forecasts under a warming scenario. Until then it says so and uses the trend.
4. Disease (TBE) is NOT forecast as its own time series (~1 case/yr, 0.11/100k).
   It is derived from exposure x infection-rate, reported as a small range.

Published model anchor (Vladimirov 2021, Table 2): annual temp x1.75/degC,
Selyaninov HTC x3.42, year x1.22.

Deps: numpy, pandas, statsmodels; optional scipy, matplotlib.
Run: python forecast_model.py
"""
import numpy as np
import pandas as pd
import warnings
warnings.filterwarnings("ignore")

CSV = "model_ready.csv"
HORIZON = 2030
WARM_RATE = 0.058          # observed central-Yakutia warming degC/yr (Vladimirov 2021)
NB_YEAR, NB_TEMP = 1.22, 1.75
TBE_RATE_PER_100K = 0.11   # observed Yakutia TBE incidence 2015-2024 (Nikitin/Andaev)
INFECTED_TICK_FRAC = (0.057, 0.098)   # observed 2013, 2014 (Nikiforov 2015)


def nb_predict(y, X, Xnew, level=0.80):
    """Negative-binomial GLM fit; returns (mean, lo, hi) for Xnew with delta-method CI.
    Falls back to Poisson, then log-OLS, if NB does not converge."""
    import statsmodels.api as sm
    from scipy.stats import norm
    z = norm.ppf(0.5 + level/2)
    try:
        res = sm.NegativeBinomial(y, X).fit(disp=0, maxiter=200)
        names = list(X.columns)
        beta = res.params[names].values
        cov = res.cov_params().loc[names, names].values
        method = f"Negative Binomial (alpha={np.exp(res.params.get('alpha', np.nan)):.2f})"
    except Exception:
        try:
            res = sm.GLM(y, X, family=sm.families.Poisson()).fit()
            beta, cov = res.params.values, res.cov_params().values
            method = "Poisson (NB failed)"
        except Exception:
            b, a = np.polyfit(X["t_index"], np.log(y), 1)
            pred = np.exp(a + b*Xnew["t_index"].values)
            return pred, pred*np.nan, pred*np.nan, "log-OLS (GLM failed)"
    lin = Xnew.values @ beta
    se = np.sqrt(np.einsum("ij,jk,ik->i", Xnew.values, cov, Xnew.values))
    return np.exp(lin), np.exp(lin-z*se), np.exp(lin+z*se), method


def main():
    df = pd.read_csv(CSV)
    obs = df.dropna(subset=["tick_bites_registered"]).copy()
    obs["tick_bites_registered"] = obs["tick_bites_registered"].astype(float)
    fit = obs[obs["season_complete"] == 1].copy()       # trustworthy points only
    excluded = obs[obs["season_complete"] != 1]
    print(f"Fit on {len(fit)} complete-season points "
          f"({int(fit.year.min())}-{int(fit.year.max())}); "
          f"excluded (derived/partial): {sorted(excluded.year.astype(int))}\n")

    fc = np.arange(int(obs.year.max())+1, HORIZON+1)
    import statsmodels.api as sm

    # ---- (1) two legitimate regimes: long-run (all) vs recent decade ----
    # The series spans an early COLONIZATION boom (2000-2010) then slower
    # established growth. Long-run fit ~ +20%/yr; recent fit ~ +13%/yr. We show
    # BOTH as an honest bracket instead of pretending one is "the" answer.
    Xnew = sm.add_constant(pd.DataFrame({"t_index": fc-2000}), has_constant="add")
    Xc = sm.add_constant(fit[["t_index"]])
    mean, lo, hi, method = nb_predict(fit["tick_bites_registered"], Xc, Xnew)
    rec = fit[fit.year >= 2015]
    Xcr = sm.add_constant(rec[["t_index"]])
    rmean, rlo, rhi, rmethod = nb_predict(rec["tick_bites_registered"], Xcr, Xnew)
    print(f"[long-run 2000-2022] {method}")
    print(f"[recent 2015-2022 ]  {rmethod}  (n={len(rec)})")
    out = pd.DataFrame({"year": fc,
                        "longrun_mean": mean.round(0), "lr_lo80": lo.round(0), "lr_hi80": hi.round(0),
                        "recent_mean": rmean.round(0), "rec_lo80": rlo.round(0), "rec_hi80": rhi.round(0)})

    # ---- (2) climate model: bites ~ year + annual temp (only if data available) ----
    clim = fit.dropna(subset=["mean_annual_temp_C"])
    if len(clim) >= 6:
        Xc2 = sm.add_constant(clim[["t_index", "mean_annual_temp_C"]].astype(float))
        last_t = obs["mean_annual_temp_C"].dropna()
        t0 = float(last_t.iloc[-1]) if len(last_t) else -7.0
        temp_fc = t0 + WARM_RATE*(fc - int(obs.year.max()))
        Xn2 = sm.add_constant(pd.DataFrame({"t_index": fc-2000,
                                            "mean_annual_temp_C": temp_fc}), has_constant="add")
        cmean, clo, chi, cmethod = nb_predict(clim["tick_bites_registered"], Xc2, Xn2)
        out["climate_mean"] = cmean.round(0)
        print(f"[climate model] {cmethod} on {len(clim)} yrs with observed temp")
    else:
        out["climate_mean"] = np.nan
        print(f"[climate model] SKIPPED - only {len(clim)} complete years have "
              f"mean_annual_temp_C. Fill that column to activate the climate model.")

    # ---- (3) literature anchor: published NB multiplier from last solid point ----
    base_row = fit.iloc[-1]
    base, by = float(base_row["tick_bites_registered"]), int(base_row["year"])
    nb_mult = NB_YEAR * NB_TEMP**WARM_RATE
    out["published_NB"] = [round(base*nb_mult**(y-by)) for y in fc]

    print("\n--- Forecast (registered tick bites/yr) ---")
    print(out.to_string(index=False))

    r30 = out[out.year == HORIZON].iloc[0]
    print(f"\n2030 SUMMARY (registered tick bites/yr)")
    print(f"  recent-decade NB  : ~{r30['recent_mean']:.0f}  [80% {r30['rec_lo80']:.0f}-{r30['rec_hi80']:.0f}]  (lower/plausible)")
    print(f"  long-run NB       : ~{r30['longrun_mean']:.0f}  [80% {r30['lr_lo80']:.0f}-{r30['lr_hi80']:.0f}]  (upper)")
    if not np.isnan(r30['climate_mean']):
        print(f"  climate NB        : ~{r30['climate_mean']:.0f}")
    print(f"  published-NB anchor: ~{r30['published_NB']:.0f}")
    print(f"  => plausible band ~{r30['recent_mean']:.0f}-{r30['longrun_mean']:.0f}, "
          f"wide interval ~{r30['rec_lo80']:.0f}-{r30['lr_hi80']:.0f}")
    pop30 = float(df[df.year == HORIZON]["population_thousands"].iloc[0])
    print(f"\n  Disease (TBE), NOT a fitted series:")
    print(f"    empirical baseline 0.11/100k -> ~{TBE_RATE_PER_100K/100*pop30:.1f} cases/yr")
    print(f"    if scaling with exposure: ~{TBE_RATE_PER_100K/100*pop30*r30['recent_mean']/base:.1f}"
          f"-{TBE_RATE_PER_100K/100*pop30*r30['longrun_mean']/base:.1f} cases/yr (order of magnitude)")

    try:
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        yrs = np.arange(2000, HORIZON+1)
        Xall = sm.add_constant(pd.DataFrame({"t_index": yrs-2000}), has_constant="add")
        m_all, l_all, h_all, _ = nb_predict(fit["tick_bites_registered"], Xc, Xall)
        m_rec, l_rec, h_rec, _ = nb_predict(rec["tick_bites_registered"], Xcr, Xall)
        plt.figure(figsize=(10, 5.6))
        plt.scatter(fit.year, fit.tick_bites_registered, color="k", zorder=5, label="fit points (complete season)")
        plt.scatter(excluded.year, excluded.tick_bites_registered, facecolors="none",
                    edgecolors="grey", zorder=5, label="excluded (derived/partial)")
        plt.plot(yrs, m_all, "b-", lw=2, label="long-run NB (upper)")
        plt.fill_between(yrs, l_all, h_all, color="b", alpha=0.10, label="long-run 80%")
        plt.plot(yrs, m_rec, color="teal", ls="-", lw=2, label="recent-decade NB (lower)")
        nb = [base*nb_mult**(y-by) if y >= by else np.nan for y in yrs]
        plt.plot(yrs, nb, "g-.", lw=1, label="published-NB anchor (upper)")
        plt.axvline(int(obs.year.max())+0.5, color="grey", lw=0.8)
        plt.text(int(obs.year.max())+0.7, 60, "forecast ->", color="grey")
        plt.ylim(0, 3200); plt.xlabel("year")
        plt.ylabel("registered tick bites / year (Yakutia)")
        plt.title("Tick-bite exposure in Yakutia: negative-binomial forecast to 2030")
        plt.legend(fontsize=8); plt.tight_layout()
        plt.savefig("forecast_to_2030.png", dpi=120)
        print("\nSaved plot -> forecast_to_2030.png")
    except ImportError:
        print("\n(matplotlib not installed - skipped plot)")


if __name__ == "__main__":
    main()
