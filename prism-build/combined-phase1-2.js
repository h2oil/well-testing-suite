// ══════════════════════════════════════════════════════════════════════════
// PRiSM ─ Pressure Reservoir Inversion & Simulation Model
// Auto-assembled from prism-build/{01-foundation,03-models,02-plots}.js
// by prism-build/concat-phase1-2.js (self-tests stripped)
// ══════════════════════════════════════════════════════════════════════════

// ─── BEGIN 01-foundation ─────────────────────────────────────────────────
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

// ── Exponential integral E1(x) and the exponential integral Ei(x) ──
// Definitions (Abramowitz & Stegun 1964, §5.1.1-5.1.2):
//   E1(x) = ∫_x^∞ e^{-t}/t dt,           x > 0   (the Theis well function W(u))
//   Ei(x) = −PV∫_{−x}^∞ e^{-t}/t dt,     x ≠ 0,  so  Ei(−x) = −E1(x)  (A&S 5.1.7)
//
//   PRiSM_E1(x)  — E1(x), x > 0. A&S 5.1.11 power series for 0 < x ≤ 1 and
//                  the continued fraction (A&S 5.1.22, Lentz) for x > 1.
//   PRiSM_Ei(x)  — the true exponential integral for every real x ≠ 0:
//                  x < 0 → −E1(−x) (the line-source form pD = −½Ei(−rD²/4tD));
//                  x > 0 → γ + ln x + Σ xⁿ/(n·n!) (A&S 5.1.10) for x ≤ 40,
//                  asymptotic eˣ/x·Σ k!/xᵏ (A&S 5.1.51) above; Ei(0) = −∞.
//   (Before v3.0 PRiSM_Ei(x > 0) returned E1(x), which is neither convention;
//   nothing in the app called it with a positive argument.)

function PRiSM_E1(x) {
    if (!(x > 0) || !isFinite(x)) throw new Error('PRiSM_E1: x must be > 0 and finite (got ' + x + ')');
    if (x <= 1.0) {
        // A&S 5.1.11: -ln(x) - γ - Σ ((-x)^n / (n·n!)). Converges fast for x ≤ 1.
        let sum = 0;
        let term = 1;
        for (let n = 1; n <= 60; n++) {
            term *= -x / n;
            const add = -term / n;
            sum += add;
            if (Math.abs(add) < 1e-16 * Math.abs(sum)) break;
        }
        return -Math.log(x) - 0.5772156649015329 + sum;
    }
    // Continued fraction (Lentz's method). Converges for x > 1.
    const TINY = 1e-300;
    let b = x + 1.0;
    let c = 1.0 / TINY;
    let d = 1.0 / b;
    let h = d;
    for (let i = 1; i <= 200; i++) {
        const a = -i * i;
        b += 2.0;
        d = 1.0 / (a * d + b); if (d === 0) d = TINY;
        c = b + a / c;          if (c === 0) c = TINY;
        const delta = c * d;
        h *= delta;
        if (Math.abs(delta - 1.0) < 1e-14) break;
    }
    return h * Math.exp(-x);
}

// Exponential integral Ei(x) for all real x (see the block comment above).
function PRiSM_Ei(x) {
    if (typeof x !== 'number' || x !== x) return NaN;
    if (x === 0) return -Infinity;
    if (x === -Infinity) return 0;
    if (x === Infinity) return Infinity;
    if (x < 0) return -PRiSM_E1(-x);                 // A&S 5.1.7
    if (x <= 40) {                                   // A&S 5.1.10
        let sum = 0, term = 1;
        for (let n = 1; n <= 200; n++) {
            term *= x / n;
            const add = term / n;
            sum += add;
            if (add < 1e-17 * sum) break;
        }
        return 0.5772156649015329 + Math.log(x) + sum;
    }
    let s = 1, t = 1;                                // A&S 5.1.51 asymptotic
    for (let k = 1; k <= 40; k++) {
        const tn = t * k / x;
        if (tn > t) break;
        t = tn; s += t;
        if (t < 1e-17) break;
    }
    return Math.exp(x) / x * s;
}

