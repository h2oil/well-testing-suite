// =============================================================================
// PRiSM — Pressure Reservoir Inversion & Simulation Model
// Layer 01 — Foundation
// -----------------------------------------------------------------------------
// This file is the first in a multi-part build for the PRiSM advanced Well
// Test Analysis module. It is designed to be pasted INSIDE the existing
// well-testing-app.html main IIFE. It assumes the following helpers are
// already in scope:
//
//   $(id)             — getElementById shorthand
//   el(tag, cls, html) — element factory
//   fmt(n, dp)        — number formatter (locale, fixed dp)
//   loadInputs(key, ids), saveInputs(key, ids) — localStorage I/O
//
// Contents (in file order):
//   1. Stehfest Laplace inversion engine + precomputed weight tables
//   2. Math utilities — Bessel K0/K1, Exponential Integral, logspace
//   3. Model #1 — Homogeneous reservoir (vertical well + WBS + skin)
//      with pd and Bourdet derivative (S < 0 via effective wellbore radius)
//   4. renderPRiSM() — five-step workflow shell (header, step bar,
//      workspace, results rail) over the seven tab hosts; tab-panel and
//      tab-hook registries; PRiSM_renderTab(n)
//   5. Dataset — demo sample + well metadata, commit/restore, basic Data
//      tab (fallback for 07), parser, multi-rate editor
//   6. SELF-TEST block at the very bottom
//
// All public symbols are PRiSM_* / window.PRiSM to avoid collisions with the
// existing app namespace.
// =============================================================================


// =============================================================================
// SECTION 1 — STEHFEST LAPLACE INVERSION
// =============================================================================
// Numerical inversion of Laplace transforms via Stehfest's algorithm.
//
//   f(t) ≈ (ln 2 / t) · Σ_{i=1..N} V_i · F̂( i·ln 2 / t )
//
// where the V_i (the "Stehfest weights") are
//
//   V_i = (-1)^(i + N/2) · Σ_{k=⌊(i+1)/2⌋}^{min(i, N/2)}
//             k^(N/2) · (2k)!  /
//             [ (N/2 - k)! · k! · (k - 1)! · (i - k)! · (2k - i)! ]
//
// N MUST be even. Larger N → more accuracy but more cancellation noise from
// alternating signs; the textbook sweet-spot for double precision is N = 12.
// We provide pre-computed tables for N ∈ {8, 12, 14, 16}.
//
// Reference: Stehfest, H. (1970). "Numerical Inversion of Laplace Transforms",
// Comm. ACM 13(1), 47–49 (and erratum 13(10), 624).
// =============================================================================

// Factorial helper (small N — direct loop, no recursion). Returns Number, not
// BigInt; for N ≤ 16 every intermediate fits comfortably in double precision.
const PRiSM_factorial = (function() {
    const cache = [1];
    return function(n) {
        if (n < 0) throw new Error('PRiSM_factorial: n must be ≥ 0');
        for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] * i;
        return cache[n];
    };
})();

// Compute one Stehfest weight V_i for a given even N.
function PRiSM_stehfestWeight(i, N) {
    const N2 = N / 2;
    const kMin = Math.floor((i + 1) / 2);
    const kMax = Math.min(i, N2);
    let sum = 0;
    for (let k = kMin; k <= kMax; k++) {
        const num = Math.pow(k, N2) * PRiSM_factorial(2 * k);
        const den = PRiSM_factorial(N2 - k) *
                    PRiSM_factorial(k) *
                    PRiSM_factorial(k - 1) *
                    PRiSM_factorial(i - k) *
                    PRiSM_factorial(2 * k - i);
        sum += num / den;
    }
    return ((i + N2) % 2 === 0 ? 1 : -1) * sum;
}

// Pre-computed weight tables. Built once at load time. Keys are the even N
// values; each entry is a length-N array of weights V_1 .. V_N (1-indexed in
// the formula, 0-indexed in the array).
const PRiSM_STEHFEST_W = (function() {
    const tbl = {};
    [8, 12, 14, 16].forEach(N => {
        const arr = new Array(N);
        for (let i = 1; i <= N; i++) arr[i - 1] = PRiSM_stehfestWeight(i, N);
        tbl[N] = arr;
    });
    return tbl;
})();

// Public inverter. Given F̂(s) and a real time t > 0, return f(t).
//   Fhat — function (s: number) -> number, the Laplace-domain function
//   t    — real time, > 0
//   N    — even number of terms; default 12. Must be in PRiSM_STEHFEST_W or
//          the function falls back to computing weights on the fly (slow).
function PRiSM_stehfest(Fhat, t, N) {
    if (typeof Fhat !== 'function') throw new Error('PRiSM_stehfest: Fhat must be a function');
    if (!isFinite(t) || t <= 0) throw new Error('PRiSM_stehfest: t must be > 0 (got ' + t + ')');
    N = (N == null) ? 12 : (N | 0);
    if (N <= 0 || (N % 2) !== 0) throw new Error('PRiSM_stehfest: N must be a positive even integer (got ' + N + ')');

    let weights = PRiSM_STEHFEST_W[N];
    if (!weights) {
        weights = new Array(N);
        for (let i = 1; i <= N; i++) weights[i - 1] = PRiSM_stehfestWeight(i, N);
    }

    const ln2_t = Math.LN2 / t;
    let acc = 0;
    for (let i = 1; i <= N; i++) {
        acc += weights[i - 1] * Fhat(i * ln2_t);
    }
    return ln2_t * acc;
}


// =============================================================================
// SECTION 2 — MATH UTILITIES (Bessel, Ei, logspace)
// =============================================================================
// Polynomial approximations from Abramowitz & Stegun, Handbook of Mathematical
// Functions, 1972 reprint. Accuracy is ~1e-7 absolute, plenty for type-curve
// generation where the eyeball / data noise dominate. If we ever need more,
// these can be swapped for higher-order Chebyshev expansions without changing
// the API.
// =============================================================================

// ── Bessel I0(x) — needed inside the K0 / K1 large-x expansions ──
// A&S 9.8.1 / 9.8.2.
function PRiSM_besselI0(x) {
    const ax = Math.abs(x);
    if (ax < 3.75) {
        const y = (x / 3.75); const y2 = y * y;
        return 1.0 + y2 * (3.5156229 + y2 * (3.0899424 + y2 * (1.2067492 +
               y2 * (0.2659732 + y2 * (0.0360768 + y2 * 0.0045813)))));
    }
    const y = 3.75 / ax;
    return (Math.exp(ax) / Math.sqrt(ax)) * (0.39894228 + y * (0.01328592 +
           y * (0.00225319 + y * (-0.00157565 + y * (0.00916281 +
           y * (-0.02057706 + y * (0.02635537 + y * (-0.01647633 +
           y * 0.00392377))))))));
}

// ── Bessel I1(x) — needed inside the K1 large-x expansion ──
// A&S 9.8.3 / 9.8.4.
function PRiSM_besselI1(x) {
    const ax = Math.abs(x);
    let result;
    if (ax < 3.75) {
        const y = (x / 3.75); const y2 = y * y;
        result = ax * (0.5 + y2 * (0.87890594 + y2 * (0.51498869 +
                 y2 * (0.15084934 + y2 * (0.02658733 + y2 * (0.00301532 +
                 y2 * 0.00032411))))));
    } else {
        const y = 3.75 / ax;
        result = 0.39894228 + y * (-0.03988024 + y * (-0.00362018 +
                 y * (0.00163801 + y * (-0.01031555 + y * (0.02282967 +
                 y * (-0.02895312 + y * (0.01787654 + y * -0.00420059)))))));
        result *= (Math.exp(ax) / Math.sqrt(ax));
    }
    return x < 0 ? -result : result;
}

// ── Modified Bessel function of the 2nd kind, order 0 ──
// A&S 9.8.5 (small x) / 9.8.6 (large x). Domain: x > 0.
function PRiSM_besselK0(x) {
    if (!(x > 0) || !isFinite(x)) throw new Error('PRiSM_besselK0: x must be > 0 and finite (got ' + x + ')');
    if (x <= 2.0) {
        const y = x * x / 4.0;
        return (-Math.log(x / 2.0) * PRiSM_besselI0(x)) +
               (-0.57721566 + y * (0.42278420 + y * (0.23069756 +
                y * (0.03488590 + y * (0.00262698 + y * (0.00010750 +
                y * 0.00000740))))));
    }
    const y = 2.0 / x;
    return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + y * (-0.07832358 +
           y * (0.02189568 + y * (-0.01062446 + y * (0.00587872 +
           y * (-0.00251540 + y * 0.00053208))))));
}

// ── Modified Bessel function of the 2nd kind, order 1 ──
// A&S 9.8.7 (small x) / 9.8.8 (large x). Domain: x > 0.
function PRiSM_besselK1(x) {
    if (!(x > 0) || !isFinite(x)) throw new Error('PRiSM_besselK1: x must be > 0 and finite (got ' + x + ')');
    if (x <= 2.0) {
        const y = x * x / 4.0;
        return (Math.log(x / 2.0) * PRiSM_besselI1(x)) +
               (1.0 / x) * (1.0 + y * (0.15443144 + y * (-0.67278579 +
                y * (-0.18156897 + y * (-0.01919402 + y * (-0.00110404 +
                y * -0.00004686))))));
    }
    const y = 2.0 / x;
    return (Math.exp(-x) / Math.sqrt(x)) * (1.25331414 + y * (0.23498619 +
           y * (-0.03655620 + y * (0.01504268 + y * (-0.00780353 +
           y * (0.00325614 + y * -0.00068245))))));
}

// ── Exponential integral E1(x) and convenience Ei(x) form ──
// E1(x) = ∫_x^∞ e^{-t}/t dt for x > 0. We expose two related routines:
//
//   PRiSM_E1(x)  — true E1(x), x > 0
//   PRiSM_Ei(x)  — petroleum-engineering convention. For Theis-style line-
//                  source solutions we want the well function W(u)=E1(u);
//                  PE textbooks often write this as Ei(u) where u>0. For
//                  callers using the strict mathematical convention with
//                  negative arguments we return -E1(-x) so the standard
//                  identity  Ei(x<0) = -E1(-x)  is honoured. Ei(0) = -∞.
//
// Implementation: A&S 5.1.53 (rational polynomial) for 0 < x ≤ 1 and the
// Cody-Thacher continued-fraction expansion for x > 1.

function PRiSM_E1(x) {
    if (!(x > 0) || !isFinite(x)) throw new Error('PRiSM_E1: x must be > 0 and finite (got ' + x + ')');
    if (x <= 1.0) {
        // A&S 5.1.53: -ln(x) - γ + Σ ((-1)^(n+1) x^n / (n·n!)). Series
        // converges fast for x ≤ 1.
        let sum = 0;
        let term = 1;
        for (let n = 1; n <= 50; n++) {
            term *= -x / n;
            const add = -term / n;
            sum += add;
            if (Math.abs(add) < 1e-15 * Math.abs(sum)) break;
        }
        return -Math.log(x) - 0.5772156649015329 + sum;
    }
    // Continued fraction (Lentz's method). Converges for x > 1.
    const TINY = 1e-300;
    let b = x + 1.0;
    let c = 1.0 / TINY;
    let d = 1.0 / b;
    let h = d;
    for (let i = 1; i <= 100; i++) {
        const a = -i * i;
        b += 2.0;
        d = 1.0 / (a * d + b); if (d === 0) d = TINY;
        c = b + a / c;          if (c === 0) c = TINY;
        const delta = c * d;
        h *= delta;
        if (Math.abs(delta - 1.0) < 1e-12) break;
    }
    return h * Math.exp(-x);
}

// For decline-curve / Theis-style usage. Supports both the petroleum-eng
// convention (Ei(x>0) = E1(x), well function W(u)) and the strict math
// convention (Ei(x<0) = -E1(-x)). Ei(0) = -∞.
function PRiSM_Ei(x) {
    if (!isFinite(x)) return NaN;
    if (x > 0) return PRiSM_E1(x);          // pet-eng: Ei(x>0) = E1(x)
    if (x < 0) return -PRiSM_E1(-x);        // math:    Ei(x<0) = -E1(-x)
    return -Infinity;                        //          Ei(0)   = -∞
}

// Expose foundation versions on window so downstream modules (e.g.
// 09-interference-multilateral) can drop their local _localE1 workarounds.
if (typeof window !== 'undefined') {
    if (typeof window.PRiSM_E1 !== 'function') window.PRiSM_E1 = PRiSM_E1;
    if (typeof window.PRiSM_Ei !== 'function') window.PRiSM_Ei = PRiSM_Ei;
}

// ── logspace ──
// Returns n logarithmically spaced points from 10^min to 10^max (inclusive).
// Mirrors numpy.logspace. n must be ≥ 2.
function PRiSM_logspace(min, max, n) {
    if (!(n >= 2)) throw new Error('PRiSM_logspace: n must be ≥ 2');
    if (min >= max) throw new Error('PRiSM_logspace: min must be < max');
    const out = new Array(n);
    const step = (max - min) / (n - 1);
    for (let i = 0; i < n; i++) out[i] = Math.pow(10, min + i * step);
    return out;
}


// =============================================================================
// SECTION 3 — MODEL #1 — HOMOGENEOUS RESERVOIR (vertical well + WBS + skin)
// =============================================================================
// Vertical well in an infinite-acting homogeneous reservoir, with wellbore
// storage (Cd) and a constant skin (S). Closed-form Laplace-domain pressure
// solution (Mavor & Cinco-Ley, SPE 7977; see also Bourdet 2002 §3.2):
//
//   Numerator   = K0(√s) + S · √s · K1(√s)              ← line-source + skin
//   Denominator = √s · K1(√s) + Cd · s · Numerator      ← WBS coupling
//   P̂_wd(s)    = Numerator / [ s · Denominator ]
//
// Inverted with Stehfest to get pwd(td). The Bourdet derivative
//
//   pwd' = td · d(pwd) / d(ln td)
//
// has the well-known shape: unit-slope WBS hump → maximum → flat ½-line at
// the radial-flow value of 0.5 (in dimensionless units).
//
// Inputs are dimensionless (td, Cd, S). Real-world conversion (k, h, μ, ct,
// φ, rw) lives in the parameter layer that calls this function.
// =============================================================================

