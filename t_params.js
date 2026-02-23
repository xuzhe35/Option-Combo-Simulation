// Pre-seeded with values from SPX data 2012-2022 (Week1_fitting.ipynb).
// Run `python spx_fit.py` to regenerate with the latest 10 years of SPX data.
//
// Student-t MLE fit to daily log-returns:
//   df    = 2.49482797   (degrees of freedom; controls tail fatness)
//   loc   = 0.00088215  (daily drift; ~0.2223 annualised)
//   scale = 0.00582130  (scale param — NOT the daily std)
//
// Daily std of this t-distribution = scale * sqrt(df/(df-2)) = ~0.01309
//   → ~20.8% annualised vol
//
// When simulating with a target portfolio IV, prob_charts.js recalculates
// the scale so the distribution's std = IV/sqrt(252), while keeping df
// fixed (preserving the historically-fitted tail shape).
const T_DIST_PARAMS = {
    df:    2.49482797,
    loc:   0.00088215,
    scale: 0.00582130
};