// Expose foundation versions on window; 09-interference-multilateral uses
// window.PRiSM_E1 for its line-source (Theis) well function.
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
        '.prism-units-note{margin:0 0 10px;padding:7px 10px;border:1px solid var(--orange,#d29922);border-radius:6px;font-size:12px;color:var(--text2);background:var(--bg2)}',
        '.prism-units-note[hidden]{display:none}',
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
          '<div class="prism-units-note" id="prism_units_note" role="note"' + (isMetric() ? '' : ' hidden') + '>' +
            PRiSM_escHTML(UNITS_NOTE) + '</div>' +
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

    // PRiSM is deliberately field-unit only (psia, h, STB/d | Mscf/d, md, ft,
    // cp, 1/psi): the units layer (22) does not convert it. In Metric mode the
    // shell says so instead of showing field-unit labels without comment.
    const UNITS_NOTE = 'PRiSM works in oilfield units (psia, hours, STB/d or Mscf/d, md, ft, cp, 1/psi). ' +
        'The Metric setting does not convert PRiSM inputs or results — enter and read values in these units.';
    function isMetric() {
        try {
            const U = hasWin() ? window.WTS_units : null;
            if (U && typeof U.getSystem === 'function') return U.getSystem() === 'metric';
            return hasWin() && window.WTS_unitsSystem === 'metric';
        } catch (e) { return false; }
    }
    function syncUnitsNote() {
        const el = byId('prism_units_note');
        if (!el) return;
        if (isMetric()) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
    }
    function ensureListeners() {
        if (listenersOn || !hasWin()) return;
        listenersOn = true;
        if (hasDoc() && typeof document.addEventListener === 'function') document.addEventListener('wts:unit-system-changed', syncUnitsNote);
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
                // Re-apply a crop window saved for this record (12-data-crop.js).
                if (typeof window.PRiSM_restorePersistedCrop === 'function') {
                    try { window.PRiSM_restorePersistedCrop(); } catch (e) { /* optional */ }
                }
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


// ─── END 01-foundation ───────────────────────────────────────────────────

// ─── BEGIN 03-models ─────────────────────────────────────────────────
// =============================================================================
// PRiSM — Phase 2 Type-Curve Models (model kernels I)
// =============================================================================
// Pressure Reservoir inversion & Simulation Model — Advanced Well Test Analysis
//
// This file owns the Laplace-domain kernels for the 03 model family plus the
// shared wellbore-storage/skin evaluator used by the rest of the model library:
//
//   homogeneous      #1   vertical well, finite wellbore, WBS + skin
//   infiniteFrac     #3   infinite-conductivity (or uniform-flux) fracture
//   finiteFrac       #4   finite-conductivity fracture (semi-analytic)
//   inclined         #7   slant well (homogeneous + Cinco-Ley pseudo-skin)
//   horizontal       #8   horizontal well (uniform-flux line source in a slab)
//   linearBoundary   #10a single sealing / constant-pressure boundary
//   parallelChannel  #10b two parallel sealing faults
//   closedChannel3   #10c channel closed at one end
//   closedRectangle  #10d closed rectangle, well anywhere inside
//   intersecting     #10e two intersecting sealing faults
//   fogBoundary      #10f leaky fault (constant partial-image approximation)
//   finiteFracSkin   #12  finite-conductivity fracture + fracture-face skin
//   partialPenFrac   #30  partial-height fracture (Green's-function shortcut)
//
// Universal signature for every model:
//
//   PRiSM_model_<name>(td, params) -> pd                (number or array)
//   PRiSM_model_<name>_pd_prime(td, params) -> pd'      (td·dpd/dtd, Bourdet
//                                                         derivative, no
//                                                         superposition)
//
// Units & conventions
//  - Everything here is dimensionless. td is referenced to the model's
//    reference length (registry `refLength`: 'rw', 'xf' or 'Lh').
//    pD = kh·Δp / (141.2 qBμ) in field units, i.e. referenced to the
//    formation kh, for every model.
//  - Wellbore storage Cd and skin S are folded in the Laplace domain:
//
//                    s·p̄ + S
//      p̄_wD = ----------------------------          p̄ = reservoir solution
//              s · ( 1 + Cd·s·(s·p̄ + S) )               (no WBS, no skin)
//
//    (Agarwal-Al-Hussainy-Ramey 1970). This is done in ONE place,
//    PRiSM_evalWbsSkin(), exported for every other model file.
//  - Negative skin. The fold has a pole where s·p̄ + S = 0 when S < 0. For
//    S < 0 we therefore use the effective-wellbore-radius transform
//    (rwa = rw·e^−S): evaluate the S = 0 problem at tDa = td·e^{2S},
//    CDa = Cd·e^{2S}, with rw-normalised distances multiplied by e^{S}.
//    pD is invariant and td·dpD/dtd = tDa·dpD/dtDa. For xf / Lh referenced
//    models the same transform is applied to time and storage only
//    (an effective-length stretch); their shape parameters are unchanged.
//  - rw-referenced models use the finite-wellbore well term
//      p̄_w = K0(√s) / ( s·√s·K1(√s) )
//    and image wells  K0(√s·r) / ( s·√s·K1(√s) ),  evaluated with
//    exponentially scaled Bessel functions so nothing underflows to 0/0 at
//    large s (very early time or strongly negative skin).
//  - The Bourdet derivative is computed in the Laplace domain:
//    td·dpD/dtd = td · L⁻¹[ s·p̄_wD(s) ](td)  (pD(0+) = 0), inverted with the
//    same Stehfest weights, so derivative and pressure are consistent.
//  - Image lattices (channel, 3-sided channel, rectangle) are summed with the
//    Laplace transform of the product of two 1-D theta functions:
//
//      Σ_images K0(√s·r_i) = ∫_0^∞ e^{−st} [Θx(t)·Θy(t) − 1] / (2t) dt
//
//    where Θ(t) = Σ_offsets e^{−d²/(4t)} is evaluated in its image form for
//    small t and in its Fourier (Poisson-summed) form for large t. The
//    integral is done with the trapezoid rule in ln t (double-exponential
//    decay at both ends). This has no image-count cap, honours the well
//    position, and reaches pseudo-steady state exactly (Θ grows as √t).
//
// References inline above each evaluator.
// =============================================================================

(function () {
'use strict';

var _G = (typeof window !== 'undefined') ? window
       : (typeof globalThis !== 'undefined' ? globalThis : {});

// ---- foundation primitives ------------------------------------------------
// The foundation file (01) declares its primitives as plain functions / consts
// in the host IIFE scope (not on window). Resolve by name: window first, then
// the lexical scope via a guarded direct eval (identifier names only).
// Nothing in this file REQUIRES the foundation: the Stehfest weights and the
// Bessel functions below are self-contained, so the file also runs standalone.
var _fcache = {};
function _foundation(name) {
  if (_fcache[name]) return _fcache[name];
  var f = null;
  if (_G[name] != null && (typeof _G[name] === 'function' || typeof _G[name] === 'object')) {
    f = _G[name];
  } else if (/^[A-Za-z_$][\w$]*$/.test(name)) {
    try { f = eval(name); } catch (e) { f = null; }
  }
  if (f != null) _fcache[name] = f;
  return f;
}

// ============================================================================
// SECTION 1 — Numerics: Stehfest, scaled Bessel K, ∫K0
// ============================================================================

var STEHFEST_N = 12;
var EULER      = 0.5772156649015329;
var HALF_PI    = Math.PI / 2;

var _W12 = null;
function _stehfestWeights() {
  if (_W12) return _W12;
  var tbl = _foundation('PRiSM_STEHFEST_W');
  if (tbl && tbl[STEHFEST_N] && tbl[STEHFEST_N].length === STEHFEST_N) {
    _W12 = tbl[STEHFEST_N];
    return _W12;
  }
  // Local copy of the same Stehfest (1970) weights (only used standalone).
  var N = STEHFEST_N, N2 = N / 2, fact = [1];
  for (var i = 1; i <= 2 * N; i++) fact[i] = fact[i - 1] * i;
  var W = new Array(N);
  for (var n = 1; n <= N; n++) {
    var sum = 0;
    for (var k = Math.floor((n + 1) / 2); k <= Math.min(n, N2); k++) {
      sum += Math.pow(k, N2) * fact[2 * k] /
             (fact[N2 - k] * fact[k] * fact[k - 1] * fact[n - k] * fact[2 * k - n]);
    }
    W[n - 1] = (((n + N2) % 2 === 0) ? 1 : -1) * sum;
  }
  _W12 = W;
  return W;
}

// f(t) ≈ (ln2/t) Σ V_i F(i ln2 / t)
function _invert(F, t) {
  var W = _stehfestWeights();
  var a = Math.LN2 / t, acc = 0;
  for (var i = 1; i <= STEHFEST_N; i++) acc += W[i - 1] * F(i * a);
  return a * acc;
}

// Modified Bessel functions to ~1e-15 relative. The Laplace kernels are
// inverted with Stehfest, which amplifies any non-smooth error in F(s) by
// ~1e5, so the 1e-7 polynomial approximations are not good enough here.
//  x ≤ 2 : ascending series (A&S 9.6.10-13)
//  x > 2 : trapezoid rule on K_ν(x)·e^x = ∫_0^∞ e^{−x(cosh u − 1)} cosh(νu) du
//          (analytic in |Im u| < π/2 → error ~ e^{−π²/h}; h = 0.2 → 1e-21).
var BESSEL_H = 0.2;
function _KsmallPair(x) {            // [K0(x), K1(x)] by series, 0 < x ≤ 2
  var y = x * x / 4, lx = Math.log(x / 2);
  var t0 = 1, t1 = 1;                // (y^k/(k!)^2), (y^k/(k!(k+1)!))
  var I0 = 0, I1s = 0, s0 = 0, s1 = 0, psi = -EULER, psi1 = 1 - EULER;
  for (var k = 0; k < 60; k++) {
    if (k > 0) {
      t0 *= y / (k * k); t1 *= y / (k * (k + 1));
      psi += 1 / k; psi1 += 1 / (k + 1);
    }
    I0 += t0; I1s += t1;
    s0 += psi * t0; s1 += (psi + psi1) * t1;
    if (t0 < 1e-18 * I0 && k > 2) break;
  }
  var I1 = (x / 2) * I1s;
  return [-lx * I0 + s0, 1 / x + lx * I1 - (x / 4) * s1];
}
function _KePair(x) {                // [K0e(x), K1e(x)] for x > 2
  var h = BESSEL_H, s0 = 0.5, s1 = 0.5;
  for (var k = 1; k < 400; k++) {
    var u = k * h, ch = Math.cosh(u), e = Math.exp(-x * (ch - 1));
    s0 += e; s1 += e * ch;
    if (e * ch < 1e-18 * s1) break;
  }
  return [s0 * h, s1 * h];
}
function _K0e(x) {
  if (x <= 2) return _KsmallPair(x)[0] * Math.exp(x);
  return _KePair(x)[0];
}
function _K1e(x) {
  if (x <= 2) return _KsmallPair(x)[1] * Math.exp(x);
  return _KePair(x)[1];
}
function _K0(x) {
  if (!(x > 0)) return Infinity;
  if (x <= 2) return _KsmallPair(x)[0];
  if (x > 740) return 0;
  return _KePair(x)[0] * Math.exp(-x);
}

// ∫_0^z K0(t) dt: exact term-by-term integral of the K0 ascending series for
// z ≤ 2; beyond, π/2 − T(z) with T(z) = ∫_z^∞ K0 = ∫_0^∞ e^{−z cosh u}/cosh u du
// (trapezoid, same exponential accuracy as above).
function _tailK0(z) {                 // ∫_z^∞ K0(t) dt
  if (!(z > 0)) return HALF_PI;
  if (z <= 2) return HALF_PI - _intK0(z);
  if (z > 740) return 0;
  var h = BESSEL_H, s = 0.5;
  for (var k = 1; k < 400; k++) {
    var ch = Math.cosh(k * h), e = Math.exp(-z * (ch - 1)) / ch;
    s += e;
    if (e < 1e-18 * s) break;
  }
  return s * h * Math.exp(-z);
}
function _intK0(z) {
  if (!(z > 0)) return 0;
  if (z > 2) return HALF_PI - _tailK0(z);
  var w = z / 2, lnw = Math.log(w), w2 = w * w;
  var pw = w, ak = 1, Hk = 0, sum = 0;
  for (var k = 0; k < 400; k++) {
    if (k > 0) { ak /= (k * k); Hk += 1 / k; pw *= w2; }
    var inv = 1 / (2 * k + 1);
    var term = ak * 2 * pw * inv * (Hk - EULER - lnw + inv);
    sum += term;
    if (k > w && Math.abs(term) <= 1e-17 * Math.abs(sum)) break;
  }
  return sum;
}

// ---- Laplace building blocks (reservoir p̄, no WBS / skin) ---------------
// finite-wellbore well term  K0(√s) / (s √s K1(√s))
function _wellTerm(s) {
  var q = Math.sqrt(s);
  return _K0e(q) / (s * q * _K1e(q));
}
// image well at distance r (rw units)  K0(√s r) / (s √s K1(√s))
function _imageTerm(s, r) {
  var q = Math.sqrt(s);
  if (!(r > 0)) return 0;
  var num;
  if (r >= 1) {
    var e = q * (r - 1);
    if (e > 740) return 0;
    num = _K0e(q * r) * Math.exp(-e);
  } else {
    num = _K0(q * r) * Math.exp(Math.min(q, 700));
  }
  return num / (s * q * _K1e(q));
}
// convert a raw image sum B = Σ K0(√s r_i) into the finite-wellbore form
function _latticeTerm(s, B) {
  if (!(B > 0)) return 0;
  var q = Math.sqrt(s);
  var lg = Math.log(B) + q;
  if (lg > 700) lg = 700;
  return Math.exp(lg) / (s * q * _K1e(q));
}

// ---- Theta-function lattice sums ------------------------------------------
// axis spec:
//   null                               no boundary on this axis (Θ = 1)
//   {finite:[d1, d2, ...]}             finite set of non-zero image offsets
//   {L, w}                             two walls a distance L apart, well at w
//                                      from the first: offsets {2iL} ∪ {2w+2iL}
function _axisRmin(ax) {
  if (!ax) return Infinity;
  if (ax.finite) {
    var m = Infinity;
    for (var i = 0; i < ax.finite.length; i++) m = Math.min(m, Math.abs(ax.finite[i]));
    return m;
  }
  return Math.min(2 * ax.L, 2 * ax.w, 2 * (ax.L - ax.w));
}
function _thetaM1(ax, t) {           // Θ(t) − 1  (the zero offset excluded)
  if (!ax) return 0;
  var sum = 0, i, e;
  if (ax.finite) {
    for (i = 0; i < ax.finite.length; i++) {
      e = ax.finite[i] * ax.finite[i] / (4 * t);
      if (e < 745) sum += Math.exp(-e);
    }
    return sum;
  }
  var L = ax.L, w = ax.w;
  if (t < L * L) {
    // image form: Σ_{i≠0} e^{-i²L²/t} + Σ_i e^{-(w+iL)²/t}
    for (i = 1; i < 1000; i++) {
      e = i * i * L * L / t;
      if (e > 745) break;
      sum += 2 * Math.exp(-e);
    }
    for (i = 0; i < 1000; i++) {
      e = (w + i * L) * (w + i * L) / t;
      if (e > 745) break;
      sum += Math.exp(-e);
    }
    for (i = -1; i > -1000; i--) {
      e = (w + i * L) * (w + i * L) / t;
      if (e > 745) break;
      sum += Math.exp(-e);
    }
    return sum;
  }
  // Fourier (Poisson) form: Θ = (√(πt)/L)[2 + 2Σ e^{-m²π²t/L²}(1 + cos(2mπw/L))]
  var a = Math.PI * Math.PI * t / (L * L), f = 2;
  for (var m = 1; m < 50; m++) {
    e = m * m * a;
    if (e > 745) break;
    f += 2 * Math.exp(-e) * (1 + Math.cos(2 * m * Math.PI * w / L));
  }
  return Math.sqrt(Math.PI * t) / L * f - 1;
}
// Σ_images K0(√s r) over the product lattice of two axes
var LATTICE_H = 0.1;          // trapezoid step in ln t
function _latticeK0Sum(s, ax, ay) {
  var rmin = Math.min(_axisRmin(ax), _axisRmin(ay));
  if (!isFinite(rmin) || !(rmin > 0)) return 0;
  var q = Math.sqrt(s);
  if (q * rmin > 80) return 0;                 // < e^-80 relative: negligible
  var vlo = Math.log(rmin * rmin / 200);
  var vhi = Math.log(50 / s);
  if (vhi <= vlo) return 0;
  var n = Math.ceil((vhi - vlo) / LATTICE_H);
  var h = (vhi - vlo) / n, sum = 0;
  for (var k = 0; k <= n; k++) {
    var t = Math.exp(vlo + k * h);
    var gx = _thetaM1(ax, t), gy = _thetaM1(ay, t);
    var g = gx * gy + gx + gy;
    if (g === 0) continue;
    var val = 0.5 * Math.exp(-s * t) * g;
    sum += (k === 0 || k === n) ? 0.5 * val : val;
  }
  return sum * h;
}

// ============================================================================
// SECTION 2 — Shared WBS + skin evaluator  (window.PRiSM_evalWbsSkin)
// ============================================================================
//
//   PRiSM_evalWbsSkin(lapRes, td, Cd, S, opts) → pd (or pd' when
//                                                opts.derivative) for td
//                                                number | array
//     lapRes(s, dScale) → reservoir p̄(s) (no WBS, no skin). dScale is the
//                          factor to apply to rw-normalised distances
//                          (1, or e^{S} under the S < 0 transform).
//     opts.scaleDistances  (default true) pass dScale = e^S when S < 0;
//                          false → dScale is always 1 (xf / Lh models).
//     opts.derivative      return td·dpd/dtd instead of pd.
//
// Pure-storage fast path: when tDa < min(1e-3·CDa, 1e-12·CDa²) the response is
// pd = td/Cd to better than ~1e-6 relative (the first correction is
// O(√tDa/CDa)), and so is the derivative.

function _fold(u, s, C, S) {
  var inner = u + S;
  return inner / (s * (1 + C * s * inner));
}

function _evalOne(lapRes, t, Cd, S, scaleDist, deriv) {
  if (!(t > 0)) return 0;
  var C = (Cd > 0) ? Cd : 0, SS = S || 0, tt = t, dScale = 1;
  if (SS < 0) {
    var e2 = Math.exp(2 * SS);
    tt = t * e2; C = C * e2;
    dScale = scaleDist ? Math.exp(SS) : 1;
    SS = 0;
  }
  if (C > 0 && tt < Math.min(1e-3 * C, 1e-12 * C * C)) return tt / C;
  var F = function (s) {
    var pbar = lapRes(s, dScale);
    return _fold(s * pbar, s, C, SS);
  };
  var v;
  if (deriv) v = tt * _invert(function (s) { return s * F(s); }, tt);
  else v = _invert(F, tt);
  return v;
}

function PRiSM_evalWbsSkin(lapRes, td, Cd, S, opts) {
  if (typeof lapRes !== 'function') throw new Error('PRiSM_evalWbsSkin: lapRes must be a function');
  opts = opts || {};
  var scaleDist = opts.scaleDistances !== false;
  var deriv = !!opts.derivative;
  if (!isFinite(Cd)) throw new Error('PRiSM_evalWbsSkin: Cd must be finite');
  if (!isFinite(S)) throw new Error('PRiSM_evalWbsSkin: S must be finite');
  if (Array.isArray(td)) {
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) out[i] = _evalOne(lapRes, +td[i], Cd, S, scaleDist, deriv);
    return out;
  }
  return _evalOne(lapRes, +td, Cd, S, scaleDist, deriv);
}

// ============================================================================
// SECTION 3 — Parameter helpers
// ============================================================================

function _num(v) { return (typeof v === 'number') && isFinite(v); }

function _checkTd(td) {
  if (Array.isArray(td)) {
    for (var i = 0; i < td.length; i++) {
      if (typeof td[i] !== 'number' || isNaN(td[i])) {
        throw new Error('PRiSM model: td must be numeric (got ' + td[i] + ' at index ' + i + ')');
      }
    }
  } else if (typeof td !== 'number' || isNaN(td)) {
    throw new Error('PRiSM model: td must be numeric (got ' + td + ')');
  }
}

// Merge params over the model defaults; reject NaN / Infinity values.
function _prep(params, defaults) {
  if (params != null && typeof params !== 'object') {
    throw new Error('PRiSM model: params object required');
  }
  var p = {}, k;
  for (k in defaults) if (Object.prototype.hasOwnProperty.call(defaults, k)) p[k] = defaults[k];
  if (params) {
    for (k in params) {
      if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
      var v = params[k];
      if (v == null) continue;
      if (typeof v === 'number' && !isFinite(v)) {
        throw new Error('PRiSM model: param "' + k + '" is NaN/Infinity');
      }
      p[k] = v;
    }
  }
  if (!_num(p.Cd) || p.Cd < 0) throw new Error('PRiSM model: Cd must be ≥ 0 (got ' + p.Cd + ')');
  return p;
}

function _positive(name, v) {
  if (!_num(v) || v <= 0) throw new Error('PRiSM model: ' + name + ' must be > 0 (got ' + v + ')');
  return v;
}

// h/rw injected by the physical-model wrapper as '__h_rw' (default 100)
function _hRw(p) {
  var v = p.__h_rw;
  return (_num(v) && v > 1) ? v : 100;
}

// ============================================================================
// SECTION 4 — Pseudo-skin library  (window.PRiSM_pseudoSkin)
// ============================================================================

// Brons & Marting (1961) partial-penetration pseudo-skin
//   Sp = (1/b − 1)·[ln hD − G(b)],  G(b) = 2.948 − 7.363b + 11.45b² − 4.675b³
//   b = hp/h (open fraction), hD = (h/rw)·√(kh/kv).
// Call as bronsMarting(b, hD) or bronsMarting(b, h, rw, kvkh).
function _bronsMarting(b, hD, rw, kvkh) {
  if (arguments.length >= 3) {
    var kk = (_num(kvkh) && kvkh > 0) ? kvkh : 1;
    hD = (hD / rw) * Math.sqrt(1 / kk);
  }
  if (!_num(b) || b <= 0) return NaN;
  if (b >= 1) return 0;
  if (!_num(hD) || hD <= 0) return NaN;
  var G = 2.948 - 7.363 * b + 11.45 * b * b - 4.675 * b * b * b;
  return (1 / b - 1) * (Math.log(hD) - G);
}

// Cinco-Ley, Ramey & Miller (1975) slant-well pseudo-skin
//   S_θ = −(θ'/41)^2.06 − (θ'/56)^1.865 · log10(hD/100)
//   θ' = atan(√(kv/kh)·tanθ) [deg],  hD = (h/rw)·√(kh/kv).
// Call as cincoLey(thetaDeg, kvkh, h_over_rw) or cincoLey(thetaDeg, kvkh, h, rw).
function _cincoLey(thetaDeg, kvkh, hRw, rw) {
  var kk = (_num(kvkh) && kvkh > 0) ? kvkh : 1;
  var ratio = (arguments.length >= 4 && _num(rw) && rw > 0) ? hRw / rw : hRw;
  if (!_num(ratio) || ratio <= 0) ratio = 100;
  if (!_num(thetaDeg)) return NaN;
  var th = Math.abs(thetaDeg);
  if (th === 0) return 0;
  if (th >= 90) th = 89.999;
  var thP = Math.atan(Math.sqrt(kk) * Math.tan(th * Math.PI / 180)) * 180 / Math.PI;
  var hD = ratio * Math.sqrt(1 / kk);
  return -Math.pow(thP / 41, 2.06) - Math.pow(thP / 56, 1.865) * (Math.log(hD / 100) / Math.LN10);
}

// Equivalent (pseudo-radial) skin of a vertical fracture referenced to rw.
//   'infinite'    infinite conductivity:  rw' = xf/2        → S = ln(2rw/xf)
//   'uniformFlux' uniform flux:           rw' = xf/e        → S = ln(e·rw/xf)
//   'finite'      finite conductivity FcD (4th argument), unified-fracture-
//                 design correlation (Economides et al. 2002):
//                 S + ln(xf/rw) = (1.65 − 0.328u + 0.116u²)/(1 + 0.180u + 0.064u² + 0.005u³),
//                 u = ln FcD  (→ ln 2 as FcD → ∞)
function _fractureSkin(xf, rw, type, FcD) {
  if (!_num(xf) || xf <= 0 || !_num(rw) || rw <= 0) return NaN;
  var t = type || 'infinite';
  if (t === 'uniformFlux' || t === 'uniform') return 1 + Math.log(rw / xf);
  if (t === 'finite') {
    if (!_num(FcD) || FcD <= 0) return NaN;
    var u = Math.log(FcD);
    var f = (1.65 - 0.328 * u + 0.116 * u * u) /
            (1 + 0.180 * u + 0.064 * u * u + 0.005 * u * u * u);
    return f - Math.log(xf / rw);
  }
  return Math.log(2 * rw / xf);
}

// Joshi-type equivalent skin of a horizontal well of total length L, for
// REPORTING ONLY (the horizontal kernel models the geometry exactly).
// Joshi (1988) productivity with the Economides anisotropy correction, in the
// limit of a large drainage radius, equated to a vertical well:
//   S_eq = ln(4·rw/L) + (βh/L)·ln( βh / ((β+1)·rw) ),   β = √(kh/kv)
function _horizontalEquivalent(L, h, rw, kvkh) {
  if (!_num(L) || L <= 0 || !_num(h) || h <= 0 || !_num(rw) || rw <= 0) return NaN;
  var kk = (_num(kvkh) && kvkh > 0) ? kvkh : 1;
  var beta = Math.sqrt(1 / kk);
  return Math.log(4 * rw / L) + (beta * h / L) * Math.log(beta * h / ((beta + 1) * rw));
}

// ============================================================================
// SECTION 5 — MODEL #1 — Homogeneous (vertical well, WBS + skin)
// ============================================================================
// Reference: Agarwal, Al-Hussainy & Ramey, SPEJ Sept 1970; Mavor & Cinco-Ley
//   SPE 7977. Same closed form as the foundation PRiSM_model_homogeneous for
//   S ≥ 0; negative skin goes through the effective-radius transform so the
//   Laplace fold never meets its pole.
// Params: { Cd, S }        refLength: rw
// ============================================================================

var HOM_DEFAULTS = { Cd: 100, S: 0 };
function _lapHom(s) { return _wellTerm(s); }

function PRiSM_model_homogeneous_rwa(td, params) {
  _checkTd(td);
  var p = _prep(params, HOM_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, p.S);
}
function PRiSM_model_homogeneous_rwa_pd_prime(td, params) {
  _checkTd(td);
  var p = _prep(params, HOM_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, p.S, { derivative: true });
}

// ============================================================================
// SECTION 6 — MODEL #3 — Infinite-conductivity fracture
// ============================================================================
// Reference: Gringarten, Ramey & Raghavan, SPEJ Aug 1974.
//   Uniform-flux fracture observed at xD = 0.732 (reproduces the
//   infinite-conductivity solution), Laplace form:
//     p̄ = [ ∫_0^{√s(1+0.732)} K0 + ∫_0^{√s(1−0.732)} K0 ] / (2 s √s)
//   params.uniformFlux truthy → observed at xD = 0:  p̄ = ∫_0^{√s} K0 / (s √s).
//   Early time: pD = √(π tD) (half slope); late: ½(ln tD + 2.2).
//   Always evaluated in Laplace (Cd = 0 is continuous with Cd → 0).
// Params: { Cd, S }        refLength: xf     (tD = 0.0002637 k t /(φ μ ct xf²))
// ============================================================================

var XD_INF = 0.732;
function _lapInfFrac(s, uniformFlux) {
  var q = Math.sqrt(s);
  if (uniformFlux) return _intK0(q) / (s * q);
  return (_intK0(q * (1 + XD_INF)) + _intK0(q * (1 - XD_INF))) / (2 * s * q);
}

var INFFRAC_DEFAULTS = { Cd: 100, S: 0 };
function PRiSM_model_infiniteFrac(td, params) {
  _checkTd(td);
  var p = _prep(params, INFFRAC_DEFAULTS);
  var uf = !!p.uniformFlux;
  return PRiSM_evalWbsSkin(function (s) { return _lapInfFrac(s, uf); }, td, p.Cd, p.S,
                           { scaleDistances: false });
}
function PRiSM_model_infiniteFrac_pd_prime(td, params) {
  _checkTd(td);
  var p = _prep(params, INFFRAC_DEFAULTS);
  var uf = !!p.uniformFlux;
  return PRiSM_evalWbsSkin(function (s) { return _lapInfFrac(s, uf); }, td, p.Cd, p.S,
                           { scaleDistances: false, derivative: true });
}

// ============================================================================
// SECTION 7 — MODELS #4 / #12 — Finite-conductivity fracture (+ face skin)
// ============================================================================
// Reference: Cinco-Ley, Samaniego & Dominguez, SPEJ Aug 1978 (semi-analytic
//   solution); Cinco-Ley & Samaniego, JPT Sept 1981 (fracture-face skin).
//   Laplace-domain form: the fracture half-length is split into NSEG
//   uniform-flux segments. Reservoir response at segment midpoint x_i
//     p̄_r(x_i) = ½ Σ_j q̄_j ∫_seg_j [K0(√s|x_i−α|) + K0(√s(x_i+α))] dα
//   Fracture (1-D linear flow, conductivity FcD):
//     p̄_w = p̄_r(x_i) + Sf·q̄_i + (π/FcD)[x_i/s − ∫_0^{x_i}∫_0^{x'} q̄]
//   with Σ q̄_j Δx_j = 1/s. Solved as an (NSEG+1)² linear system per s.
//   Sf here is the Cinco-Ley fracture-face skin (π/2)(bs/xf)(k/ks − 1).
//   Early: bilinear pD = 2.45 tD^¼/√FcD; FcD → ∞ approaches infiniteFrac;
//   late: ½(ln tD + 0.809) + pseudo-skin.
// Params: { Cd, S, FcD [, Sf] }      refLength: xf
// ============================================================================

var NSEG = 20;
// Uniform mesh: edges e_j = j/N, midpoints x_i = (i+½)/N. Every kernel
// argument |x_i − e_j| and x_i + e_j is an odd multiple of 1/(2N), so the
// ∫K0 values are tabulated once per s (4N+2 evaluations instead of 2N(N+1)).
// The integration weights c_ij of the fracture-flow term do not depend on s.
var _FRAC_C = (function () {
  var N = NSEG, d = 1 / N, C = [];
  for (var i = 0; i < N; i++) {
    var xi = (i + 0.5) * d, row = [];
    for (var j = 0; j < N; j++) {
      var a = j * d, b = (j + 1) * d;
      if (b <= xi)     row.push(d * (xi - b) + 0.5 * d * d);
      else if (a < xi) row.push(0.5 * (xi - a) * (xi - a));
      else             row.push(0);
    }
    C.push(row);
  }
  return C;
})();

function _solveLinear(A, b) {        // Gaussian elimination, partial pivoting
  var n = b.length, i, j, k;
  for (k = 0; k < n; k++) {
    var piv = k, mx = Math.abs(A[k][k]);
    for (i = k + 1; i < n; i++) if (Math.abs(A[i][k]) > mx) { mx = Math.abs(A[i][k]); piv = i; }
    if (!(mx > 0)) return null;
    if (piv !== k) { var tr = A[k]; A[k] = A[piv]; A[piv] = tr; var tb = b[k]; b[k] = b[piv]; b[piv] = tb; }
    for (i = k + 1; i < n; i++) {
      var f = A[i][k] / A[k][k];
      if (f === 0) continue;
      for (j = k; j < n; j++) A[i][j] -= f * A[k][j];
      b[i] -= f * b[k];
    }
  }
  var x = new Array(n);
  for (i = n - 1; i >= 0; i--) {
    var sum = b[i];
    for (j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
    x[i] = sum / A[i][i];
  }
  return x;
}

function _lapFinFrac(s, FcD, Sf) {
  var q = Math.sqrt(s), N = NSEG, d = 1 / N, i, j;
  var K = new Array(4 * N + 3);                 // K[m] = ∫_0^{q·m/(2N)} K0
  for (var m = 0; m < K.length; m++) K[m] = _intK0(q * m * 0.5 * d);
  var A = new Array(N + 1), b = new Array(N + 1);
  var cpf = Math.PI / FcD;
  for (i = 0; i < N; i++) {
    var row = new Array(N + 1), ci = _FRAC_C[i];
    for (j = 0; j < N; j++) {
      // segment j = [j/N, (j+1)/N], observation x_i = (2i+1)/(2N)
      var g;
      if (j > i)      g = K[2 * (j - i) + 1] - K[2 * (j - i) - 1];
      else if (j < i) g = K[2 * (i - j) + 1] - K[2 * (i - j) - 1];
      else            g = 2 * K[1];
      g += K[2 * i + 2 * j + 3] - K[2 * i + 2 * j + 1];   // mirror wing
      g /= q;
      row[j] = 0.5 * g - cpf * ci[j] + ((i === j) ? Sf : 0);
    }
    row[N] = -1;                    // −P
    A[i] = row;
    b[i] = -cpf * (i + 0.5) * d;    // RHS (unknowns scaled by s: Q = s·q̄, P = s·p̄w)
  }
  var last = new Array(N + 1);
  for (j = 0; j < N; j++) last[j] = d;
  last[N] = 0;
  A[N] = last; b[N] = 1;
  var x = _solveLinear(A, b);
  if (!x) return NaN;
  return x[N] / s;
}

var FINFRAC_DEFAULTS = { Cd: 100, S: 0, FcD: 10 };
var FINFRACSKIN_DEFAULTS = { Cd: 100, S: 0, FcD: 10, Sf: 0.5 };

function _finFracEval(td, params, defaults, deriv, withSf) {
  _checkTd(td);
  var p = _prep(params, defaults);
  var FcD = _positive('FcD', p.FcD);
  var Sf = withSf ? (_num(p.Sf) ? Math.max(0, p.Sf) : 0) : 0;
  return PRiSM_evalWbsSkin(function (s) { return _lapFinFrac(s, FcD, Sf); }, td, p.Cd, p.S,
                           { scaleDistances: false, derivative: deriv });
}
function PRiSM_model_finiteFrac(td, params)          { return _finFracEval(td, params, FINFRAC_DEFAULTS, false, false); }
function PRiSM_model_finiteFrac_pd_prime(td, params) { return _finFracEval(td, params, FINFRAC_DEFAULTS, true, false); }
function PRiSM_model_finiteFracSkin(td, params)          { return _finFracEval(td, params, FINFRACSKIN_DEFAULTS, false, true); }
function PRiSM_model_finiteFracSkin_pd_prime(td, params) { return _finFracEval(td, params, FINFRACSKIN_DEFAULTS, true, true); }

// ============================================================================
// SECTION 8 — MODEL #7 — Inclined (slant) well
// ============================================================================
// Reference: Cinco, Miller & Ramey, JPT Nov 1975 (pseudo-skin correlation).
//   Evaluated as the homogeneous model with S = S_perf + S_global + S_θ
//   (+ Brons-Marting partial penetration when hp_to_h < 1, additive
//   engineering approximation). S_θ < 0 for any θ > 0, so this model relies
//   on the negative-skin transform. θ, Kv/Kh and hp/h enter only through the
//   constant S_θ and are therefore collinear with S_perf: they are frozen by
//   default (registry defaultFrozen).
//   hD = __h_rw·√(kh/kv); __h_rw = h/rw is injected by the physical wrapper
//   (default 100 → the log10 term vanishes).
// Params: { Cd, S_perf, S_global, KvKh, theta_deg, hp_to_h }   refLength: rw
// ============================================================================

var INCL_DEFAULTS = { Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45, hp_to_h: 1.0 };

function _inclinedPseudoSkin(p) {
  var kk = (_num(p.KvKh) && p.KvKh > 0) ? p.KvKh : 1;
  var hRw = _hRw(p);
  var St = _cincoLey(_num(p.theta_deg) ? p.theta_deg : 0, kk, hRw);
  var b = _num(p.hp_to_h) ? p.hp_to_h : 1;
  var Sp = (b > 0 && b < 1) ? _bronsMarting(b, hRw * Math.sqrt(1 / kk)) : 0;
  return St + (isFinite(Sp) ? Sp : 0);
}
function _inclinedTotalS(p) {
  return (p.S_perf || 0) + (p.S_global || 0) + _inclinedPseudoSkin(p);
}
function PRiSM_model_inclined(td, params) {
  _checkTd(td);
  var p = _prep(params, INCL_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, _inclinedTotalS(p));
}
function PRiSM_model_inclined_pd_prime(td, params) {
  _checkTd(td);
  var p = _prep(params, INCL_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapHom, td, p.Cd, _inclinedTotalS(p), { derivative: true });
}

// ============================================================================
// SECTION 9 — MODEL #8 — Horizontal well
// ============================================================================
// Reference: Ozkan & Raghavan, SPEFE Sept 1991 (uniform-flux line source
//   between two no-flow planes), evaluated at xD = 0.732, zD = zwD + rwD:
//
//   p̄ = (1/s){ ½∫_{-1}^{1}K0(√s|xD−α|)dα
//              + Σ_{n≥1} cos(nπzD)cos(nπzwD)∫_{-1}^{1}K0(β_n|xD−α|)dα }
//   β_n = √(s + n²π²LD²),  LD = (Lh/h)·√(kv/kh),  Lh = half-length = L/2.
//
//   Evaluation: ∫K0 over the well length = π/β_n minus two exponentially
//   small end corrections; the π/β_n part of the series is summed exactly,
//   by Poisson summation into vertical image wells when √s/(πLD) ≥ 0.05
//   (early time) and by a Kummer-accelerated Fourier sum otherwise.
//   No additive geometric skin: the geometry is in the kernel. S_perf and
//   S_global (collinear; S_global frozen by default) add to pD directly.
//   Early radial: pD' = ½·(h/L)·√(kh/kv) (L = total length); late
//   pseudo-radial: pD' = ½.
// Params: { Cd, S_perf, S_global, KvKh, L_to_h, zw_to_h }  (L_to_h = total
//   length / h; __h_rw = h/rw injected, default 100; optional __Lh_h = Lh/h
//   injected by a wrapper that floats Lh overrides L_to_h)  refLength: Lh
// ============================================================================

var HORIZ_DEFAULTS = { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5 };

// Σ_{n≥1} cos(nθ)/√(s + n²ω²)
function _cosSeries(s, theta, omega) {
  var c = Math.sqrt(s) / omega;
  var sum = 0, k, arg;
  if (c >= 0.05) {
    // Poisson: Σ_{n∈Z} e^{inθ}/√(s+n²ω²) = (2/ω) Σ_k K0(c|θ + 2πk|)
    for (k = 0; k < 100000; k++) {
      arg = c * Math.abs(theta + 2 * Math.PI * k);
      if (arg > 50) break;
      sum += _K0(arg);
    }
    for (k = -1; k > -100000; k--) {
      arg = c * Math.abs(theta + 2 * Math.PI * k);
      if (arg > 50) break;
      sum += _K0(arg);
    }
    return sum / omega - 0.5 / Math.sqrt(s);
  }
  // Kummer: (1/ω)Σcos(nθ)/n = −(1/ω) ln|2 sin(θ/2)|, remainder ~ s/(2n³ω³)
  var base = -Math.log(Math.abs(2 * Math.sin(theta / 2))) / omega;
  var nMax = Math.min(20000, Math.ceil(Math.pow(s / (2e-13 * omega * omega * omega), 1 / 3)) + 2);
  for (var n = 1; n <= nMax; n++) {
    var no = n * omega;
    sum += Math.cos(n * theta) * (1 / Math.sqrt(s + no * no) - 1 / no);
  }
  return base + sum;
}

function _horizGeom(p) {
  var KvKh = _positive('KvKh', p.KvKh);
  // '__Lh_h' (= Lh/h, injected by a physical wrapper that floats Lh in ft)
  // takes precedence over the L_to_h shape parameter so the two cannot disagree.
  var Lh_h = (_num(p.__Lh_h) && p.__Lh_h > 0) ? p.__Lh_h : 0.5 * _positive('L_to_h', p.L_to_h);
  var zw = _num(p.zw_to_h) ? p.zw_to_h : 0.5;
  if (zw < 0 || zw > 1) throw new Error('PRiSM horizontal: zw_to_h must be in [0,1]');
  var rwD = 1 / _hRw(p);
  var zD = zw + rwD;
  if (zD > 1) zD = zw - rwD;
  return { LD: Lh_h * Math.sqrt(KvKh), zw: zw, zD: zD };
}

function PRiSM_lap_horizontal(s, params) {
  var g = (params && params.__geom) ? params.__geom : _horizGeom(_prep(params, HORIZ_DEFAULTS));
  var x = XD_INF, q = Math.sqrt(s);
  var omega = Math.PI * g.LD;
  // n = 0 term
  var tot = 0.5 * (_intK0(q * (1 + x)) + _intK0(q * (1 - x))) / q;
  // end corrections of the n ≥ 1 terms: I_n − π/β_n = −[T(β(1+x)) + T(β(1−x))]/β
  for (var n = 1; n < 100000; n++) {
    var beta = Math.sqrt(s + n * n * omega * omega);
    if (beta * (1 - x) > 40) break;
    var cn = Math.cos(n * Math.PI * g.zD) * Math.cos(n * Math.PI * g.zw);
    tot -= cn * (_tailK0(beta * (1 + x)) + _tailK0(beta * (1 - x))) / beta;
  }
  // π Σ c_n/β_n,  c_n = ½[cos(nπ(zD−zw)) + cos(nπ(zD+zw))]
  var ta = _cosSeries(s, Math.PI * Math.abs(g.zD - g.zw), omega);
  var tb = _cosSeries(s, Math.PI * (g.zD + g.zw), omega);
  tot += Math.PI * 0.5 * (ta + tb);
  return tot / s;
}

function _horizEval(td, params, deriv) {
  _checkTd(td);
  var p = _prep(params, HORIZ_DEFAULTS);
  var geom = _horizGeom(p);
  var pp = { __geom: geom };
  var S = (p.S_perf || 0) + (p.S_global || 0);
  return PRiSM_evalWbsSkin(function (s) { return PRiSM_lap_horizontal(s, pp); }, td, p.Cd, S,
                           { scaleDistances: false, derivative: deriv });
}
function PRiSM_model_horizontal(td, params)          { return _horizEval(td, params, false); }
function PRiSM_model_horizontal_pd_prime(td, params) { return _horizEval(td, params, true); }

// ============================================================================
// SECTION 10 — Boundary models (rw-referenced, image wells)
// ============================================================================
// Reference: van Poolen, Bixel & Jargon, JPT Aug 1963 (image wells);
//   Earlougher, SPE Monograph 5 (1977) ch. 2. All distances are in rw.
//
// #10a linearBoundary  one image at 2dF (+1 sealing, −1 constant pressure).
// #10b parallelChannel walls at dF1 / dF2 (width W = dF1 + dF2); image
//      shells 2K0(2nW) + K0(2nW−2dF1) + K0(2nW−2dF2) — summed exactly via the
//      theta lattice. Late: pD' = √(π tD)/W.
// #10c closedChannel3  channel + end wall at dEnd: the whole channel image
//      set is reflected once in the end wall. Late: pD' = 2√(π tD)/W.
// #10d closedRectangle well at (dW, dS) in a (dW+dE)×(dS+dN) rectangle; four-
//      image lattice (±xw + 2iLx, ±yw + 2jLy). Late PSS: pD' = 2π tD/A.
// #10e intersecting    circular image pattern (unchanged geometry).
// #10f fogBoundary     leaky fault — constant partial-image approximation:
//      one image of strength fog ∈ [−1, 1] (+1 sealing, 0 none, −1 constant
//      pressure). An engineering approximation, not the rigorous
//      semi-permeable-fault solution.
// ============================================================================

var LB_DEFAULTS  = { Cd: 100, S: 0, dF: 1000, BC: 'noflow' };
var PC_DEFAULTS  = { Cd: 100, S: 0, dF1: 500, dF2: 500 };
var CC3_DEFAULTS = { Cd: 100, S: 0, dF1: 500, dF2: 500, dEnd: 1000 };
var CR_DEFAULTS  = { Cd: 100, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 };
var INT_DEFAULTS = { Cd: 100, S: 0, dF1: 500, dF2: 500, angleDeg: 90 };
var FOG_DEFAULTS = { Cd: 100, S: 0, dF: 1000, fog: 0.5 };

function _lapLinearBoundary(p) {
  var dF = _positive('dF', p.dF);
  if (p.BC && p.BC !== 'noflow' && p.BC !== 'constP') {
    throw new Error('PRiSM linearBoundary: BC must be "noflow" or "constP"');
  }
  var sign = (p.BC === 'constP') ? -1 : 1;
  return function (s, d) { return _wellTerm(s) + sign * _imageTerm(s, 2 * dF * d); };
}
function _lapFog(p) {
  var dF = _positive('dF', p.dF), fog = p.fog;
  if (!_num(fog) || fog < -1 || fog > 1) throw new Error('PRiSM fogBoundary: fog must be in [-1, 1]');
  return function (s, d) { return _wellTerm(s) + fog * _imageTerm(s, 2 * dF * d); };
}
function _lapParallelChannel(p) {
  var dF1 = _positive('dF1', p.dF1), dF2 = _positive('dF2', p.dF2);
  return function (s, d) {
    var ay = { L: (dF1 + dF2) * d, w: dF1 * d };
    return _wellTerm(s) + _latticeTerm(s, _latticeK0Sum(s, null, ay));
  };
}
function _lapClosedChannel3(p) {
  var dF1 = _positive('dF1', p.dF1), dF2 = _positive('dF2', p.dF2), dEnd = _positive('dEnd', p.dEnd);
  return function (s, d) {
    var ay = { L: (dF1 + dF2) * d, w: dF1 * d };
    var ax = { finite: [2 * dEnd * d] };
    return _wellTerm(s) + _latticeTerm(s, _latticeK0Sum(s, ax, ay));
  };
}
function _lapClosedRectangle(p) {
  var dN = _positive('dN', p.dN), dS = _positive('dS', p.dS);
  var dE = _positive('dE', p.dE), dW = _positive('dW', p.dW);
  return function (s, d) {
    var ax = { L: (dE + dW) * d, w: dW * d };
    var ay = { L: (dN + dS) * d, w: dS * d };
    return _wellTerm(s) + _latticeTerm(s, _latticeK0Sum(s, ax, ay));
  };
}
var _warnedAngle = {};
function _lapIntersecting(p) {
  var dF1 = _positive('dF1', p.dF1), dF2 = _positive('dF2', p.dF2), ang = p.angleDeg;
  if (!_num(ang) || ang <= 0 || ang >= 360) throw new Error('PRiSM intersecting: angleDeg must be in (0,360)');
  var ratio = 360 / ang, nImages = Math.max(1, Math.min(719, Math.round(ratio) - 1));
  if (Math.abs(ratio - Math.round(ratio)) > 1e-6 && !_warnedAngle[ang]) {
    _warnedAngle[ang] = true;
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('PRiSM intersecting: 360/angleDeg = ' + ratio + ' is non-integer; image lattice approximate');
    }
  }
  var dCentral = Math.sqrt(dF1 * dF1 + dF2 * dF2);
  var rho = [];
  for (var n = 1; n <= nImages; n++) rho.push(2 * dCentral * Math.sin(n * ang * Math.PI / 360));
  return function (s, d) {
    var v = _wellTerm(s);
    for (var i = 0; i < rho.length; i++) v += _imageTerm(s, Math.abs(rho[i]) * d);
    return v;
  };
}

function _makeRwModel(defaults, lapFactory) {
  function run(td, params, deriv) {
    _checkTd(td);
    var p = _prep(params, defaults);
    var lap = lapFactory(p);
    return PRiSM_evalWbsSkin(lap, td, p.Cd, _num(p.S) ? p.S : 0, { derivative: deriv });
  }
  return {
    pd: function (td, params) { return run(td, params, false); },
    pdPrime: function (td, params) { return run(td, params, true); }
  };
}
var _LB  = _makeRwModel(LB_DEFAULTS,  _lapLinearBoundary);
var _PC  = _makeRwModel(PC_DEFAULTS,  _lapParallelChannel);
var _CC3 = _makeRwModel(CC3_DEFAULTS, _lapClosedChannel3);
var _CR  = _makeRwModel(CR_DEFAULTS,  _lapClosedRectangle);
var _INT = _makeRwModel(INT_DEFAULTS, _lapIntersecting);
var _FOG = _makeRwModel(FOG_DEFAULTS, _lapFog);

function PRiSM_model_linearBoundary(td, params)            { return _LB.pd(td, params); }
function PRiSM_model_linearBoundary_pd_prime(td, params)   { return _LB.pdPrime(td, params); }
function PRiSM_model_parallelChannel(td, params)           { return _PC.pd(td, params); }
function PRiSM_model_parallelChannel_pd_prime(td, params)  { return _PC.pdPrime(td, params); }
function PRiSM_model_closedChannel3(td, params)            { return _CC3.pd(td, params); }
function PRiSM_model_closedChannel3_pd_prime(td, params)   { return _CC3.pdPrime(td, params); }
function PRiSM_model_closedRectangle(td, params)           { return _CR.pd(td, params); }
function PRiSM_model_closedRectangle_pd_prime(td, params)  { return _CR.pdPrime(td, params); }
function PRiSM_model_intersecting(td, params)              { return _INT.pd(td, params); }
function PRiSM_model_intersecting_pd_prime(td, params)     { return _INT.pdPrime(td, params); }
function PRiSM_model_fogBoundary(td, params)               { return _FOG.pd(td, params); }
function PRiSM_model_fogBoundary_pd_prime(td, params)      { return _FOG.pdPrime(td, params); }

// ============================================================================
// SECTION 11 — MODEL #30 — Partial-penetration hydraulic fracture
// ============================================================================
// Reference: Gringarten & Ramey, SPEJ Oct 1973 (source functions).
//   Green's-function shortcut (engineering approximation, ~5%): uniform-flux
//   fracture kernel (early fracture-linear flow) + a partial-height vertical
//   kernel exp(−√s/(hf/h))/(s(1+√s)) + an off-centre constant (zw/h − ½)².
// Params: { Cd, S, hf_to_h, zw_to_h }      refLength: xf
// ============================================================================

var PPF_DEFAULTS = { Cd: 100, S: 0, hf_to_h: 0.5, zw_to_h: 0.5 };
function _lapPartialPenFrac(p) {
  var hf = p.hf_to_h, zw = p.zw_to_h;
  if (!_num(hf) || hf <= 0 || hf > 1) throw new Error('PRiSM partialPenFrac: hf_to_h must be in (0,1]');
  if (!_num(zw) || zw < 0 || zw > 1) throw new Error('PRiSM partialPenFrac: zw_to_h must be in [0,1]');
  var A = 1 / hf, dz = zw - 0.5;
  return function (s) {
    var q = Math.sqrt(s);
    return _lapInfFrac(s, true) + Math.exp(-A * q) / (s * (1 + q)) + dz * dz / s;
  };
}
function _ppfEval(td, params, deriv) {
  _checkTd(td);
  var p = _prep(params, PPF_DEFAULTS);
  return PRiSM_evalWbsSkin(_lapPartialPenFrac(p), td, p.Cd, _num(p.S) ? p.S : 0,
                           { scaleDistances: false, derivative: deriv });
}
function PRiSM_model_partialPenFrac(td, params)          { return _ppfEval(td, params, false); }
function PRiSM_model_partialPenFrac_pd_prime(td, params) { return _ppfEval(td, params, true); }

// ============================================================================
// SECTION 12 — REGISTRY
// ============================================================================
// Metadata consumed by the physical-model wrapper (C3) and the regression:
//   refLength      'rw' | 'xf' | 'Lh'  — length that td and Cd refer to
//   defaultFrozen  parameters frozen unless the user frees them
//   paramSpec[i].scale 'log' — regress in log space
//   timeInput      'td'  — the evaluator takes dimensionless time
//   pseudoSkin(params, geom) / equivalentSkin(params, geom) → number | NaN
//     geom = {h, rw, xf, Lh, kvkh} in ft (optional; params.__h_rw used if set)

function _geomHRw(params, geom) {
  if (geom && _num(geom.h) && _num(geom.rw) && geom.rw > 0) return geom.h / geom.rw;
  return _hRw(params || {});
}

var CD_SPEC = { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0, max: 1e10, default: 100, scale: 'log' };
function _cd(def) { var o = {}; for (var k in CD_SPEC) o[k] = CD_SPEC[k]; if (def != null) o.default = def; return o; }
function _sSpec() { return { key: 'S', label: 'Skin S', unit: '-', min: -7, max: 50, default: 0 }; }

var REGISTRY_ADDITIONS = {
  homogeneous: {
    pd: PRiSM_model_homogeneous_rwa,
    pdPrime: PRiSM_model_homogeneous_rwa_pd_prime,
    defaults: { Cd: 100, S: 0 },
    paramSpec: [ _cd(100), _sSpec() ],
    reference: 'Agarwal, Al-Hussainy & Ramey, SPEJ Sept 1970; Bourdet 2002 §3.2',
    category: 'homogeneous',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Vertical well in an infinite-acting homogeneous reservoir, with wellbore storage and constant skin (damaged or stimulated).'
  },

  infiniteFrac: {
    pd: PRiSM_model_infiniteFrac,
    pdPrime: PRiSM_model_infiniteFrac_pd_prime,
    defaults: { Cd: 100, S: 0 },
    paramSpec: [ _cd(100), _sSpec() ],
    reference: 'Gringarten, Ramey & Raghavan, SPEJ Aug 1974',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      if (!geom || !_num(geom.xf) || !_num(geom.rw)) return NaN;
      return _fractureSkin(geom.xf, geom.rw, (params && params.uniformFlux) ? 'uniformFlux' : 'infinite');
    },
    description: 'Vertical well with an infinite-conductivity hydraulic fracture in a homogeneous reservoir (half-slope linear flow, then pseudo-radial).'
  },

  finiteFrac: {
    pd: PRiSM_model_finiteFrac,
    pdPrime: PRiSM_model_finiteFrac_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1e4, default: 10, scale: 'log' }
    ],
    reference: 'Cinco-Ley, Samaniego & Dominguez, SPEJ Aug 1978 (semi-analytic, 20 segments)',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      if (!geom || !_num(geom.xf) || !_num(geom.rw)) return NaN;
      return _fractureSkin(geom.xf, geom.rw, 'finite', (params && params.FcD) || 10);
    },
    description: 'Vertical well with a finite-conductivity hydraulic fracture (bilinear, linear, then pseudo-radial flow).'
  },

  inclined: {
    pd: PRiSM_model_inclined,
    pdPrime: PRiSM_model_inclined_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45, hp_to_h: 1.0 },
    paramSpec: [
      _cd(100),
      { key: 'S_perf',    label: 'Mechanical skin',      unit: '-',   min: -7,    max: 50,  default: 0 },
      { key: 'S_global',  label: 'Global skin',          unit: '-',   min: -7,    max: 50,  default: 0 },
      { key: 'KvKh',      label: 'Anisotropy Kv/Kh',     unit: '-',   min: 0.001, max: 10,  default: 1, scale: 'log' },
      { key: 'theta_deg', label: 'Inclination angle',    unit: 'deg', min: 0,     max: 75,  default: 45 },
      { key: 'hp_to_h',   label: 'Open fraction hp/h',   unit: '-',   min: 0.01,  max: 1,   default: 1.0 }
    ],
    reference: 'Cinco, Miller & Ramey, JPT Nov 1975 (slant-well pseudo-skin); Brons & Marting 1961',
    category: 'well-type',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: ['S_global', 'theta_deg', 'KvKh', 'hp_to_h'],
    timeInput: 'td',
    pseudoSkin: function (params, geom) {
      var p = _prep(params, INCL_DEFAULTS);
      p.__h_rw = _geomHRw(params, geom);
      return _inclinedPseudoSkin(p);
    },
    description: 'Slant well in a homogeneous reservoir: vertical-well response with the Cinco-Ley inclination pseudo-skin (always negative).'
  },

  horizontal: {
    pd: PRiSM_model_horizontal,
    pdPrime: PRiSM_model_horizontal_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5 },
    paramSpec: [
      _cd(100),
      { key: 'S_perf',   label: 'Mechanical skin',          unit: '-', min: -7,    max: 50,  default: 0 },
      { key: 'S_global', label: 'Global skin',              unit: '-', min: -7,    max: 50,  default: 0 },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',         unit: '-', min: 0.001, max: 10,  default: 0.1, scale: 'log' },
      { key: 'L_to_h',   label: 'Well length / thickness L/h', unit: '-', min: 0.1, max: 200, default: 5.0, scale: 'log' },
      { key: 'zw_to_h',  label: 'Vertical position zw/h',   unit: '-', min: 0,     max: 1,   default: 0.5 }
    ],
    reference: 'Ozkan & Raghavan, SPEFE Sept 1991 (uniform-flux line source in a slab)',
    category: 'well-type',
    kind: 'pressure',
    refLength: 'Lh',
    refLengthNote: 'Lh = half-length = 0.5·L_to_h·h; td and Cd are referenced to Lh. A wrapper that floats Lh should inject __Lh_h = Lh/h (overrides L_to_h) and freeze L_to_h.',
    defaultFrozen: ['S_global'],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      var p = _prep(params, HORIZ_DEFAULTS);
      var hRw = _geomHRw(params, geom);
      return _horizontalEquivalent(p.L_to_h, 1, 1 / hRw, p.KvKh);
    },
    description: 'Horizontal well: early radial flow in the vertical plane, intermediate linear flow, late pseudo-radial flow.'
  },

  linearBoundary: {
    pd: PRiSM_model_linearBoundary,
    pdPrime: PRiSM_model_linearBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, BC: 'noflow' },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF', label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' },
      { key: 'BC', label: 'Boundary condition',   unit: '',    options: ['noflow', 'constP'], default: 'noflow' }
    ],
    reference: 'van Poolen, Bixel & Jargon, JPT Aug 1963',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Single linear boundary (sealing fault or constant pressure) via an image well.'
  },

  parallelChannel: {
    pd: PRiSM_model_parallelChannel,
    pdPrime: PRiSM_model_parallelChannel_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF1', label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dF2', label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 (complete image lattice)',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Two parallel sealing faults (channel): late-time half-slope linear flow.'
  },

  closedChannel3: {
    pd: PRiSM_model_closedChannel3,
    pdPrime: PRiSM_model_closedChannel3_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, dEnd: 1000 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF1',  label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e7, default: 500,  scale: 'log' },
      { key: 'dF2',  label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e7, default: 500,  scale: 'log' },
      { key: 'dEnd', label: 'Distance to end wall', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' }
    ],
    reference: 'van Poolen et al., JPT Aug 1963',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Channel closed at one end (three sealing faults): linear flow doubles its derivative once the end wall is felt.'
  },

  closedRectangle: {
    pd: PRiSM_model_closedRectangle,
    pdPrime: PRiSM_model_closedRectangle_pd_prime,
    defaults: { Cd: 100, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dN', label: 'Distance north', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dS', label: 'Distance south', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dE', label: 'Distance east',  unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dW', label: 'Distance west',  unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' }
    ],
    reference: 'van Poolen et al., JPT Aug 1963; Earlougher, SPE Monograph 5 — full image lattice',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Closed rectangle with the well anywhere inside: late-time pseudo-steady state (unit slope).'
  },

  intersecting: {
    pd: PRiSM_model_intersecting,
    pdPrime: PRiSM_model_intersecting_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, angleDeg: 90 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF1',      label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'dF2',      label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e7, default: 500, scale: 'log' },
      { key: 'angleDeg', label: 'Intersection angle',  unit: 'deg', min: 1, max: 359, default: 90 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 — circular image pattern',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Two intersecting sealing faults: derivative rises by 360/angle.'
  },

  fogBoundary: {
    pd: PRiSM_model_fogBoundary,
    pdPrime: PRiSM_model_fogBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, fog: 0.5 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'dF',  label: 'Distance to fault', unit: 'r_w', min: 1, max: 1e7, default: 1000, scale: 'log' },
      { key: 'fog', label: 'Image strength (1 sealing, 0 open, −1 constant pressure)', unit: '-', min: -1, max: 1, default: 0.5 }
    ],
    reference: 'Constant partial-image approximation of a leaky fault (image of strength fog)',
    category: 'boundary',
    kind: 'pressure',
    refLength: 'rw',
    defaultFrozen: [],
    timeInput: 'td',
    label: 'Leaky fault — constant partial-image approximation',
    description: 'Leaky fault — constant partial-image approximation: one image well of strength fog ∈ [−1, 1]. Approximate; not the rigorous semi-permeable-fault solution.'
  },

  finiteFracSkin: {
    pd: PRiSM_model_finiteFracSkin,
    pdPrime: PRiSM_model_finiteFracSkin_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10, Sf: 0.5 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1e4, default: 10, scale: 'log' },
      { key: 'Sf',  label: 'Fracture-face skin Sf',     unit: '-', min: 0,   max: 20,  default: 0.5 }
    ],
    reference: 'Cinco-Ley & Samaniego, JPT Sept 1981',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    equivalentSkin: function (params, geom) {
      if (!geom || !_num(geom.xf) || !_num(geom.rw)) return NaN;
      var p = params || {};
      return _fractureSkin(geom.xf, geom.rw, 'finite', p.FcD || 10) + (_num(p.Sf) ? p.Sf : 0);
    },
    description: 'Finite-conductivity fracture with fracture-face damage (Sf) that masks early bilinear flow.'
  },

  partialPenFrac: {
    pd: PRiSM_model_partialPenFrac,
    pdPrime: PRiSM_model_partialPenFrac_pd_prime,
    defaults: { Cd: 100, S: 0, hf_to_h: 0.5, zw_to_h: 0.5 },
    paramSpec: [
      _cd(100), _sSpec(),
      { key: 'hf_to_h', label: 'Fracture-height fraction hf/h', unit: '-', min: 0.01, max: 1, default: 0.5 },
      { key: 'zw_to_h', label: 'Vertical position zw/h',         unit: '-', min: 0,    max: 1, default: 0.5 }
    ],
    reference: 'Gringarten & Ramey, SPEJ Oct 1973 (Green\'s-function shortcut)',
    category: 'fracture',
    kind: 'pressure',
    refLength: 'xf',
    defaultFrozen: [],
    timeInput: 'td',
    description: 'Partial-height hydraulic fracture (approximate Green\'s-function shortcut): fracture-linear, vertical-radial, then horizontal-radial flow.'
  }
};