/**
 * Forward pwd(td) for the homogeneous reservoir model.
 *
 * @param {number|number[]} td  Dimensionless time. Scalar or array.
 * @param {{Cd:number, S:number}} params Dimensionless wellbore-storage and skin.
 * @returns {number|number[]} pwd at each td.
 */
function PRiSM_model_homogeneous(td, params) {
    PRiSM_validateHomogeneousParams(params);
    const Cd = params.Cd, S = params.S;
    const N = (params.N != null) ? params.N : 12;

    // Negative skin (stimulated well): evaluate through the effective
    // wellbore radius instead of putting S < 0 into the Laplace fold, where
    // it creates a pole. See PRiSM_homogeneousNegSkin below.
    if (S < 0) return PRiSM_homogeneousNegSkin(td, Cd, S, N, false);

    // Closed-form Laplace-domain pwd. s is the Laplace variable.
    const Phat = function(s) {
        const sqs = Math.sqrt(s);
        const k0 = PRiSM_besselK0(sqs);
        const k1 = PRiSM_besselK1(sqs);
        const num = k0 + S * sqs * k1;
        const denom = sqs * k1 + Cd * s * num;
        return num / (s * denom);
    };

    if (Array.isArray(td)) {
        return td.map(t => PRiSM_stehfest(Phat, t, N));
    }
    if (!(td > 0) || !isFinite(td)) throw new Error('PRiSM_model_homogeneous: td must be > 0 (got ' + td + ')');
    return PRiSM_stehfest(Phat, td, N);
}

/**
 * Bourdet derivative pwd' = td · d(pwd)/d(ln td) for the homogeneous model.
 *
 * Because we have the closed-form Laplace solution we can evaluate pwd' by
 * inverting s · P̂(s) (the Laplace identity for d/dt) and then multiplying by
 * td. This avoids numerical differentiation in the time domain and gives a
 * smooth Bourdet curve at any td.
 *
 * @param {number|number[]} td
 * @param {{Cd:number, S:number}} params
 * @returns {number|number[]}
 */
function PRiSM_model_homogeneous_pd_prime(td, params) {
    PRiSM_validateHomogeneousParams(params);
    const Cd = params.Cd, S = params.S;
    const N = (params.N != null) ? params.N : 12;

    // Negative skin: same effective-wellbore-radius route (pd' is invariant
    // under the time rescaling, so no extra factor is needed).
    if (S < 0) return PRiSM_homogeneousNegSkin(td, Cd, S, N, true);

    // P̂_pd_prime(s) for pwd' = t · d(pwd)/dt. The Laplace transform of
    // t · d(f)/dt is -d/ds [s · F̂(s)] = -F̂(s) - s · F̂'(s). Rather than
    // differentiate symbolically we use the fact that d(pwd)/dt has Laplace
    // transform s · F̂(s) - f(0+) = s · F̂(s) (since pwd(0+) = 0), then
    // multiply by t in the time domain after inversion.
    const Phat = function(s) {
        const sqs = Math.sqrt(s);
        const k0 = PRiSM_besselK0(sqs);
        const k1 = PRiSM_besselK1(sqs);
        const num = k0 + S * sqs * k1;
        const denom = sqs * k1 + Cd * s * num;
        return num / (s * denom);
    };
    // Stehfest-invert F̂_dot(s) = s · F̂(s) to get d(pwd)/dt, then multiply
    // by td. This is mathematically equivalent to td · d(pwd)/d(ln td).
    const Fdot = function(s) { return s * Phat(s); };

    if (Array.isArray(td)) {
        return td.map(t => t * PRiSM_stehfest(Fdot, t, N));
    }
    if (!(td > 0) || !isFinite(td)) throw new Error('PRiSM_model_homogeneous_pd_prime: td must be > 0 (got ' + td + ')');
    return td * PRiSM_stehfest(Fdot, td, N);
}

// Common input validator for the homogeneous model.
function PRiSM_validateHomogeneousParams(params) {
    if (!params || typeof params !== 'object') throw new Error('PRiSM_model_homogeneous: params object required');
    if (!(params.Cd > 0) || !isFinite(params.Cd)) throw new Error('PRiSM_model_homogeneous: Cd must be positive and finite (got ' + params.Cd + ')');
    if (!isFinite(params.S)) throw new Error('PRiSM_model_homogeneous: S must be finite (got ' + params.S + ')');
}

// ── K1(x)/K0(x) without the exp(−x) factor ──
// Same A&S polynomials as PRiSM_besselK0/K1. For x > 2 both carry
// exp(−x)/√x, which cancels in the ratio; computing the ratio directly keeps
// it finite for x > ~700, where exp(−x) underflows to 0 and K0/K1 would give
// 0/0.
function PRiSM_besselK1overK0(x) {
    if (x <= 2.0) return PRiSM_besselK1(x) / PRiSM_besselK0(x);
    const y = 2.0 / x;
    const p0 = 1.25331414 + y * (-0.07832358 + y * (0.02189568 + y * (-0.01062446 +
               y * (0.00587872 + y * (-0.00251540 + y * 0.00053208)))));
    const p1 = 1.25331414 + y * (0.23498619 + y * (-0.03655620 + y * (0.01504268 +
               y * (-0.00780353 + y * (0.00325614 + y * -0.00068245)))));
    return p1 / p0;
}

// ── Negative skin through the effective wellbore radius ──
// rwa = rw·e^(−S). With f = e^(2S):
//     pd (td; Cd, S) = pd_{S=0}(td·f; Cd·f)
//     pd'(td; Cd, S) = pd'_{S=0}(td·f; Cd·f)      (td·d/dtd is scale-invariant)
// The S = 0 Laplace solution K0/[s(√s·K1 + Cd·s·K0)] is written as
// 1/[s(√s·K1/K0 + Cd·s)] so a tiny td·f (large s) never forms 0/0. At very
// large s this tends to 1/(Cd·f·s²), i.e. pure storage pd = td/Cd.
function PRiSM_homogeneousNegSkin(td, Cd, S, N, wantDeriv) {
    const f = Math.exp(2 * S);
    const Cda = Cd * f;
    const Phat = function (s) {
        const x = Math.sqrt(s);
        return 1 / (s * (x * PRiSM_besselK1overK0(x) + Cda * s));
    };
    const Fdot = function (s) { return s * Phat(s); };
    const one = function (t) {
        const ta = t * f;
        return wantDeriv ? ta * PRiSM_stehfest(Fdot, ta, N) : PRiSM_stehfest(Phat, ta, N);
    };
    if (Array.isArray(td)) return td.map(one);
    if (!(td > 0) || !isFinite(td)) {
        throw new Error((wantDeriv ? 'PRiSM_model_homogeneous_pd_prime' : 'PRiSM_model_homogeneous') +
                        ': td must be > 0 (got ' + td + ')');
    }
    return one(td);
}


// =============================================================================
// SECTION 4 — SHELL: extension registries (C7) + five-step workflow (C9)
// =============================================================================
// renderPRiSM(body) draws the whole PRiSM module:
//
//   #prism_header     breadcrumb (dataset ▸ period), test-type chip,
//                     ▶ Analyse, undo / redo, Tools, Export
//   #prism_steps      ① Data ② Flow periods ③ Diagnose ④ Model & fit ⑤ Report
//                     with status ticks
//   #prism_workspace  the seven legacy tab hosts #prism_tab_1..7 (+ a panel
//                     host #prism_tab_N_panels after each), the step-②
//                     view #prism_step2 and the step-④ sub-tab strip
//                     #prism_tabs (Model · Parameters · Type-curve match ·
//                     Regression)
//   #prism_rail       results rail: a 320 px column at ≥ 1024 px, a bottom
//                     sheet ('prism-rail--sheet') below that. Filled by
//                     window.PRiSM_renderRail(railEl) when present.
//
// Steps sit on top of the tabs: ① → tab 1, ③ → tab 2, ④ → tabs 3–6,
// ⑤ → tab 7, ② → window.PRiSM_stepViews[2](host). PRiSM_renderTab(n) and
// window.PRiSM.setTab(n) keep working for every module that uses tabs.
//
// Registries (merge, never replace):
//   window.PRiSM_tabPanels[n]  = [{id, title, order, when?(), render(hostEl), collapsed?}]
//   window.PRiSM_tabHooks      = {any:[fn(n)], 1:[fn(n)], …}   called after each tab render
//   window.PRiSM_postDrawHooks = [fn({canvas, plotKey, data, opts, axes})]   (called by 04)
//   window.PRiSM_stepViews     = {2: fn(hostEl)}
// Exports: PRiSM_renderTab, PRiSM_registerTabPanel, PRiSM_gotoStep,
//   PRiSM_currentStep, PRiSM_stepStatus, PRiSM_refreshShell,
//   PRiSM_commitDataset, PRiSM_seedDefaultSample, PRiSM_loadDemoData,
//   PRiSM_DEFAULT_SAMPLE_META, PRiSM_DEFAULT_SAMPLE_CSV.
// Events fired: prism:step-changed {step, prev, tab}, prism:tab-open {tab},
//   prism:dataset-loaded {source, dataset}, prism:mode-changed {mode}.
// =============================================================================

if (typeof window !== 'undefined') {
    if (!window.PRiSM_tabPanels || typeof window.PRiSM_tabPanels !== 'object') window.PRiSM_tabPanels = {};
    if (!window.PRiSM_tabHooks || typeof window.PRiSM_tabHooks !== 'object') window.PRiSM_tabHooks = {};
    if (!Array.isArray(window.PRiSM_tabHooks.any)) window.PRiSM_tabHooks.any = [];
    if (!Array.isArray(window.PRiSM_postDrawHooks)) window.PRiSM_postDrawHooks = [];
    if (!window.PRiSM_stepViews || typeof window.PRiSM_stepViews !== 'object') window.PRiSM_stepViews = {};
}

