#!/usr/bin/env python3
"""
Starter forecast model for tick spread / TBE exposure in Yakutia up to 2030.

Target: tick_bites_registered (republic-wide registered tick bites) - used as a
proxy for tick abundance/exposure. Confirmed TBE clinical cases are too sparse
(0-1/year) to fit a standalone time-series model, so we forecast exposure and
discuss disease risk as a small fraction of it (see README).

Two simple, low-data-appropriate models are fit (only ~10 reliable points):
  1. Exponential trend in time  (log-linear OLS)
  2. Poisson GLM with predictors: time index + modeled temperature anomaly

Then both are extrapolated to 2030 using the predictor rows already present in
model_ready.csv (is_forecast == 1).

Dependencies: pandas, numpy, statsmodels (optional matplotlib for the plot).
Run: python forecast_model.py
"""
import numpy as np
import pandas as pd

CSV = "model_ready.csv"


def load():
    df = pd.read_csv(CSV)
    return df


def fit_exponential(df):
    """log(bites) = a + b*t  ->  bites = exp(a) * exp(b*t)."""
    obs = df.dropna(subset=["tick_bites_registered"]).copy()
    # exclude the 'conflicting' year-attribution point from the fit, keep for plotting
    fit = obs[obs["target_quality"] != "conflicting"]
    x = fit["t_index"].to_numpy(float)
    y = np.log(fit["tick_bites_registered"].to_numpy(float))
    b, a = np.polyfit(x, y, 1)
    yhat = np.exp(a + b * df["t_index"].to_numpy(float))
    doubling = np.log(2) / b
    print(f"[Exponential] growth rate b = {b:.3f}/yr "
          f"(~{np.exp(b) - 1:+.1%}/yr, doubling time {doubling:.1f} yr)")
    return yhat


def fit_poisson(df):
    """Poisson GLM: bites ~ t_index + temp_anomaly_modeled_c."""
    try:
        import statsmodels.api as sm
    except ImportError:
        print("[Poisson] statsmodels not installed - skipping")
        return None
    obs = df.dropna(subset=["tick_bites_registered"]).copy()
    fit = obs[obs["target_quality"] != "conflicting"]
    X = sm.add_constant(fit[["t_index", "temp_anomaly_modeled_c"]].astype(float))
    model = sm.GLM(fit["tick_bites_registered"].astype(float), X,
                   family=sm.families.Poisson()).fit()
    Xall = sm.add_constant(df[["t_index", "temp_anomaly_modeled_c"]].astype(float),
                           has_constant="add")
    print("\n[Poisson GLM] coefficients:")
    print(model.params.to_string())
    return model.predict(Xall)


def main():
    df = load()
    df["exp_pred"] = fit_exponential(df)
    poi = fit_poisson(df)
    if poi is not None:
        df["poisson_pred"] = poi

    cols = ["year", "tick_bites_registered", "exp_pred"]
    if "poisson_pred" in df:
        cols.append("poisson_pred")
    out = df[df["year"] >= 2021][cols].round(0)
    print("\n--- Observed vs forecast (2021-2030) ---")
    print(out.to_string(index=False))

    horizon = df[df["year"] == 2030].iloc[0]
    print(f"\n2030 forecast (exponential): "
          f"~{horizon['exp_pred']:.0f} registered bites/year")
    if "poisson_pred" in df:
        print(f"2030 forecast (Poisson+temp): "
              f"~{horizon['poisson_pred']:.0f} registered bites/year")

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.figure(figsize=(9, 5))
        obs = df.dropna(subset=["tick_bites_registered"])
        plt.scatter(obs["year"], obs["tick_bites_registered"],
                    color="k", zorder=3, label="observed bites")
        plt.plot(df["year"], df["exp_pred"], "--", label="exponential trend")
        if "poisson_pred" in df:
            plt.plot(df["year"], df["poisson_pred"], "-.",
                     label="Poisson (time+temp)")
        plt.axvline(2025.5, color="grey", lw=0.8)
        plt.text(2025.7, plt.ylim()[1] * 0.9, "forecast ->", color="grey")
        plt.xlabel("year"); plt.ylabel("registered tick bites / year (Yakutia)")
        plt.title("Tick-bite exposure in Yakutia: history and forecast to 2030")
        plt.legend(); plt.tight_layout()
        plt.savefig("forecast_to_2030.png", dpi=120)
        print("\nSaved plot -> forecast_to_2030.png")
    except ImportError:
        print("\n(matplotlib not installed - skipped plot)")


if __name__ == "__main__":
    main()