(function _installRegistry() {
  var g = _G;
  if (!g.PRiSM_MODELS || typeof g.PRiSM_MODELS !== 'object') g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (Object.prototype.hasOwnProperty.call(REGISTRY_ADDITIONS, key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
  // shared kernels / evaluator for every other model file
  g.PRiSM_evalWbsSkin        = PRiSM_evalWbsSkin;
  g.PRiSM_pd_lap_homogeneous = function (s) { return _wellTerm(s); };
  g.PRiSM_lap_wellTerm       = _wellTerm;
  g.PRiSM_lap_imageTerm      = _imageTerm;
  g.PRiSM_lap_infiniteFrac   = function (s, params) { return _lapInfFrac(s, !!(params && params.uniformFlux)); };
  g.PRiSM_lap_horizontal     = PRiSM_lap_horizontal;
  g.PRiSM_intK0              = _intK0;
  var ps = (g.PRiSM_pseudoSkin && typeof g.PRiSM_pseudoSkin === 'object') ? g.PRiSM_pseudoSkin : {};
  ps.bronsMarting         = _bronsMarting;
  ps.cincoLey             = _cincoLey;
  ps.fracture             = _fractureSkin;
  ps.horizontalEquivalent = _horizontalEquivalent;
  g.PRiSM_pseudoSkin = ps;
  // evaluator functions on the global so other modules can reference them
  g.PRiSM_model_homogeneous_rwa          = PRiSM_model_homogeneous_rwa;
  g.PRiSM_model_homogeneous_rwa_pd_prime = PRiSM_model_homogeneous_rwa_pd_prime;
  g.PRiSM_model_infiniteFrac             = PRiSM_model_infiniteFrac;
  g.PRiSM_model_infiniteFrac_pd_prime    = PRiSM_model_infiniteFrac_pd_prime;
  g.PRiSM_model_finiteFrac               = PRiSM_model_finiteFrac;
  g.PRiSM_model_finiteFrac_pd_prime      = PRiSM_model_finiteFrac_pd_prime;
  g.PRiSM_model_inclined                 = PRiSM_model_inclined;
  g.PRiSM_model_inclined_pd_prime        = PRiSM_model_inclined_pd_prime;
  g.PRiSM_model_horizontal               = PRiSM_model_horizontal;
  g.PRiSM_model_horizontal_pd_prime      = PRiSM_model_horizontal_pd_prime;
  g.PRiSM_model_linearBoundary           = PRiSM_model_linearBoundary;
  g.PRiSM_model_linearBoundary_pd_prime  = PRiSM_model_linearBoundary_pd_prime;
  g.PRiSM_model_parallelChannel          = PRiSM_model_parallelChannel;
  g.PRiSM_model_parallelChannel_pd_prime = PRiSM_model_parallelChannel_pd_prime;
  g.PRiSM_model_closedChannel3           = PRiSM_model_closedChannel3;
  g.PRiSM_model_closedChannel3_pd_prime  = PRiSM_model_closedChannel3_pd_prime;
  g.PRiSM_model_closedRectangle          = PRiSM_model_closedRectangle;
  g.PRiSM_model_closedRectangle_pd_prime = PRiSM_model_closedRectangle_pd_prime;
  g.PRiSM_model_intersecting             = PRiSM_model_intersecting;
  g.PRiSM_model_intersecting_pd_prime    = PRiSM_model_intersecting_pd_prime;
  g.PRiSM_model_fogBoundary              = PRiSM_model_fogBoundary;
  g.PRiSM_model_fogBoundary_pd_prime     = PRiSM_model_fogBoundary_pd_prime;
  g.PRiSM_model_finiteFracSkin           = PRiSM_model_finiteFracSkin;
  g.PRiSM_model_finiteFracSkin_pd_prime  = PRiSM_model_finiteFracSkin_pd_prime;
  g.PRiSM_model_partialPenFrac           = PRiSM_model_partialPenFrac;
  g.PRiSM_model_partialPenFrac_pd_prime  = PRiSM_model_partialPenFrac_pd_prime;
})();

// ============================================================================

})();  // end IIFE

// ─── END 03-models ───────────────────────────────────────────────────