// Escape text for innerHTML.
function PRiSM_escHTML(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Fire a window CustomEvent. Returns true when dispatched.
function PRiSM_emit(type, detail) {
    if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return false;
    try {
        let ev = null;
        if (typeof CustomEvent === 'function') ev = new CustomEvent(type, { detail: detail });
        else if (typeof document !== 'undefined' && document.createEvent) {
            ev = document.createEvent('CustomEvent');
            ev.initCustomEvent(type, false, false, detail);
        }
        if (!ev) return false;
        window.dispatchEvent(ev);
        return true;
    } catch (e) { return false; }
}

// ── C7: register a collapsible panel card under tab n ──
// spec = {id, title, order?, when?(), render(hostEl), collapsed?}. Same id →
// replaced in place. When tab n is on screen the panels re-mount at once.
function PRiSM_registerTabPanel(n, spec) {
    n = parseInt(n, 10);
    if (!(n >= 1 && n <= 7) || !spec || typeof spec.render !== 'function') return false;
    if (typeof window === 'undefined') return false;
    if (!window.PRiSM_tabPanels || typeof window.PRiSM_tabPanels !== 'object') window.PRiSM_tabPanels = {};
    const reg = window.PRiSM_tabPanels;
    if (!Array.isArray(reg[n])) reg[n] = [];
    if (spec.id == null || spec.id === '') spec.id = 'panel' + (reg[n].length + 1);
    spec.id = String(spec.id);
    const i = reg[n].findIndex(p => p && String(p.id) === spec.id);
    if (i >= 0) reg[n][i] = spec; else reg[n].push(spec);
    if (typeof document !== 'undefined' && document.getElementById('prism_tab_' + n + '_panels')) {
        PRiSM_mountTabPanels(n);
    }
    return true;
}

// Collapsed/expanded choice per "tab:id", kept for the session.
const PRiSM_panelCollapsed = {};

// Render every registered panel of tab n into #prism_tab_n_panels (created
// next to #prism_tab_n when missing). A panel that throws gets an inline
// error card; a collapsed panel renders on first expand.
function PRiSM_mountTabPanels(n) {
    if (typeof document === 'undefined') return 0;
    n = parseInt(n, 10);
    const tabHost = document.getElementById('prism_tab_' + n);
    let host = document.getElementById('prism_tab_' + n + '_panels');
    if (!host) {
        if (!tabHost || !tabHost.parentNode) return 0;
        host = document.createElement('div');
        host.id = 'prism_tab_' + n + '_panels';
        host.className = 'prism-panels';
        tabHost.parentNode.insertBefore(host, tabHost.nextSibling);
    }
    if (tabHost) host.style.display = (tabHost.style.display === 'none') ? 'none' : '';
    const reg = (typeof window !== 'undefined' && window.PRiSM_tabPanels) || {};
    const list = (Array.isArray(reg[n]) ? reg[n] : []).filter(p => p && typeof p.render === 'function');
    const order = (p) => (typeof p.order === 'number' && isFinite(p.order)) ? p.order : 100;
    const sorted = list.map((p, i) => ({ p, i })).sort((a, b) => (order(a.p) - order(b.p)) || (a.i - b.i)).map(x => x.p);
    host.innerHTML = '';
    let mounted = 0;
    sorted.forEach(spec => {
        if (typeof spec.when === 'function') {
            let show = false;
            try { show = !!spec.when(); } catch (e) { show = false; }
            if (!show) return;
        }
        const id = String(spec.id);
        const safe = id.replace(/[^A-Za-z0-9_-]/g, '_');
        const key = n + ':' + id;
        const collapsed = (PRiSM_panelCollapsed[key] != null) ? PRiSM_panelCollapsed[key] : !!spec.collapsed;
        const card = document.createElement('div');
        card.className = 'card prism-panel';
        card.id = 'prism_panel_' + n + '_' + safe;
        card.setAttribute('data-panel-id', id);
        const head = document.createElement('button');
        head.type = 'button';
        head.className = 'prism-panel-head';
        head.id = card.id + '_head';
        head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        head.setAttribute('aria-controls', card.id + '_body');
        head.innerHTML = '<span class="prism-panel-title">' + PRiSM_escHTML(spec.title || id) + '</span>' +
                         '<span class="prism-panel-chev" aria-hidden="true">' + (collapsed ? '▸' : '▾') + '</span>';
        const bodyEl = document.createElement('div');
        bodyEl.className = 'prism-panel-body';
        bodyEl.id = card.id + '_body';
        card.appendChild(head);
        card.appendChild(bodyEl);
        host.appendChild(card);
        let rendered = false;
        const renderBody = () => {
            rendered = true;
            try { spec.render(bodyEl); }
            catch (e) {
                if (typeof console !== 'undefined') console.warn('PRiSM panel "' + id + '" (tab ' + n + ') failed:', e);
                bodyEl.innerHTML = '<div class="prism-error-note" role="alert">This panel could not be displayed: <code>' +
                    PRiSM_escHTML(e && e.message ? e.message : e) + '</code></div>';
            }
        };
        const setCollapsed = (c) => {
            PRiSM_panelCollapsed[key] = c;
            bodyEl.style.display = c ? 'none' : '';
            head.setAttribute('aria-expanded', c ? 'false' : 'true');
            const chev = head.querySelector('.prism-panel-chev');
            if (chev) chev.textContent = c ? '▸' : '▾';
            if (!c && !rendered) renderBody();
        };
        head.onclick = () => setCollapsed(bodyEl.style.display !== 'none');
        bodyEl.style.display = collapsed ? 'none' : '';
        if (!collapsed) renderBody();
        mounted++;
    });
    return mounted;
}

// C7 hooks: window.PRiSM_tabHooks.any + window.PRiSM_tabHooks[n], each isolated.
function PRiSM_runTabHooks(n) {
    const hooks = (typeof window !== 'undefined' && window.PRiSM_tabHooks) || {};
    const run = (list) => {
        if (!Array.isArray(list)) return;
        list.slice().forEach(fn => {
            if (typeof fn !== 'function') return;
            try { fn(n); } catch (e) { if (typeof console !== 'undefined') console.warn('PRiSM tab hook failed (tab ' + n + '):', e); }
        });
    };
    run(hooks.any);
    run(hooks[n]);
}

// Error card for a tab whose renderer is missing or threw.
function PRiSM_renderTabError(host, n, err) {
    const titles = { 1: 'Data', 2: 'Diagnostic plots', 3: 'Model', 4: 'Parameters', 5: 'Type-curve match', 6: 'Regression', 7: 'Report' };
    const msg = err
        ? 'It stopped with an error: <code>' + PRiSM_escHTML(err.message || String(err)) + '</code>'
        : 'The module that draws this view is not loaded in this build.';
    host.innerHTML =
        '<div class="card prism-error-card" role="alert">' +
        '<div class="card-title" style="color:var(--red); border-bottom-color:var(--border);">' +
        PRiSM_escHTML(titles[n] || ('Tab ' + n)) + ' could not be displayed</div>' +
        '<div style="font-size:12px; color:var(--text2); line-height:1.5;">' + msg + '</div>' +
        '</div>';
}

// Render tab n into #prism_tab_n, then its C7 panels, then the tab hooks and
// 'prism:tab-open'. opts.silent skips hooks + event (hidden pre-render).
function PRiSM_renderTab(n, opts) {
    n = parseInt(n, 10);
    opts = opts || {};
    if (!(n >= 1 && n <= 7) || typeof document === 'undefined') return false;
    const host = document.getElementById('prism_tab_' + n);
    if (!host) return false;
    // Delegate to the wired renderers. They are exposed on window by their
    // layers and re-render fresh each time, so the view reflects the latest
    // data. No setTab-wrapping or polling.
    const wired = {
        1: window.PRiSM_renderDataTabEnhanced,
        2: window.PRiSM_renderPlotsTab,
        3: window.PRiSM_renderModelTab,
        4: window.PRiSM_renderParamsTab,
        5: window.PRiSM_renderMatchTab,
        6: window.PRiSM_renderRegressTab,
        7: window.PRiSM_renderReportTab
    };
    let ok = false, err = null;
    if (typeof wired[n] === 'function') {
        window.PRiSM_tabDelegationActive = true;   // tells legacy setTab wrappers to stand down
        try { wired[n](); ok = true; }
        catch (e) { err = e; if (typeof console !== 'undefined') console.warn('PRiSM tab ' + n + ' renderer failed:', e); }
    }
    if (!ok && n === 1) {
        try { PRiSM_renderTabData(host); ok = true; }
        catch (e) { err = err || e; if (typeof console !== 'undefined') console.warn('PRiSM basic Data tab failed:', e); }
    }
    if (!ok) PRiSM_renderTabError(host, n, err);
    host.dataset.prismRendered = '1';
    PRiSM_mountTabPanels(n);
    if (!opts.silent) {
        PRiSM_runTabHooks(n);
        PRiSM_emit('prism:tab-open', { tab: n });
    }
    return ok;
}

// ── The five-step shell ──
const PRiSM_SHELL = (function () {
    const STEPS = [
        null,
        { n: 1, num: '①', label: 'Data',         tab: 1 },
        { n: 2, num: '②', label: 'Flow periods', tab: null },
        { n: 3, num: '③', label: 'Diagnose',     tab: 2 },
        { n: 4, num: '④', label: 'Model & fit',  tab: null },   // sub-tabs 3–6
        { n: 5, num: '⑤', label: 'Report',       tab: 7 }
    ];
    const SUBTABS = [
        { tab: 3, label: 'Model' },
        { tab: 4, label: 'Parameters' },
        { tab: 5, label: 'Type-curve match' },
        { tab: 6, label: 'Regression' }
    ];
    const STEP_FOR_TAB = { 1: 1, 2: 3, 3: 4, 4: 4, 5: 4, 6: 4, 7: 5 };
    const MODES = ['transient', 'decline', 'combined'];
    const TEST_TYPES = ['auto', 'drawdown', 'buildup', 'injection', 'falloff'];
    const TEST_LABELS = { auto: 'Auto-detect', drawdown: 'Drawdown', buildup: 'Buildup', injection: 'Injection',
                          falloff: 'Falloff', rate: 'Rate only (decline)', combined: 'Pressure + rate' };
    const NARROW_MQ = '(max-width: 1023px)';
    const STATE_EVENTS = ['prism:fit-updated', 'prism:well-changed', 'prism:step-changed', 'prism:dataset-loaded',
                          'prism:dataset-cleared', 'prism:period-changed', 'prism:model-changed'];
    const CSS_ID = 'prism-shell-css';

    let body = null;              // element that holds the current shell
    let listenersOn = false;
    let mql = null;
    let refreshing = false, refreshAgain = false, refreshCount = 0;
    let railExpanded = false;     // fallback bottom sheet only (WP13 keeps its own)
    let menuFor = null;
    let stateVer = 0;
    let adataCache = null;
    let mrateLoaded = false;

    const hasWin = () => typeof window !== 'undefined';
    const hasDoc = () => typeof document !== 'undefined';

    function byId(id) {
        if (!hasDoc()) return null;
        const e = document.getElementById(id);
        if (e) return e;
        if (body && body.querySelector) { try { return body.querySelector('#' + id); } catch (err) { return null; } }
        return null;
    }

    function tabForStep(n, P) {
        if (n === 4) return (P && [3, 4, 5, 6].indexOf(P.sub4) !== -1) ? P.sub4 : 3;
        return STEPS[n] ? STEPS[n].tab : null;
    }

    // window.PRiSM — the per-session UI state (mode, tab, step, multiRate).
    function state() {
        if (!hasWin()) return { mode: 'transient', tab: 1, step: 1, sub4: 3, multiRate: [] };
        let P = window.PRiSM;
        if (!P || typeof P !== 'object') P = window.PRiSM = {};
        if (MODES.indexOf(P.mode) === -1) P.mode = 'transient';
        let t = parseInt(P.tab, 10);
        if (!(t >= 1 && t <= 7)) t = 1;
        P.tab = t;
        let s = parseInt(P.step, 10);
        if (!(s >= 1 && s <= 5)) s = STEP_FOR_TAB[t];
        if (s !== 2 && STEP_FOR_TAB[t] !== s) s = STEP_FOR_TAB[t];
        P.step = s;
        if ([3, 4, 5, 6].indexOf(P.sub4) === -1) P.sub4 = (t >= 3 && t <= 6) ? t : 3;
        if (!Array.isArray(P.multiRate)) P.multiRate = [];
        // Multi-rate table: read 'wts_prism_mrate' once per session (another
        // layer may already have created window.PRiSM with an empty table).
        if (!mrateLoaded) {
            mrateLoaded = true;
            if (!P.multiRate.length) try {
                const raw = localStorage.getItem('wts_prism_mrate');
                const arr = raw ? JSON.parse(raw) : null;
                if (Array.isArray(arr)) {
                    const rows = arr.filter(r => r && isFinite(r.t) && isFinite(r.q)).map(r => ({ t: +r.t, q: +r.q }));
                    // A lone {t:0, q:0} row is the old editor's placeholder, not a schedule.
                    P.multiRate = (rows.length === 1 && rows[0].t === 0 && rows[0].q === 0) ? [] : rows;
                }
            } catch (e) { /* ignore */ }
        }
        if (typeof P.setTab !== 'function')   P.setTab   = function (n) { return setTab(n); };
        if (typeof P.setMode !== 'function')  P.setMode  = function (m) { return setMode(m); };
        if (typeof P.getState !== 'function') P.getState = function () { return getState(); };
        if (typeof P.gotoStep !== 'function') P.gotoStep = function (n, o) { return gotoStep(n, o); };
        return P;
    }

    function getState() {
        const P = state();
        return {
            mode: P.mode, tab: P.tab, step: P.step,
            multiRate: (P.multiRate || []).slice(),
            dataset: (hasWin() && window.PRiSM_dataset) || null
        };
    }

    function shellPresent() { return !!byId('prism_shell'); }

    function isNarrow() {
        if (!hasWin()) return false;
        try { if (typeof window.matchMedia === 'function') return !!window.matchMedia(NARROW_MQ).matches; } catch (e) { /* fall through */ }
        return (window.innerWidth || 1280) < 1024;
    }

    // ── styles (scoped 'prism-' classes, host dark-theme variables) ──
    const CSS = [
        '.prism-shell{display:flex;flex-direction:column;gap:10px;min-width:0;max-width:100%}',
        '.prism-shell *,.prism-shell *::before,.prism-shell *::after{box-sizing:border-box}',
        '.prism-header{position:relative;display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;min-width:0}',
        '.prism-crumb{flex:1 1 220px;min-width:0;font-size:12px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.prism-crumb b{color:var(--text);font-weight:600}',
        '.prism-crumb-sep{color:var(--text3);margin:0 5px}',
        '.prism-compact{flex:1 1 auto;min-width:0;text-align:left;background:transparent;border:0;color:var(--text);font-size:13px;font-weight:700;padding:6px 2px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-height:36px}',
        '.prism-tt{display:inline-flex;align-items:center;gap:6px;background:var(--bg1);border:1px solid var(--border);border-radius:999px;padding:2px 6px 2px 10px;font-size:11px;color:var(--text2);max-width:100%;min-width:0}',
        '.prism-tt select{background:transparent;border:0;color:var(--text);font-size:12px;font-weight:600;padding:5px 2px;max-width:170px;min-width:0;outline:none;cursor:pointer}',
        '.prism-tt select option{background:var(--bg2);color:var(--text)}',
        '.prism-hgroup{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-width:0}',
        '.prism-hbtn{display:inline-flex;align-items:center;justify-content:center;gap:4px;background:var(--bg4);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;min-height:34px;line-height:1;touch-action:manipulation}',
        '.prism-hbtn:hover{border-color:var(--accent)}',
        '.prism-hbtn--primary{background:var(--accent);border-color:var(--accent);color:#fff}',
        '.prism-hbtn--icon{min-width:34px;font-size:15px;padding:6px 8px}',
        '.prism-hbtn:disabled{opacity:.4;cursor:not-allowed}',
        '.prism-status{flex:1 1 100%;font-size:12px;color:var(--text2);min-height:0}',
        '.prism-status:empty{display:none}',
        '.prism-menu{position:absolute;right:8px;top:calc(100% + 4px);z-index:60;min-width:210px;max-width:calc(100vw - 32px);background:var(--bg3);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);padding:4px}',
        '.prism-menu[hidden]{display:none}',
        '.prism-menu button{display:block;width:100%;text-align:left;background:transparent;border:0;color:var(--text);font-size:12.5px;padding:9px 10px;border-radius:6px;cursor:pointer}',
        '.prism-menu button:hover,.prism-menu button:focus{background:var(--bg4);outline:none}',
        '.prism-menu button:disabled{opacity:.4;cursor:not-allowed}',
        '.prism-steps{display:flex;gap:4px;background:var(--bg1);border:1px solid var(--border);border-radius:8px;padding:3px;min-width:0}',
        '.prism-step{flex:1 1 0;min-width:0;display:flex;align-items:center;justify-content:center;gap:6px;padding:8px 6px;border:0;border-radius:6px;background:transparent;color:var(--text2);font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;min-height:38px;touch-action:manipulation}',
        '.prism-step:hover{background:var(--bg4);color:var(--text)}',
        '.prism-step.is-active{background:var(--accent);color:#fff}',
        '.prism-step-num{font-size:15px;line-height:1}',
        '.prism-step-label{overflow:hidden;text-overflow:ellipsis;min-width:0}',
        '.prism-step-tick{color:var(--green);font-weight:700}',
        '.prism-step-tick:empty{display:none}',
        '.prism-step.is-active .prism-step-tick{color:#fff}',
        '.prism-steps--compact .prism-step-label{display:none}',
        '.prism-body{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px;align-items:start;min-width:0}',
        '.prism-body--narrow{display:block}',
        '.prism-workspace{min-width:0}',
        '.prism-subtabs{flex-wrap:wrap;margin-bottom:12px}',
        '.prism-subtabs .tab-btn{min-width:0;white-space:normal}',
        '.prism-railwrap{position:sticky;top:12px;min-width:0}',
        '.prism-rail{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:12px;max-height:calc(100vh - 40px);overflow:auto;font-size:12px;color:var(--text);min-width:0}',
        '.prism-railwrap--sheet{position:sticky;top:auto;bottom:0;z-index:30;margin-top:12px}',
        '.prism-rail.prism-rail--sheet{max-height:none;overflow:visible;padding:0 8px 6px;background:var(--bg1);border-radius:10px 10px 0 0;box-shadow:0 -6px 18px rgba(0,0,0,.4)}',
        '.prism-rail-fb{display:flex;flex-direction:column;gap:8px}',
        '.prism-rail-fb-title{font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:var(--text2)}',
        '.prism-rail-fb-row{display:flex;justify-content:space-between;gap:10px;min-width:0}',
        '.prism-rail-fb-row span{color:var(--text2)}',
        '.prism-rail-fb-row b{color:var(--text);font-weight:600;text-align:right;overflow-wrap:anywhere;min-width:0}',
        '.prism-rail-fb-warn{border-left:3px solid var(--yellow);padding:6px 8px;color:var(--text);background:var(--bg3)}',
        '.prism-rail-fb-hint{color:var(--text3)}',
        '.prism-sheetbar{width:100%;display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 10px;background:transparent;border:0;color:var(--text);font-size:13px;font-weight:600;text-align:left;cursor:pointer}',
        '.prism-sheetbar span.prism-sheetbar-sum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.prism-panels{display:flex;flex-direction:column}',
        '.prism-panel{padding:0;overflow:hidden}',
        '.prism-panel-head{display:flex;width:100%;align-items:center;justify-content:space-between;gap:8px;background:transparent;border:0;color:var(--accent);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;padding:14px 20px;cursor:pointer;text-align:left;min-height:44px}',
        '.prism-panel-body{padding:0 20px 20px;min-width:0}',
        '.prism-error-card{border-color:var(--red)}',
        '.prism-error-note{font-size:12px;color:var(--red);line-height:1.5}',
        '.prism-note{font-size:12.5px;color:var(--text2);line-height:1.55}',
        '.prism-note b{color:var(--text)}',
        '@media (max-width:1023px){.prism-body{display:block}.prism-railwrap{position:sticky;top:auto;bottom:0;z-index:30;margin-top:12px}}',
        '@media (max-width:600px){.prism-panel-head{padding:12px 14px}.prism-panel-body{padding:0 14px 14px}.prism-header{padding:6px 8px}}'
    ].join('\n');

    function ensureCss() {
        if (!hasDoc() || document.getElementById(CSS_ID)) return;
        const s = document.createElement('style');
        s.id = CSS_ID;
        s.textContent = CSS;
        (document.head || document.body || document.documentElement).appendChild(s);
    }

    // ── markup ──
    function markup(P) {
        const steps = [1, 2, 3, 4, 5].map(n => {
            const s = STEPS[n];
            return '<button type="button" class="prism-step" id="prism_step_btn_' + n + '" data-prism-step="' + n + '"' +
                   ' title="' + PRiSM_escHTML(s.label) + '">' +
                   '<span class="prism-step-num" aria-hidden="true">' + s.num + '</span>' +
                   '<span class="prism-step-label">' + PRiSM_escHTML(s.label) + '</span>' +
                   '<span class="prism-step-tick" id="prism_step_tick_' + n + '"></span></button>';
        }).join('');
        const sub = SUBTABS.map(t =>
            '<button type="button" class="tab-btn" role="tab" data-prism-tab="' + t.tab + '">' + PRiSM_escHTML(t.label) + '</button>'
        ).join('');
        const tt = ['auto', 'drawdown', 'buildup', 'injection', 'falloff', 'rate', 'combined'].map(v =>
            '<option value="' + v + '">' + PRiSM_escHTML(TEST_LABELS[v]) + '</option>'
        ).join('');
        let tabs = '';
        for (let i = 1; i <= 7; i++) {
            tabs += '<div id="prism_tab_' + i + '" class="prism-tab" style="display:none;"></div>' +
                    '<div id="prism_tab_' + i + '_panels" class="prism-panels" style="display:none;"></div>';
        }
        return '' +
        '<div class="prism-shell" id="prism_shell" data-mode="' + PRiSM_escHTML(P.mode) + '">' +
          '<div class="prism-header" id="prism_header">' +
            '<button type="button" class="prism-compact" id="prism_step_compact" style="display:none;"></button>' +
            '<div class="prism-crumb" id="prism_crumb">' +
              '<b>PRiSM</b><span class="prism-crumb-sep">▸</span>' +
              '<span id="prism_crumb_ds">No data loaded</span><span class="prism-crumb-sep">▸</span>' +
              '<span id="prism_crumb_period">—</span>' +
            '</div>' +
            '<label class="prism-tt" title="Test type — drives the Δp sign, reference pressure and which models and plots are offered">' +
              '<span>Test</span><select id="prism_testtype" aria-label="Test type">' + tt + '</select>' +
            '</label>' +
            '<div class="prism-hgroup">' +
              '<button type="button" class="prism-hbtn prism-hbtn--primary" id="prism_analyse_btn" title="Run the automatic analysis on the current data">▶ Analyse</button>' +
              '<button type="button" class="prism-hbtn prism-hbtn--icon" id="prism_undo" title="Undo" aria-label="Undo">↶</button>' +
              '<button type="button" class="prism-hbtn prism-hbtn--icon" id="prism_redo" title="Redo" aria-label="Redo">↷</button>' +
              '<button type="button" class="prism-hbtn" id="prism_tools_btn" aria-haspopup="true" aria-expanded="false">Tools</button>' +
              '<button type="button" class="prism-hbtn" id="prism_export_btn" aria-haspopup="true" aria-expanded="false">Export</button>' +
            '</div>' +
            '<div class="prism-status" id="prism_status" role="status" aria-live="polite"></div>' +
            '<div class="prism-menu" id="prism_menu" role="menu" hidden></div>' +
          '</div>' +
          '<nav class="prism-steps" id="prism_steps" aria-label="Analysis steps">' + steps + '</nav>' +
          '<div class="prism-body" id="prism_body">' +
            '<div class="prism-workspace" id="prism_workspace">' +
              '<div class="tabs prism-subtabs" id="prism_tabs" role="tablist" aria-label="Model and fit" style="display:none;">' + sub + '</div>' +
              '<div id="prism_step2" class="prism-stepview" style="display:none;"></div>' +
              tabs +
            '</div>' +
            '<div class="prism-railwrap" id="prism_railwrap">' +
              '<aside class="prism-rail" id="prism_rail" aria-label="Results"></aside>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    function wire(root) {
        const q = (sel) => (root && root.querySelector) ? root.querySelector(sel) : null;
        const qa = (sel) => (root && root.querySelectorAll) ? Array.prototype.slice.call(root.querySelectorAll(sel)) : [];
        qa('[data-prism-step]').forEach(b => { b.onclick = () => gotoStep(parseInt(b.getAttribute('data-prism-step'), 10)); });
        qa('#prism_tabs [data-prism-tab]').forEach(b => { b.onclick = () => setTab(parseInt(b.getAttribute('data-prism-tab'), 10)); });
        const compact = q('#prism_step_compact');
        if (compact) compact.onclick = () => { const P = state(); gotoStep(P.step < 5 ? P.step + 1 : 1); };
        const sel = q('#prism_testtype');
        if (sel) sel.onchange = () => onTestType(sel.value);
        const an = q('#prism_analyse_btn');
        if (an) an.onclick = analyse;
        const un = q('#prism_undo');
        if (un) un.onclick = () => callHistory('PRiSM_undo');
        const re = q('#prism_redo');
        if (re) re.onclick = () => callHistory('PRiSM_redo');
        const tb = q('#prism_tools_btn');
        if (tb) tb.onclick = () => openTools(tb);
        const eb = q('#prism_export_btn');
        if (eb) eb.onclick = () => toggleMenu('export', eb);
    }

    function setStatus(text, tone) {
        const el = byId('prism_status');
        if (!el) return;
        el.textContent = text || '';
        el.style.color = tone === 'bad' ? 'var(--red)' : (tone === 'good' ? 'var(--green)' : '');
    }

    // ── viewport: desktop column vs bottom sheet ──
    function applyViewport() {
        if (!shellPresent()) return;
        const narrow = isNarrow();
        const bodyEl = byId('prism_body'), rail = byId('prism_rail'), wrap = byId('prism_railwrap');
        const steps = byId('prism_steps'), compact = byId('prism_step_compact'), crumb = byId('prism_crumb');
        const was = !!(rail && rail.classList.contains('prism-rail--sheet'));
        if (bodyEl) bodyEl.classList.toggle('prism-body--narrow', narrow);
        if (wrap) wrap.classList.toggle('prism-railwrap--sheet', narrow);
        if (rail) rail.classList.toggle('prism-rail--sheet', narrow);
        if (steps) steps.classList.toggle('prism-steps--compact', narrow);
        if (compact) compact.style.display = narrow ? '' : 'none';
        if (crumb) crumb.style.display = narrow ? 'none' : '';
        if (rail && was !== narrow) refreshRail();
    }

    function onViewportChange() { applyViewport(); }

    function ensureListeners() {
        if (listenersOn || !hasWin()) return;
        listenersOn = true;
        if (typeof window.addEventListener === 'function') {
            STATE_EVENTS.forEach(t => window.addEventListener(t, onStateEvent));
        }
        try {
            if (typeof window.matchMedia === 'function') {
                mql = window.matchMedia(NARROW_MQ);
                if (mql && typeof mql.addEventListener === 'function') mql.addEventListener('change', onViewportChange);
                else if (mql && typeof mql.addListener === 'function') mql.addListener(onViewportChange);
                else mql = null;
            }
        } catch (e) { mql = null; }
        // Always listen to resize too: some embedded / emulated viewports resize
        // without firing the media-query change event (applyViewport is idempotent).
        if (typeof window.addEventListener === 'function') window.addEventListener('resize', onViewportChange);
        if (hasDoc() && typeof document.addEventListener === 'function') {
            document.addEventListener('click', onDocClick);
            document.addEventListener('keydown', onDocKey);
        }
    }

    function onStateEvent(e) {
        const t = e && e.type;
        if (t === 'prism:well-changed' || t === 'prism:dataset-loaded' || t === 'prism:dataset-cleared' || t === 'prism:period-changed') {
            stateVer++;
            adataCache = null;
        }
        if (!shellPresent()) return;
        const P = state();
        if (P.step === 2 && (t === 'prism:dataset-loaded' || t === 'prism:dataset-cleared') &&
            !(hasWin() && window.PRiSM_stepViews && typeof window.PRiSM_stepViews[2] === 'function')) {
            renderStep2();
        }
        refresh();
    }

    // ── cached per-refresh facts (analysis data is the expensive one) ──
    function activePeriod() {
        const st = hasWin() ? window.PRiSM_state : null;
        const ap = st ? st.activePeriod : null;
        return (ap != null && ap !== '' && isFinite(ap) && +ap >= 0) ? +ap : null;
    }

    function periodCount(ds) {
        if (!ds || !ds.t || !ds.t.length) return 0;
        if (typeof window.PRiSM_detectPeriods === 'function' && ds.q && ds.q.length === ds.t.length) {
            try {
                const r = window.PRiSM_detectPeriods(ds.t, ds.q);
                if (Array.isArray(r) && r.length) return r.length;
                if (r && Array.isArray(r.periods) && r.periods.length) return r.periods.length;
            } catch (e) { /* fall back */ }
        }
        const q = ds.q;
        if (!q || !q.length) return 1;
        let maxQ = 0;
        for (let i = 0; i < q.length; i++) if (isFinite(q[i]) && Math.abs(q[i]) > maxQ) maxQ = Math.abs(q[i]);
        if (!(maxQ > 0)) return 1;
        const thr = 0.01 * maxQ;
        let n = 1;
        for (let i = 1; i < q.length; i++) {
            if (isFinite(q[i]) && isFinite(q[i - 1]) && Math.abs(q[i] - q[i - 1]) > thr) n++;
        }
        return n;
    }

    function lastFit() {
        if (!hasWin()) return null;
        if (typeof window.PRiSM_getLastFit === 'function') {
            try { return window.PRiSM_getLastFit() || null; } catch (e) { return null; }
        }
        const st = window.PRiSM_state;
        return (st && st.lastFit) ? st.lastFit : null;
    }

    function analysisData(ds) {
        if (typeof window.PRiSM_getAnalysisData !== 'function') return null;
        const st = window.PRiSM_state || {};
        const key = [stateVer, activePeriod(), st.timeFn || '', st.bourdetL == null ? '' : st.bourdetL].join('|');
        if (adataCache && adataCache.ds === ds && adataCache.key === key) return adataCache.value;
        let v;
        try { v = window.PRiSM_getAnalysisData(); } catch (e) { v = { ok: false, reason: e && e.message }; }
        adataCache = { ds: ds, key: key, value: v };
        return v;
    }

    function snapshot() {
        const ds = hasWin() ? window.PRiSM_dataset : null;
        const has = !!(ds && ds.t && ds.t.length);
        const snap = { ds: ds, has: has, adata: null, fit: lastFit(), well: null,
                       nPeriods: has ? periodCount(ds) : 0, activePeriod: activePeriod() };
        if (has) snap.adata = analysisData(ds);
        if (typeof window.PRiSM_getWell === 'function') { try { snap.well = window.PRiSM_getWell(); } catch (e) { snap.well = null; } }
        return snap;
    }

    function stepStatus(snap) {
        snap = snap || snapshot();
        const s = { 1: snap.has, 2: false, 3: false, 4: false, 5: true };
        if (snap.has) {
            s[2] = snap.activePeriod != null || snap.nPeriods <= 1;
            if (typeof window.PRiSM_getAnalysisData === 'function') s[3] = !!(snap.adata && snap.adata.ok);
            else {
                const p = snap.ds.p;
                s[3] = !!(p && p.length >= 3 && snap.ds.t.length === p.length);
            }
        }
        const f = snap.fit;
        s[4] = !!(f && f.converged && !f.stale);
        return s;
    }

    // ── labels ──
    function datasetLabel(ds) {
        if (!ds || !ds.t || !ds.t.length) return 'No data loaded';
        const name = ds.name || (ds.source === 'sample' ? 'Demo data' : 'Data');
        let n = String(ds.t.length);
        n = n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return name + ' · ' + n + ' pts';
    }

    function periodLabel(snap) {
        if (!snap.has) return '—';
        if (snap.activePeriod != null) return 'Period ' + (snap.activePeriod + 1) + ' of ' + Math.max(snap.nPeriods, snap.activePeriod + 1);
        if (!snap.ds.p) return 'Rate history';
        return snap.nPeriods <= 1 ? 'Single period' : (snap.nPeriods + ' flow periods');
    }

    function storedTestType(snap) {
        let tt = null;
        if (snap && snap.well && snap.well.testType) tt = snap.well.testType;
        if (!tt && hasWin() && window.PRiSM_pvt && window.PRiSM_pvt.testType) tt = window.PRiSM_pvt.testType;
        if (!tt) tt = state().testType;
        return TEST_TYPES.indexOf(tt) !== -1 ? tt : 'auto';
    }

    function chipValue(snap) {
        const P = state();
        if (P.mode === 'decline') return 'rate';
        if (P.mode === 'combined') return 'combined';
        return storedTestType(snap);
    }

    function inferredTestType(snap) {
        const a = snap && snap.adata;
        const tt = a && a.testType;
        return (TEST_TYPES.indexOf(tt) !== -1 && tt !== 'auto') ? tt : null;
    }

    function compactLabel(n) {
        const s = STEPS[n];
        return s.num + ' ' + s.label + ' · ' + n + '/5' + (n < 5 ? ' ›' : '');
    }

    function fmtNum(v) {
        if (typeof v !== 'number' || !isFinite(v)) return '—';
        const a = Math.abs(v);
        if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
        return String(+v.toPrecision(4));
    }

    // ── refresh header / steps / rail ──
    function refreshHeader(snap) {
        const P = state();
        const shell = byId('prism_shell');
        if (shell) shell.setAttribute('data-mode', P.mode);
        const dsEl = byId('prism_crumb_ds');
        if (dsEl) dsEl.textContent = datasetLabel(snap.ds);
        const perEl = byId('prism_crumb_period');
        if (perEl) perEl.textContent = periodLabel(snap);
        const sel = byId('prism_testtype');
        if (sel) {
            const inf = inferredTestType(snap);
            const autoOpt = sel.querySelector ? sel.querySelector('option[value="auto"]') : null;
            if (autoOpt) autoOpt.textContent = 'Auto-detect' + (inf ? ' (' + TEST_LABELS[inf].toLowerCase() + ')' : '');
            const v = chipValue(snap);
            if (sel.value !== v) sel.value = v;
        }
        const compact = byId('prism_step_compact');
        if (compact) {
            compact.textContent = compactLabel(P.step);
            compact.setAttribute('aria-label', 'Step ' + P.step + ' of 5, ' + STEPS[P.step].label + (P.step < 5 ? '. Go to the next step' : '. Go to step 1'));
        }
        const hist = (fnName, canName, id) => {
            const b = byId(id);
            if (!b) return;
            const has = typeof window[fnName] === 'function';
            let can = has;
            if (has && typeof window[canName] === 'function') { try { can = !!window[canName](); } catch (e) { can = true; } }
            b.disabled = !can;
            if (!has) b.title = (id === 'prism_undo' ? 'Undo' : 'Redo') + ' is not available in this build';
        };
        hist('PRiSM_undo', 'PRiSM_canUndo', 'prism_undo');
        hist('PRiSM_redo', 'PRiSM_canRedo', 'prism_redo');
    }

    function refreshSteps(snap) {
        const P = state();
        const done = stepStatus(snap);
        for (let n = 1; n <= 5; n++) {
            const b = byId('prism_step_btn_' + n);
            if (!b) continue;
            const active = (n === P.step);
            b.classList.toggle('is-active', active);
            b.classList.toggle('is-done', !!done[n] && n < 5);
            if (active) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
            const tick = byId('prism_step_tick_' + n);
            if (tick) tick.textContent = (n < 5 && done[n]) ? '✓' : '';
            b.title = STEPS[n].label + (n < 5 ? (done[n] ? ' — done' : ' — to do') : '');
        }
    }

    function fallbackRail(rail, snap) {
        const rows = [];
        const row = (k, v) => rows.push('<div class="prism-rail-fb-row"><span>' + PRiSM_escHTML(k) + '</span><b>' + PRiSM_escHTML(v) + '</b></div>');
        row('Dataset', datasetLabel(snap.ds));
        const cv = chipValue(snap), inf = inferredTestType(snap);
        row('Test', cv === 'auto' ? ('Auto' + (inf ? ' — ' + TEST_LABELS[inf].toLowerCase() : '')) : TEST_LABELS[cv]);
        const f = snap.fit;
        let summary = snap.has ? datasetLabel(snap.ds) : 'No data loaded';
        if (f) {
            const ph = f.phys || {};
            const model = f.modelKey || f.model || '—';
            row('Model', model);
            if (typeof ph.k === 'number' && isFinite(ph.k)) row('k', fmtNum(ph.k) + ' md');
            if (typeof ph.kh === 'number' && isFinite(ph.kh)) row('kh', fmtNum(ph.kh) + ' md·ft');
            if (typeof ph.S === 'number' && isFinite(ph.S)) row('Skin S', fmtNum(ph.S));
            if (typeof ph.C === 'number' && isFinite(ph.C)) row('C', fmtNum(ph.C) + ' bbl/psi');
            const r2 = (typeof f.r2 === 'number') ? f.r2 : f.R2;
            if (typeof r2 === 'number' && isFinite(r2)) row('Fit R²', r2.toFixed(4) + (f.converged ? ' ✓' : ''));
            summary = model + (typeof ph.k === 'number' && isFinite(ph.k) ? ' · k ' + fmtNum(ph.k) + ' md' : '') +
                      (typeof ph.S === 'number' && isFinite(ph.S) ? ' · S ' + fmtNum(ph.S) : '');
        }
        const missing = (snap.well && Array.isArray(snap.well.missing)) ? snap.well.missing : [];
        let html = '<div class="prism-rail-fb">' +
                   '<div class="prism-rail-fb-title">Results</div>' + rows.join('');
        if (missing.length) html += '<div class="prism-rail-fb-warn">⚠ Missing well inputs: ' + PRiSM_escHTML(missing.join(', ')) + '</div>';
        if (!f) html += '<div class="prism-rail-fb-hint">' + (snap.has ? 'No fit yet — press ▶ Analyse or fit a model on step ④.' : 'Load a file or try the demo data on step ①.') + '</div>';
        html += '</div>';
        if (rail.classList.contains('prism-rail--sheet')) {
            rail.innerHTML =
                '<button type="button" class="prism-sheetbar" id="prism_rail_sheetbar" aria-expanded="' + (railExpanded ? 'true' : 'false') + '" aria-controls="prism_rail_body">' +
                '<span class="prism-sheetbar-sum">' + PRiSM_escHTML(summary) + '</span><span aria-hidden="true">' + (railExpanded ? '▾' : '▴') + '</span></button>' +
                '<div id="prism_rail_body" style="display:' + (railExpanded ? 'block' : 'none') + '; max-height:70vh; overflow:auto; padding:4px 4px 8px;">' + html + '</div>';
            const bar = rail.querySelector ? rail.querySelector('#prism_rail_sheetbar') : null;
            if (bar) bar.onclick = () => { railExpanded = !railExpanded; fallbackRail(rail, snapshot()); };
        } else {
            rail.innerHTML = html;
        }
    }

    function refreshRail(snap) {
        const rail = byId('prism_rail');
        if (!rail) return;
        if (hasWin() && typeof window.PRiSM_renderRail === 'function') {
            try { window.PRiSM_renderRail(rail); }
            catch (e) {
                if (typeof console !== 'undefined') console.warn('PRiSM_renderRail failed:', e);
                rail.innerHTML = '<div class="prism-error-note" role="alert">Results unavailable: ' + PRiSM_escHTML(e && e.message) + '</div>';
            }
            return;
        }
        fallbackRail(rail, snap || snapshot());
    }

    function refresh() {
        if (!shellPresent()) return;
        if (refreshing) { refreshAgain = true; return; }
        const railNow = byId('prism_rail');
        if (railNow && isNarrow() !== railNow.classList.contains('prism-rail--sheet')) applyViewport();
        refreshing = true;
        let guard = 0;
        try {
            do {
                refreshAgain = false;
                const snap = snapshot();
                refreshHeader(snap);
                refreshSteps(snap);
                refreshRail(snap);
            } while (refreshAgain && ++guard < 3);
        } finally {
            refreshing = false;
            refreshCount++;
        }
    }

    // ── show / hide the step views ──
    function showStep(n, tab) {
        for (let i = 1; i <= 7; i++) {
            const disp = (i === tab) ? 'block' : 'none';
            const t = byId('prism_tab_' + i);
            if (t) t.style.display = disp;
            const p = byId('prism_tab_' + i + '_panels');
            if (p) p.style.display = (i === tab) ? '' : 'none';
        }
        const s2 = byId('prism_step2');
        if (s2) s2.style.display = (n === 2) ? 'block' : 'none';
        const sub = byId('prism_tabs');
        if (sub) {
            sub.style.display = (n === 4) ? 'flex' : 'none';
            const btns = sub.querySelectorAll ? sub.querySelectorAll('[data-prism-tab]') : [];
            Array.prototype.forEach.call(btns, b => {
                const on = parseInt(b.getAttribute('data-prism-tab'), 10) === tab;
                b.classList.toggle('active', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            });
        }
    }

    function renderStep2() {
        const host = byId('prism_step2');
        if (!host) return;
        const fn = hasWin() && window.PRiSM_stepViews ? window.PRiSM_stepViews[2] : null;
        if (typeof fn === 'function') {
            try { fn(host); }
            catch (e) {
                if (typeof console !== 'undefined') console.warn('PRiSM step ② view failed:', e);
                PRiSM_renderTabError(host, 0, e);
                const title = host.querySelector ? host.querySelector('.card-title') : null;
                if (title) title.textContent = 'Flow periods could not be displayed';
            }
            return;
        }
        const ds = hasWin() ? window.PRiSM_dataset : null;
        const has = !!(ds && ds.t && ds.t.length);
        const n = has ? periodCount(ds) : 0;
        let msg;
        if (!has) msg = 'No data is loaded yet. Load a file or try the demo data on step ① first.';
        else if (!ds.p) msg = 'This dataset has rates but no pressure — it is analysed as a rate history (decline).';
        else if (n <= 1) msg = 'The data is one flow period at a constant rate, so it is analysed as a single period.';
        else msg = 'The rate history has <b>' + n + ' flow periods</b>. Pick the period to analyse on step ③ (Diagnose); Δt restarts at the start of that period.';
        host.innerHTML =
            '<div class="card">' +
            '<div class="card-title">Flow periods</div>' +
            '<div class="prism-note">' + msg + '</div>' +
            '<div class="prism-note" style="margin-top:8px;">To trim the start or end of the record, use the crop tool on step ①.</div>' +
            '<div style="margin-top:12px; display:flex; flex-wrap:wrap; gap:8px;">' +
            '<button type="button" class="btn btn-secondary" id="prism_step2_crop">Open the crop tool</button>' +
            (has && ds.p ? '<button type="button" class="btn btn-primary" id="prism_step2_next">Go to Diagnose ›</button>' : '') +
            '</div></div>';
        const crop = host.querySelector ? host.querySelector('#prism_step2_crop') : null;
        if (crop) crop.onclick = () => focusCrop();
        const next = host.querySelector ? host.querySelector('#prism_step2_next') : null;
        if (next) next.onclick = () => gotoStep(3);
    }

    function focusCrop() {
        gotoStep(1);
        const el = byId('prism_crop_tool_host') || byId('prism_tab_1_panels');
        if (el && typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ } }
    }

    // ── navigation ──
    function gotoStep(n, opts) {
        opts = opts || {};
        n = parseInt(n, 10);
        if (!(n >= 1 && n <= 5)) return false;
        const P = state();
        const prev = P.step;
        if (n === 4) {
            const want = parseInt(opts.tab, 10);
            if ([3, 4, 5, 6].indexOf(want) !== -1) P.sub4 = want;
        }
        const tab = tabForStep(n, P);
        P.step = n;
        if (tab) P.tab = tab;
        closeMenu();
        if (!shellPresent()) return true;
        showStep(n, tab);
        if (tab) PRiSM_renderTab(tab);
        else renderStep2();
        const before = refreshCount;
        PRiSM_emit('prism:step-changed', { step: n, prev: prev, tab: tab });
        if (refreshCount === before) refresh();   // no listener reached (e.g. events unavailable)
        return true;
    }

    function setTab(n) {
        n = parseInt(n, 10);
        if (!(n >= 1 && n <= 7)) return false;
        return gotoStep(STEP_FOR_TAB[n], { tab: n });
    }

    function setMode(m) {
        if (MODES.indexOf(m) === -1) return false;
        const P = state();
        const changed = P.mode !== m;
        P.mode = m;
        if (body && body.querySelector && body.querySelector('#prism_shell')) renderPRiSM(body);
        if (changed) PRiSM_emit('prism:mode-changed', { mode: m });
        return true;
    }

    function onTestType(v) {
        const P = state();
        if (v === 'rate') { setMode('decline'); return; }
        if (v === 'combined') { setMode('combined'); return; }
        if (TEST_TYPES.indexOf(v) === -1) return;
        if (typeof window.PRiSM_setWell === 'function') {
            try { window.PRiSM_setWell({ testType: v }, { source: 'user' }); }
            catch (e) { if (typeof console !== 'undefined') console.warn('PRiSM_setWell(testType) failed:', e); }
        } else {
            P.testType = v;
            stateVer++; adataCache = null;
        }
        if (P.mode !== 'transient') setMode('transient');
        else refresh();
    }

    function analyse() {
        setStatus('');
        if (hasWin() && typeof window.PRiSM_analyse === 'function') {
            let r;
            try { r = window.PRiSM_analyse(); }
            catch (e) { setStatus('Analysis failed: ' + (e && e.message ? e.message : e), 'bad'); return; }
            if (r && typeof r.then === 'function') {
                r.then(() => refresh(), (e) => { setStatus('Analysis failed: ' + (e && e.message ? e.message : e), 'bad'); refresh(); });
            } else refresh();
            return;
        }
        // Without the one-click pipeline, open the regression view.
        gotoStep(4, { tab: 6 });
        setStatus('Automatic analysis is not available in this build — fit a model here.');
    }

    function callHistory(fnName) {
        if (!hasWin() || typeof window[fnName] !== 'function') return;
        try { window[fnName](); }
        catch (e) { setStatus((fnName === 'PRiSM_undo' ? 'Undo' : 'Redo') + ' failed: ' + (e && e.message ? e.message : e), 'bad'); }
        refresh();
    }

    // ── Tools / Export ──
    function openTools(btn) {
        if (hasWin() && typeof window.PRiSM_openTools === 'function') {
            closeMenu();
            try { window.PRiSM_openTools(); }
            catch (e) { setStatus('Tools failed to open: ' + (e && e.message ? e.message : e), 'bad'); }
            return;
        }
        toggleMenu('tools', btn);
    }

    function menuItems(kind) {
        const W = hasWin() ? window : {};
        const st = W.PRiSM_state || {};
        if (kind === 'tools') {
            return [
                { label: 'Crop and trim the data', run: () => focusCrop() },
                { label: 'Well, fluid and test inputs', run: () => {
                    gotoStep(1);
                    const el = byId('prism_tab_1_panels');
                    if (el && typeof el.scrollIntoView === 'function') { try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ } }
                } },
                { label: 'Flow periods', run: () => gotoStep(2) }
            ];
        }
        const items = [{ label: 'Open the report (step ⑤)', run: () => gotoStep(5) }];
        if (typeof W.PRiSM_exportReportPDF === 'function') items.push({ label: 'Report as PDF', run: () => W.PRiSM_exportReportPDF() });
        if (typeof W.PRiSM_exportCSV === 'function') items.push({ label: 'Results as CSV', run: () => W.PRiSM_exportCSV() });
        if (typeof W.PRiSM_exportPlotPNG === 'function') items.push({ label: 'Current plot as PNG', run: () => W.PRiSM_exportPlotPNG(st.activePlot || 'bourdet') });
        if (typeof W.PRiSM_exportXMLDownload === 'function') items.push({ label: 'Data and results as XML', run: () => W.PRiSM_exportXMLDownload() });
        return items;
    }

    function toggleMenu(kind, btn) {
        const menu = byId('prism_menu');
        if (!menu) return;
        if (menuFor === kind && !menu.hasAttribute('hidden')) { closeMenu(); return; }
        closeMenu();
        const items = menuItems(kind);
        menu.innerHTML = items.map((it, i) =>
            '<button type="button" role="menuitem" data-prism-menu="' + i + '">' + PRiSM_escHTML(it.label) + '</button>'
        ).join('');
        Array.prototype.forEach.call(menu.querySelectorAll('[data-prism-menu]'), b => {
            b.onclick = () => {
                const it = items[parseInt(b.getAttribute('data-prism-menu'), 10)];
                closeMenu();
                if (!it) return;
                try { it.run(); }
                catch (e) { setStatus(it.label + ' failed: ' + (e && e.message ? e.message : e), 'bad'); }
            };
        });
        menu.removeAttribute('hidden');
        menuFor = kind;
        if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'true');
    }

    function closeMenu() {
        const menu = byId('prism_menu');
        if (menu && !menu.hasAttribute('hidden')) menu.setAttribute('hidden', '');
        menuFor = null;
        ['prism_tools_btn', 'prism_export_btn'].forEach(id => { const b = byId(id); if (b) b.setAttribute('aria-expanded', 'false'); });
    }

    function onDocClick(ev) {
        if (!menuFor) return;
        const t = ev && ev.target;
        if (t && typeof t.closest === 'function' && t.closest('#prism_menu, #prism_tools_btn, #prism_export_btn')) return;
        closeMenu();
    }

    function onDocKey(ev) {
        if (menuFor && ev && ev.key === 'Escape') closeMenu();
    }

    // ── dataset on first open / after a reload ──
    // Empty dataset → promote the persisted Data-tab text (C8), else seed the
    // demo data unless the user cleared it.
    function autoPromote() {
        const ds = window.PRiSM_dataset;
        if (ds && ds.t && ds.t.length) return false;
        const text = PRiSM_persistedPaste();
        if (text && text.trim()) {
            const isSample = text.trim() === PRiSM_DEFAULT_SAMPLE_CSV.trim();
            const meta = isSample ? { name: 'Demo data', source: 'sample' } : { source: 'restored' };
            const built = PRiSM_datasetFromTextAny(text, meta);
            if (built) {
                if (isSample) { built.name = 'Demo data'; built.source = 'sample'; }
                PRiSM_commitDataset(built, { source: 'restored' });
                return true;
            }
            return false;
        }
        return PRiSM_seedDefaultSample('prism_data_paste');
    }

    function render(bodyEl) {
        if (!bodyEl) return;
        if (typeof $ === 'function') {
            if ($('pgTitle')) $('pgTitle').textContent = 'PRiSM — Well Test Analysis';
            if ($('pgSub')) $('pgSub').textContent = 'Pressure Reservoir Inversion & Simulation Model';
        }
        const P = state();
        ensureCss();
        ensureListeners();
        try { autoPromote(); } catch (e) { if (typeof console !== 'undefined') console.warn('PRiSM dataset restore failed:', e); }
        body = bodyEl;
        menuFor = null;
        bodyEl.innerHTML = markup(P);
        wire(bodyEl);
        applyViewport();
        const tab = tabForStep(P.step, P);
        // Tab 1 is always drawn (hidden when not current) so the Data inputs
        // and their persistence exist whichever step is open.
        if (tab !== 1) PRiSM_renderTab(1, { silent: true });
        showStep(P.step, tab);
        if (tab) PRiSM_renderTab(tab);
        else renderStep2();
        refresh();
    }

    return {
        render: render,
        gotoStep: gotoStep,
        setTab: setTab,
        setMode: setMode,
        currentStep: () => state().step,
        stepStatus: () => stepStatus(),
        refresh: refresh,
        applyViewport: applyViewport,
        stepForTab: (n) => STEP_FOR_TAB[parseInt(n, 10)] || null,
        tabForStep: (n) => tabForStep(parseInt(n, 10), state()),
        compactLabel: compactLabel,
        state: state
    };
})();