// ─── BEGIN 02-plots ─────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Plot Suite (02-plots.js)
// 15 canvas plot functions + shared helpers for the PRiSM Well Test
// Analysis module. Pure vanilla JS, dark theme (host CSS variables),
// retina-aware, responsive (ResizeObserver) and touch-capable (Pointer
// Events: pan / box-zoom / pinch / long-press reset).
//
// This file is intentionally NOT wrapped in an IIFE: its `function
// PRiSM_plot_*` declarations hoist into the host main IIFE scope. Every
// public symbol is also published on window at the end of the file.
//
// Universal signature:   PRiSM_plot_<NAME>(canvas, data, opts)
//
// ── C6 plot data contract ───────────────────────────────────────────
//   Log-log (Bourdet)  data = { t: Δt[hr], dp: Δp[psi] (>0 plotted),
//                               deriv?: Δp′[psi], x?: time-function[],
//                               overlay?: { t[], dp[], deriv[] } }
//        dp and deriv are plotted EXACTLY as given. When deriv is present
//        the derivative is never recomputed. data.dp ALWAYS means Δp,
//        never the derivative. Without dp the plot derives a sign-aware
//        Δp from data.p (pRef = data.pRef, else p[0]) and warns once.
//   Horner   data = { t: Δt[], p: pws[], tp (required), line?: {m,b,x0,x1} }
//            line: p = b + m·X with X = log10((tp+Δt)/Δt); x0/x1 in X
//            (or t0/t1 in Δt hours). p* = b.
//   MDH      data = { t: Δt[], p[], line?: {m,b,t0,t1} }  p = b + m·log10(Δt)
//   Superposition (build-up / multi-rate)
//            data = { t: Δt[], p[], tStart?, periods? | rateHistory? | q?,
//                     x? (C2 time function), tp?, line?: {m,b,x0,x1} }
//            X = Σ (qᵢ−qᵢ₋₁)/q_ref · log10(T_n − Tᵢ₋₁ + Δt), q_ref = the
//            analysed rate, or the last NON-ZERO flowing rate for a shut-in
//            (single-rate build-up → log10((tp+Δt)/Δt), p* at X = 0).
//   Cartesian data = { t: tAbs[], p[], q?[], periods?[{t0,t1,start,end,q}],
//                      overlay?: { t[], p[] } }   (q drawn on a right axis)
//   Decline / RTA data = { t: days[], q[], overlay?: { t[], q[] } }
//            opts.timeUnit 'd' (default) | 'h' | 'mo' | 'yr', opts.xLabel,
//            opts.rateUnit, opts.showTangentEUR, opts.eurWindow.
//
// ── Common opts ─────────────────────────────────────────────────────
//   width, height, padding, title, xLabel, yLabel, showLegend, hover,
//   dragZoom, activePeriod, smoothL, plotKey, view {x:{min,max},y:{…}},
//   resetView, postDraw(info), postDrawHooks (bool)
//
// ── Axes (C6) ───────────────────────────────────────────────────────
//   canvas._prismAxes = { scaleX:{kind,min,max,label}, scaleY, toX, toY,
//       fromX(px), fromY(py), plot:{x,y,w,h,cssW,cssH}, plotKey,
//       xLog, yLog, x0,x1,y0,y1, dx0,dx1,dy0,dy1 (legacy flat keys),
//       userView, autoScale, dataSig, points, result }
//
// ── Interaction (installed ONCE per canvas; no per-draw listeners) ──
//   mouse : drag = box zoom, Shift/Alt/middle-drag = pan,
//           Ctrl/⌘+wheel or trackpad pinch = zoom, double-click = reset,
//           hover = nearest-point read-out
//   touch : one-finger drag = pan, two-finger pinch = zoom, tap = read-out,
//           long-press (600 ms) = reset view
//   The user view survives redraws of the same plot + same data; it is
//   dropped on new data, opts.resetView, or when canvas._prismAxes is
//   deleted (the Tab-2 "Reset view" button does this).
//   Internal repaints (zoom / pan / pinch / resize / reset) call
//   opts.postDraw(info) and — when opts.plotKey is given or
//   opts.postDrawHooks === true (and not === false) — each entry of
//   window.PRiSM_postDrawHooks with {canvas, plotKey, data, opts, axes,
//   reason}. The initial draw never runs hooks (drawActivePlot does).
//   Event 'prism:plot-view-changed' {plotKey, zoomed, view} bubbles from
//   the canvas after every view change.
// ════════════════════════════════════════════════════════════════════

const PRiSM_PLOT_G = (typeof window !== 'undefined') ? window
    : (typeof globalThis !== 'undefined' ? globalThis : {});

// ─────────────────────────────────────────────────────────────────────
// THEME — defaults = host dark theme; refreshed from the host CSS
// variables (--bg1, --bg2, --border, --text …) on every plot call.
// ─────────────────────────────────────────────────────────────────────
const PRiSM_THEME = {
    bg:        '#0d1117',
    panel:     '#161b22',
    border:    '#30363d',
    grid:      '#21262d',
    gridMajor: '#30363d',
    text:      '#c9d1d9',
    text2:     '#8b949e',
    text3:     '#848d97',   // P10 contrast (was #6e7681); synced from --text3
    accent:    '#f0883e', // orange — primary series
    blue:      '#58a6ff', // overlay / model curve
    green:     '#3fb950', // derivative / good fit
    red:       '#f85149', // boundaries / bad fit
    yellow:    '#d29922', // half-slope / linear flow
    cyan:      '#39c5cf', // secondary axis
    purple:    '#bc8cff'  // type-curve guides
};

const PRiSM_THEME_VARS = {
    bg: '--bg1', panel: '--bg2', border: '--border', grid: '--bg4', gridMajor: '--border',
    text: '--text', text2: '--text2', text3: '--text3', accent: '--accent',
    blue: '--blue', green: '--green', red: '--red', yellow: '--yellow', purple: '--purple'
};

function PRiSM_plot_syncTheme() {
    try {
        const G = PRiSM_PLOT_G;
        const doc = G.document;
        if (!doc || !doc.documentElement || typeof G.getComputedStyle !== 'function') return;
        const cs = G.getComputedStyle(doc.documentElement);
        if (!cs || typeof cs.getPropertyValue !== 'function') return;
        Object.keys(PRiSM_THEME_VARS).forEach(function (k) {
            const v = String(cs.getPropertyValue(PRiSM_THEME_VARS[k]) || '').trim();
            if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\))$/i.test(v)) PRiSM_THEME[k] = v;
        });
    } catch (_) { /* theme stays on defaults */ }
}

// Desktop padding is kept identical to the historical value (other
// layers mirror it). Canvases narrower than 480 CSS px use the compact
// set so a 375 px phone keeps a usable plot area.
const PRiSM_DEFAULT_PADDING = { top: 30, right: 80, bottom: 48, left: 64 };
const PRiSM_COMPACT_PADDING = { top: 28, right: 14, bottom: 42, left: 52 };

// ─────────────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_isNum(v) {
    return (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && isFinite(+v);
}
function PRiSM_plot_num() {
    for (let i = 0; i < arguments.length; i++) if (PRiSM_plot_isNum(arguments[i])) return +arguments[i];
    return NaN;
}
function PRiSM_plot_pos() {
    for (let i = 0; i < arguments.length; i++) {
        const v = arguments[i];
        if (PRiSM_plot_isNum(v) && +v > 0) return +v;
    }
    return NaN;
}
function PRiSM_plot_arr(a) {
    return (a && typeof a !== 'string' && typeof a.length === 'number' && a.length > 0) ? a : null;
}
function PRiSM_plot_isData(data) {
    return !!(data && PRiSM_plot_arr(data.t));
}
function PRiSM_plot_zip(xs, ys) {
    const n = Math.min(xs ? xs.length : 0, ys ? ys.length : 0);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [xs[i], ys[i]];
    return out;
}
function PRiSM_plot_copyScale(s) {
    return { kind: s.kind, min: s.min, max: s.max, label: s.label };
}
function PRiSM_plot_now() {
    const G = PRiSM_PLOT_G;
    try { if (G.performance && typeof G.performance.now === 'function') return G.performance.now(); } catch (_) { /* ignore */ }
    return Date.now();
}
function PRiSM_plot_warnOnce(S, key, msg) {
    if (!S || S.warned[key]) return;
    S.warned[key] = true;
    try { console.warn(msg); } catch (_) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────
// FORMATTING — engineering (k / M / G), scientific fallback.
// Trailing zeros are stripped ONLY after a decimal point, so 100 → '100',
// 120 → '120', 850 → '850' (the old /\.?0+$/ turned 100 into '1').
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_trimZeros(s) {
    s = String(s);
    const e = s.search(/e/i);
    if (e !== -1) {
        let exp = s.slice(e + 1).replace(/^\+/, '');
        exp = exp.replace(/^(-?)0+(\d)/, '$1$2');
        return PRiSM_plot_trimZeros(s.slice(0, e)) + 'e' + exp;
    }
    if (s.indexOf('.') === -1) return s;
    return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function PRiSM_plot_format_eng(n, sig) {
    if (n === null || n === undefined || n === '') return '';
    n = +n;
    if (!isFinite(n)) return '';
    sig = Math.max(1, Math.min(12, sig || 3));
    if (n === 0) return '0';
    // Round first so 999.95k promotes to 1M rather than '1000k'.
    const r = Number(n.toPrecision(sig));
    const a = Math.abs(r);
    if (a >= 1e12 || a < 1e-3) return PRiSM_plot_trimZeros(r.toExponential(Math.max(0, sig - 1)));
    if (a >= 1e9) return PRiSM_plot_trimZeros((r / 1e9).toPrecision(sig)) + 'G';
    if (a >= 1e6) return PRiSM_plot_trimZeros((r / 1e6).toPrecision(sig)) + 'M';
    if (a >= 1e3) return PRiSM_plot_trimZeros((r / 1e3).toPrecision(sig)) + 'k';
    return PRiSM_plot_trimZeros(r.toPrecision(sig));
}

// Tick label. Log axes: decades as plain numbers between 0.01 and 100k,
// else 1eK. Linear axes: fixed decimals derived from the tick step so the
// labels of one axis are consistent (3200, 3400 … / 0.5, 1.0 …); very
// large or very fine steps fall back to engineering notation.
function PRiSM_plot_format_tick(v, isLog, step) {
    if (!isFinite(v)) return '';
    if (isLog) {
        if (v <= 0) return '';
        const k = Math.round(Math.log10(Math.abs(v)));
        if (Math.abs(v - Math.pow(10, k)) / Math.pow(10, k) < 1e-6) {
            if (k >= -2 && k <= 5) return PRiSM_plot_format_eng(v);
            return '1e' + k;
        }
        return PRiSM_plot_format_eng(v);
    }
    if (isFinite(step) && step > 0) {
        const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
        if (Math.abs(v) < step * 1e-6) return (0).toFixed(Math.min(dec, 6));
        if (Math.abs(v) < 1e5 && step < 1e4 && dec <= 6) return v.toFixed(dec);
        const sig = Math.max(3, Math.min(8, Math.floor(Math.log10(Math.abs(v))) - Math.floor(Math.log10(step) + 1e-9) + 1));
        return PRiSM_plot_format_eng(v, sig);
    }
    return PRiSM_plot_format_eng(v);
}

// Pressure-style value for plot annotations (p*, p1hr).
function PRiSM_plot_fmtP(v) {
    if (!isFinite(v)) return '—';
    return Math.abs(v) >= 100 ? v.toFixed(1) : PRiSM_plot_format_eng(v, 4);
}

// ─────────────────────────────────────────────────────────────────────
// TICKS — log decades & "nice" linear ticks
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_log_ticks(min, max) {
    // Returns { major: [10^k …], minor: [2·10^k, 3·10^k, …] } in the
    // visible decade span.
    if (!isFinite(min) || !isFinite(max) || min <= 0 || max <= 0 || max <= min) {
        return { major: [], minor: [] };
    }
    const k0 = Math.floor(Math.log10(min));
    const k1 = Math.ceil(Math.log10(max));
    const major = [], minor = [];
    const eps = 1e-9;
    for (let k = k0; k <= k1; k++) {
        const base = Math.pow(10, k);
        if (base >= min * (1 - eps) && base <= max * (1 + eps)) major.push(base);
        if (k1 - k0 > 12) continue; // too many decades — skip minors
        for (let m = 2; m <= 9; m++) {
            const v = m * base;
            if (v >= min && v <= max) minor.push(v);
        }
    }
    return { major, minor };
}

function PRiSM_plot_lin_ticks(min, max, target) {
    target = target || 6;
    if (!isFinite(min) || !isFinite(max) || max <= min) return [];
    const span = max - min;
    const rough = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step;
    if (norm < 1.5)      step = 1 * mag;
    else if (norm < 3)   step = 2 * mag;
    else if (norm < 7)   step = 5 * mag;
    else                 step = 10 * mag;
    const k0 = Math.ceil(min / step - 1e-9);
    const ticks = [];
    for (let k = k0; k <= k0 + 1000; k++) {
        const v = k * step;
        if (v > max + step * 1e-9) break;
        ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    ticks.step = step;
    return ticks;
}

// ─────────────────────────────────────────────────────────────────────
// PER-CANVAS STATE (WeakMap → collected with the canvas)
// ─────────────────────────────────────────────────────────────────────
const PRiSM_PLOT_STATES = (typeof WeakMap === 'function') ? new WeakMap() : null;

function PRiSM_plot_getState(canvas) {
    if (!canvas) return null;
    return PRiSM_PLOT_STATES ? (PRiSM_PLOT_STATES.get(canvas) || null) : (canvas.__prismPlotState || null);
}

function PRiSM_plot_state(canvas) {
    let S = PRiSM_plot_getState(canvas);
    if (S) return S;
    const st = canvas.style || {};
    const aw = String(st.width || ''), ah = String(st.height || '');
    // An author size that is not a plain px value (100%, calc(), vw …)
    // stays CSS-controlled; everything else is pinned in px as before.
    const isRel = function (v) { return v !== '' && !/^\s*-?[\d.]+\s*(px)?\s*$/i.test(v); };
    const pxOf = function (v) { const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v); return m ? parseFloat(m[1]) : 0; };
    S = {
        canvas: canvas,
        relW: isRel(aw), relH: isRel(ah),
        authorPxW: pxOf(aw), authorPxH: pxOf(ah),
        authorTouch: String(st.touchAction || ''),
        touchSet: false,
        cssW: 0, cssH: 0,
        cur: null,
        installed: false, handlers: null, ro: null,
        pointers: (typeof Map === 'function') ? new Map() : null,
        gesture: null, lpTimer: null,
        snap: null, hover: null,
        raf: null, rafReason: null,
        warned: {}
    };
    if (PRiSM_PLOT_STATES) PRiSM_PLOT_STATES.set(canvas, S);
    else {
        try { Object.defineProperty(canvas, '__prismPlotState', { value: S, configurable: true }); }
        catch (_) { canvas.__prismPlotState = S; }
    }
    return S;
}

// ─────────────────────────────────────────────────────────────────────
// CANVAS SETUP — retina, padding, plot rect
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_padding(cssW, opts, extra) {
    const narrow = cssW < 480;
    const base = Object.assign({}, narrow ? PRiSM_COMPACT_PADDING : PRiSM_DEFAULT_PADDING);
    if (extra && extra.secondaryAxis) base.right = Math.max(base.right, narrow ? 46 : 64);
    return Object.assign(base, (opts && opts.padding) || {});
}

function PRiSM_plot_measure(canvas, opts, S) {
    const ow = +opts.width, oh = +opts.height;
    const pinW = ow > 0 || !S.relW;
    const pinH = oh > 0 || !S.relH;
    let w = ow > 0 ? ow : (canvas.clientWidth || 0);
    let h = oh > 0 ? oh : (canvas.clientHeight || 0);
    if (!(w > 0)) w = S.cssW || S.authorPxW || canvas.width || 600;
    if (!(h > 0)) h = S.cssH || S.authorPxH || canvas.height || 400;
    return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), pinW: pinW, pinH: pinH };
}

function PRiSM_plot_applySize(canvas, opts, S, extra) {
    const dpr = PRiSM_PLOT_G.devicePixelRatio || 1;
    const m = PRiSM_plot_measure(canvas, opts || {}, S);
    if (canvas.style) {
        if (m.pinW) canvas.style.width = m.w + 'px';
        if (m.pinH) canvas.style.height = m.h + 'px';
    }
    canvas.width = Math.max(1, Math.round(m.w * dpr));
    canvas.height = Math.max(1, Math.round(m.h * dpr));
    const ctx = canvas.getContext('2d');
    if (ctx && typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // crisp on retina
    S.cssW = m.w; S.cssH = m.h; S.dpr = dpr;
    const pad = PRiSM_plot_padding(m.w, opts, extra);
    const plot = {
        x: pad.left,
        y: pad.top,
        w: Math.max(10, m.w - pad.left - pad.right),
        h: Math.max(10, m.h - pad.top - pad.bottom),
        cssW: m.w,
        cssH: m.h,
        pad: pad,
        dpr: dpr,
        narrow: m.w < 480
    };
    return { ctx: ctx, plot: plot, dpr: dpr };
}

function PRiSM_plot_setup(canvas, opts, extra) {
    opts = opts || {};
    PRiSM_plot_syncTheme();
    const S = PRiSM_plot_state(canvas);
    PRiSM_plot_abortGesture(S);
    S.cur = null; S.snap = null; S.hover = null;
    const prevAxes = canvas._prismAxes || null;
    try { canvas._prismAxes = null; } catch (_) { /* detached / frozen */ }
    const r = PRiSM_plot_applySize(canvas, opts, S, extra);
    return { ctx: r.ctx, plot: r.plot, dpr: r.dpr, S: S, prevAxes: prevAxes, opts: opts, extra: extra || null, canvas: canvas };
}

// Balanced helper: ONE save() — pair every call with ONE ctx.restore().
function PRiSM_plot_clip(ctx, x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
}

// ─────────────────────────────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_empty(ctx, plot, msg) {
    ctx.fillStyle = PRiSM_THEME.bg;
    ctx.fillRect(0, 0, plot.cssW, plot.cssH);
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);
    ctx.fillStyle = PRiSM_THEME.text3;
    ctx.font = (plot.narrow ? '12px' : '13px') + ' sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data', plot.x + plot.w / 2, plot.y + plot.h / 2, Math.max(40, plot.w - 12));
}

// Draws an empty-state message and records it so a resize repaints it.
function PRiSM_plot_noData(setup, msg) {
    const ctx = setup.ctx, plot = setup.plot, S = setup.S;
    const render = function () { PRiSM_plot_empty(ctx, plot, msg); };
    render();
    S.cur = { empty: true, msg: msg, canvas: setup.canvas, ctx: ctx, plot: plot, render: render,
              opts: setup.opts, extra: setup.extra };
    PRiSM_plot_install(setup.canvas, S);
}

// Public: themed, correctly sized status message on a plot canvas.
// Prefer this over clearing the canvas by hand — it also detaches the
// previous plot's interactions and keeps the message on resize.
function PRiSM_plot_message(canvas, msg, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const setup = PRiSM_plot_setup(canvas, opts || {});
    PRiSM_plot_noData(setup, msg || 'No data');
}

// ─────────────────────────────────────────────────────────────────────
// SCALE TRANSFORMS (invertible) — used by axes, gestures and consumers.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_makeTransform(scale, p0, len, invert) {
    const log = scale.kind === 'log';
    const a = log ? Math.log10(scale.min) : scale.min;
    const b = log ? Math.log10(scale.max) : scale.max;
    const span = (b - a) || 1;
    const to = invert
        ? function (v) { return p0 + len - ((log ? Math.log10(v) : v) - a) / span * len; }
        : function (v) { return p0 + ((log ? Math.log10(v) : v) - a) / span * len; };
    const from = invert
        ? function (px) { const u = a + (p0 + len - px) / len * span; return log ? Math.pow(10, u) : u; }
        : function (px) { const u = a + (px - p0) / len * span; return log ? Math.pow(10, u) : u; };
    return { to: to, from: from };
}