function renderPRiSM(body) {
    return PRiSM_SHELL.render(body);
}

if (typeof window !== 'undefined') {
    window.PRiSM_renderTab = PRiSM_renderTab;
    window.PRiSM_registerTabPanel = PRiSM_registerTabPanel;
    window.PRiSM_mountTabPanels = PRiSM_mountTabPanels;
    window.PRiSM_gotoStep = function (n, opts) { return PRiSM_SHELL.gotoStep(n, opts); };
    window.PRiSM_currentStep = function () { return PRiSM_SHELL.currentStep(); };
    window.PRiSM_stepStatus = function () { return PRiSM_SHELL.stepStatus(); };
    window.PRiSM_refreshShell = function () { return PRiSM_SHELL.refresh(); };
}


// =============================================================================
// SECTION 5 — DATASET: demo sample, commit, restore + basic Data tab
// =============================================================================
// The enhanced Data tab (07-data-enhancements.js) is the normal Tab 1. The
// basic renderer below is the fallback when 07 is missing or throws.
// Parsing commits the dataset — there is no separate "use this data" step.
// window.PRiSM_dataset = { t:[h], p:[psia]|null, q:[STB/d|Mscf/d]|null,
//                          name?, source?, timeUnit:'h', … }
// Persistence: the Data-tab text lives under 'wts_prism' (loadInputs /
// saveInputs pattern) and the multi-rate table under 'wts_prism_mrate'.
// =============================================================================