// ─────────────────────────────────────────────────────────────────────
// AXES — paints background, grid, ticks, labels, title.
// scaleX / scaleY: { kind:'lin'|'log', min, max, label }
// opts.scaleY2 (optional): right-hand linear axis { min, max, label, color }
// Returns the world↔pixel transforms and stashes canvas._prismAxes.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_axes(ctx, plot, scaleX, scaleY, opts) {
    opts = opts || {};
    const narrow = !!plot.narrow;
    // Background
    ctx.fillStyle = PRiSM_THEME.bg;
    ctx.fillRect(0, 0, plot.cssW, plot.cssH);
    ctx.fillStyle = PRiSM_THEME.panel;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    const xLog = scaleX.kind === 'log';
    const yLog = scaleY.kind === 'log';
    const xTarget = Math.max(3, Math.min(8, Math.floor(plot.w / 70)));
    const yTarget = Math.max(3, Math.min(7, Math.floor(plot.h / 45)));
    const xTicks = xLog
        ? PRiSM_plot_log_ticks(scaleX.min, scaleX.max)
        : { major: PRiSM_plot_lin_ticks(scaleX.min, scaleX.max, xTarget), minor: [] };
    const yTicks = yLog
        ? PRiSM_plot_log_ticks(scaleY.min, scaleY.max)
        : { major: PRiSM_plot_lin_ticks(scaleY.min, scaleY.max, yTarget), minor: [] };
    const xStep = xTicks.major.step, yStep = yTicks.major.step;

    const tx = PRiSM_plot_makeTransform(scaleX, plot.x, plot.w, false);
    const ty = PRiSM_plot_makeTransform(scaleY, plot.y, plot.h, true);
    const toX = tx.to, toY = ty.to, fromX = tx.from, fromY = ty.from;

    // Minor grid (log only)
    if (xLog && xTicks.minor.length) {
        ctx.strokeStyle = PRiSM_THEME.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        xTicks.minor.forEach(function (v) {
            const px = Math.round(toX(v)) + 0.5;
            ctx.moveTo(px, plot.y);
            ctx.lineTo(px, plot.y + plot.h);
        });
        ctx.stroke();
    }
    if (yLog && yTicks.minor.length) {
        ctx.strokeStyle = PRiSM_THEME.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        yTicks.minor.forEach(function (v) {
            const py = Math.round(toY(v)) + 0.5;
            ctx.moveTo(plot.x, py);
            ctx.lineTo(plot.x + plot.w, py);
        });
        ctx.stroke();
    }

    // Major grid + tick labels (labels that would collide are skipped)
    ctx.strokeStyle = PRiSM_THEME.gridMajor;
    ctx.lineWidth = 1;
    ctx.fillStyle = PRiSM_THEME.text2;
    ctx.font = (narrow ? '10px' : '11px') + ' sans-serif';

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let lastRight = -Infinity;
    xTicks.major.forEach(function (v) {
        const px = Math.round(toX(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, plot.y);
        ctx.lineTo(px, plot.y + plot.h);
        ctx.stroke();
        const s = PRiSM_plot_format_tick(v, xLog, xStep);
        const w = ctx.measureText(s).width || 0;
        if (px - w / 2 < lastRight + 4) return;
        ctx.fillText(s, px, plot.y + plot.h + 6);
        lastRight = px + w / 2;
    });

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    let lastY = Infinity;
    yTicks.major.forEach(function (v) {
        const py = Math.round(toY(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, py);
        ctx.lineTo(plot.x + plot.w, py);
        ctx.stroke();
        if (Math.abs(lastY - py) < (narrow ? 12 : 13)) return;
        ctx.fillText(PRiSM_plot_format_tick(v, yLog, yStep), plot.x - 6, py);
        lastY = py;
    });

    // Secondary (right) linear axis
    let toY2 = null, fromY2 = null;
    const s2 = opts.scaleY2;
    if (s2 && isFinite(s2.min) && isFinite(s2.max) && s2.max > s2.min) {
        const t2 = PRiSM_plot_makeTransform({ kind: 'lin', min: s2.min, max: s2.max }, plot.y, plot.h, true);
        toY2 = t2.to; fromY2 = t2.from;
        const ticks2 = PRiSM_plot_lin_ticks(s2.min, s2.max, yTarget);
        ctx.fillStyle = s2.color || PRiSM_THEME.cyan;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        let last2 = Infinity;
        ticks2.forEach(function (v) {
            const py = Math.round(toY2(v)) + 0.5;
            if (Math.abs(last2 - py) < 13) return;
            ctx.fillText(PRiSM_plot_format_tick(v, false, ticks2.step), plot.x + plot.w + 5, py);
            last2 = py;
        });
    }

    // Border on top
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);

    // Axis labels
    ctx.fillStyle = PRiSM_THEME.text;
    ctx.font = (narrow ? '11px' : '12px') + ' sans-serif';
    if (scaleX.label) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(scaleX.label, plot.x + plot.w / 2, plot.cssH - (narrow ? 4 : 8), Math.max(40, plot.cssW - 8));
    }
    if (scaleY.label) {
        ctx.save();
        ctx.translate(narrow ? 11 : 14, plot.y + plot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(scaleY.label, 0, 0, Math.max(40, plot.h + (plot.pad ? plot.pad.top : 0)));
        ctx.restore();
    }
    if (s2 && toY2 && s2.label) {
        ctx.save();
        ctx.fillStyle = s2.color || PRiSM_THEME.cyan;
        ctx.translate(plot.cssW - (narrow ? 8 : 10), plot.y + plot.h / 2);
        ctx.rotate(Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(s2.label, 0, 0, Math.max(40, plot.h));
        ctx.restore();
    }

    // Title
    if (opts.title) {
        ctx.fillStyle = PRiSM_THEME.text;
        ctx.font = 'bold ' + (narrow ? '12px' : '13px') + ' sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(opts.title, plot.x, narrow ? 7 : 8, Math.max(40, plot.cssW - plot.x - 8));
    }

    // C6 axes object (+ the legacy flat keys read by the analysis-key and
    // overlay layers). Scales are copied so a stashed object stays
    // self-consistent after a later zoom.
    if (opts.canvas) {
        const sX = PRiSM_plot_copyScale(scaleX), sY = PRiSM_plot_copyScale(scaleY);
        const axes = {
            scaleX: sX, scaleY: sY,
            toX: toX, toY: toY, fromX: fromX, fromY: fromY,
            plot: { x: plot.x, y: plot.y, w: plot.w, h: plot.h, cssW: plot.cssW, cssH: plot.cssH },
            plotKey: opts.plotKey || null,
            xLog: xLog, yLog: yLog,
            x0: plot.x, x1: plot.x + plot.w, y0: plot.y, y1: plot.y + plot.h,
            dx0: sX.min, dx1: sX.max, dy0: sY.min, dy1: sY.max,
            dpr: plot.dpr || 1
        };
        if (toY2) {
            axes.scaleY2 = { kind: 'lin', min: s2.min, max: s2.max, label: s2.label };
            axes.toY2 = toY2; axes.fromY2 = fromY2;
        }
        try { opts.canvas._prismAxes = axes; } catch (_) { /* detached node */ }
    }

    return { toX: toX, toY: toY, fromX: fromX, fromY: fromY, xLog: xLog, yLog: yLog, toY2: toY2, fromY2: fromY2 };
}

// ─────────────────────────────────────────────────────────────────────
// LEGEND — top-right, drawn AFTER all series so it sits on top.
// items: [ { label, color, dash:bool, marker:'line'|'dot' } ]
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_legend(ctx, items, plot, opts) {
    if (!items || !items.length) return;
    opts = opts || {};
    ctx.save();
    const narrow = !!plot.narrow;
    ctx.font = (narrow ? '10px' : '11px') + ' sans-serif';
    ctx.textBaseline = 'middle';
    const padX = narrow ? 6 : 8, padY = narrow ? 4 : 6, lineH = narrow ? 14 : 16, swatch = narrow ? 14 : 18;
    let maxW = 0;
    items.forEach(function (it) { maxW = Math.max(maxW, ctx.measureText(it.label).width || 0); });
    const boxW = Math.min(plot.w - 8, swatch + 6 + maxW + padX * 2);
    const boxH = items.length * lineH + padY * 2 - 4;
    const bx = plot.x + plot.w - boxW - (narrow ? 4 : 8);
    const by = plot.y + (narrow ? 4 : 8);
    ctx.fillStyle = 'rgba(13,17,23,0.85)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
    items.forEach(function (it, i) {
        const ly = by + padY + i * lineH + lineH / 2 - 2;
        ctx.strokeStyle = it.color;
        ctx.fillStyle = it.color;
        ctx.lineWidth = 2;
        if (it.marker === 'dot') {
            ctx.beginPath();
            ctx.arc(bx + padX + swatch / 2, ly, 3, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.beginPath();
            if (it.dash) ctx.setLineDash([5, 3]);
            ctx.moveTo(bx + padX, ly);
            ctx.lineTo(bx + padX + swatch, ly);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        ctx.fillStyle = PRiSM_THEME.text;
        ctx.textAlign = 'left';
        ctx.fillText(it.label, bx + padX + swatch + 6, ly, Math.max(20, boxW - swatch - padX * 2 - 6));
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// SHARED — line series, scatter series
// ─────────────────────────────────────────────────────────────────────
// P6 plot decimation (drawing only — data, fits and _prismAxes are untouched).
// A series longer than PRiSM_PLOT_DECIMATE_MIN points is drawn with the M4 rule:
// per pixel column keep the first, lowest, highest and last vertex in their
// original order, which rasterises to the same polyline (Jugel et al., "M4: A
// Visualization-Oriented Time Series Data Aggregation", PVLDB 7(10), 2014).
// Markers keep one dot per half-pixel cell.
const PRiSM_PLOT_DECIMATE_MIN = 1500;
function PRiSM_plot_pathM4(ctx, pts, toX, toY) {
    let started = false, col = null, b = null;
    const flush = function () {
        if (!b) return;
        let last = -1;
        [b.f, b.mn, b.mx, b.l].sort(function (a, c) { return a.i - c.i; }).forEach(function (q) {
            if (q.i === last) return;
            last = q.i;
            if (!started) { ctx.moveTo(q.x, q.y); started = true; } else ctx.lineTo(q.x, q.y);
        });
        b = null;
    };
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const x = (p && isFinite(p[0]) && isFinite(p[1])) ? toX(p[0]) : NaN;
        const y = isFinite(x) ? toY(p[1]) : NaN;
        if (!isFinite(x) || !isFinite(y)) { flush(); started = false; col = null; continue; }
        const c = Math.floor(x);
        if (b && c !== col) flush();
        col = c;
        const q = { i: i, x: x, y: y };
        if (!b) b = { f: q, mn: q, mx: q, l: q };
        else { if (y < b.mn.y) b.mn = q; if (y > b.mx.y) b.mx = q; b.l = q; }
    }
    flush();
}

function PRiSM_plot_line(ctx, pts, toX, toY, color, opts) {
    if (!pts || !pts.length) return;
    opts = opts || {};
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.width || 2;
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
    if (pts.length > PRiSM_PLOT_DECIMATE_MIN) {
        PRiSM_plot_pathM4(ctx, pts, toX, toY);
        ctx.stroke();
        ctx.restore();
        return;
    }
    let started = false;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) { started = false; continue; }
        const x = toX(p[0]), y = toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) { started = false; continue; }
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
}

function PRiSM_plot_dots(ctx, pts, toX, toY, color, r) {
    if (!pts || !pts.length) return;
    r = r || 2.5;
    ctx.save();
    ctx.fillStyle = color;
    const seen = pts.length > PRiSM_PLOT_DECIMATE_MIN ? new Set() : null;
    pts.forEach(function (p) {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        const x = toX(p[0]), y = toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) return;
        if (seen) {
            const k = Math.round(x * 2) + ',' + Math.round(y * 2);
            if (seen.has(k)) return;
            seen.add(k);
        }
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// AUTO-RANGE — computes min/max for an array, padded, log-safe.
// maxDecades (log only) floors min at max/10^maxDecades so a single
// noisy near-zero derivative cannot flatten the whole plot.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_range(arr, isLog, padFrac, maxDecades) {
    if (!arr || !arr.length) return { min: isLog ? 0.1 : 0, max: isLog ? 10 : 1 };
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!isFinite(v)) continue;
        if (isLog && v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return { min: isLog ? 0.1 : 0, max: isLog ? 10 : 1 };
    if (isLog && maxDecades > 0 && max / min > Math.pow(10, maxDecades)) min = max / Math.pow(10, maxDecades);
    if (min === max) {
        if (isLog) { min /= 2; max *= 2; }
        else if (min === 0) { max = 1; }
        else { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    }
    if (isLog) {
        // Snap to outer decades for nice ticks.
        const lo = Math.pow(10, Math.floor(Math.log10(min) + 1e-9));
        const hi = Math.pow(10, Math.ceil(Math.log10(max) - 1e-9));
        return { min: lo, max: hi > lo ? hi : lo * 10 };
    }
    const f = padFrac == null ? 0.05 : padFrac;
    const span = max - min;
    return { min: min - span * f, max: max + span * f };
}

// ─────────────────────────────────────────────────────────────────────
// PERIODS — every flow period shaded (shut-ins tinted blue), active
// period highlighted. Accepts {start,end} and {t0,t1} (C2 / C6).
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_periods(ctx, periods, activeIdx, toX, plot) {
    if (!periods || !periods.length) return;
    PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
    for (let i = 0; i < periods.length; i++) {
        const pr = periods[i];
        if (!pr) continue;
        const s = PRiSM_plot_num(pr.start, pr.t0, pr.tStart);
        const e = PRiSM_plot_num(pr.end, pr.t1, pr.tEnd);
        if (!isFinite(s) || !isFinite(e)) continue;
        const x0 = toX(s), x1 = toX(e);
        if (!isFinite(x0) || !isFinite(x1)) continue;
        const lo = Math.min(x0, x1), w = Math.max(1, Math.abs(x1 - x0));
        const active = i === activeIdx;
        const shut = PRiSM_plot_isNum(pr.q) && Math.abs(+pr.q) < 1e-12;
        ctx.fillStyle = active ? 'rgba(240,136,62,0.14)'
            : (shut ? 'rgba(88,166,255,0.08)' : (i % 2 ? 'rgba(139,148,158,0.05)' : 'rgba(139,148,158,0.09)'));
        ctx.fillRect(lo, plot.y, w, plot.h);
        ctx.strokeStyle = active ? PRiSM_THEME.accent : 'rgba(139,148,158,0.45)';
        ctx.lineWidth = 1;
        ctx.setLineDash(active ? [4, 3] : [2, 4]);
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, plot.y); ctx.lineTo(x0 + 0.5, plot.y + plot.h);
        ctx.moveTo(x1 + 0.5, plot.y); ctx.lineTo(x1 + 0.5, plot.y + plot.h);
        ctx.stroke();
        ctx.setLineDash([]);
        const label = pr.label || (active ? 'Analysed period' : '');
        if (label && w > 30) {
            ctx.fillStyle = active ? PRiSM_THEME.accent : PRiSM_THEME.text3;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(label, lo + 4, plot.y + 4, Math.max(20, w - 6));
        }
    }
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// SEMILOG STRAIGHT LINE  p = b + m·X  on a plot whose x value maps to X
// through xOf (Horner: log10 ratio, MDH: log10 Δt, superposition: X).
// win = [xa, xb] in PLOTTED x units (solid), the rest is dashed.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, xOf, win) {
    if (!line || !isFinite(line.m) || !isFinite(line.b)) return;
    const pAt = function (xv) { return line.b + line.m * xOf(xv); };
    const xa = scaleX.min, xb = scaleX.max;
    PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
    ctx.strokeStyle = 'rgba(88,166,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(tr.toX(xa), tr.toY(pAt(xa)));
    ctx.lineTo(tr.toX(xb), tr.toY(pAt(xb)));
    ctx.stroke();
    ctx.setLineDash([]);
    if (win && isFinite(win[0]) && isFinite(win[1])) {
        const w0 = Math.min(win[0], win[1]), w1 = Math.max(win[0], win[1]);
        ctx.strokeStyle = PRiSM_THEME.blue;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(tr.toX(w0), tr.toY(pAt(w0)));
        ctx.lineTo(tr.toX(w1), tr.toY(pAt(w1)));
        ctx.stroke();
        ctx.fillStyle = PRiSM_THEME.blue;
        [w0, w1].forEach(function (xv) {
            ctx.beginPath();
            ctx.arc(tr.toX(xv), tr.toY(pAt(xv)), 3, 0, Math.PI * 2);
            ctx.fill();
        });
    }
    ctx.restore();
}

// Marker + label at a key abscissa (p* at ratio 1, p1hr at 1 h …).
function PRiSM_plot_keyPoint(ctx, tr, plot, xv, pv, text, color) {
    const px = tr.toX(xv), py = tr.toY(pv);
    if (!isFinite(px) || !isFinite(py)) return;
    if (px < plot.x - 1 || px > plot.x + plot.w + 1 || py < plot.y - 1 || py > plot.y + plot.h + 1) return;
    ctx.save();
    ctx.fillStyle = color || PRiSM_THEME.green;
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = (plot.narrow ? '10px' : '11px') + ' sans-serif';
    ctx.textBaseline = 'bottom';
    const w = ctx.measureText(text).width || 0;
    const right = px + 8 + w > plot.x + plot.w;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(text, right ? px - 8 : px + 8, Math.max(plot.y + 12, py - 6));
    ctx.restore();
}

// ════════════════════════════════════════════════════════════════════
// ── INTERACTION LAYER (Pointer Events + ResizeObserver) ─────────────
// ════════════════════════════════════════════════════════════════════
function PRiSM_plot_signature(pts) {
    if (!pts || !pts.length) return '0';
    const f = function (v) { return isFinite(v) ? (+v).toPrecision(7) : 'x'; };
    const a = pts[0], b = pts[pts.length - 1], m = pts[pts.length >> 1];
    return pts.length + ':' + f(a[0]) + ',' + f(a[1]) + ':' + f(m[0]) + ',' + f(m[1]) + ':' + f(b[0]) + ',' + f(b[1]);
}

function PRiSM_plot_validRange(kind, r) {
    return r && isFinite(r.min) && isFinite(r.max) && r.max > r.min && (kind !== 'log' || r.min > 0);
}

function PRiSM_plot_applyView(sx, sy, view) {
    if (!view) return false;
    let ok = false;
    if (PRiSM_plot_validRange(sx.kind, view.x)) { sx.min = +view.x.min; sx.max = +view.x.max; ok = true; }
    if (PRiSM_plot_validRange(sy.kind, view.y)) { sy.min = +view.y.min; sy.max = +view.y.max; ok = true; }
    return ok;
}

// Finish a plot call: restore a persisted user view, paint, install the
// (once-per-canvas) interaction layer.
//   cfg = { scaleX, scaleY, points, sigPoints?, plotKey, data, xName,
//           yName, result? }
function PRiSM_plot_finish(setup, render, cfg) {
    const S = setup.S, canvas = setup.canvas, opts = setup.opts || {};
    const sx = cfg.scaleX, sy = cfg.scaleY;
    const plotKey = (typeof opts.plotKey === 'string' && opts.plotKey) ? opts.plotKey : (cfg.plotKey || null);
    const auto = { x: PRiSM_plot_copyScale(sx), y: PRiSM_plot_copyScale(sy) };
    const sig = PRiSM_plot_signature(cfg.sigPoints || cfg.points);
    let zoomed = false;
    if (opts.view && PRiSM_plot_applyView(sx, sy, opts.view)) zoomed = true;
    else if (!opts.resetView) {
        const pa = setup.prevAxes;
        const uv = pa && pa.userView;
        if (uv && pa.plotKey === plotKey && pa.dataSig === sig && uv.x && uv.y &&
            uv.x.kind === sx.kind && uv.y.kind === sy.kind && PRiSM_plot_applyView(sx, sy, uv)) {
            zoomed = true;
        }
    }
    try { canvas._prismOriginalScale = { x: PRiSM_plot_copyScale(auto.x), y: PRiSM_plot_copyScale(auto.y) }; }
    catch (_) { /* detached */ }
    PRiSM_plot_ariaSummary(canvas, opts, cfg, plotKey);
    S.cur = {
        canvas: canvas, ctx: setup.ctx, plot: setup.plot, render: render, opts: opts, extra: setup.extra,
        data: cfg.data || null, plotKey: plotKey, scaleX: sx, scaleY: sy, auto: auto, zoomed: zoomed,
        sig: sig, points: cfg.points || [], xName: cfg.xName || 'x', yName: cfg.yName || 'y',
        result: cfg.result || null
    };
    PRiSM_plot_paint(S, 'initial');
    PRiSM_plot_install(canvas, S);
}

// P10: the plot is an image to assistive technology — role="img" plus a text
// summary (plot, axes, point count and data ranges). An author-set label wins.
function PRiSM_plot_ariaSummary(canvas, opts, cfg, plotKey) {
    try {
        if (!canvas || typeof canvas.setAttribute !== 'function') return;
        if (canvas.hasAttribute && canvas.hasAttribute('aria-label') && !canvas.hasAttribute('data-a11y-auto')) return;
        const pts = cfg.sigPoints || cfg.points || [];   // the measured series (Bourdet: Δp, not Δp + derivative)
        let n = 0, x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
            n++;
            if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
            if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
        }
        const name = String(opts.title || plotKey || 'PRiSM') + ' plot';
        const xn = String(cfg.xName || 'x'), yn = String(cfg.yName || 'y');
        const f = function (v) { return PRiSM_plot_format_eng(v, 3); };
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('data-a11y-auto', '1');
        canvas.setAttribute('aria-label', name + ': ' + yn + ' against ' + xn + '. ' +
            (n ? n + ' points; ' + xn + ' ' + f(x0) + ' to ' + f(x1) + ', ' + yn + ' ' + f(y0) + ' to ' + f(y1) + '.' : 'No data points.'));
    } catch (_) { /* a label is a nicety — never break a plot */ }
}

function PRiSM_plot_decorate(S) {
    const cur = S.cur;
    const ax = cur && cur.canvas._prismAxes;
    if (!ax) return;
    ax.plotKey = cur.plotKey;
    ax.dataSig = cur.sig;
    ax.userView = cur.zoomed ? { x: PRiSM_plot_copyScale(cur.scaleX), y: PRiSM_plot_copyScale(cur.scaleY) } : null;
    ax.autoScale = { x: PRiSM_plot_copyScale(cur.auto.x), y: PRiSM_plot_copyScale(cur.auto.y) };
    ax.points = cur.points;
    if (cur.result) ax.result = cur.result;
}

function PRiSM_plot_runHooks(S, reason) {
    const cur = S.cur;
    if (!cur || cur.empty) return;
    const o = cur.opts || {};
    const info = { canvas: cur.canvas, plotKey: cur.plotKey, data: cur.data, opts: o,
                   axes: cur.canvas._prismAxes || null, reason: reason };
    if (typeof o.postDraw === 'function') {
        try { o.postDraw(info); } catch (e) { try { console.warn('PRiSM plot postDraw failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
    const want = o.postDrawHooks === true ||
        (o.postDrawHooks !== false && typeof o.plotKey === 'string' && !!o.plotKey);
    const hooks = PRiSM_PLOT_G.PRiSM_postDrawHooks;
    if (!want || !hooks || typeof hooks.length !== 'number') return;
    for (let i = 0; i < hooks.length; i++) {
        const h = hooks[i];
        const fn = typeof h === 'function' ? h : (h && typeof h.fn === 'function' ? h.fn : null);
        if (!fn) continue;
        try { fn(info); } catch (e) { try { console.warn('PRiSM post-draw hook failed:', e && e.message); } catch (_) { /* ignore */ } }
    }
}

// Full repaint. reason: 'initial' | 'view' | 'reset' | 'resize'
function PRiSM_plot_paint(S, reason) {
    const cur = S.cur;
    if (!cur) return;
    if (reason === 'resize') {
        const r = PRiSM_plot_applySize(cur.canvas, cur.opts || {}, S, cur.extra);
        Object.assign(cur.plot, r.plot);
    }
    S.snap = null;
    if (reason !== 'initial') S.hover = null;
    try { cur.render(); }
    catch (e) { try { console.warn('PRiSM plot render failed:', e && e.message); } catch (_) { /* ignore */ } return; }
    if (cur.empty) return;
    PRiSM_plot_decorate(S);
    if (reason !== 'initial') PRiSM_plot_runHooks(S, reason);
}

function PRiSM_plot_schedule(S, reason) {
    S.rafReason = (S.rafReason === 'resize' || reason === 'resize') ? 'resize' : reason;
    if (S.raf != null) return;
    const G = PRiSM_PLOT_G;
    if (typeof G.requestAnimationFrame === 'function') {
        S.raf = G.requestAnimationFrame(function () { S.raf = null; PRiSM_plot_flushPaint(S); });
    } else {
        PRiSM_plot_flushPaint(S);
    }
}

function PRiSM_plot_flushPaint(S) {
    const G = PRiSM_PLOT_G;
    if (S.raf != null) {
        try { if (typeof G.cancelAnimationFrame === 'function') G.cancelAnimationFrame(S.raf); } catch (_) { /* ignore */ }
        S.raf = null;
    }
    const reason = S.rafReason;
    S.rafReason = null;
    if (reason) PRiSM_plot_paint(S, reason);
}

function PRiSM_plot_emitView(S) {
    const cur = S.cur;
    if (!cur || cur.empty) return;
    const canvas = cur.canvas;
    const detail = { plotKey: cur.plotKey, zoomed: !!cur.zoomed,
                     view: { x: PRiSM_plot_copyScale(cur.scaleX), y: PRiSM_plot_copyScale(cur.scaleY) } };
    try {
        const CE = PRiSM_PLOT_G.CustomEvent;
        if (typeof CE === 'function' && typeof canvas.dispatchEvent === 'function') {
            canvas.dispatchEvent(new CE('prism:plot-view-changed', { bubbles: true, detail: detail }));
        }
    } catch (_) { /* ignore */ }
}

function PRiSM_plot_clearLongPress(S) {
    if (S.lpTimer != null) {
        try { PRiSM_PLOT_G.clearTimeout(S.lpTimer); } catch (_) { /* ignore */ }
        S.lpTimer = null;
    }
}

function PRiSM_plot_abortGesture(S) {
    if (!S) return;
    PRiSM_plot_clearLongPress(S);
    S.gesture = null;
    if (S.raf != null) {
        try { if (typeof PRiSM_PLOT_G.cancelAnimationFrame === 'function') PRiSM_PLOT_G.cancelAnimationFrame(S.raf); } catch (_) { /* ignore */ }
        S.raf = null;
    }
    S.rafReason = null;
}

// View maths in "u-space" (log10 for log axes, value for linear axes).
function PRiSM_plot_uRange(scale) {
    return scale.kind === 'log' ? [Math.log10(scale.min), Math.log10(scale.max)] : [scale.min, scale.max];
}

function PRiSM_plot_setU(scale, a, b) {
    if (!isFinite(a) || !isFinite(b)) return false;
    if (b < a) { const t = a; a = b; b = t; }
    let span = b - a;
    const mid = (a + b) / 2;
    if (scale.kind === 'log') {
        const s2 = Math.min(40, Math.max(0.02, span));
        if (s2 !== span) { span = s2; a = mid - span / 2; b = mid + span / 2; }
        if (a < -300 || b > 300) return false;
        scale.min = Math.pow(10, a);
        scale.max = Math.pow(10, b);
    } else {
        const minSpan = Math.max(Math.abs(mid) * 1e-9, 1e-12);
        if (!(span >= minSpan)) { span = minSpan; a = mid - span / 2; b = mid + span / 2; }
        if (!isFinite(span) || span > 1e300) return false;
        scale.min = a;
        scale.max = b;
    }
    return true;
}

function PRiSM_plot_viewU(cur) {
    return { x: PRiSM_plot_uRange(cur.scaleX), y: PRiSM_plot_uRange(cur.scaleY) };
}

function PRiSM_plot_localXY(canvas, S, e) {
    let r = null;
    try { r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null; } catch (_) { r = null; }
    const left = r ? (r.left || 0) : 0, top = r ? (r.top || 0) : 0;
    // CSS-scaled canvases (max-width:100% on a phone): map to plot px.
    const kx = (r && r.width > 0 && S.cssW > 0) ? S.cssW / r.width : 1;
    const ky = (r && r.height > 0 && S.cssH > 0) ? S.cssH / r.height : 1;
    return { x: ((+e.clientX || 0) - left) * kx, y: ((+e.clientY || 0) - top) * ky };
}

function PRiSM_plot_inPlot(plot, p, slop) {
    slop = slop || 0;
    return p.x >= plot.x - slop && p.x <= plot.x + plot.w + slop &&
           p.y >= plot.y - slop && p.y <= plot.y + plot.h + slop;
}

function PRiSM_plot_nearest(cur, pos, radius) {
    const ax = cur.canvas._prismAxes;
    if (!ax || !cur.points || !cur.points.length) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < cur.points.length; i++) {
        const p = cur.points[i];
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
        const x = ax.toX(p[0]), y = ax.toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) continue;
        const d = (x - pos.x) * (x - pos.x) + (y - pos.y) * (y - pos.y);
        if (d < bd) { bd = d; best = p; }
    }
    if (!best || bd > radius * radius) return null;
    return {
        p: best,
        label: cur.xName + ' ' + PRiSM_plot_format_eng(best[0], 4) + ' · ' +
               (best[2] || cur.yName) + ' ' + PRiSM_plot_format_eng(best[1], 4)
    };
}

function PRiSM_plot_snapshot(canvas) {
    try {
        const doc = PRiSM_PLOT_G.document;
        if (!doc || typeof doc.createElement !== 'function') return null;
        const s = doc.createElement('canvas');
        s.width = canvas.width; s.height = canvas.height;
        const sc = s.getContext ? s.getContext('2d') : null;
        if (!sc || typeof sc.drawImage !== 'function') return null;
        sc.drawImage(canvas, 0, 0);
        return s;
    } catch (_) { return null; }
}

// Light-weight frame for hover / box-zoom: restore the cached frame
// (which includes whatever post-draw hooks painted) and draw on top.
function PRiSM_plot_overlayFrame(S) {
    const cur = S.cur;
    if (!cur || cur.empty) return;
    const ctx = cur.ctx, plot = cur.plot;
    if (!S.snap) S.snap = PRiSM_plot_snapshot(cur.canvas);
    if (S.snap) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(S.snap, 0, 0);
        ctx.restore();
    } else {
        try { cur.render(); } catch (_) { return; }
        PRiSM_plot_decorate(S);
    }
    const g = S.gesture;
    if (g && g.mode === 'box') {
        ctx.save();
        ctx.fillStyle = 'rgba(88,166,255,0.10)';
        ctx.strokeStyle = PRiSM_THEME.blue;
        ctx.lineWidth = 1;
        const rx = Math.min(g.x0, g.x1), ry = Math.min(g.y0, g.y1);
        const rw = Math.abs(g.x1 - g.x0), rh = Math.abs(g.y1 - g.y0);
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
        ctx.restore();
    }
    const ax = cur.canvas._prismAxes;
    if (S.hover && ax) {
        const px = ax.toX(S.hover.p[0]), py = ax.toY(S.hover.p[1]);
        if (isFinite(px) && isFinite(py)) {
            ctx.save();
            ctx.strokeStyle = PRiSM_THEME.text2;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(plot.x, py + 0.5); ctx.lineTo(plot.x + plot.w, py + 0.5);
            ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = PRiSM_THEME.accent;
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, Math.PI * 2);
            ctx.fill();
            const label = S.hover.label;
            ctx.font = '11px sans-serif';
            const tw = (ctx.measureText(label).width || 0) + 12;
            const th = 18;
            let tx = px + 8, ty = py - th - 8;
            if (tx + tw > plot.x + plot.w) tx = Math.max(plot.x, px - tw - 8);
            if (ty < plot.y) ty = py + 8;
            ctx.fillStyle = 'rgba(13,17,23,0.92)';
            ctx.fillRect(tx, ty, tw, th);
            ctx.strokeStyle = PRiSM_THEME.border;
            ctx.strokeRect(tx + 0.5, ty + 0.5, tw, th);
            ctx.fillStyle = PRiSM_THEME.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, tx + 6, ty + th / 2);
            ctx.restore();
        }
    }
}

function PRiSM_plot_zoomAbout(cur, pos, fx, fy) {
    const plot = cur.plot;
    const vx = PRiSM_plot_uRange(cur.scaleX), vy = PRiSM_plot_uRange(cur.scaleY);
    const fxr = (pos.x - plot.x) / plot.w, fyr = (plot.y + plot.h - pos.y) / plot.h;
    if (fx !== 1) {
        const sx = (vx[1] - vx[0]) * fx, ux = vx[0] + fxr * (vx[1] - vx[0]);
        PRiSM_plot_setU(cur.scaleX, ux - fxr * sx, ux - fxr * sx + sx);
    }
    if (fy !== 1) {
        const sy = (vy[1] - vy[0]) * fy, uy = vy[0] + fyr * (vy[1] - vy[0]);
        PRiSM_plot_setU(cur.scaleY, uy - fyr * sy, uy - fyr * sy + sy);
    }
    cur.zoomed = true;
}

function PRiSM_plot_applyPan(cur, v0, dx, dy) {
    const plot = cur.plot;
    const sx = v0.x[1] - v0.x[0], sy = v0.y[1] - v0.y[0];
    const ox = dx / plot.w * sx, oy = dy / plot.h * sy;
    PRiSM_plot_setU(cur.scaleX, v0.x[0] - ox, v0.x[1] - ox);
    PRiSM_plot_setU(cur.scaleY, v0.y[0] + oy, v0.y[1] + oy);
    cur.zoomed = true;
}

function PRiSM_plot_pinchPoints(S, g) {
    const a = S.pointers.get(g.ids[0]), b = S.pointers.get(g.ids[1]);
    return (a && b) ? [a, b] : null;
}

function PRiSM_plot_startPinch(S, cur) {
    const ids = Array.from(S.pointers.keys()).slice(-2);
    const g = { mode: 'pinch', ids: ids };
    const pts = PRiSM_plot_pinchPoints(S, g);
    if (!pts) return null;
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    g.d0 = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    g.dx0 = Math.max(1, Math.abs(dx));
    g.dy0 = Math.max(1, Math.abs(dy));
    g.axis = Math.abs(dx) > 2.5 * Math.abs(dy) ? 'x' : (Math.abs(dy) > 2.5 * Math.abs(dx) ? 'y' : 'xy');
    g.m0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    g.view0 = PRiSM_plot_viewU(cur);
    return g;
}

function PRiSM_plot_updatePinch(S, cur, g) {
    const pts = PRiSM_plot_pinchPoints(S, g);
    if (!pts) return false;
    const plot = cur.plot;
    const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
    const d1 = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const m1 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    const rx = g.axis === 'y' ? 1 : (g.axis === 'x' ? g.dx0 / Math.max(1, Math.abs(dx)) : g.d0 / d1);
    const ry = g.axis === 'x' ? 1 : (g.axis === 'y' ? g.dy0 / Math.max(1, Math.abs(dy)) : g.d0 / d1);
    const v0 = g.view0;
    const sx0 = v0.x[1] - v0.x[0], sy0 = v0.y[1] - v0.y[0];
    const umx = v0.x[0] + (g.m0.x - plot.x) / plot.w * sx0;
    const sx1 = sx0 * rx;
    const ax = umx - (m1.x - plot.x) / plot.w * sx1;
    PRiSM_plot_setU(cur.scaleX, ax, ax + sx1);
    const umy = v0.y[0] + (plot.y + plot.h - g.m0.y) / plot.h * sy0;
    const sy1 = sy0 * ry;
    const ay = umy - (plot.y + plot.h - m1.y) / plot.h * sy1;
    PRiSM_plot_setU(cur.scaleY, ay, ay + sy1);
    cur.zoomed = true;
    return true;
}

function PRiSM_plot_zoomBox(S, cur, g) {
    const plot = cur.plot;
    const dx = Math.abs(g.x1 - g.x0), dy = Math.abs(g.y1 - g.y0);
    const zx = dx >= 6 && (dy >= 6 || dx >= 12);
    const zy = dy >= 6 && (dx >= 6 || dy >= 12);
    if (!zx && !zy) return false;
    const vx = PRiSM_plot_uRange(cur.scaleX), vy = PRiSM_plot_uRange(cur.scaleY);
    if (zx) {
        const f0 = (Math.min(g.x0, g.x1) - plot.x) / plot.w, f1 = (Math.max(g.x0, g.x1) - plot.x) / plot.w;
        PRiSM_plot_setU(cur.scaleX, vx[0] + f0 * (vx[1] - vx[0]), vx[0] + f1 * (vx[1] - vx[0]));
    }
    if (zy) {
        const f0 = (plot.y + plot.h - Math.max(g.y0, g.y1)) / plot.h, f1 = (plot.y + plot.h - Math.min(g.y0, g.y1)) / plot.h;
        PRiSM_plot_setU(cur.scaleY, vy[0] + f0 * (vy[1] - vy[0]), vy[0] + f1 * (vy[1] - vy[0]));
    }
    cur.zoomed = true;
    return true;
}

function PRiSM_plot_makeHandlers(canvas, S) {
    const G = PRiSM_PLOT_G;
    const LONG_PRESS_MS = 600, SLOP = 8;
    const live = function () { return (S.cur && !S.cur.empty) ? S.cur : null; };
    const finishView = function () {
        if (S.raf != null || S.rafReason) { S.rafReason = S.rafReason || 'view'; PRiSM_plot_flushPaint(S); }
        PRiSM_plot_emitView(S);
    };
    const startLongPress = function () {
        PRiSM_plot_clearLongPress(S);
        if (typeof G.setTimeout !== 'function') return;
        S.lpTimer = G.setTimeout(function () {
            S.lpTimer = null;
            const g = S.gesture;
            if (!g || g.mode !== 'press') return;
            g.consumed = true;
            PRiSM_plotResetView(canvas);
        }, LONG_PRESS_MS);
    };

    const down = function (e) {
        const cur = live();
        if (!cur || !S.pointers) return;
        const o = cur.opts || {};
        if (PRiSM_plot_dprChanged(S)) { S.rafReason = 'resize'; PRiSM_plot_flushPaint(S); }
        const pos = PRiSM_plot_localXY(canvas, S, e);
        const type = e.pointerType || 'mouse';
        // Clear the read-out, then drop the cached frame: click handlers of
        // other layers (analysis keys) may draw on this press, and the next
        // overlay must be built on top of their marks, not erase them.
        if (S.hover) { S.hover = null; PRiSM_plot_overlayFrame(S); }
        S.snap = null;
        S.pointers.set(e.pointerId, { x: pos.x, y: pos.y, type: type });
        const touchLike = type === 'touch' || type === 'pen';
        if (S.pointers.size === 1) {
            if (!PRiSM_plot_inPlot(cur.plot, pos, 4)) return;
            if (touchLike) {
                if (!o.dragZoom && !o.hover) return;
                S.gesture = { mode: 'press', id: e.pointerId, x0: pos.x, y0: pos.y, t0: PRiSM_plot_now(),
                              view0: PRiSM_plot_viewU(cur), touch: true, consumed: false };
                if (o.dragZoom) startLongPress();
            } else {
                if (!o.dragZoom) return;
                const btn = e.button || 0;
                if (btn === 1 || (btn === 0 && (e.shiftKey || e.altKey))) {
                    S.gesture = { mode: 'pan', id: e.pointerId, x0: pos.x, y0: pos.y, view0: PRiSM_plot_viewU(cur) };
                } else if (btn === 0) {
                    S.gesture = { mode: 'box', id: e.pointerId, x0: pos.x, y0: pos.y, x1: pos.x, y1: pos.y };
                } else return;
            }
            if (o.dragZoom) { try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }
        } else if (S.pointers.size >= 2 && o.dragZoom) {
            PRiSM_plot_clearLongPress(S);
            const g = PRiSM_plot_startPinch(S, cur);
            if (g) {
                S.gesture = g;
                S.hover = null;
                try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
            }
        }
    };

    const move = function (e) {
        const cur = live();
        if (!cur || !S.pointers) return;
        const o = cur.opts || {};
        const pos = PRiSM_plot_localXY(canvas, S, e);
        const rec = S.pointers.get(e.pointerId);
        if (rec) { rec.x = pos.x; rec.y = pos.y; }
        const g = S.gesture;
        if (g && g.mode === 'pinch') {
            if (rec && PRiSM_plot_updatePinch(S, cur, g)) PRiSM_plot_schedule(S, 'view');
            return;
        }
        if (g && g.mode === 'done') return;
        if (g && g.id === e.pointerId) {
            if (g.mode === 'box') {
                const p = cur.plot;
                g.x1 = Math.max(p.x, Math.min(p.x + p.w, pos.x));
                g.y1 = Math.max(p.y, Math.min(p.y + p.h, pos.y));
                if (!g.drawn && Math.abs(g.x1 - g.x0) < 3 && Math.abs(g.y1 - g.y0) < 3) return;
                g.drawn = true;
                PRiSM_plot_overlayFrame(S);
                return;
            }
            const dx = pos.x - g.x0, dy = pos.y - g.y0;
            if (g.mode === 'press') {
                if (Math.sqrt(dx * dx + dy * dy) < SLOP) return;
                PRiSM_plot_clearLongPress(S);
                if (!o.dragZoom) { S.gesture = null; return; }
                g.mode = 'pan';
            }
            if (g.mode === 'pan') {
                PRiSM_plot_applyPan(cur, g.view0, dx, dy);
                S.hover = null;
                PRiSM_plot_schedule(S, 'view');
            }
            return;
        }
        if (!g && o.hover && (e.pointerType || 'mouse') === 'mouse') {
            if (PRiSM_plot_dprChanged(S)) { S.rafReason = 'resize'; PRiSM_plot_flushPaint(S); }
            if (!PRiSM_plot_inPlot(cur.plot, pos)) {
                if (S.hover) { S.hover = null; PRiSM_plot_overlayFrame(S); }
                return;
            }
            const h = PRiSM_plot_nearest(cur, pos, 30);
            if (!h && !S.hover) return;
            S.hover = h;
            PRiSM_plot_overlayFrame(S);
        }
    };

    const end = function (e, cancelled) {
        if (S.pointers) S.pointers.delete(e.pointerId);
        try { if (canvas.releasePointerCapture) canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        const g = S.gesture;
        const cur = live();
        if (!g) return;
        if (!cur) { S.gesture = null; PRiSM_plot_clearLongPress(S); return; }
        if (g.mode === 'pinch') {
            if (!S.pointers || S.pointers.size < 2) {
                S.gesture = (S.pointers && S.pointers.size) ? { mode: 'done' } : null;
                finishView();
            }
            return;
        }
        if (g.mode === 'done') { if (!S.pointers || !S.pointers.size) S.gesture = null; return; }
        if (g.id !== e.pointerId) return;
        PRiSM_plot_clearLongPress(S);
        S.gesture = null;
        if (g.mode === 'box') {
            if (!cancelled && PRiSM_plot_zoomBox(S, cur, g)) {
                PRiSM_plot_paint(S, 'view');
                PRiSM_plot_emitView(S);
            } else if (g.drawn) {
                PRiSM_plot_overlayFrame(S);      // wipe the rubber band only
            }
            return;
        }
        if (g.mode === 'pan') { finishView(); return; }
        if (g.mode === 'press' && !g.consumed && !cancelled && (cur.opts || {}).hover) {
            const pos = PRiSM_plot_localXY(canvas, S, e);
            S.hover = PRiSM_plot_nearest(cur, pos, 40);
            PRiSM_plot_overlayFrame(S);
        }
    };

    const up = function (e) { end(e, false); };
    const cancel = function (e) { end(e, true); };

    const leave = function (e) {
        if ((e.pointerType || 'mouse') !== 'mouse') return;
        if (S.hover && !S.gesture) { S.hover = null; PRiSM_plot_overlayFrame(S); }
        if (!S.gesture) S.snap = null;   // re-cache on re-entry (other layers may draw meanwhile)
    };

    const dbl = function () {
        const cur = live();
        if (cur && (cur.opts || {}).dragZoom) PRiSM_plotResetView(canvas);
    };

    const wheel = function (e) {
        const cur = live();
        if (!cur || !(cur.opts || {}).dragZoom) return;
        if (!(e.ctrlKey || e.metaKey)) return; // plain wheel scrolls the page
        const pos = PRiSM_plot_localXY(canvas, S, e);
        if (!PRiSM_plot_inPlot(cur.plot, pos)) return;
        if (e.cancelable && typeof e.preventDefault === 'function') e.preventDefault();
        let d = +e.deltaY || 0;
        if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
        d = Math.max(-100, Math.min(100, d));
        const f = Math.exp(d * 0.005);
        PRiSM_plot_zoomAbout(cur, pos, f, f);
        S.hover = null;
        S.rafReason = 'view';
        PRiSM_plot_flushPaint(S);
        PRiSM_plot_emitView(S);
    };

    const ctxmenu = function (e) {
        // Long-press on touch would open the system menu — suppress while a
        // finger is down on an interactive plot.
        let touching = false;
        if (S.pointers) S.pointers.forEach(function (p) { if (p.type === 'touch' || p.type === 'pen') touching = true; });
        if (touching && live() && (live().opts || {}).dragZoom && typeof e.preventDefault === 'function') e.preventDefault();
    };

    return { down: down, move: move, up: up, cancel: cancel, leave: leave, dbl: dbl, wheel: wheel, ctxmenu: ctxmenu };
}

// devicePixelRatio moved since the last paint (window dragged to another
// screen, browser zoom, host pane rescaled) → backing store must be rebuilt.
function PRiSM_plot_dprChanged(S) {
    const d = PRiSM_PLOT_G.devicePixelRatio || 1;
    return !!S.dpr && Math.abs(d - S.dpr) > 1e-6;
}

function PRiSM_plot_observe(canvas, S) {
    if (S.ro || !(S.relW || S.relH)) return;
    const RO = PRiSM_PLOT_G.ResizeObserver;
    if (typeof RO !== 'function' || !canvas.isConnected) return;
    try {
        S.ro = new RO(function (entries) {
            if (!S.cur) return;
            let w = 0, h = 0;
            for (let i = 0; i < (entries ? entries.length : 0); i++) {
                const en = entries[i];
                if (en && en.target && en.target !== canvas) continue;
                const r = en && en.contentRect;
                if (r) { w = r.width; h = r.height; }
            }
            if (!(w > 0 && h > 0)) { w = canvas.clientWidth; h = canvas.clientHeight; }
            if (!(w >= 2 && h >= 2)) return;          // hidden — redraw when shown
            if (Math.abs(w - S.cssW) < 1 && Math.abs(h - S.cssH) < 1 && !PRiSM_plot_dprChanged(S)) return;
            PRiSM_plot_schedule(S, 'resize');
        });
        S.ro.observe(canvas);
    } catch (_) { S.ro = null; }
}

function PRiSM_plot_install(canvas, S) {
    const cur = S.cur;
    if (!cur) return;
    const o = cur.opts || {};
    const pan = !!o.dragZoom && !cur.empty;
    const hov = !!o.hover && !cur.empty;
    const st = canvas.style;
    if (st) {
        if (pan) {
            st.touchAction = 'none';
            try {
                if (typeof st.setProperty === 'function') {
                    st.setProperty('-webkit-touch-callout', 'none');
                    st.setProperty('-webkit-user-select', 'none');
                    st.setProperty('user-select', 'none');
                }
            } catch (_) { /* ignore */ }
            S.touchSet = true;
        } else if (S.touchSet) {
            st.touchAction = S.authorTouch;
            S.touchSet = false;
        }
    }
    if ((pan || hov) && !S.installed && typeof canvas.addEventListener === 'function' && S.pointers) {
        const h = PRiSM_plot_makeHandlers(canvas, S);
        canvas.addEventListener('pointerdown', h.down);
        canvas.addEventListener('pointermove', h.move);
        canvas.addEventListener('pointerup', h.up);
        canvas.addEventListener('pointercancel', h.cancel);
        canvas.addEventListener('pointerleave', h.leave);
        canvas.addEventListener('dblclick', h.dbl);
        canvas.addEventListener('wheel', h.wheel, { passive: false });
        canvas.addEventListener('contextmenu', h.ctxmenu);
        S.handlers = h;
        S.installed = true;
    }
    PRiSM_plot_observe(canvas, S);
}

// ── Public view API ─────────────────────────────────────────────────
function PRiSM_plotResetView(canvas) {
    const S = PRiSM_plot_getState(canvas);
    if (!S || !S.cur || S.cur.empty) return false;
    const cur = S.cur;
    cur.scaleX.min = cur.auto.x.min; cur.scaleX.max = cur.auto.x.max;
    cur.scaleY.min = cur.auto.y.min; cur.scaleY.max = cur.auto.y.max;
    cur.zoomed = false;
    S.hover = null;
    PRiSM_plot_abortGesture(S);
    PRiSM_plot_paint(S, 'reset');
    PRiSM_plot_emitView(S);
    return true;
}

function PRiSM_plotSetView(canvas, view) {
    const S = PRiSM_plot_getState(canvas);
    if (!S || !S.cur || S.cur.empty) return false;
    const cur = S.cur;
    if (!PRiSM_plot_applyView(cur.scaleX, cur.scaleY, view)) return false;
    cur.zoomed = true;
    PRiSM_plot_abortGesture(S);
    PRiSM_plot_paint(S, 'view');
    PRiSM_plot_emitView(S);
    return true;
}

function PRiSM_plotGetView(canvas) {
    const S = PRiSM_plot_getState(canvas);
    if (!S || !S.cur || S.cur.empty) return null;
    return { x: PRiSM_plot_copyScale(S.cur.scaleX), y: PRiSM_plot_copyScale(S.cur.scaleY),
             zoomed: !!S.cur.zoomed, plotKey: S.cur.plotKey };
}

// Kept for backward compatibility (older callers / docs). Interaction is
// now installed once per canvas by PRiSM_plot_finish.
function PRiSM_plot_attach_interactions(canvas) {
    const S = PRiSM_plot_getState(canvas);
    if (S) PRiSM_plot_install(canvas, S);
}

// ════════════════════════════════════════════════════════════════════
// ── NUMERICAL HELPERS (exported) ────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// BOURDET DERIVATIVE — log-smoothed (unchanged algorithm)
//
//   d[i] = ((Δp[i] - Δp[i-1])/dl1) * (dl2/dlT)
//        + ((Δp[i+1] - Δp[i])/dl2) * (dl1/dlT)
//
//   where dl1 = ln t[i] - ln t[i-1], dl2 = ln t[i+1] - ln t[i],
//         dlT = ln t[i+1] - ln t[i-1].
// Feed it SIGN-AWARE Δp (see CLAUDE.md). t may be any positive,
// increasing time function (Δt, Agarwal, exp(superposition)).
// ─────────────────────────────────────────────────────────────────────
function PRiSM_compute_bourdet(t, dp, L) {
    L = (isFinite(L) && L > 0) ? L : 0; // optional smoothing window in log units
    const n = t.length;
    const d = new Array(n).fill(NaN);
    if (n < 3) return d;
    for (let i = 1; i < n - 1; i++) {
        if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
        // Walk outward to find points that are at least L apart in ln t
        let i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            const lnT = Math.log(t[i]);
            while (i1 > 0 && lnT - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - lnT < L) i2++;
        }
        const t1 = t[i1], t2 = t[i2], ti = t[i];
        if (!isFinite(t1) || !isFinite(t2) || t1 <= 0 || t2 <= 0) continue;
        const dl1 = Math.log(ti) - Math.log(t1);
        const dl2 = Math.log(t2) - Math.log(ti);
        const dlT = Math.log(t2) - Math.log(t1);
        if (dl1 === 0 || dl2 === 0 || dlT === 0) continue;
        const a = (dp[i] - dp[i1]) / dl1 * (dl2 / dlT);
        const b = (dp[i2] - dp[i]) / dl2 * (dl1 / dlT);
        d[i] = a + b;
    }
    return d;
}

// Resolves the Bourdet implementation at call time (window override
// first) so a derivative computation is observable / replaceable.
function PRiSM_plot_bourdetImpl() {
    const w = PRiSM_PLOT_G.PRiSM_compute_bourdet;
    return typeof w === 'function' ? w : PRiSM_compute_bourdet;
}

// Sign-aware Δp from absolute pressure (CLAUDE.md rule):
//   sign = +1 build-up / injection (p rises), −1 drawdown / fall-off.
function PRiSM_plot_signedDp(p, pRef, sign) {
    const n = p.length;
    const ref = isFinite(pRef) ? pRef : p[0];
    const s = (sign === 1 || sign === -1) ? sign : ((p[n - 1] - p[0]) >= 0 ? 1 : -1);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = s * (p[i] - ref);
    return { dp: out, sign: s, pRef: ref };
}

// Unit factor from opts.timeUnit to DAYS (decline volumes).
function PRiSM_plot_timeUnit(opts) {
    const u = String((opts && opts.timeUnit) || 'd').toLowerCase();
    if (/^(h|hr|hrs|hour|hours)$/.test(u)) return { label: 'hr', toDays: 1 / 24 };
    if (/^(mo|mon|month|months)$/.test(u)) return { label: 'months', toDays: 30.4375 };
    if (/^(y|yr|yrs|year|years)$/.test(u)) return { label: 'yr', toDays: 365.25 };
    return { label: 'days', toDays: 1 };
}

function PRiSM_plot_rateUnits(opts) {
    const r = String((opts && opts.rateUnit) || 'STB/d');
    const gas = /mscf|mcf|scf|m3/i.test(r);
    const vol = (opts && opts.volumeUnit) || (gas ? r.replace(/\s*\/\s*d(ay)?$/i, '') : 'STB');
    return { rate: r, volume: vol, cumName: gas ? 'Gp' : 'Np' };
}

// Cumulative production Np[i] = Σ ½(q_i + q_{i−1})·Δt_days (trapezoid).
function PRiSM_plot_cumulative(t, q, timeUnit) {
    const n = Math.min(t ? t.length : 0, q ? q.length : 0);
    const k = PRiSM_plot_timeUnit({ timeUnit: timeUnit }).toDays;
    const out = new Array(n);
    if (!n) return out;
    out[0] = 0;
    for (let i = 1; i < n; i++) {
        const dt = (t[i] - t[i - 1]) * k;
        const inc = 0.5 * ((+q[i] || 0) + (+q[i - 1] || 0)) * dt;
        out[i] = out[i - 1] + (isFinite(inc) ? inc : 0);
    }
    return out;
}

// Rate steps [{t (start), q}] from data.rateHistory / data.periods /
// (data.q + absolute time). Consecutive equal rates are merged.
function PRiSM_plot_rateSteps(data, tAbs) {
    let steps = [];
    const rh = PRiSM_plot_arr(data.rateHistory);
    const pr = PRiSM_plot_arr(data.periods);
    if (rh) {
        for (let i = 0; i < rh.length; i++) {
            const r = rh[i] || {};
            const ts = PRiSM_plot_num(r.t_start, r.t, r.t0, r.start);
            if (isFinite(ts) && PRiSM_plot_isNum(r.q)) steps.push({ t: ts, q: +r.q });
        }
    } else if (pr) {
        for (let i = 0; i < pr.length; i++) {
            const r = pr[i] || {};
            const ts = PRiSM_plot_num(r.t0, r.start, r.tStart);
            if (isFinite(ts) && PRiSM_plot_isNum(r.q)) steps.push({ t: ts, q: +r.q });
        }
    } else if (PRiSM_plot_arr(data.q) && tAbs && data.q.length === tAbs.length) {
        let last = NaN;
        for (let i = 0; i < tAbs.length; i++) {
            const q = +data.q[i];
            if (!isFinite(q) || !isFinite(tAbs[i])) continue;
            if (!(Math.abs(q - last) <= 1e-9 * Math.max(1, Math.abs(q)))) {
                // A rate sample holds over the interval that ends at it, so
                // the step starts at the previous sample time.
                const ts = steps.length ? tAbs[Math.max(0, i - 1)] : Math.min(0, tAbs[i]);
                steps.push({ t: ts, q: q });
                last = q;
            }
        }
    }
    steps = steps.filter(function (s) { return isFinite(s.t) && isFinite(s.q); })
                 .sort(function (a, b) { return a.t - b.t; });
    const merged = [];
    for (let i = 0; i < steps.length; i++) {
        const s = steps[i], m = merged[merged.length - 1];
        if (m && Math.abs(s.q - m.q) <= 1e-9 * Math.max(1, Math.abs(s.q))) continue;
        if (m && Math.abs(s.t - m.t) < 1e-12) { m.q = s.q; continue; }
        merged.push({ t: s.t, q: s.q });
    }
    return merged.length ? merged : null;
}

// Superposition time function (Horner-generalised), see header.
//   dt[]    Δt since the start of the analysed step (hours)
//   steps[] [{t: start, q}] sorted; tStart = start of the analysed step
// Returns { x: X[], qRef, shutIn, n } or null.
function PRiSM_plot_superposition_x(dt, steps, tStart) {
    if (!steps || !steps.length || !dt || !dt.length) return null;
    let n = -1;
    for (let i = 0; i < steps.length; i++) if (steps[i].t <= tStart + 1e-9) n = i;
    if (n < 0) return null;
    const qn = steps[n].q;
    let qRef = qn;
    const shutIn = Math.abs(qn) < 1e-12;
    if (shutIn) {
        qRef = 0;
        for (let i = n - 1; i >= 0; i--) if (Math.abs(steps[i].q) > 1e-12) { qRef = steps[i].q; break; }
    }
    if (!qRef) return null;
    const Tn = steps[n].t;
    const X = new Array(dt.length);
    for (let j = 0; j < dt.length; j++) {
        const d = dt[j];
        if (!(d > 0)) { X[j] = NaN; continue; }
        let s = 0;
        for (let i = 0; i <= n; i++) {
            const qPrev = i === 0 ? 0 : steps[i - 1].q;
            const arg = Tn - steps[i].t + d;
            if (!(arg > 0)) { s = NaN; break; }
            s += (steps[i].q - qPrev) / qRef * Math.log10(arg);
        }
        X[j] = s;
    }
    return { x: X, qRef: qRef, shutIn: shutIn, n: n };
}

// ════════════════════════════════════════════════════════════════════
// ── TRANSIENT (PTA) PLOTS ───────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// 1. Cartesian P vs t (history) — periods shaded, rate on a right axis.
function PRiSM_plot_cartesian(canvas, data, opts) {
    opts = opts || {};
    const qArr = data && PRiSM_plot_arr(data.q);
    let qMax = -Infinity, qMin = Infinity;
    if (qArr && opts.showRate !== false) {
        for (let i = 0; i < qArr.length; i++) {
            const v = +qArr[i];
            if (isFinite(v)) { if (v > qMax) qMax = v; if (v < qMin) qMin = v; }
        }
    }
    const hasQ = isFinite(qMax) && (qMax !== 0 || qMin !== 0);
    const setup = PRiSM_plot_setup(canvas, opts, { secondaryAxis: hasQ });
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No pressure data');
    const tRange = PRiSM_plot_range(data.t, false);
    const pRange = PRiSM_plot_range(data.p, false);
    const overlayP = data.overlay && PRiSM_plot_arr(data.overlay.p) ? data.overlay.p : null;
    if (overlayP) {
        const oR = PRiSM_plot_range(overlayP, false);
        pRange.min = Math.min(pRange.min, oR.min);
        pRange.max = Math.max(pRange.max, oR.max);
    }
    const ru = PRiSM_plot_rateUnits(opts);
    const scaleX = { kind: 'lin', min: tRange.min, max: tRange.max, label: opts.xLabel || 'Time, t (hr)' };
    const scaleY = { kind: 'lin', min: pRange.min, max: pRange.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const scaleY2 = hasQ ? {
        min: Math.min(0, qMin), max: (qMax > 0 ? qMax : Math.abs(qMin) || 1) * 1.15,
        label: opts.y2Label || ('Rate, q (' + ru.rate + ')'), color: PRiSM_THEME.cyan
    } : null;
    const points = [];
    for (let i = 0; i < data.t.length; i++) points.push([data.t[i], data.p[i]]);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            canvas: canvas, title: opts.title || 'Cartesian P vs t', scaleY2: scaleY2
        });
        PRiSM_plot_periods(ctx, data.periods, opts.activePeriod, tr.toX, plot);
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        if (hasQ && tr.toY2) {
            // Step line of the rate history. Each rate sample covers the
            // interval that ENDS at it (a change is placed at the last sample
            // of the old rate — the same convention as the rate steps used by
            // the analysis), so the jump is drawn at the previous sample.
            ctx.save();
            ctx.strokeStyle = 'rgba(57,197,207,0.75)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            let started = false, lastX = NaN;
            for (let i = 0; i < data.t.length && i < qArr.length; i++) {
                const ti = data.t[i], qi = +qArr[i];
                if (!isFinite(ti) || !isFinite(qi)) continue;
                const x = tr.toX(ti), y = tr.toY2(qi);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else { ctx.lineTo(lastX, y); ctx.lineTo(x, y); }
                lastX = x;
            }
            ctx.stroke();
            ctx.restore();
        }
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        if (overlayP) {
            const opts_pts = PRiSM_plot_zip(data.overlay.t || data.t, overlayP);
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured p', color: PRiSM_THEME.accent }];
            if (overlayP) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (hasQ) legend.push({ label: 'Rate q', color: PRiSM_THEME.cyan });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'cartesian',
                                       data: data, xName: 't', yName: 'p' });
}