// ── Default sample dataset ──────────────────────────────────────────────
// A physically-correct homogeneous-reservoir drawdown (Cd=80, S=2.5,
// k=45 md, h=35 ft, q=850 STB/d) so PRiSM is immediately usable — the user
// can flip to Plots / Model / Match and see a textbook Bourdet (unit-slope
// wellbore storage → hump → 0.5 radial stabilisation) without loading
// anything. Seeded whenever PRiSM has no data, until the user clears it
// (guarded by localStorage 'wts_prism_sample_suppress').
const PRiSM_DEFAULT_SAMPLE_CSV =
`time,pressure,rate
0.01000,3861.4,850
0.01190,3823.1,850
0.01416,3783.2,850
0.01685,3743.4,850
0.02005,3705.0,850
0.02386,3668.2,850
0.02840,3633.4,850
0.03379,3602.4,850
0.04021,3575.4,850
0.04785,3551.4,850
0.05694,3530.4,850
0.06776,3512.9,850
0.08063,3497.6,850
0.09595,3483.3,850
0.1142,3470.1,850
0.1359,3458.5,850
0.1617,3447.2,850
0.1924,3435.7,850
0.2289,3425.0,850
0.2724,3415.1,850
0.3242,3405.0,850
0.3858,3394.7,850
0.4591,3385.2,850
0.5463,3375.9,850
0.6501,3366.0,850
0.7736,3356.1,850
0.9206,3347.0,850
1.095,3337.7,850
1.304,3327.8,850
1.551,3318.4,850
1.846,3309.6,850
2.197,3300.4,850
2.614,3290.8,850
3.111,3281.8,850
3.701,3273.0,850
4.405,3263.6,850
5.241,3254.0,850
6.237,3245.0,850
7.422,3236.1,850
8.832,3226.5,850
10.51,3217.2,850
12.51,3208.5,850
14.88,3199.5,850
17.71,3190.0,850
21.08,3181.0,850
25.08,3172.3,850
29.84,3163.0,850
35.51,3153.4,850
42.26,3144.5,850
50.29,3135.6,850
59.84,3126.1,850
71.21,3116.8,850
84.74,3108.2,850
100.8,3099.3,850
120.0,3089.8,850`;