// 2. Horner — P vs (tp + Δt) / Δt on semi-log x. tp is REQUIRED.
//   The build-up sweeps from right (Δt small, ratio large) to left
//   (Δt large, ratio → 1). p* is read at ratio = 1.
function PRiSM_plot_horner(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No build-up data');
    const tp = PRiSM_plot_pos(data.tp, opts.tp);
    if (!(tp > 0)) return PRiSM_plot_noData(setup, 'Set tp on Tab 1 → Well & Test');
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        const dt = data.t[i];
        if (!isFinite(dt) || dt <= 0 || !isFinite(data.p[i])) continue;
        xs.push((tp + dt) / dt);
        ys.push(data.p[i]);
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No valid Horner points (Δt must be > 0)');
    const line = data.line && isFinite(data.line.m) && isFinite(data.line.b) ? data.line : null;
    const xRange = PRiSM_plot_range(xs, true);
    if (xRange.min > 1) xRange.min = 1;
    const yVals = ys.slice();
    if (line) yVals.push(line.b);
    const yRange = PRiSM_plot_range(yVals, false);
    const scaleX = { kind: 'log', min: xRange.min, max: xRange.max, label: opts.xLabel || 'Horner time (tp + Δt) / Δt' };
    const scaleY = { kind: 'lin', min: yRange.min, max: yRange.max, label: opts.yLabel || 'Pressure, pws (psia)' };
    const points = PRiSM_plot_zip(xs, ys);
    let win = null;
    if (line) {
        if (isFinite(line.x0) && isFinite(line.x1)) win = [Math.pow(10, line.x0), Math.pow(10, line.x1)];
        else if (line.t0 > 0 && line.t1 > 0) win = [(tp + line.t0) / line.t0, (tp + line.t1) / line.t1];
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Horner Plot' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 1.5 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2.5);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                const dt = ot[i];
                if (!isFinite(dt) || dt <= 0) continue;
                oxs.push((tp + dt) / dt);
                oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (line) {
            PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, function (R) { return Math.log10(R); }, win);
        }
        // p* guide at Horner ratio = 1.
        const px = tr.toX(1);
        if (px >= plot.x && px <= plot.x + plot.w) {
            ctx.save();
            ctx.strokeStyle = 'rgba(63,185,80,0.4)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
            if (!line) {        // with a line the p* value label below replaces it
                ctx.fillStyle = PRiSM_THEME.green;
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('p* at ratio = 1', px + 4, plot.y + 14);
            }
            ctx.restore();
        }
        if (line) PRiSM_plot_keyPoint(ctx, tr, plot, 1, line.b, 'p* ' + PRiSM_plot_fmtP(line.b) + ' psia', PRiSM_THEME.green);
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Build-up', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (line) legend.push({ label: 'Semilog line', color: PRiSM_THEME.blue });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'horner',
                                       data: data, xName: 'ratio', yName: 'pws', result: { tp: tp } });
}