// Well / fluid / test inputs that belong to the sample (contract C1). Applied
// through window.PRiSM_setWell(META, {source:'sample'}) when the sample is
// seeded, so pi = 4200 psia is a real reference, not p[0].
const PRiSM_DEFAULT_SAMPLE_META = {
    pi: 4200, testType: 'drawdown', q: 850, Bo: 1.25, mu_o: 1.1,
    ct: 1.2e-5, h: 35, phi: 0.18, rw: 0.354, fluidType: 'oil'
};

if (typeof window !== 'undefined') {
    window.PRiSM_DEFAULT_SAMPLE_CSV = PRiSM_DEFAULT_SAMPLE_CSV;
    window.PRiSM_DEFAULT_SAMPLE_META = PRiSM_DEFAULT_SAMPLE_META;
}

// The Data-tab text persisted under 'wts_prism' ({prism_data_paste: text}).
function PRiSM_persistedPaste() {
    try {
        const raw = localStorage.getItem('wts_prism');
        if (!raw) return '';
        const o = JSON.parse(raw);
        return (o && typeof o.prism_data_paste === 'string') ? o.prism_data_paste : '';
    } catch (e) { return ''; }
}

function PRiSM_persistPaste(text) {
    try {
        let o = {};
        const raw = localStorage.getItem('wts_prism');
        if (raw) { try { o = JSON.parse(raw); } catch (e) { o = {}; } }
        if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
        o.prism_data_paste = String(text == null ? '' : text);
        localStorage.setItem('wts_prism', JSON.stringify(o));
    } catch (e) { /* ignore quota / private mode */ }
}

// Basic text → {t, p, q} (column order time, pressure, rate).
function PRiSM_basicDatasetFromText(text) {
    const res = PRiSM_parseDataText(text);
    if (!res.rows.length) return null;
    const rows = res.rows;
    const t = rows.map(r => r[0]);
    const p = rows.map(r => r[1]);
    const q = rows.map(r => r.length >= 3 ? r[2] : null);
    return { t: t, p: p, q: q.every(v => v != null && isFinite(v)) ? q : null, timeUnit: 'h' };
}