// 3. MDH — P vs log10 Δt (semilog drawdown / Miller-Dyes-Hutchinson).
function PRiSM_plot_mdh(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No pressure data');
    const points = [];
    for (let i = 0; i < data.t.length; i++) {
        const t = data.t[i], p = data.p[i];
        if (isFinite(t) && t > 0 && isFinite(p)) points.push([t, p]);
    }
    if (!points.length) return PRiSM_plot_noData(setup, 'No valid points (Δt must be > 0)');
    const line = data.line && isFinite(data.line.m) && isFinite(data.line.b) ? data.line : null;
    const xRange = PRiSM_plot_range(points.map(function (p) { return p[0]; }), true);
    const yRange = PRiSM_plot_range(points.map(function (p) { return p[1]; }), false);
    const scaleX = { kind: 'log', min: xRange.min, max: xRange.max, label: opts.xLabel || 'Δt (hr)' };
    const scaleY = { kind: 'lin', min: yRange.min, max: yRange.max, label: opts.yLabel || 'Pressure, pwf (psia)' };
    let win = null;
    if (line) {
        if (line.t0 > 0 && line.t1 > 0) win = [line.t0, line.t1];
        else if (isFinite(line.x0) && isFinite(line.x1)) win = [Math.pow(10, line.x0), Math.pow(10, line.x1)];
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'MDH Semilog (p vs log Δt)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, 'rgba(240,136,62,0.45)', { width: 1 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2.5);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            const op = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) if (ot[i] > 0 && isFinite(data.overlay.p[i])) op.push([ot[i], data.overlay.p[i]]);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (line) {
            PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, function (t) { return Math.log10(t); }, win);
            PRiSM_plot_keyPoint(ctx, tr, plot, 1, line.b, 'p1hr ' + PRiSM_plot_fmtP(line.b) + ' psia', PRiSM_THEME.green);
        }
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent, marker: 'dot' }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (line) legend.push({ label: 'Semilog line', color: PRiSM_THEME.blue });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'mdh',
                                       data: data, xName: 'Δt', yName: 'p' });
}

// 4. Bourdet log-log diagnostic — KEYSTONE plot (C6).
//   Δp as a line, Δp′ as filled circles, both exactly as supplied.
//   Slope guides: unit (WBS), ½ (linear), ¼ (bilinear), 0 (radial).
function PRiSM_plot_bourdet(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot, S = setup.S;
    if (!PRiSM_plot_isData(data) || !(PRiSM_plot_arr(data.dp) || PRiSM_plot_arr(data.p))) {
        return PRiSM_plot_noData(setup, 'No pressure data');
    }
    const t = data.t;
    const L = PRiSM_plot_isNum(opts.smoothL) ? +opts.smoothL : (PRiSM_plot_isNum(data.L) ? +data.L : 0.1);
    let dp, dpSign = NaN, dpRef = NaN, derivGiven = false;
    if (PRiSM_plot_arr(data.dp)) {
        dp = data.dp;
    } else {
        const sd = PRiSM_plot_signedDp(data.p, PRiSM_plot_num(data.pRef), PRiSM_plot_num(data.sign));
        dp = sd.dp; dpSign = sd.sign; dpRef = sd.pRef;
        PRiSM_plot_warnOnce(S, 'dpFallback', '[PRiSM plots] Bourdet: data.dp missing — Δp derived from p with pRef = ' +
            PRiSM_plot_fmtP(dpRef) + ' psia, sign ' + (dpSign > 0 ? '+1 (build-up)' : '−1 (drawdown)') +
            '. Pass sign-aware Δp from PRiSM_getAnalysisData for correct skin.');
    }
    let deriv;
    if (PRiSM_plot_arr(data.deriv) && data.deriv.length === t.length) {
        deriv = data.deriv; derivGiven = true;
    } else {
        const xs = (PRiSM_plot_arr(data.x) && data.x.length === t.length) ? data.x : t;
        deriv = PRiSM_plot_bourdetImpl()(xs, dp, L);
    }
    const dpPts = [], drPts = [];
    for (let i = 0; i < t.length; i++) {
        const ti = +t[i];
        if (!(ti > 0) || !isFinite(ti)) continue;
        const a = +dp[i], d = +deriv[i];
        if (isFinite(a) && a > 0) dpPts.push([ti, a, 'Δp']);
        if (isFinite(d) && d > 0) drPts.push([ti, d, 'Δp′']);
    }
    if (!dpPts.length && !drPts.length) {
        return PRiSM_plot_noData(setup, 'No positive Δp — check test type / pi on Tab 1');
    }
    const allX = dpPts.map(function (p) { return p[0]; }).concat(drPts.map(function (p) { return p[0]; }));
    const allY = dpPts.map(function (p) { return p[1]; }).concat(drPts.map(function (p) { return p[1]; }));
    const xR = PRiSM_plot_range(allX, true);
    const yR = PRiSM_plot_range(allY, true, null, 6);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Δt (hr)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Δp, Δp′ (psi)' };

    // Overlay (model): overlay.dp / overlay.deriv as given (C6).
    let modelDp = null, modelDr = null;
    const ov = data.overlay;
    if (ov && (PRiSM_plot_arr(ov.dp) || PRiSM_plot_arr(ov.p))) {
        const ot = PRiSM_plot_arr(ov.t) ? ov.t : t;
        let odp;
        if (PRiSM_plot_arr(ov.dp)) odp = ov.dp;
        else odp = PRiSM_plot_signedDp(ov.p, isFinite(dpRef) ? dpRef : PRiSM_plot_num(ov.pRef, data.pRef),
                                        isFinite(dpSign) ? dpSign : PRiSM_plot_num(ov.sign, data.sign)).dp;
        let odr;
        if (PRiSM_plot_arr(ov.deriv) && ov.deriv.length === ot.length) odr = ov.deriv;
        else {
            const oxs = (PRiSM_plot_arr(ov.x) && ov.x.length === ot.length) ? ov.x : ot;
            odr = PRiSM_plot_bourdetImpl()(oxs, odp, L);
        }
        modelDp = []; modelDr = [];
        for (let i = 0; i < ot.length; i++) {
            const ti = +ot[i];
            if (!(ti > 0)) continue;
            if (+odp[i] > 0) modelDp.push([ti, +odp[i]]);
            if (+odr[i] > 0) modelDr.push([ti, +odr[i]]);
        }
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            canvas: canvas,
            title: opts.title || 'Log-Log Bourdet Derivative'
        });
        // ── Slope guides anchored to the data ────────────────────────
        //   • WBS (1) through the EARLIEST derivative point;
        //   • radial (0) at the late-time derivative level;
        //   • ½ and ¼ at the geometric centre of the view.
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        let earlyAnchor = null, lateAnchor = null;
        if (drPts.length >= 2) {
            earlyAnchor = { x: drPts[0][0], y: drPts[0][1] };
            const nLate = Math.max(2, Math.floor(drPts.length * 0.25));
            let sumLog = 0;
            for (let li = drPts.length - nLate; li < drPts.length; li++) sumLog += Math.log(drPts[li][1]);
            lateAnchor = {
                x: drPts[Math.max(0, drPts.length - Math.floor(nLate / 2)) - 1][0],
                y: Math.exp(sumLog / nLate)
            };
        }
        const midX = Math.sqrt(scaleX.min * scaleX.max);
        const midY = Math.sqrt(scaleY.min * scaleY.max);
        const slopes = [
            { m: 1.0,  label: 'WBS (slope 1)',     color: 'rgba(248,81,73,0.55)',
              anchor: earlyAnchor || { x: scaleX.min, y: midY } },
            { m: 0.5,  label: 'Linear (slope ½)',  color: 'rgba(210,153,34,0.40)',
              anchor: { x: midX, y: midY } },
            { m: 0.25, label: 'Bilinear (¼)',      color: 'rgba(188,140,255,0.35)',
              anchor: { x: midX, y: midY * 0.6 } },
            { m: 0.0,  label: 'Radial (slope 0)',  color: 'rgba(63,185,80,0.55)',
              anchor: lateAnchor || { x: scaleX.max, y: midY } }
        ];
        slopes.forEach(function (s) {
            const xL = scaleX.min, xRr = scaleX.max;
            const yL = s.anchor.y * Math.pow(xL / s.anchor.x, s.m);
            const yRr = s.anchor.y * Math.pow(xRr / s.anchor.x, s.m);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = (s.m === 1.0 || s.m === 0.0) ? 1.5 : 1.0;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(tr.toX(xL), tr.toY(yL));
            ctx.lineTo(tr.toX(xRr), tr.toY(yRr));
            ctx.stroke();
            ctx.setLineDash([]);
            if (s.anchor && (earlyAnchor || lateAnchor) && (s.m === 1.0 || s.m === 0.0)) {
                ctx.fillStyle = s.color.replace(/0\.\d+\)/, '0.95)');
                ctx.beginPath();
                ctx.arc(tr.toX(s.anchor.x), tr.toY(s.anchor.y), 3, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.fillStyle = s.color.replace(/0\.\d+\)/, '0.95)');
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            const ly = Math.max(plot.y + 2, Math.min(plot.y + plot.h - 2, tr.toY(yRr)));
            ctx.fillText(s.label, plot.x + plot.w - 4, ly - 2);
        });
        // Series
        PRiSM_plot_line(ctx, dpPts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, drPts, tr.toX, tr.toY, PRiSM_THEME.green, 3);
        if (modelDp) {
            PRiSM_plot_line(ctx, modelDp, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
            PRiSM_plot_line(ctx, modelDr, tr.toX, tr.toY, PRiSM_THEME.cyan, { width: 1.5, dash: [4, 3] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [
                { label: 'Δp', color: PRiSM_THEME.accent },
                { label: derivGiven ? 'Δp′' : 'Δp′ (Bourdet)', color: PRiSM_THEME.green, marker: 'dot' }
            ];
            if (modelDp) legend.push({ label: 'Model Δp', color: PRiSM_THEME.blue, dash: true });
            if (modelDr) legend.push({ label: 'Model Δp′', color: PRiSM_THEME.cyan, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, {
        scaleX: scaleX, scaleY: scaleY, points: dpPts.concat(drPts), sigPoints: dpPts.length ? dpPts : drPts,
        plotKey: 'bourdet', data: data, xName: 'Δt', yName: 'Δp',
        result: { derivGiven: derivGiven, L: derivGiven ? null : L, dpSource: isFinite(dpSign) ? 'p-fallback' : 'dp' }
    });
}

// Shared body for the three "p vs f(t)" linear diagnostic plots.
function PRiSM_plot_transformedTime(canvas, data, opts, cfg) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No data');
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        const t = data.t[i];
        if (!isFinite(t) || !cfg.ok(t) || !isFinite(data.p[i])) continue;
        xs.push(cfg.f(t));
        ys.push(data.p[i]);
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No data');
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || cfg.xLabel };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || cfg.title });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || !cfg.ok(ot[i])) continue;
                oxs.push(cfg.f(ot[i]));
                oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: cfg.plotKey,
                                       data: data, xName: cfg.xName, yName: 'p' });
}

// 5. Square-root time — P vs √t (linear) — diagnostic for linear flow
function PRiSM_plot_sqrt_time(canvas, data, opts) {
    PRiSM_plot_transformedTime(canvas, data, opts, {
        plotKey: 'sqrt', title: 'Square-Root Time', xLabel: '√Δt  (hr^½)', xName: '√t',
        ok: function (t) { return t >= 0; }, f: function (t) { return Math.sqrt(t); }
    });
}

// 6. Quarter-root time — P vs t^¼ — diagnostic for bilinear flow
function PRiSM_plot_quarter_root_time(canvas, data, opts) {
    PRiSM_plot_transformedTime(canvas, data, opts, {
        plotKey: 'quarter', title: 'Quarter-Root Time (Bilinear)', xLabel: 'Δt^¼  (hr^¼)', xName: 't^¼',
        ok: function (t) { return t >= 0; }, f: function (t) { return Math.pow(t, 0.25); }
    });
}

// 7. Spherical flow — P vs t^(-½) — partial penetration diagnostic
function PRiSM_plot_spherical(canvas, data, opts) {
    PRiSM_plot_transformedTime(canvas, data, opts, {
        plotKey: 'spherical', title: 'Spherical Flow (Partial Penetration)', xLabel: 'Δt^(-½)  (hr^-½)', xName: 't^-½',
        ok: function (t) { return t > 0; }, f: function (t) { return Math.pow(t, -0.5); }
    });
}