// Text → dataset through the enhanced pipeline (07) when loaded, else basic.
function PRiSM_datasetFromTextAny(text, meta) {
    meta = meta || {};
    if (typeof window !== 'undefined' && typeof window.PRiSM_datasetFromText === 'function') {
        try {
            const ds = window.PRiSM_datasetFromText(text, meta);
            return (ds && ds.t && ds.t.length) ? ds : null;
        } catch (e) {
            if (typeof console !== 'undefined') console.warn('PRiSM enhanced parse failed, using the basic parser:', e);
        }
    }
    const ds = PRiSM_basicDatasetFromText(text);
    if (ds) {
        if (meta.name) ds.name = meta.name;
        if (meta.source) ds.source = meta.source;
    }
    return ds;
}

// Make ds the active dataset and announce it once ('prism:dataset-loaded').
// opts.source → event detail source ('paste' | 'file' | 'sample' | 'restored'
// | 'crop' | …); ds.source keeps where the data came from.
function PRiSM_commitDataset(ds, opts) {
    opts = opts || {};
    if (!ds || !ds.t || !ds.t.length) return null;
    if (opts.name && !ds.name) ds.name = opts.name;
    if (!ds.source && opts.source) ds.source = opts.source;
    if (!ds.timeUnit) ds.timeUnit = 'h';
    if (ds.p === undefined) ds.p = null;
    if (ds.q === undefined) ds.q = null;
    window.PRiSM_dataset = ds;
    const src = opts.source || ds.source || 'data';
    // A dataset that is not the demo and not derived from the current data
    // (paste, file, gauge / analysis set, project, …) must not inherit the demo
    // well's inputs (pi 4200, drawdown, h 35, …): reset every 'sample'-
    // provenance field to the store default so it shows amber on Well & Test.
    // Sources that derive a dataset from the current one keep the well inputs.
    const derived = { sample: 1, crop: 1, tide: 1, 'tide-correction': 1, 'tide-reset': 1,
                      deconvolution: 1, 'deconvolution-restore': 1, filter: 1, period: 1 };
    if (!derived[src] && !PRiSM_isSampleData(ds)) PRiSM_releaseSampleInputs();
    PRiSM_emit('prism:dataset-loaded', { source: src, dataset: ds });
    return ds;
}

// True when ds carries exactly the demo sample's samples.
let PRiSM__sampleSig = null;
function PRiSM_isSampleData(ds) {
    try {
        if (!ds || !ds.t || !ds.p) return false;
        if (!PRiSM__sampleSig) {
            const rows = PRiSM_DEFAULT_SAMPLE_CSV.trim().split(/\r?\n/).slice(1).map(function (l) { return l.split(','); });
            PRiSM__sampleSig = { n: rows.length, t: rows.map(function (r) { return +r[0]; }), p: rows.map(function (r) { return +r[1]; }) };
        }
        const S = PRiSM__sampleSig;
        if (ds.t.length !== S.n || ds.p.length !== S.n) return false;
        for (let i = 0; i < S.n; i++) {
            if (Math.abs(ds.t[i] - S.t[i]) > 1e-6 || Math.abs(ds.p[i] - S.p[i]) > 1e-6) return false;
        }
        return true;
    } catch (e) { return false; }
}

// Reset 'sample'-provenance Well & Test inputs to the store defaults with
// 'default' provenance (pi then resolves to null, testType to auto), so the
// demo's h, B, μ, ct, φ, rw never carry over to another well's data, and
// notify through PRiSM_setWell.
function PRiSM_releaseSampleInputs() {
    try {
        const s = window.PRiSM_pvt;
        if (!s || !s.provenance) return false;
        const released = [];
        Object.keys(s.provenance).forEach(function (k) {
            if (s.provenance[k] === 'sample') { s.provenance[k] = 'default'; released.push(k); }
        });
        if (!released.length) return false;
        const patch = {};
        const defs = (typeof window.PRiSM_pvt_defaults === 'function') ? window.PRiSM_pvt_defaults() : null;
        if (defs) {
            released.forEach(function (k) {
                if (k === 'testType' || k === 'provenance' || k === '_computed') return;
                if (Object.prototype.hasOwnProperty.call(defs, k)) patch[k] = defs[k];
            });
        }
        if (released.indexOf('testType') >= 0) patch.testType = 'auto';
        if (typeof window.PRiSM_setWell === 'function') {
            window.PRiSM_setWell(patch, { source: 'default', origin: 'dataset-change' });
            if (patch.testType) s.provenance.testType = 'default';
        }
        return true;
    } catch (e) { return false; }
}

// Seed the demo sample whenever PRiSM has no data — unless the user cleared
// it (Clear sets 'wts_prism_sample_suppress') or has their own text.
// opts.force (the "Try demo data" button) always loads it. Fills the textarea
// when it exists, persists the text, commits the dataset and applies the
// sample's well / fluid / test inputs. Returns true when it seeded.
function PRiSM_seedDefaultSample(textareaId, opts) {
    opts = opts || {};
    try {
        const ta = (typeof document !== 'undefined') ? document.getElementById(textareaId || 'prism_data_paste') : null;
        if (opts.force) {
            try { localStorage.removeItem('wts_prism_sample_suppress'); } catch (e) { /* ignore */ }
        } else {
            if (localStorage.getItem('wts_prism_sample_suppress')) return false;       // user cleared
            const cur = window.PRiSM_dataset;
            if (cur && cur.t && cur.t.length) return false;                            // already have data
            const sample = PRiSM_DEFAULT_SAMPLE_CSV.trim();
            if (ta && ta.value && ta.value.trim() && ta.value.trim() !== sample) return false;   // user text
            const persisted = PRiSM_persistedPaste().trim();
            if (persisted && persisted !== sample) return false;
        }
        if (ta) ta.value = PRiSM_DEFAULT_SAMPLE_CSV;
        PRiSM_persistPaste(PRiSM_DEFAULT_SAMPLE_CSV);
        const ds = PRiSM_datasetFromTextAny(PRiSM_DEFAULT_SAMPLE_CSV, { name: 'Demo data', source: 'sample' });
        if (!ds) return false;
        ds.name = 'Demo data';
        ds.source = 'sample';
        if (typeof window.PRiSM_setWell === 'function') {
            try { window.PRiSM_setWell(Object.assign({}, PRiSM_DEFAULT_SAMPLE_META), { source: 'sample' }); }
            catch (e) { if (typeof console !== 'undefined') console.warn('PRiSM_setWell(sample) failed:', e); }
        }
        PRiSM_commitDataset(ds, { source: 'sample' });
        return true;
    } catch (e) { return false; }
}

// "Try demo data": load the sample regardless of what is there.
function PRiSM_loadDemoData() {
    if (!PRiSM_seedDefaultSample('prism_data_paste', { force: true })) return null;
    // The demo is a pressure drawdown — leave rate-only (decline) mode.
    if (window.PRiSM && window.PRiSM.mode === 'decline') {
        window.PRiSM.mode = 'transient';
        PRiSM_emit('prism:mode-changed', { mode: 'transient' });
        PRiSM_SHELL.refresh();
    }
    // Basic Data tab on screen (07 not loaded) → refresh its preview.
    if (typeof document !== 'undefined' && typeof window.PRiSM_datasetFromText !== 'function' &&
        document.getElementById('prism_data_stats')) {
        PRiSM_basicShowParse(PRiSM_parseDataText(PRiSM_DEFAULT_SAMPLE_CSV));
        const msg = document.getElementById('prism_data_msg');
        if (msg) msg.innerHTML = '<span style="color:var(--green);">Demo data loaded (55 points, homogeneous drawdown).</span>';
    }
    return window.PRiSM_dataset;
}

if (typeof window !== 'undefined') {
    window.PRiSM_seedDefaultSample = PRiSM_seedDefaultSample;
    window.PRiSM_loadDemoData = PRiSM_loadDemoData;
    window.PRiSM_commitDataset = PRiSM_commitDataset;
}

// ── Basic Data tab (fallback renderer) ──
function PRiSM_renderTabData(host) {
    host.innerHTML = `
    <div class="cols-2">
      <div>
        <div class="card">
          <div class="card-title">Pressure / Rate Data</div>
          <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">
            Paste from Excel (tab-delimited) or CSV. Columns: <code>time</code> (hours),
            <code>pressure</code> (psia), <code>rate</code> (optional, STB/d or Mscf/d).
            A header row is detected and skipped.
          </div>
          <textarea id="prism_data_paste" class="data-textarea" style="min-height:220px; font-family:monospace; font-size:12px; width:100%;" placeholder="time,pressure,rate
0.01,3861.4,850
0.02,3705.0,850
..."></textarea>
          <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
            <input type="file" id="prism_data_file" accept=".csv,.txt" style="font-size:12px; color:var(--text2); max-width:100%;">
            <button class="btn btn-primary" id="prism_data_parse">Load data</button>
            <button class="btn btn-secondary" id="prism_data_demo">Try demo data</button>
            <button class="btn btn-secondary" id="prism_data_clear">Clear</button>
          </div>
          <div id="prism_data_msg" style="margin-top:8px; font-size:12px; color:var(--text2);"></div>
        </div>

        <div class="card">
          <div class="card-title">Multi-Rate History (optional)</div>
          <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">
            For superposition. One [time (h), rate] pair per rate change; rate = 0
            for a shut-in. Leave empty for a single-rate test.
          </div>
          <table class="dtable" id="prism_mrate_table">
            <thead><tr><th>Time (h)</th><th>Rate</th><th></th></tr></thead>
            <tbody id="prism_mrate_body"></tbody>
          </table>
          <div style="margin-top:8px;"><button class="btn btn-secondary" id="prism_mrate_add">+ Add row</button></div>
        </div>
      </div>

      <div>
        <div class="card">
          <div class="card-title">Summary</div>
          <div id="prism_data_stats">
            <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">Preview (first 10 + last 5)</div>
          <div id="prism_data_preview" style="overflow-x:auto;">
            <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>
          </div>
        </div>
      </div>
    </div>`;

    const PERSIST_IDS = ['prism_data_paste'];
    loadInputs('prism', PERSIST_IDS);
    if (PRiSM_seedDefaultSample('prism_data_paste')) saveInputs('prism', PERSIST_IDS);
    if (!window.PRiSM) window.PRiSM = {};
    if (!Array.isArray(window.PRiSM.multiRate)) window.PRiSM.multiRate = [];
    PRiSM_renderMultiRateRows();

    $('prism_data_file').onchange = function(ev) {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            $('prism_data_paste').value = e.target.result;
            saveInputs('prism', PERSIST_IDS);
            PRiSM_doParseData({ source: 'file', name: f.name });
        };
        reader.readAsText(f);
    };
    $('prism_data_parse').onclick = function () { PRiSM_doParseData(); };
    $('prism_data_demo').onclick = function () { PRiSM_loadDemoData(); saveInputs('prism', PERSIST_IDS); };
    $('prism_data_clear').onclick = function() {
        $('prism_data_paste').value = '';
        $('prism_data_preview').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        $('prism_data_stats').innerHTML   = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        $('prism_data_msg').textContent   = '';
        window.PRiSM_dataset = null;
        try { localStorage.setItem('wts_prism_sample_suppress', '1'); } catch (e) {}
        saveInputs('prism', PERSIST_IDS);
        PRiSM_emit('prism:dataset-cleared', { source: 'clear' });
    };
    $('prism_mrate_add').onclick = function() {
        window.PRiSM.multiRate.push({ t: 0, q: 0 });
        PRiSM_renderMultiRateRows();
        PRiSM_persistMultiRate();
    };

    // Show what is already there; commit only when nothing is active.
    const text = $('prism_data_paste').value;
    if (text.trim()) {
        const res = PRiSM_parseDataText(text);
        PRiSM_basicShowParse(res);
        const cur = window.PRiSM_dataset;
        if (!(cur && cur.t && cur.t.length) && res.rows.length) {
            PRiSM_commitDataset(PRiSM_basicDatasetFromText(text), { source: 'restored' });
        }
    }
}

// ── CSV / paste parser ──
// Handles tab, comma, semicolon, or whitespace separators. Auto-detects and
// skips a single header row by checking whether the first row contains any
// non-numeric cell. Returns { rows: [[...], ...], headerSkipped: bool,
// errors: [...] }.
function PRiSM_parseDataText(text) {
    if (typeof text !== 'string') return { rows: [], headerSkipped: false, errors: ['Empty input'] };
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (!lines.length) return { rows: [], headerSkipped: false, errors: ['Empty input'] };

    // Detect separator from the first non-empty line. Priority: tab > comma >
    // semicolon > whitespace.
    const sample = lines[0];
    let sep = /\s+/;
    if (sample.indexOf('\t') >= 0)      sep = /\t/;
    else if (sample.indexOf(',') >= 0)  sep = /,/;
    else if (sample.indexOf(';') >= 0)  sep = /;/;

    const split = (line) => line.split(sep).map(s => s.trim()).filter(s => s.length > 0);

    // Auto-detect a header. If any cell in the first row fails parseFloat
    // we treat the whole row as a header and skip it.
    const firstCells = split(lines[0]);
    const headerSkipped = firstCells.some(c => isNaN(parseFloat(c)));
    const startIdx = headerSkipped ? 1 : 0;

    const rows = [];
    const errors = [];
    for (let i = startIdx; i < lines.length; i++) {
        const cells = split(lines[i]);
        if (cells.length < 2) { errors.push('Row ' + (i + 1) + ': < 2 columns, skipped'); continue; }
        const nums = cells.map(c => parseFloat(c));
        if (nums.some(n => isNaN(n))) { errors.push('Row ' + (i + 1) + ': non-numeric cell, skipped'); continue; }
        rows.push(nums);
    }
    return { rows: rows, headerSkipped: headerSkipped, errors: errors, cols: rows.length ? rows[0].length : 0 };
}

// Summary + preview for a basic parse result (no commit).
function PRiSM_basicShowParse(result) {
    const stats = $('prism_data_stats'), prev = $('prism_data_preview');
    if (!stats || !prev) return;
    if (!result.rows.length) {
        prev.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        stats.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        return;
    }
    const t = result.rows.map(r => r[0]);
    const p = result.rows.map(r => r[1]);
    const q = result.rows.map(r => r.length >= 3 ? r[2] : null);
    const hasRate = q.every(v => v != null && !isNaN(v));
    const tMin = Math.min.apply(null, t), tMax = Math.max.apply(null, t);
    const pMin = Math.min.apply(null, p), pMax = Math.max.apply(null, p);
    const ratesSeen = hasRate ? Array.from(new Set(q.map(v => Math.round(v * 100) / 100))).sort((a, b) => a - b) : [];

    let statsHTML = '<div class="rbox" style="margin-bottom:0;">';
    statsHTML += '<div class="rrow"><span class="rl">Rows parsed</span><span class="rv">' + result.rows.length + '</span></div>';
    statsHTML += '<div class="rrow"><span class="rl">Header row</span><span class="rv">' + (result.headerSkipped ? 'detected &amp; skipped' : 'none') + '</span></div>';
    statsHTML += '<div class="rrow"><span class="rl">Time (h)</span><span class="rv">' + fmt(tMin, 4) + ' .. ' + fmt(tMax, 4) + '</span></div>';
    statsHTML += '<div class="rrow"><span class="rl">Pressure (psia)</span><span class="rv">' + fmt(pMin, 2) + ' .. ' + fmt(pMax, 2) + '</span></div>';
    if (hasRate) {
        const rateLabel = ratesSeen.length <= 6
            ? ratesSeen.map(v => fmt(v, 2)).join(', ')
            : (ratesSeen.length + ' distinct (' + fmt(Math.min.apply(null, ratesSeen), 2) + ' .. ' + fmt(Math.max.apply(null, ratesSeen), 2) + ')');
        statsHTML += '<div class="rrow"><span class="rl">Rates seen</span><span class="rv">' + rateLabel + '</span></div>';
    } else {
        statsHTML += '<div class="rrow"><span class="rl">Rates</span><span class="rv">— (no rate column)</span></div>';
    }
    if (result.errors.length) {
        statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Warnings</span><span class="rv">' + result.errors.length + ' rows skipped</span></div>';
    }
    statsHTML += '</div>';
    stats.innerHTML = statsHTML;

    const cols = result.rows[0].length;
    const headers = ['Time (h)', 'Pressure (psia)', 'Rate'].slice(0, cols);
    let html = '<table class="dtable"><thead><tr>';
    headers.forEach(h => { html += '<th>' + h + '</th>'; });
    html += '</tr></thead><tbody>';
    const showHead = Math.min(10, result.rows.length);
    const showTail = result.rows.length > 15 ? 5 : 0;
    for (let i = 0; i < showHead; i++) {
        html += '<tr>' + result.rows[i].map(v => '<td>' + fmt(v, 4) + '</td>').join('') + '</tr>';
    }
    if (showTail) {
        html += '<tr><td colspan="' + cols + '" style="text-align:center; color:var(--text3); font-style:italic;">… ' +
                (result.rows.length - showHead - showTail) + ' rows omitted …</td></tr>';
        for (let i = result.rows.length - showTail; i < result.rows.length; i++) {
            html += '<tr>' + result.rows[i].map(v => '<td>' + fmt(v, 4) + '</td>').join('') + '</tr>';
        }
    }
    html += '</tbody></table>';
    prev.innerHTML = html;
}

// ── Parse the textarea, show it, and make it the active dataset ──
function PRiSM_doParseData(meta) {
    meta = (meta && typeof meta === 'object' && !meta.type) ? meta : {};
    const ta = $('prism_data_paste');
    if (!ta) return null;
    const text = ta.value;
    const result = PRiSM_parseDataText(text);
    saveInputs('prism', ['prism_data_paste']);
    const msg = $('prism_data_msg');
    PRiSM_basicShowParse(result);
    if (!result.rows.length) {
        if (msg) msg.innerHTML = '<span style="color:var(--red);">No valid data rows. ' +
            PRiSM_escHTML(result.errors.length ? result.errors.slice(0, 3).join(' · ') : '') + '</span>';
        return null;
    }
    if (!window.PRiSM) window.PRiSM = {};
    window.PRiSM._parsed = result.rows;
    const ds = PRiSM_basicDatasetFromText(text);
    ds.name = meta.name || 'Pasted data';
    ds.source = meta.source || 'paste';
    PRiSM_commitDataset(ds, { source: ds.source });
    if (msg) msg.innerHTML = '<span style="color:var(--green);">Parsed ' + result.rows.length + ' rows (' + result.cols + ' cols). ' +
        'Dataset active: ' + ds.t.length + ' points.</span>' +
        (result.errors.length ? ' <span style="color:var(--yellow);">' + result.errors.length + ' rows skipped.</span>' : '');
    return ds;
}

// Kept for API compatibility: parsing already commits.
function PRiSM_doUseData() {
    return PRiSM_doParseData();
}

if (typeof window !== 'undefined') {
    // The enhanced Data tab (07) replaces these on load.
    if (typeof window.PRiSM_doParseData !== 'function') window.PRiSM_doParseData = PRiSM_doParseData;
    if (typeof window.PRiSM_doUseData !== 'function') window.PRiSM_doUseData = PRiSM_doUseData;
}

// ── Multi-rate history editor (table of [time, rate] rows) ──
function PRiSM_renderMultiRateRows() {
    if (typeof document === 'undefined') return;
    const tbody = document.getElementById('prism_mrate_body');
    if (!tbody) return;
    if (!window.PRiSM) window.PRiSM = {};
    if (!Array.isArray(window.PRiSM.multiRate)) window.PRiSM.multiRate = [];
    const rows = window.PRiSM.multiRate;
    const inputStyle = 'width:100%; min-width:0; padding:4px 6px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px;';
    let html = '';
    rows.forEach((row, idx) => {
        html += '<tr>' +
            '<td><input type="number" step="any" value="' + row.t + '" data-mrate-i="' + idx + '" data-mrate-k="t" aria-label="Time (h), row ' + (idx + 1) + '" style="' + inputStyle + '"></td>' +
            '<td><input type="number" step="any" value="' + row.q + '" data-mrate-i="' + idx + '" data-mrate-k="q" aria-label="Rate, row ' + (idx + 1) + '" style="' + inputStyle + '"></td>' +
            '<td><button class="btn btn-secondary" data-mrate-rm="' + idx + '" aria-label="Remove row ' + (idx + 1) + '" style="padding:4px 8px;">×</button></td>' +
        '</tr>';
    });
    if (!rows.length) {
        html = '<tr><td colspan="3" style="color:var(--text3); font-size:12px;">No rate changes entered — the test is treated as single-rate (or the rates in the data are used).</td></tr>';
    }
    tbody.innerHTML = html;
    tbody.querySelectorAll('input[data-mrate-i]').forEach(inp => {
        inp.oninput = function() {
            const i = parseInt(inp.dataset.mrateI, 10);
            const k = inp.dataset.mrateK;
            const v = parseFloat(inp.value);
            if (!isNaN(v) && window.PRiSM.multiRate[i]) {
                window.PRiSM.multiRate[i][k] = v;
                PRiSM_persistMultiRate();
            }
        };
    });
    tbody.querySelectorAll('button[data-mrate-rm]').forEach(btn => {
        btn.onclick = function() {
            const i = parseInt(btn.dataset.mrateRm, 10);
            window.PRiSM.multiRate.splice(i, 1);
            PRiSM_renderMultiRateRows();
            PRiSM_persistMultiRate();
        };
    });
}

function PRiSM_persistMultiRate() {
    try { localStorage.setItem('wts_prism_mrate', JSON.stringify((window.PRiSM && window.PRiSM.multiRate) || [])); }
    catch (e) { /* ignore quota errors */ }
}


// =============================================================================
// SECTION 6 — SELF-TEST
// =============================================================================
// Quick checks run when this file is executed on its own (node
// prism-build/01-foundation.js). Stripped from the app build by
// concat-phase1-2.js. Failures print to console.error.
// =============================================================================

// === SELF-TEST ===
(function PRiSM_selfTest() {
    const log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function(){};
    const err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function(){};
    const results = [];
    const near = (a, b, tol) => Math.abs(a - b) <= tol;
    // 1. Stehfest on F̂(s) = 1/s should give f(t) = 1 for any t.
    const t1 = PRiSM_stehfest(s => 1 / s, 1.0, 12);
    results.push({ name: 'Stehfest 1/s -> 1', ok: near(t1, 1, 1e-6), val: t1 });
    // 2. Stehfest on F̂(s) = 1/s² should give f(t) = t.
    const t2 = PRiSM_stehfest(s => 1 / (s * s), 2.5, 12);
    results.push({ name: 'Stehfest 1/s^2 -> t', ok: near(t2, 2.5, 1e-5), val: t2 });
    // 3. Bessel K0(1) ≈ 0.4210244382. K1(1) ≈ 0.6019072302.
    results.push({ name: 'K0(1) ≈ 0.4210', ok: near(PRiSM_besselK0(1), 0.4210244382, 1e-5), val: PRiSM_besselK0(1) });
    results.push({ name: 'K1(1) ≈ 0.6019', ok: near(PRiSM_besselK1(1), 0.6019072302, 1e-5), val: PRiSM_besselK1(1) });
    // 4. K1/K0 ratio: matches the direct ratio on both sides of x = 2, finite at x = 2000.
    const rA = PRiSM_besselK1overK0(3), rB = PRiSM_besselK1(3) / PRiSM_besselK0(3);
    results.push({ name: 'K1/K0 ratio matches direct (x=3)', ok: near(rA, rB, 1e-9), val: [rA, rB] });
    results.push({ name: 'K1/K0 ratio finite at x=2000', ok: isFinite(PRiSM_besselK1overK0(2000)) && near(PRiSM_besselK1overK0(2000), 1, 1e-3) });
    // 5. Homogeneous-reservoir model returns finite, monotone-increasing pwd.
    const pwd = PRiSM_model_homogeneous([0.1, 1, 10], { Cd: 100, S: 0 });
    const monotone = pwd.every((v, i) => isFinite(v) && (i === 0 || v >= pwd[i - 1]));
    results.push({ name: 'Homogeneous pwd finite & monotone', ok: monotone, val: pwd });
    // 6. Negative skin = S=0 at the scaled time (effective wellbore radius).
    const f = Math.exp(2 * -1.5);
    const a = PRiSM_model_homogeneous(50, { Cd: 20, S: -1.5 });
    const b = PRiSM_model_homogeneous(50 * f, { Cd: 20 * f, S: 0 });
    results.push({ name: 'S<0 equals S=0 at rwa scaling', ok: near(a, b, 1e-6 * Math.max(1, Math.abs(b))), val: [a, b] });
    // 7. S = −3, Cd = 100: monotone and late pd = 0.5(ln td + 0.80907) − 3.
    const tds = [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7];
    const pn = PRiSM_model_homogeneous(tds, { Cd: 100, S: -3 });
    const mono3 = pn.every((v, i) => isFinite(v) && (i === 0 || v > pn[i - 1]));
    const late = 0.5 * (Math.log(1e7) + 0.80907) - 3;
    results.push({ name: 'S=-3 monotone', ok: mono3, val: pn });
    results.push({ name: 'S=-3 late pd = 0.5(ln td+0.80907)-3', ok: near(pn[pn.length - 1], late, 0.01), val: [pn[pn.length - 1], late] });
    const dn = PRiSM_model_homogeneous_pd_prime(1e7, { Cd: 100, S: -3 });
    results.push({ name: 'S=-3 late derivative 0.5', ok: near(dn, 0.5, 0.01), val: dn });
    // 8. S = −7, Cd = 1e4: finite for td 1 … 1e6.
    const tds7 = [1, 3, 10, 20, 30, 100, 1e3, 1e4, 1e5, 1e6];
    const p7 = PRiSM_model_homogeneous(tds7, { Cd: 1e4, S: -7 });
    const d7 = PRiSM_model_homogeneous_pd_prime(tds7, { Cd: 1e4, S: -7 });
    results.push({ name: 'S=-7 pd finite td 1..1e6', ok: p7.every(v => isFinite(v) && v > 0), val: p7 });
    results.push({ name: 'S=-7 pd\' finite td 1..1e6', ok: d7.every(v => isFinite(v)), val: d7 });
    // 9. Early time with S < 0 is pure storage: pd ≈ td/Cd.
    const pe = PRiSM_model_homogeneous(1e-4, { Cd: 1e4, S: -7 });
    results.push({ name: 'S=-7 early pd = td/Cd', ok: near(pe, 1e-8, 1e-10), val: pe });
    // 10. Shell mapping: steps ↔ tabs.
    results.push({ name: 'step for tab 1..7', ok: [1, 2, 3, 4, 5, 6, 7].map(PRiSM_SHELL.stepForTab).join(',') === '1,3,4,4,4,4,5' });
    results.push({ name: 'compact label step 3', ok: PRiSM_SHELL.compactLabel(3) === '③ Diagnose · 3/5 ›' });
    // 11. Basic parser: sample → 55 rows × 3 cols.
    const pr = PRiSM_parseDataText(PRiSM_DEFAULT_SAMPLE_CSV);
    results.push({ name: 'sample parses 55×3', ok: pr.rows.length === 55 && pr.cols === 3 && pr.headerSkipped });
    const fails = results.filter(r => !r.ok);
    if (fails.length) {
        err('PRiSM self-test FAILED:', fails);
    } else {
        log('PRiSM self-test passed (' + results.length + ' checks).');
    }
})();