// 8. Material-balance time — P vs te = Σq·Δt / q_n (log x).
//   te is the equivalent constant-rate time of each flowing sample; it is
//   undefined while q = 0 (shut-in), so those points are left out.
function PRiSM_plot_sandface_convolution(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p) || !PRiSM_plot_arr(data.q)) {
        return PRiSM_plot_noData(setup, 'Needs t, p and q for material-balance time');
    }
    const t = data.t, p = data.p, q = data.q;
    let qScale = 0;
    for (let i = 0; i < q.length; i++) if (isFinite(+q[i])) qScale = Math.max(qScale, Math.abs(+q[i]));
    const teq = new Array(t.length);
    let cum = 0, skipped = 0;
    for (let i = 0; i < t.length; i++) {
        const dt = (i === 0) ? t[i] : (t[i] - t[i - 1]);
        const qi = +q[i] || 0;
        if (isFinite(dt) && dt > 0) cum += qi * dt;
        if (Math.abs(qi) <= 1e-9 * Math.max(1, qScale)) { teq[i] = NaN; skipped++; continue; }
        teq[i] = cum / qi;
    }
    const xs = [], ys = [];
    for (let i = 0; i < t.length; i++) {
        if (!isFinite(teq[i]) || teq[i] <= 0 || !isFinite(p[i])) continue;
        xs.push(teq[i]); ys.push(p[i]);
    }
    if (!xs.length) {
        return PRiSM_plot_noData(setup, skipped
            ? 'Material-balance time is undefined while q = 0 (shut-in) — use the Horner or superposition plot'
            : 'No valid material-balance time');
    }
    const xR = PRiSM_plot_range(xs, true);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Material-balance time Σq·Δt/q_n (hr)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Material-Balance Time' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p)) {
            // Overlay values are mapped by sample index onto the same te.
            const op = [];
            for (let i = 0; i < t.length && i < data.overlay.p.length; i++) {
                if (isFinite(teq[i]) && teq[i] > 0) op.push([teq[i], data.overlay.p[i]]);
            }
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        if (skipped) {
            ctx.fillStyle = PRiSM_THEME.text3;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(skipped + ' shut-in point' + (skipped > 1 ? 's' : '') + ' (q = 0) not shown',
                plot.x + 6, plot.y + plot.h - 4);
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'sandface',
                                       data: data, xName: 'te', yName: 'p', result: { skipped: skipped } });
}

// 9. Build-up / multi-rate superposition — P vs the superposition time
//   function X (see header). Normalised by the analysed rate, or by the
//   last NON-ZERO flowing rate for a shut-in. p* at X = 0.
function PRiSM_plot_buildup_superposition(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.p)) return PRiSM_plot_noData(setup, 'No data');
    const p = data.p;
    let X = null, shutIn = null, qRef = NaN, mode = '';
    const tStartGiven = PRiSM_plot_num(data.tStart);
    const tAbs = PRiSM_plot_arr(data.tAbs) ? data.tAbs : (isFinite(tStartGiven) ? null : data.t);
    const steps = PRiSM_plot_rateSteps(data, tAbs);
    if (steps) {
        let dts, tStart;
        if (isFinite(tStartGiven)) { tStart = tStartGiven; dts = data.t; }
        else {
            tStart = steps[steps.length - 1].t;
            dts = tAbs.map(function (v) { return v - tStart; });
        }
        const sx = PRiSM_plot_superposition_x(dts, steps, tStart);
        if (sx) { X = sx.x; shutIn = sx.shutIn; qRef = sx.qRef; mode = 'rates'; }
    }
    if (!X && PRiSM_plot_arr(data.x) && data.x.length === data.t.length) {
        const tt = String(data.testType || '').toLowerCase();
        shutIn = /build|fall/.test(tt) || (PRiSM_plot_num(data.sign) === 1 && !/inj/.test(tt));
        X = Array.prototype.map.call(data.x, function (v) { return v > 0 ? (shutIn ? -1 : 1) * Math.log10(v) : NaN; });
        mode = 'x';
    }
    if (!X) {
        const tp = PRiSM_plot_pos(data.tp, opts.tp);
        if (tp > 0) {
            X = Array.prototype.map.call(data.t, function (dt) { return dt > 0 ? Math.log10((tp + dt) / dt) : NaN; });
            shutIn = true; mode = 'tp';
        }
    }
    if (!X) return PRiSM_plot_noData(setup, 'Set tp on Tab 1 → Well & Test (or load a rate history)');
    const xs = [], ys = [];
    for (let i = 0; i < X.length && i < p.length; i++) {
        if (isFinite(X[i]) && isFinite(p[i])) { xs.push(X[i]); ys.push(p[i]); }
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No valid superposition points');
    const line = data.line && isFinite(data.line.m) && isFinite(data.line.b) ? data.line : null;
    const xR = PRiSM_plot_range(shutIn ? xs.concat([0]) : xs, false);
    const yVals = ys.slice();
    if (line && shutIn) yVals.push(line.b);
    const yR = PRiSM_plot_range(yVals, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max,
                     label: opts.xLabel || (shutIn ? 'Superposition time Σ(Δqᵢ/q)·log((T−Tᵢ+Δt)/Δt)' : 'Superposition time Σ(Δqᵢ/q)·log(T−Tᵢ+Δt)') };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, p (psia)' };
    const points = PRiSM_plot_zip(xs, ys);
    const win = line && isFinite(line.x0) && isFinite(line.x1) ? [line.x0, line.x1] : null;

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Superposition Plot' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 1.5 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.p) && data.overlay.p.length === X.length) {
            const op = [];
            for (let i = 0; i < X.length; i++) if (isFinite(X[i])) op.push([X[i], data.overlay.p[i]]);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        if (shutIn) {
            const px = tr.toX(0);
            if (px >= plot.x && px <= plot.x + plot.w) {
                ctx.strokeStyle = 'rgba(63,185,80,0.4)';
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        }
        ctx.restore();
        if (line) {
            PRiSM_plot_straightLine(ctx, tr, plot, scaleX, line, function (x) { return x; }, win);
            if (shutIn) PRiSM_plot_keyPoint(ctx, tr, plot, 0, line.b, 'p* ' + PRiSM_plot_fmtP(line.b) + ' psia', PRiSM_THEME.green);
        }
        if (opts.showLegend !== false) {
            const legend = [{ label: shutIn ? 'Build-up' : 'Flowing', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            if (line) legend.push({ label: 'Semilog line', color: PRiSM_THEME.blue });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'superposition',
                                       data: data, xName: 'X', yName: 'p',
                                       result: { mode: mode, shutIn: !!shutIn, qRef: qRef } });
}

// ════════════════════════════════════════════════════════════════════
// ── DECLINE (DCA) PLOTS ─────────────────────────────────────────────
// t in DAYS by default (opts.timeUnit), q in opts.rateUnit (STB/d).
// ════════════════════════════════════════════════════════════════════

function PRiSM_plot_rateTime(canvas, data, opts, cfg) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    const tu = PRiSM_plot_timeUnit(opts), ru = PRiSM_plot_rateUnits(opts);
    const pts = [];
    for (let i = 0; i < data.t.length; i++) {
        const t = +data.t[i], q = +data.q[i];
        if (!isFinite(t) || !isFinite(q)) continue;
        if (cfg.xLog && !(t > 0)) continue;
        if (cfg.yLog && !(q > 0)) continue;
        pts.push([t, q]);
    }
    if (!pts.length) return PRiSM_plot_noData(setup, 'No positive data');
    const xR = PRiSM_plot_range(pts.map(function (p) { return p[0]; }), cfg.xLog);
    const yR = PRiSM_plot_range(pts.map(function (p) { return p[1]; }), cfg.yLog);
    const scaleX = { kind: cfg.xLog ? 'log' : 'lin', min: xR.min, max: xR.max, label: opts.xLabel || ('Time, t (' + tu.label + ')') };
    const scaleY = { kind: cfg.yLog ? 'log' : 'lin', min: cfg.yLog ? yR.min : Math.max(0, yR.min), max: yR.max,
                     label: opts.yLabel || ('Rate, q (' + ru.rate + ')') };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || cfg.title });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.q)) {
            const ot = data.overlay.t || data.t;
            const op = [];
            for (let i = 0; i < ot.length; i++) {
                const t = +ot[i], q = +data.overlay.q[i];
                if (cfg.xLog && !(t > 0)) continue;
                if (cfg.yLog && !(q > 0)) continue;
                op.push([t, q]);
            }
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: pts, plotKey: cfg.plotKey,
                                       data: data, xName: 't', yName: 'q' });
}

// 10. Rate vs time, linear (cartesian)
function PRiSM_plot_rate_time_cartesian(canvas, data, opts) {
    PRiSM_plot_rateTime(canvas, data, opts, { plotKey: 'rateCart', title: 'Rate vs Time (Cartesian)', xLog: false, yLog: false });
}

// 11. Semi-log: rate-time with log y-axis (exponential decline → straight)
function PRiSM_plot_rate_time_semilog(canvas, data, opts) {
    PRiSM_plot_rateTime(canvas, data, opts, { plotKey: 'rateSemi', title: 'Rate vs Time (Semi-log)', xLog: false, yLog: true });
}

// 12. Log-log rate-time (hyperbolic / harmonic curvature visible)
function PRiSM_plot_rate_time_loglog(canvas, data, opts) {
    PRiSM_plot_rateTime(canvas, data, opts, { plotKey: 'rateLog', title: 'Rate vs Time (Log-Log)', xLog: true, yLog: true });
}

// Least-squares window for the rate-cumulative EUR tangent.
//   eurWindow: fraction (0,1] of the last points (default 0.3), an
//   integer count ≥ 2, or {t0, t1} in the plot's time unit.
function PRiSM_plot_eurWindow(t, n, w) {
    if (w && typeof w === 'object' && (PRiSM_plot_isNum(w.t0) || PRiSM_plot_isNum(w.t1))) {
        const a = PRiSM_plot_num(w.t0, -Infinity), b = PRiSM_plot_num(w.t1, Infinity);
        const idx = [];
        for (let i = 0; i < n; i++) if (t[i] >= a && t[i] <= b) idx.push(i);
        return idx;
    }
    let k;
    if (PRiSM_plot_isNum(w) && +w > 1) k = Math.round(+w);
    else k = Math.round(n * ((PRiSM_plot_isNum(w) && +w > 0) ? +w : 0.3));
    k = Math.max(2, Math.min(n, k));
    const idx = [];
    for (let i = n - k; i < n; i++) idx.push(i);
    return idx;
}

// 13. Rate vs cumulative — q vs Np (trapezoid, Δt converted to days)
function PRiSM_plot_rate_cumulative(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    const tu = PRiSM_plot_timeUnit(opts), ru = PRiSM_plot_rateUnits(opts);
    const Np = (PRiSM_plot_arr(opts.cum) && opts.cum.length === data.t.length)
        ? Array.prototype.slice.call(opts.cum)
        : PRiSM_plot_cumulative(data.t, data.q, opts.timeUnit);
    const pts = [];
    for (let i = 0; i < Np.length; i++) if (isFinite(Np[i]) && isFinite(+data.q[i])) pts.push([Np[i], +data.q[i]]);
    if (!pts.length) return PRiSM_plot_noData(setup, 'No valid cumulative data');
    // EUR tangent (only on request): LS line q = a + s·Np over the window.
    let eur = null;
    if (opts.showTangentEUR && pts.length >= 2) {
        const tIdx = [];
        for (let i = 0; i < data.t.length; i++) if (isFinite(Np[i]) && isFinite(+data.q[i])) tIdx.push(+data.t[i]);
        const idx = PRiSM_plot_eurWindow(tIdx, pts.length, opts.eurWindow);
        if (idx.length >= 2) {
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            idx.forEach(function (i) { const x = pts[i][0], y = pts[i][1]; sx += x; sy += y; sxy += x * y; sxx += x * x; });
            const n = idx.length, den = n * sxx - sx * sx;
            if (den !== 0) {
                const s = (n * sxy - sx * sy) / den, a = (sy - s * sx) / n;
                if (s < 0 && isFinite(s) && isFinite(a) && a > 0) eur = { value: -a / s, slope: s, intercept: a, from: pts[idx[0]][0] };
            }
        }
    }
    const xVals = pts.map(function (p) { return p[0]; });
    if (eur) xVals.push(eur.value);
    const xR = PRiSM_plot_range(xVals, false);
    const yR = PRiSM_plot_range(pts.map(function (p) { return p[1]; }), false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max,
                     label: opts.xLabel || ('Cumulative, ' + ru.cumName + ' (' + ru.volume + ')') };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || ('Rate, q (' + ru.rate + ')') };
    if (eur) scaleY.min = 0;

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Rate vs Cumulative' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && PRiSM_plot_arr(data.overlay.q)) {
            const ot = data.overlay.t || data.t;
            const oNp = PRiSM_plot_cumulative(ot, data.overlay.q, opts.timeUnit);
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oNp, data.overlay.q), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        if (eur) {
            ctx.strokeStyle = 'rgba(63,185,80,0.7)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([5, 4]);
            ctx.beginPath();
            ctx.moveTo(tr.toX(eur.from), tr.toY(eur.intercept + eur.slope * eur.from));
            ctx.lineTo(tr.toX(eur.value), tr.toY(0));
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = PRiSM_THEME.green;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText('EUR ≈ ' + PRiSM_plot_format_eng(eur.value, 3) + ' ' + ru.volume,
                Math.min(plot.x + plot.w - 4, tr.toX(eur.value)), tr.toY(0) - 6);
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            if (eur) legend.push({ label: 'EUR tangent', color: PRiSM_THEME.green, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, {
        scaleX: scaleX, scaleY: scaleY, points: pts, plotKey: 'rateCum', data: data, xName: ru.cumName, yName: 'q',
        result: { npLast: pts[pts.length - 1][0], eur: eur ? eur.value : null, timeUnit: tu.label }
    });
}

// 14. Loss-ratio: 1/D vs t  where D = -d(ln q)/dt
//   Exponential → constant 1/D; hyperbolic → 1/D = a + b·t (slope b);
//   harmonic → straight line through origin.
function PRiSM_plot_loss_ratio(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    const tu = PRiSM_plot_timeUnit(opts);
    const t = data.t, q = data.q;
    const xs = [], ys = [];
    for (let i = 1; i < t.length - 1; i++) {
        if (q[i] <= 0 || q[i - 1] <= 0 || q[i + 1] <= 0) continue;
        const dlnq = Math.log(q[i + 1]) - Math.log(q[i - 1]);
        const dt = t[i + 1] - t[i - 1];
        if (dt === 0) continue;
        const D = -dlnq / dt;
        if (!isFinite(D) || D <= 0) continue;
        xs.push(t[i]);
        ys.push(1 / D);
    }
    if (!xs.length) return PRiSM_plot_noData(setup, 'No valid 1/D points (rate must decline)');
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || ('Time, t (' + tu.label + ')') };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || ('Loss ratio 1/D = -dt/d(ln q) (' + tu.label + ')') };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Loss-Ratio (1/D vs t)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.green, 3);
        if (points.length >= 3) {
            let sx = 0, sy = 0, sxy = 0, sxx = 0;
            const n = points.length;
            for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
            const denom = n * sxx - sx * sx;
            if (denom !== 0) {
                const m = (n * sxy - sx * sy) / denom;
                const c = (sy - m * sx) / n;
                ctx.strokeStyle = 'rgba(88,166,255,0.7)';
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(tr.toX(scaleX.min), tr.toY(c + m * scaleX.min));
                ctx.lineTo(tr.toX(scaleX.max), tr.toY(c + m * scaleX.max));
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = PRiSM_THEME.blue;
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
                ctx.fillText('b ≈ ' + m.toFixed(3) + ',  1/Di ≈ ' + PRiSM_plot_format_eng(c) + ' ' + tu.label,
                    plot.x + 8, plot.y + plot.h - 8);
            }
        }
        if (data.overlay && PRiSM_plot_arr(data.overlay.q)) {
            const ot = data.overlay.t || data.t;
            const oq = data.overlay.q;
            const oxs = [], oys = [];
            for (let i = 1; i < ot.length - 1; i++) {
                if (oq[i] <= 0 || oq[i - 1] <= 0 || oq[i + 1] <= 0) continue;
                const dlnq = Math.log(oq[i + 1]) - Math.log(oq[i - 1]);
                const dt = ot[i + 1] - ot[i - 1];
                if (dt === 0) continue;
                const D = -dlnq / dt;
                if (!isFinite(D) || D <= 0) continue;
                oxs.push(ot[i]); oys.push(1 / D);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: '1/D measured', color: PRiSM_THEME.green, marker: 'dot' }];
            if (data.overlay) legend.push({ label: 'Model 1/D', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: points, plotKey: 'lossRatio',
                                       data: data, xName: 't', yName: '1/D' });
}

// 15. Type-curve overlay — dimensionless qD = q/qi vs tD = Di·t on log-log
//   with a family of Arps b curves. opts.qi / opts.Di (1/time unit) /
//   opts.b (active curve, drawn bold) / opts.bList.
function PRiSM_plot_typecurve_overlay(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const ctx = setup.ctx, plot = setup.plot;
    if (!PRiSM_plot_isData(data) || !PRiSM_plot_arr(data.q)) return PRiSM_plot_noData(setup, 'No rate data');
    let qFirst = 1;
    for (let i = 0; i < data.q.length; i++) if (+data.q[i] > 0) { qFirst = +data.q[i]; break; }
    const qi = PRiSM_plot_pos(opts.qi) || qFirst;
    const Di = PRiSM_plot_pos(opts.Di) || 1;
    const dataPts = [];
    for (let i = 0; i < data.t.length; i++) {
        const td = data.t[i] * Di;
        const qd = data.q[i] / qi;
        if (td > 0 && qd > 0) dataPts.push([td, qd]);
    }
    if (!dataPts.length) return PRiSM_plot_noData(setup, 'No positive data');
    const bList = (opts.bList && opts.bList.length) ? opts.bList : [0, 0.25, 0.5, 0.75, 1];
    const bActive = PRiSM_plot_isNum(opts.b) ? +opts.b : 0.5;
    const xData = PRiSM_plot_range(dataPts.map(function (p) { return p[0]; }), true);
    const xCurve = { min: Math.min(xData.min, 0.01), max: Math.max(xData.max, 100) };
    const curves = bList.map(function (b) {
        const pts = [];
        const n = 80;
        const lo = Math.log10(xCurve.min), hi = Math.log10(xCurve.max);
        for (let i = 0; i <= n; i++) {
            const td = Math.pow(10, lo + (hi - lo) * i / n);
            const qd = (b === 0) ? Math.exp(-td) : Math.pow(1 + b * td, -1 / b);
            if (qd > 0 && isFinite(qd)) pts.push([td, qd]);
        }
        return { b: b, pts: pts };
    });
    const allY = dataPts.map(function (p) { return p[1]; });
    curves.forEach(function (c) { c.pts.forEach(function (p) { allY.push(p[1]); }); });
    const yR = PRiSM_plot_range(allY, true);
    yR.min = Math.max(yR.min, 1e-3);
    const scaleX = { kind: 'log', min: xCurve.min, max: xCurve.max, label: opts.xLabel || 'tD = Di · t' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'qD = q / qi' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { canvas: canvas, title: opts.title || 'Type-Curve Overlay (Arps qD-tD)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        curves.forEach(function (c) {
            const isActive = Math.abs(c.b - bActive) < 1e-6;
            const color = isActive ? PRiSM_THEME.purple : 'rgba(139,148,158,0.45)';
            PRiSM_plot_line(ctx, c.pts, tr.toX, tr.toY, color, { width: isActive ? 2.5 : 1 });
            const last = c.pts[c.pts.length - 1];
            if (last) {
                const lx = tr.toX(last[0]), ly = tr.toY(last[1]);
                if (lx > plot.x && lx < plot.x + plot.w && ly > plot.y && ly < plot.y + plot.h) {
                    ctx.fillStyle = isActive ? PRiSM_THEME.purple : PRiSM_THEME.text3;
                    ctx.font = isActive ? 'bold 10px sans-serif' : '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('b=' + c.b, lx + 4, ly);
                }
            }
        });
        PRiSM_plot_dots(ctx, dataPts, tr.toX, tr.toY, PRiSM_THEME.accent, 3.5);
        ctx.restore();
        if (opts.showLegend !== false) {
            PRiSM_plot_legend(ctx, [
                { label: 'Data', color: PRiSM_THEME.accent, marker: 'dot' },
                { label: 'Active b=' + bActive, color: PRiSM_THEME.purple },
                { label: 'Other b values', color: PRiSM_THEME.text3 }
            ], plot);
        }
    }

    PRiSM_plot_finish(setup, render, { scaleX: scaleX, scaleY: scaleY, points: dataPts, plotKey: 'typeCurve',
                                       data: data, xName: 'tD', yName: 'qD', result: { qi: qi, Di: Di, b: bActive } });
}

// ════════════════════════════════════════════════════════════════════
// ── WINDOW EXPORTS ──────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════
(function PRiSM_plot_exports() {
    const G = PRiSM_PLOT_G;
    const api = {
        PRiSM_THEME: PRiSM_THEME,
        PRiSM_compute_bourdet: PRiSM_compute_bourdet,
        PRiSM_plot_cartesian: PRiSM_plot_cartesian,
        PRiSM_plot_horner: PRiSM_plot_horner,
        PRiSM_plot_mdh: PRiSM_plot_mdh,
        PRiSM_plot_bourdet: PRiSM_plot_bourdet,
        PRiSM_plot_sqrt_time: PRiSM_plot_sqrt_time,
        PRiSM_plot_quarter_root_time: PRiSM_plot_quarter_root_time,
        PRiSM_plot_spherical: PRiSM_plot_spherical,
        PRiSM_plot_sandface_convolution: PRiSM_plot_sandface_convolution,
        PRiSM_plot_buildup_superposition: PRiSM_plot_buildup_superposition,
        PRiSM_plot_rate_time_cartesian: PRiSM_plot_rate_time_cartesian,
        PRiSM_plot_rate_time_semilog: PRiSM_plot_rate_time_semilog,
        PRiSM_plot_rate_time_loglog: PRiSM_plot_rate_time_loglog,
        PRiSM_plot_rate_cumulative: PRiSM_plot_rate_cumulative,
        PRiSM_plot_loss_ratio: PRiSM_plot_loss_ratio,
        PRiSM_plot_typecurve_overlay: PRiSM_plot_typecurve_overlay,
        // helpers other layers reuse
        PRiSM_plot_format_eng: PRiSM_plot_format_eng,
        PRiSM_plot_format_tick: PRiSM_plot_format_tick,
        PRiSM_plot_setup: PRiSM_plot_setup,
        PRiSM_plot_axes: PRiSM_plot_axes,
        PRiSM_plot_range: PRiSM_plot_range,
        PRiSM_plot_log_ticks: PRiSM_plot_log_ticks,
        PRiSM_plot_lin_ticks: PRiSM_plot_lin_ticks,
        PRiSM_plot_line: PRiSM_plot_line,
        PRiSM_plot_dots: PRiSM_plot_dots,
        PRiSM_plot_legend: PRiSM_plot_legend,
        PRiSM_plot_periods: PRiSM_plot_periods,
        PRiSM_plot_message: PRiSM_plot_message,
        PRiSM_plot_cumulative: PRiSM_plot_cumulative,
        PRiSM_plot_superposition_x: PRiSM_plot_superposition_x,
        PRiSM_plotResetView: PRiSM_plotResetView,
        PRiSM_plotSetView: PRiSM_plotSetView,
        PRiSM_plotGetView: PRiSM_plotGetView
    };
    Object.keys(api).forEach(function (k) {
        try { G[k] = api[k]; } catch (_) { /* read-only global */ }
    });
})();

// ════════════════════════════════════════════════════════════════════

// ─── END 02-plots ───────────────────────────────────────────────────

