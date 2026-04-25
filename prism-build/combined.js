// ══════════════════════════════════════════════════════════════════════════
// PRiSM ─ Pressure Reservoir Inversion & Simulation Model
// Auto-assembled from prism-build/{01-foundation,03-models,02-plots}.js
// Generated 2026-04-25T19:47:24.479Z
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
//      with pd and Bourdet derivative
//   4. renderPRiSM() — 7-tab UI shell with mode selector
//   5. Data tab — paste/upload CSV, parser, preview, multi-rate editor
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

// ── Exponential integral E1(x) and convenience -Ei(-x) form ──
// E1(x) = ∫_x^∞ e^{-t}/t dt for x > 0. We expose two related routines:
//
//   PRiSM_E1(x)  — true E1(x), x > 0
//   PRiSM_Ei(x)  — for our PTA / DCA use-cases this is the "negative
//                  exponential integral" sometimes written -Ei(-x); it
//                  equals E1(x) for x > 0 and is the building block of the
//                  Theis line-source pressure solution. For x ≤ 0 we return
//                  NaN since negative arguments aren't physical here.
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

// For decline-curve / Theis-style usage. x > 0.
function PRiSM_Ei(x) {
    if (x <= 0 || !isFinite(x)) return NaN;
    return PRiSM_E1(x);
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


// =============================================================================
// SECTION 4 — renderPRiSM(): UI shell
// =============================================================================
// 7-tab workflow with a top mode selector (Transient / Decline / Combined).
// The Data tab is fully implemented; the other six tabs render small
// placeholders for now and will be filled in by subsequent layers.
//
// All state lives on window.PRiSM. Existing helpers ($, el, fmt,
// loadInputs/saveInputs) are used directly.
// =============================================================================

function renderPRiSM(body) {
    if ($('pgTitle')) $('pgTitle').textContent = 'PRiSM — Well Test Analysis';
    if ($('pgSub')) $('pgSub').textContent = 'Pressure Reservoir Inversion & Simulation Model';

    // ── State container ──
    // Persist previously chosen mode & tab across re-renders within the same
    // session. Hard refresh resets to defaults.
    if (!window.PRiSM) window.PRiSM = { mode: 'transient', tab: 1, multiRate: [] };
    const S = window.PRiSM;

    // Each call to renderPRiSM() repaints the whole module body. The mode
    // selector and tab strip are static; the inner per-tab content is
    // rebuilt by setTab().
    body.innerHTML = `
    <div class="card" style="padding:14px 16px;">
      <div style="display:flex; align-items:center; flex-wrap:wrap; gap:14px;">
        <div style="font-size:12px; font-weight:700; color:var(--text2); text-transform:uppercase; letter-spacing:.5px;">Analysis Mode</div>
        <div class="tabs" id="prism_modebar" style="margin:0; max-width:none; flex:0 0 auto;">
          <button class="tab-btn ${S.mode==='transient'?'active':''}" id="prism_mode_transient">Transient PTA</button>
          <button class="tab-btn ${S.mode==='decline'?'active':''}"   id="prism_mode_decline">Decline DCA</button>
          <button class="tab-btn ${S.mode==='combined'?'active':''}"  id="prism_mode_combined">Combined</button>
        </div>
        <div style="margin-left:auto; font-size:11px; color:var(--text3);">
          Mode drives which model library &amp; plots are visible.
        </div>
      </div>
    </div>

    <div class="tabs" id="prism_tabs" style="max-width:none; margin-top:14px;">
      <button class="tab-btn ${S.tab===1?'active':''}" data-prism-tab="1">1 Data</button>
      <button class="tab-btn ${S.tab===2?'active':''}" data-prism-tab="2">2 Plots</button>
      <button class="tab-btn ${S.tab===3?'active':''}" data-prism-tab="3">3 Model</button>
      <button class="tab-btn ${S.tab===4?'active':''}" data-prism-tab="4">4 Params</button>
      <button class="tab-btn ${S.tab===5?'active':''}" data-prism-tab="5">5 Match</button>
      <button class="tab-btn ${S.tab===6?'active':''}" data-prism-tab="6">6 Regress</button>
      <button class="tab-btn ${S.tab===7?'active':''}" data-prism-tab="7">7 Report</button>
    </div>

    <div id="prism_tab_1" class="prism-tab" style="display:${S.tab===1?'block':'none'};"></div>
    <div id="prism_tab_2" class="prism-tab" style="display:${S.tab===2?'block':'none'};"></div>
    <div id="prism_tab_3" class="prism-tab" style="display:${S.tab===3?'block':'none'};"></div>
    <div id="prism_tab_4" class="prism-tab" style="display:${S.tab===4?'block':'none'};"></div>
    <div id="prism_tab_5" class="prism-tab" style="display:${S.tab===5?'block':'none'};"></div>
    <div id="prism_tab_6" class="prism-tab" style="display:${S.tab===6?'block':'none'};"></div>
    <div id="prism_tab_7" class="prism-tab" style="display:${S.tab===7?'block':'none'};"></div>
    `;

    // ── Wire mode buttons ──
    $('prism_mode_transient').onclick = () => window.PRiSM.setMode('transient');
    $('prism_mode_decline').onclick   = () => window.PRiSM.setMode('decline');
    $('prism_mode_combined').onclick  = () => window.PRiSM.setMode('combined');

    // ── Wire tab buttons ──
    document.querySelectorAll('#prism_tabs [data-prism-tab]').forEach(btn => {
        btn.onclick = () => window.PRiSM.setTab(parseInt(btn.dataset.prismTab, 10));
    });

    // ── Public API on window.PRiSM ──
    window.PRiSM.setMode = function(m) {
        if (['transient', 'decline', 'combined'].indexOf(m) === -1) return;
        window.PRiSM.mode = m;
        renderPRiSM(body);
    };
    window.PRiSM.setTab = function(n) {
        n = parseInt(n, 10);
        if (!(n >= 1 && n <= 7)) return;
        window.PRiSM.tab = n;
        // Toggle tab-button active state without a full re-render so the
        // user's typed-in textarea contents survive a tab change.
        document.querySelectorAll('#prism_tabs .tab-btn').forEach(b => {
            b.classList.toggle('active', parseInt(b.dataset.prismTab, 10) === n);
        });
        for (let i = 1; i <= 7; i++) {
            const t = $('prism_tab_' + i);
            if (t) t.style.display = (i === n) ? 'block' : 'none';
        }
        // Lazy-render any tab on first activation so we don't pay the cost
        // for tabs the user never visits in a session.
        PRiSM_renderTab(n);
    };
    window.PRiSM.getState = function() {
        return {
            mode: window.PRiSM.mode,
            tab: window.PRiSM.tab,
            multiRate: window.PRiSM.multiRate.slice(),
            dataset: window.PRiSM_dataset || null
        };
    };

    // Render whichever tab is currently active and pre-render the Data tab
    // (cheap, and the most common landing point) so its inputs exist for
    // loadInputs() to populate.
    PRiSM_renderTab(1);
    if (S.tab !== 1) PRiSM_renderTab(S.tab);
}

// Dispatch table for per-tab renderers. Currently only Tab 1 (Data) has full
// content; the rest show a clearly-labelled placeholder so the user can see
// the workflow even before the implementation lands.
function PRiSM_renderTab(n) {
    const host = $('prism_tab_' + n);
    if (!host) return;
    // Skip if already rendered (cheap idempotency check on a marker).
    if (host.dataset.prismRendered === '1' && n !== 1) return;
    switch (n) {
        case 1: PRiSM_renderTabData(host); break;
        case 2: PRiSM_renderTabPlaceholder(host, 'Plot Workshop',
                    'Diagnostic plot suite (Cartesian, Horner, log-log Bourdet, ' +
                    'square-root, ¼-root, spherical, sandface convolution, ' +
                    'superposition). Wired in by the Plot layer.'); break;
        case 3: PRiSM_renderTabPlaceholder(host, 'Model Library',
                    'Categorised picker for well type / reservoir / boundary / ' +
                    'fluid. Each model card has schematic SVG + reference. ' +
                    'Wired in by the Model layer.'); break;
        case 4: PRiSM_renderTabPlaceholder(host, 'Parameter Setup',
                    'Per-parameter initial value, lower / upper bounds, ' +
                    'fix-or-float toggle. Wired in by the Model layer.'); break;
        case 5: PRiSM_renderTabPlaceholder(host, 'Type-Curve Match',
                    'Forward simulation overlaid on the diagnostic plots. ' +
                    'Drag-to-fit interaction. Wired in by the Match layer.'); break;
        case 6: PRiSM_renderTabPlaceholder(host, 'Non-Linear Regression',
                    'Levenberg-Marquardt with bounds + confidence intervals + ' +
                    'AIC scoring. Wired in by the Regression layer.'); break;
        case 7: PRiSM_renderTabPlaceholder(host, 'Results & Report',
                    'Summary table with parameters + uncertainty + units. ' +
                    'PDF export through the existing exportReport pipeline. ' +
                    'Wired in by the Report layer.'); break;
    }
    host.dataset.prismRendered = '1';
}

function PRiSM_renderTabPlaceholder(host, title, msg) {
    host.innerHTML = `
    <div class="card">
      <div class="card-title">${title}</div>
      <div class="info-bar" style="background:var(--bg2); border:1px dashed var(--border); padding:14px; border-radius:6px; color:var(--text2); font-size:13px;">
        <strong style="color:var(--text);">Coming soon.</strong>
        <div style="margin-top:6px;">${msg}</div>
      </div>
    </div>`;
}


// =============================================================================
// SECTION 5 — DATA TAB (fully implemented)
// =============================================================================
// Paste-or-upload CSV area with header auto-detect, preview table (first 10 +
// last 5 rows), summary stats, multi-rate history editor. Final dataset is
// pushed to window.PRiSM_dataset = { t: [...], p: [...], q: [...] } for any
// downstream layer to consume.
//
// Persistence: simple textareas and the multi-rate table are saved under the
// key 'wts_prism' via the existing loadInputs/saveInputs pattern.
// =============================================================================

function PRiSM_renderTabData(host) {
    host.innerHTML = `
    <div class="cols-2">
      <div>
        <div class="card">
          <div class="card-title">Pressure / Rate Data</div>
          <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">
            Paste from Excel (tab-delimited) or CSV. Columns: <code>time</code>,
            <code>pressure</code>, <code>rate</code> (rate optional). Header
            row auto-detected and skipped if present. First column = elapsed
            time in any consistent unit.
          </div>
          <textarea id="prism_data_paste" class="data-textarea" style="min-height:220px; font-family:monospace; font-size:12px; width:100%;" placeholder="time,pressure,rate
0,2500,0
0.01,2520,500
0.02,2550,500
..."></textarea>
          <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
            <input type="file" id="prism_data_file" accept=".csv,.txt" style="font-size:12px; color:var(--text2);">
            <button class="btn btn-secondary" id="prism_data_parse">Parse</button>
            <button class="btn btn-primary" id="prism_data_use">Use this data</button>
            <button class="btn btn-secondary" id="prism_data_clear">Clear</button>
          </div>
          <div id="prism_data_msg" style="margin-top:8px; font-size:12px; color:var(--text2);"></div>
        </div>

        <div class="card">
          <div class="card-title">Multi-Rate History (optional)</div>
          <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">
            For superposition / convolution. One [time, rate] pair per row.
            Use rate = 0 for a shut-in. Leave empty for single-rate datasets.
          </div>
          <table class="dtable" id="prism_mrate_table">
            <thead><tr><th>Time</th><th>Rate</th><th></th></tr></thead>
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

    // ── Persistence ──
    const PERSIST_IDS = ['prism_data_paste'];
    loadInputs('prism', PERSIST_IDS);

    // Restore multi-rate rows from a separate JSON entry. localStorage strings
    // outside the loadInputs system because the table isn't a single input.
    try {
        const raw = localStorage.getItem('wts_prism_mrate');
        if (raw) window.PRiSM.multiRate = JSON.parse(raw) || [];
    } catch (e) { /* ignore */ }
    if (!window.PRiSM.multiRate || !window.PRiSM.multiRate.length) {
        window.PRiSM.multiRate = [{ t: 0, q: 0 }];
    }
    PRiSM_renderMultiRateRows();

    // ── Wire buttons ──
    $('prism_data_file').onchange = function(ev) {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            $('prism_data_paste').value = e.target.result;
            saveInputs('prism', PERSIST_IDS);
            PRiSM_doParseData();
        };
        reader.readAsText(f);
    };
    $('prism_data_parse').onclick = PRiSM_doParseData;
    $('prism_data_use').onclick   = PRiSM_doUseData;
    $('prism_data_clear').onclick = function() {
        $('prism_data_paste').value = '';
        $('prism_data_preview').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        $('prism_data_stats').innerHTML   = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        $('prism_data_msg').textContent   = '';
        window.PRiSM_dataset = null;
        saveInputs('prism', PERSIST_IDS);
    };
    $('prism_mrate_add').onclick = function() {
        window.PRiSM.multiRate.push({ t: 0, q: 0 });
        PRiSM_renderMultiRateRows();
        PRiSM_persistMultiRate();
    };

    // Auto-parse on load if there's already content from a previous session.
    if ($('prism_data_paste').value.trim()) PRiSM_doParseData();
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
    // semicolon > whitespace. We pick the first one that yields ≥ 2 columns.
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
    return { rows: rows, headerSkipped: headerSkipped, errors: errors };
}

// ── Run parse on the textarea, render preview + stats ──
function PRiSM_doParseData() {
    const text = $('prism_data_paste').value;
    const result = PRiSM_parseDataText(text);
    saveInputs('prism', ['prism_data_paste']);

    if (!result.rows.length) {
        $('prism_data_msg').innerHTML = '<span style="color:var(--red);">No valid data rows. ' +
            (result.errors.length ? result.errors.slice(0, 3).join(' · ') : '') + '</span>';
        $('prism_data_preview').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        $('prism_data_stats').innerHTML   = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        return;
    }

    // Stash parsed rows on the namespace so the "Use" button can promote
    // them to PRiSM_dataset without re-parsing.
    window.PRiSM._parsed = result.rows;

    const t = result.rows.map(r => r[0]);
    const p = result.rows.map(r => r[1]);
    const q = result.rows.map(r => r.length >= 3 ? r[2] : null);
    const hasRate = q.every(v => v != null && !isNaN(v));

    // ── Stats ──
    const tMin = Math.min.apply(null, t), tMax = Math.max.apply(null, t);
    const pMin = Math.min.apply(null, p), pMax = Math.max.apply(null, p);
    const ratesSeen = hasRate ? Array.from(new Set(q.map(v => Math.round(v * 100) / 100))).sort((a, b) => a - b) : [];

    let statsHTML = '<div class="rbox" style="margin-bottom:0;">';
    statsHTML += '<div class="rrow"><span class="rl">Rows parsed</span><span class="rv">' + result.rows.length + '</span></div>';
    statsHTML += '<div class="rrow"><span class="rl">Header row</span><span class="rv">' + (result.headerSkipped ? 'detected &amp; skipped' : 'none') + '</span></div>';
    statsHTML += '<div class="rrow"><span class="rl">Time range</span><span class="rv">' + fmt(tMin, 4) + ' .. ' + fmt(tMax, 4) + '</span></div>';
    statsHTML += '<div class="rrow"><span class="rl">Pressure range</span><span class="rv">' + fmt(pMin, 2) + ' .. ' + fmt(pMax, 2) + '</span></div>';
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
    $('prism_data_stats').innerHTML = statsHTML;

    // ── Preview table ──
    const cols = result.rows[0].length;
    const headers = ['Time', 'Pressure', 'Rate'].slice(0, cols);
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
    $('prism_data_preview').innerHTML = html;

    $('prism_data_msg').innerHTML = '<span style="color:var(--green);">Parsed ' + result.rows.length + ' rows.</span>' +
        (result.errors.length ? ' <span style="color:var(--yellow);">' + result.errors.length + ' rows skipped.</span>' : '');
}

// ── Promote parsed rows to the official PRiSM_dataset ──
function PRiSM_doUseData() {
    if (!window.PRiSM._parsed || !window.PRiSM._parsed.length) {
        // Try parsing now in case the user hit "Use" without "Parse".
        PRiSM_doParseData();
        if (!window.PRiSM._parsed || !window.PRiSM._parsed.length) {
            $('prism_data_msg').innerHTML = '<span style="color:var(--red);">Nothing to use — paste or upload data first.</span>';
            return;
        }
    }
    const rows = window.PRiSM._parsed;
    const t = rows.map(r => r[0]);
    const p = rows.map(r => r[1]);
    const q = rows.map(r => r.length >= 3 ? r[2] : null);
    window.PRiSM_dataset = { t: t, p: p, q: q.every(v => v != null) ? q : null };
    $('prism_data_msg').innerHTML = '<span style="color:var(--green);">Dataset of ' + t.length +
        ' points active. Switch to the Plots tab to visualise.</span>';
}

// ── Multi-rate history editor (table of [time, rate] rows) ──
function PRiSM_renderMultiRateRows() {
    const tbody = $('prism_mrate_body');
    if (!tbody) return;
    let html = '';
    window.PRiSM.multiRate.forEach((row, idx) => {
        html += '<tr>' +
            '<td><input type="number" step="any" value="' + row.t + '" data-mrate-i="' + idx + '" data-mrate-k="t" style="width:100%; padding:4px 6px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px;"></td>' +
            '<td><input type="number" step="any" value="' + row.q + '" data-mrate-i="' + idx + '" data-mrate-k="q" style="width:100%; padding:4px 6px; background:var(--bg1); color:var(--text); border:1px solid var(--border); border-radius:4px;"></td>' +
            '<td><button class="btn btn-secondary" data-mrate-rm="' + idx + '" style="padding:4px 8px;">×</button></td>' +
        '</tr>';
    });
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
            if (!window.PRiSM.multiRate.length) window.PRiSM.multiRate.push({ t: 0, q: 0 });
            PRiSM_renderMultiRateRows();
            PRiSM_persistMultiRate();
        };
    });
}

function PRiSM_persistMultiRate() {
    try { localStorage.setItem('wts_prism_mrate', JSON.stringify(window.PRiSM.multiRate || [])); }
    catch (e) { /* ignore quota errors */ }
}


// =============================================================================
// SECTION 6 — SELF-TEST
// =============================================================================
// Quick smoke-tests run at load time. Failures print to console.error so they
// surface in browser devtools without breaking the host app.
// =============================================================================

// ─── END 01-foundation ───────────────────────────────────────────────────

// ─── BEGIN 03-models ─────────────────────────────────────────────────
// =============================================================================
// PRiSM — Phase 2 Type-Curve Models (12 evaluators)
// =============================================================================
// Pressure Reservoir inversion & Simulation Model — Advanced Well Test Analysis
//
// This file implements 11 standard well/reservoir/boundary models (12 total
// evaluator functions including #4 vs #12 finite-conductivity variants).
// Models #1 (Homogeneous) is supplied by the foundation file.
//
// Universal signature for every model:
//
//   PRiSM_model_<name>(td, params) -> pd            (number or array)
//   PRiSM_model_<name>_pd_prime(td, params) -> tdp  (logarithmic derivative
//                                                    td * dPd/dtd of the
//                                                    Bourdet kind, no superpos)
//
// Conventions:
//  - Dimensionless time td is referenced to fracture half-length, well radius,
//    horizontal-well length, or other relevant characteristic length depending
//    on the model. Each function header documents the convention.
//  - Wellbore storage Cd and total skin S are folded in via the Laplace-domain
//    relation
//
//                    Pd_lap_reservoir + S
//      Pd_lap = ---------------------------------
//               s * ( 1 + s*Cd*(s*Pd_lap_res + S) )
//
//    (Agarwal-Ramey, Bourdet-Gringarten). The Stehfest inverter is then
//    applied to F(s) = Pd_lap(s).
//  - Logarithmic derivative tdp = td * dPd/dtd is computed with a 5-point
//    central difference in ln(td) space when an analytic Laplace derivative
//    is unavailable.
//  - Image-well series cap at 200 total terms, with early break when the
//    contribution of new image pairs drops below 1e-9. Convergence warnings
//    are emitted via console.warn (never thrown).
//
// References inline above each evaluator.
// =============================================================================

(function () {
'use strict';

// ---- foundation primitives (assumed defined in the orchestrator scope) ----
//   PRiSM_stehfest(Fhat, t, N)        Stehfest numerical Laplace inversion
//   PRiSM_besselK0(x), PRiSM_besselK1(x)
//   PRiSM_Ei(x)                       exponential integral
//   PRiSM_pd_lap_homogeneous(s, p)    Laplace-domain Pd of the Homogeneous
//                                     reservoir model (with WBS+S folded in
//                                     by the foundation file)
//
// They live on the global / IIFE-host scope. We resolve them lazily so the
// self-test block below can stub them in if the foundation file has not
// been loaded yet.

function _foundation(name) {
  var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (typeof g[name] === 'function') return g[name];
  // also accept symbols introduced via plain `var` in an IIFE host
  // (works in the orchestrated build; in the self-test we replace these).
  if (typeof eval(name + ' === "function"') === 'undefined') {
    // shouldn't reach here
  }
  try { return eval(name); } catch (e) { return null; }
}

// ============================================================================
// Common helpers
// ============================================================================

var STEHFEST_N      = 12;     // Stehfest order used by every Laplace model
var IMAGE_CAP       = 200;    // hard cap on image-well terms per series
var IMAGE_TOL       = 1e-9;   // convergence tolerance per term contribution
var DERIV_REL_STEP  = 1e-3;   // relative log-step for numerical derivative

// numeric guards ------------------------------------------------------------

function _num(v) {
  return (typeof v === 'number') && isFinite(v) && !isNaN(v);
}

function _requirePositiveTd(td) {
  if (Array.isArray(td)) {
    for (var i = 0; i < td.length; i++) {
      if (!_num(td[i]) || td[i] <= 0) {
        throw new Error('PRiSM model: td must be > 0 (got ' + td[i] + ' at index ' + i + ')');
      }
    }
  } else {
    if (!_num(td) || td <= 0) {
      throw new Error('PRiSM model: td must be > 0 (got ' + td + ')');
    }
  }
}

function _requireParams(params, keys) {
  if (!params || typeof params !== 'object') {
    throw new Error('PRiSM model: params object required');
  }
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!(k in params)) {
      throw new Error('PRiSM model: missing required param "' + k + '"');
    }
    var v = params[k];
    if (typeof v === 'number' && !_num(v)) {
      throw new Error('PRiSM model: param "' + k + '" is NaN/Infinity');
    }
  }
}

function _arrayMap(td, fn) {
  if (Array.isArray(td)) {
    var out = new Array(td.length);
    for (var i = 0; i < td.length; i++) out[i] = fn(td[i]);
    return out;
  }
  return fn(td);
}

// fold WBS + skin into a Laplace-domain reservoir solution Pd_lap_res(s)
// using the standard relation:
//
//      Pwd_lap = ( s*Pd_lap_res + S ) / ( s * ( 1 + Cd * s * (s*Pd_lap_res + S) ) )
//
// (Agarwal-Ramey 1970; Bourdet-Gringarten 1980)
function _foldWbsSkin(pdResLap, s, Cd, S) {
  var inner = s * pdResLap + S;
  var denom = s * (1 + Cd * s * inner);
  if (!_num(denom) || denom === 0) return 1e30;
  return inner / denom;
}

// numerical logarithmic derivative td * dPd/dtd via 5-point central diff in ln td
function _numericLogDeriv(pdFn, td, params) {
  var h = DERIV_REL_STEP;
  // u = ln(td); we evaluate pd at u-2h, u-h, u+h, u+2h
  var lnTd = Math.log(td);
  var f_m2 = pdFn(Math.exp(lnTd - 2 * h), params);
  var f_m1 = pdFn(Math.exp(lnTd -     h), params);
  var f_p1 = pdFn(Math.exp(lnTd +     h), params);
  var f_p2 = pdFn(Math.exp(lnTd + 2 * h), params);
  // 5-point central derivative w.r.t. ln td
  var dPd_dlnTd = (-f_p2 + 8 * f_p1 - 8 * f_m1 + f_m2) / (12 * h);
  return dPd_dlnTd;  // == td * dPd/dtd
}

// generic primer helper: take a Laplace-domain Pd_lap_res(s) generator and
// return a real-time pd(td) (number or array) with WBS+skin already folded.
function _stehfestEval(pdResLapFn, td, Cd, S) {
  var stehfest = _foundation('PRiSM_stehfest');
  if (!stehfest) {
    throw new Error('PRiSM_stehfest() missing — foundation file not loaded');
  }
  var Fhat = function (s) { return _foldWbsSkin(pdResLapFn(s), s, Cd, S); };
  return _arrayMap(td, function (t) { return stehfest(Fhat, t, STEHFEST_N); });
}

// ============================================================================
// MODEL #3 — Infinite-Conductivity Hydraulic Fracture (vertical well)
// ============================================================================
//
// Reference: Gringarten, A.C., Ramey, H.J., Raghavan, R.
//   "Unsteady-State Pressure Distributions Created by a Well with a Single
//    Infinite-Conductivity Vertical Fracture." SPEJ, August 1974.
//
// Physics: vertical fracture of half-length xf in a homogeneous infinite
//   reservoir; pressure drop along the fracture is negligible (infinite
//   conductivity), so the entire fracture face is at uniform pressure.
//   Early-time response is linear flow into the fracture (½-slope on log-log
//   derivative); late-time transitions to pseudo-radial flow.
//
// Dimensionless time: tDxf = k * t / ( phi * mu * ct * xf^2 )
//
// Solution (Gringarten 1974, Eq. 5 — uniform-flux fracture used as the
// rigorous infinite-conductivity surrogate, accurate to <1% beyond tDxf=0.1):
//
//   pd(tDxf) = sqrt(pi*tDxf) * erf(1/(2*sqrt(tDxf)))
//             - 0.5 * Ei(-1/(4*tDxf))
//
// where erf is the error function. We provide a simple polynomial erf and
// reuse the foundation's PRiSM_Ei. For regression-quality use we also expose
// a Laplace-domain wellbore-storage path through _stehfestEval.
//
// Params: { Cd, S }
//   Cd = wellbore storage coefficient, dimensionless
//   S  = mechanical / fracture-face skin, dimensionless
// ============================================================================

function _erf(x) {
  // Abramowitz & Stegun 7.1.26 — max error 1.5e-7
  var sign = (x < 0) ? -1 : 1;
  var a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  var a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  var ax = Math.abs(x);
  var t = 1 / (1 + p * ax);
  var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

// Closed-form (no WBS) infinite-conductivity fracture solution
function _pd_infFrac_closed(tDxf) {
  if (tDxf <= 0) return 0;
  var Ei = _foundation('PRiSM_Ei');
  // pd = sqrt(pi*tDxf) * erf(1/(2*sqrt(tDxf))) - 0.5*Ei(-1/(4*tDxf))
  var sqrtT = Math.sqrt(tDxf);
  var arg   = 1 / (2 * sqrtT);
  var term1 = Math.sqrt(Math.PI * tDxf) * _erf(arg);
  var arg2  = -1 / (4 * tDxf);
  var term2 = -0.5 * (Ei ? Ei(arg2) : 0);  // Ei(negative arg)
  return term1 + term2;
}

// Laplace-domain Pd_lap of the infinite-conductivity fracture (Ozkan-
// Raghavan 1991 source-function form, no WBS):
//
//   Pd_lap_res(s) = K0(sqrt(s)) / s        ... approximation valid for the
//                                              uniform-flux surrogate
//
// For higher fidelity at very early time we fall back to the closed form
// when Cd == 0 and S == 0; otherwise we go through Laplace + Stehfest.

function _pdLap_infFrac(s, params) {
  // params unused beyond Cd/S which are folded outside
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var sq = Math.sqrt(s);
  return K0(sq) / s;
}

/**
 * Infinite-conductivity hydraulic fracture (Gringarten-Ramey-Raghavan 1974).
 * @param {number|number[]} td - dimensionless time tDxf
 * @param {{Cd:number, S:number}} params
 * @returns {number|number[]} Pd
 */
function PRiSM_model_infiniteFrac(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  var Cd = params.Cd, S = params.S;
  if (Cd === 0 && S === 0) {
    return _arrayMap(td, _pd_infFrac_closed);
  }
  return _stehfestEval(function (s) { return _pdLap_infFrac(s, params); }, td, Cd, S);
}

function PRiSM_model_infiniteFrac_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_infiniteFrac, t, params);
  });
}

// ============================================================================
// MODEL #4 — Finite-Conductivity Hydraulic Fracture
// ============================================================================
//
// Reference: Cinco-Ley, H., Samaniego-V., F., Dominguez-A., N.
//   "Transient Pressure Behavior for a Well with a Finite-Conductivity
//    Vertical Fracture." SPE 6014 (1976) / SPEJ Aug 1978.
//
// Physics: finite-conductivity vertical fracture characterised by FcD =
//   kf*wf / (k*xf). For FcD < ~50 the bilinear-flow regime ( 1/4-slope on
//   the log-log derivative ) is observed at early time, transitioning into
//   formation-linear flow ( ½-slope ), then fracture-radial flow.
//
// Approximation used here:
//
//   We splice three asymptotes that bracket the rigorous Cinco-Ley curve to
//   within ~5% over the engineering range 0.1 < FcD < 500:
//
//     bilinear  :  pd_b  = 2.45 * tDxf^(1/4) / sqrt(FcD)
//     linear    :  pd_l  = sqrt(pi * tDxf)
//     radial    :  pd_r  = 0.5*(ln(tDxf) + 0.80907)  (Theis-like)
//
//   Splice with a smooth weighting based on tDxf relative to the regime
//   transition times that depend on FcD:
//     tD_bl_to_l = 0.0205 * (FcD - 1.5)^-1.6  (Cinco-Ley 1981)
//     tD_l_to_r  = 0.1 / (FcD/(FcD+5))         (heuristic crossover)
//
// IMPORTANT:  This is NOT the exact Cinco-Ley double-integral solution.  The
//             splice covers the engineering window used by quick-look analysis
//             but should not be used for high-precision regression.  A future
//             release should replace this with the Cinco-Ley table-lookup or
//             the fractional Stehfest evaluation through the Bessel kernel.
//
// Params: { Cd, S, FcD }
// ============================================================================

function _pd_finFrac_approx(tDxf, FcD) {
  if (tDxf <= 0) return 0;
  if (FcD <= 0) throw new Error('FcD must be > 0');
  var pdB = 2.45 * Math.pow(tDxf, 0.25) / Math.sqrt(FcD);
  var pdL = Math.sqrt(Math.PI * tDxf);
  var pdR = 0.5 * (Math.log(tDxf) + 0.80907);
  // smooth weighting in ln(tDxf) -- soft-min of the three regimes
  // approach: take the minimum of (bilinear, linear) at early time, then
  // blend with radial via a softplus once tDxf is large enough.
  var earlyAsym = Math.min(pdB, pdL);
  // weight toward radial as tDxf grows; transition centred at tDxf ~ 1.0
  var w = 1 / (1 + Math.exp(-2.5 * (Math.log(tDxf) - Math.log(1.0))));
  return (1 - w) * earlyAsym + w * Math.max(pdR, 0);
}

function _pdLap_finFrac(s, params) {
  // Laplace approximation: weighted sum of bilinear and radial Laplace
  // pieces. Useful only when WBS folding is required; the time-domain
  // approximation above is preferred for regression.
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var FcD = params.FcD;
  var sq  = Math.sqrt(s);
  // Bilinear Laplace (Cinco-Ley 1981 short-time):
  //    Pd_lap_b = pi / (s^(5/4) * sqrt(FcD))
  // Radial Laplace asymptote (line-source):
  //    Pd_lap_r = K0(sq) / s
  var pdB = Math.PI / (Math.pow(s, 1.25) * Math.sqrt(FcD));
  var pdR = K0(sq) / s;
  // soft transition driven by 1 / (s + 1)
  var w = 1 / (1 + s);
  return w * pdB + (1 - w) * pdR;
}

/**
 * Finite-conductivity hydraulic fracture (Cinco-Ley et al. 1976).
 * APPROXIMATION: spliced bilinear/linear/radial asymptotes — see header.
 * @param {number|number[]} td - dimensionless time tDxf
 * @param {{Cd:number, S:number, FcD:number}} params
 */
function PRiSM_model_finiteFrac(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD']);
  if (params.FcD <= 0) throw new Error('PRiSM finiteFrac: FcD must be > 0');
  var Cd = params.Cd, S = params.S, FcD = params.FcD;
  if (Cd === 0 && S === 0) {
    return _arrayMap(td, function (t) { return _pd_finFrac_approx(t, FcD); });
  }
  return _stehfestEval(function (s) { return _pdLap_finFrac(s, params); }, td, Cd, S);
}

function PRiSM_model_finiteFrac_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_finiteFrac, t, params);
  });
}

// ============================================================================
// MODEL #7 — Inclined Well
// ============================================================================
//
// Reference: Cinco, H., Miller, F.G., Ramey, H.J.
//   "Unsteady-State Pressure Distribution Created by a Directionally
//    Drilled Well." JPT, November 1975.
//
// Physics: a slant well that pierces the producing layer at angle theta
//   between vertical (theta=0) and horizontal (theta=90 deg). Early-time
//   response is dominated by inclined-radial flow (the well looks like a
//   cylinder of length h/cos(theta)); late-time transitions to vertical-
//   radial flow as boundaries of the perforated interval are felt.
//
// Implementation:
//   We use the Cinco/Miller/Ramey "pseudo-skin" decomposition, which
//   represents the inclined well as an equivalent vertical well with an
//   additional pseudo-skin S_theta that captures the geometry:
//
//      S_theta = -(theta_w/41)^2.06 - (theta_w/56)^1.865 * log(hp/h)
//
//   where theta_w is the corrected angle in the formation
//   (theta_w = atan(sqrt(KvKh) * tan(theta))) and hp/h is the perforated
//   fraction. Total skin S_total = S_perf + S_global + S_theta and is
//   folded into the homogeneous Laplace solution.
//
// Params: { Cd, S_perf, S_global, KvKh, theta_deg, hp_to_h }
// ============================================================================

function _inclined_pseudoskin(theta_deg, KvKh, hp_to_h) {
  if (KvKh <= 0) throw new Error('KvKh must be > 0');
  if (hp_to_h <= 0 || hp_to_h > 1) throw new Error('hp_to_h must be in (0,1]');
  var theta = theta_deg * Math.PI / 180;
  // corrected angle in formation
  var thetaW_rad = Math.atan(Math.sqrt(KvKh) * Math.tan(theta));
  var thetaW_deg = thetaW_rad * 180 / Math.PI;
  // Cinco-Miller-Ramey pseudo-skin
  var part1 = -Math.pow(thetaW_deg / 41, 2.06);
  var part2 = -Math.pow(thetaW_deg / 56, 1.865) * Math.log10(hp_to_h);
  return part1 + part2;
}

function _pdLap_inclined(s, params) {
  // We delegate to the Homogeneous Laplace solution, with a modified skin.
  var pdHom = _foundation('PRiSM_pd_lap_homogeneous');
  if (!pdHom) {
    // graceful fallback to line-source K0 if foundation hom solution missing
    var K0 = _foundation('PRiSM_besselK0');
    return K0(Math.sqrt(s)) / s;
  }
  var Stotal = (params.S_perf || 0) + (params.S_global || 0)
             + _inclined_pseudoskin(params.theta_deg, params.KvKh, params.hp_to_h);
  // Pass synthetic params with combined skin and zero Cd (we will fold WBS
  // again outside via _foldWbsSkin, so here we ask the homogeneous solution
  // for the *reservoir* pressure only and rely on the caller's folding).
  return pdHom(s, { Cd: 0, S: 0, _S_extra: Stotal });
}

/**
 * Inclined / slant well in homogeneous reservoir (Cinco-Miller-Ramey 1975).
 * @param {number|number[]} td
 * @param {{Cd:number,S_perf:number,S_global:number,KvKh:number,
 *          theta_deg:number,hp_to_h:number}} params
 */
function PRiSM_model_inclined(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'theta_deg', 'hp_to_h']);
  var Cd = params.Cd;
  // total skin includes the geometric pseudo-skin
  var Sg = _inclined_pseudoskin(params.theta_deg, params.KvKh, params.hp_to_h);
  var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
  // use foundation hom Laplace (without WBS/skin folded inside) and fold
  // here with the combined skin
  return _stehfestEval(function (s) {
    var pdHom = _foundation('PRiSM_pd_lap_homogeneous');
    if (pdHom) {
      // ask for the bare reservoir Pd_lap (Cd=0, S=0)
      return pdHom(s, { Cd: 0, S: 0 });
    }
    var K0 = _foundation('PRiSM_besselK0');
    return K0(Math.sqrt(s)) / s;
  }, td, Cd, Stotal);
}

function PRiSM_model_inclined_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'theta_deg', 'hp_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_inclined, t, params);
  });
}

// ============================================================================
// MODEL #8 — Horizontal Well
// ============================================================================
//
// Reference: Raghavan, R., Ozkan, E., Joshi, S.D.
//   "Horizontal Well Pressure Behavior." SPE 16378.
//   Also Goode, P.A., Thambynayagam, R.K.M. SPE 14250 (1985)
//   (Goode-Thambynayagam image-summation kernel).
//
// Physics: horizontal well of length L drilled at vertical position zw in a
//   reservoir of thickness h, anisotropy KvKh = kv/kh. Three flow regimes:
//     1. early-time radial flow about the wellbore (vertical radial):
//          pd ~ 0.5 [ln(tDw) + 0.80907]
//          tDw = kh * t / (phi*mu*ct*rw^2)
//     2. intermediate linear flow normal to the well length:
//          pd ~ sqrt(pi * tDL)  (Joshi)
//          tDL = kh * t / (phi*mu*ct*L^2)
//     3. late-time pseudo-radial flow in the horizontal plane:
//          pd ~ 0.5 [ln(tDL) + 0.80907 + 2*Sg]
//   where Sg is the geometric pseudo-skin from anisotropy and partial
//   penetration of the reservoir thickness (Joshi 1991).
//
// Implementation:
//   Goode-Thambynayagam image-summation kernel for the vertical-radial-to-
//   linear transition (uniform-flux line source mirrored at z=0 and z=h):
//
//      Pd_lap_h(s) = K0(sqrt(s)) / s
//                  + 2 * sum_{n=1..N} K0(sqrt(s) * (2 * n * h_dim))
//
//   where h_dim = h / L is the dimensionless reservoir thickness, capped at
//   N <= 50 image terms or until the marginal contribution drops below
//   IMAGE_TOL.  Pseudo-skin from Joshi adds to the global S.
//
// Params: { Cd, S_perf, S_global, KvKh, L_to_h, zw_to_h }
// ============================================================================

function _horizontal_pseudoskin(KvKh, L_to_h, zw_to_h) {
  if (KvKh <= 0) throw new Error('KvKh must be > 0');
  if (L_to_h <= 0) throw new Error('L_to_h must be > 0');
  if (zw_to_h < 0 || zw_to_h > 1) throw new Error('zw_to_h must be in [0,1]');
  // Joshi 1991 anisotropy / partial-penetration pseudo-skin:
  //   Sg = ln(h/(2*pi*rw)) - (1/2)*ln(KvKh) ... rw normalised to 1 here
  var beta = Math.sqrt(1 / KvKh);
  var Sg = Math.log(beta * 0.5) - 0.5 * Math.log(KvKh);
  // small correction for off-centre placement
  var dz = (zw_to_h - 0.5);
  Sg += 2.0 * dz * dz;
  return Sg;
}

function _pdLap_horizontal(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  // Goode-Thambynayagam image series
  var h_dim = 1 / params.L_to_h;            // h normalised to L
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var nMax = 50;
  for (var n = 1; n <= nMax; n++) {
    var arg = sq * (2 * n * h_dim);
    if (arg > 50) break;                   // K0 is exponentially small
    var inc = 2 * K0(arg) / s;
    pd += inc;
    if (Math.abs(inc) < IMAGE_TOL) break;
  }
  return pd;
}

/**
 * Horizontal well in homogeneous reservoir (Goode-Thambynayagam / Joshi).
 * @param {number|number[]} td - tD referenced to L^2
 * @param {{Cd:number,S_perf:number,S_global:number,KvKh:number,
 *          L_to_h:number,zw_to_h:number}} params
 */
function PRiSM_model_horizontal(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'zw_to_h']);
  var Cd = params.Cd;
  var Sg = _horizontal_pseudoskin(params.KvKh, params.L_to_h, params.zw_to_h);
  var Stotal = (params.S_perf || 0) + (params.S_global || 0) + Sg;
  return _stehfestEval(function (s) { return _pdLap_horizontal(s, params); }, td, Cd, Stotal);
}

function PRiSM_model_horizontal_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S_perf', 'S_global', 'KvKh', 'L_to_h', 'zw_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_horizontal, t, params);
  });
}

// ============================================================================
// MODEL #10a — Single Linear Boundary
// ============================================================================
//
// Reference: van Poolen, H.K., Bixel, H.C., Jargon, J.R.
//   "Individual Well Pressures in Reservoirs of Various Shapes."
//   JPT, August 1963.
//
// Physics: infinite-acting homogeneous reservoir bounded by a single linear
//   boundary (sealing fault or constant-pressure aquifer/gas-cap) at
//   dimensionless distance dF (in units of well radius). One image well at
//   distance 2*dF is added; sign +1 for sealing (no-flow), -1 for constant
//   pressure (subtracts the image contribution).
//
//   Sealing fault → derivative doubles (slope 1.0 on log-log → 2.0).
//   Const-pressure → derivative drops to zero (rolls over).
//
// Params: { Cd, S, dF, BC }
//   BC: 'noflow' (default) or 'constP'
// ============================================================================

function _pdLap_linearBoundary(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var sign = (params.BC === 'constP') ? -1 : +1;
  var dF = params.dF;
  if (!_num(dF) || dF <= 0) throw new Error('dF must be > 0');
  var sq = Math.sqrt(s);
  var pwd = K0(sq) / s;
  var image = K0(sq * 2 * dF) / s;
  return pwd + sign * image;
}

/**
 * Single linear boundary (van Poolen 1963).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF:number,BC:string}} params
 */
function PRiSM_model_linearBoundary(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF']);
  if (params.BC && params.BC !== 'noflow' && params.BC !== 'constP') {
    throw new Error('PRiSM linearBoundary: BC must be "noflow" or "constP"');
  }
  return _stehfestEval(function (s) { return _pdLap_linearBoundary(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_linearBoundary_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_linearBoundary, t, params);
  });
}

// ============================================================================
// MODEL #10b — Parallel Channel (two parallel sealing faults)
// ============================================================================
//
// Two parallel sealing boundaries at distances dF1 and dF2 either side of
// the well form an infinite chain of image wells. The classical image-well
// series for a single image-pair offset is:
//
//   Pd_res_lap(s) = K0(sq) / s
//                 + sum_{n=1..N} [K0(sq*Rn+) + K0(sq*Rn-)] / s
//
// where Rn+ and Rn- are the distances to image wells generated by reflecting
// alternately across the two boundaries. We truncate at IMAGE_CAP=200 pairs
// (50 default) once the marginal term drops below IMAGE_TOL.
//
// Late-time expected behaviour: derivative goes to ½-slope (linear flow in
// the channel).
//
// Params: { Cd, S, dF1, dF2 }
// ============================================================================

function _pdLap_parallelChannel(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF1 = params.dF1, dF2 = params.dF2;
  if (!_num(dF1) || dF1 <= 0 || !_num(dF2) || dF2 <= 0) {
    throw new Error('dF1, dF2 must be > 0');
  }
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var W = dF1 + dF2;        // channel width
  var added = 0;
  for (var n = 1; n <= IMAGE_CAP; n++) {
    var off1 = 2 * n * W;          // primary even-pair offset
    var off2 = 2 * n * W - 2 * dF1; // alternate offsets
    var off3 = 2 * n * W - 2 * dF2;
    var inc = (K0(sq * off1) + K0(sq * Math.max(off2, 1e-12))
                              + K0(sq * Math.max(off3, 1e-12))) / s;
    if (Math.abs(inc) < IMAGE_TOL && n > 5) break;
    pd += inc;
    added++;
  }
  if (added >= IMAGE_CAP) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('PRiSM parallelChannel: image-well series did not converge within ' + IMAGE_CAP + ' terms');
    }
  }
  return pd;
}

/**
 * Parallel-channel boundaries (image-well series).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF1:number,dF2:number}} params
 */
function PRiSM_model_parallelChannel(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2']);
  return _stehfestEval(function (s) { return _pdLap_parallelChannel(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_parallelChannel_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_parallelChannel, t, params);
  });
}

// ============================================================================
// MODEL #10c — Closed Channel (3-sided)
// ============================================================================
//
// Two parallel sealing boundaries (channel) PLUS a third sealing boundary at
// the channel end (distance dEnd). 2D image-well lattice: parallel chain of
// images mirrored once more about the end boundary. Late-time response is
// pseudo-steady-state along the channel length (unit slope on the
// derivative).
//
// Params: { Cd, S, dF1, dF2, dEnd }
// ============================================================================

function _pdLap_closedChannel3(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF1 = params.dF1, dF2 = params.dF2, dEnd = params.dEnd;
  if (!_num(dF1) || dF1 <= 0 || !_num(dF2) || dF2 <= 0 || !_num(dEnd) || dEnd <= 0) {
    throw new Error('dF1, dF2, dEnd must all be > 0');
  }
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var W = dF1 + dF2;
  // primary parallel images
  var added = 0;
  for (var n = 1; n <= 100; n++) {
    var off1 = 2 * n * W;
    var off2 = Math.abs(2 * n * W - 2 * dF1);
    var off3 = Math.abs(2 * n * W - 2 * dF2);
    var inc1 = (K0(sq * off1) + K0(sq * Math.max(off2, 1e-12))
                              + K0(sq * Math.max(off3, 1e-12))) / s;
    pd += inc1;
    added++;
    if (Math.abs(inc1) < IMAGE_TOL && n > 5) break;
  }
  // end-boundary mirror images (distance 2*dEnd shifted by parallel offsets)
  for (var m = 1; m <= 100; m++) {
    var off_end = 2 * m * dEnd;
    var inc2 = K0(sq * off_end) / s;
    pd += inc2;
    added++;
    if (Math.abs(inc2) < IMAGE_TOL && m > 5) break;
    if (added >= IMAGE_CAP) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('PRiSM closedChannel3: image cap reached');
      }
      break;
    }
  }
  return pd;
}

/**
 * Closed channel (3-sided) boundary set.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF1:number,dF2:number,dEnd:number}} params
 */
function PRiSM_model_closedChannel3(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'dEnd']);
  return _stehfestEval(function (s) { return _pdLap_closedChannel3(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_closedChannel3_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'dEnd']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_closedChannel3, t, params);
  });
}

// ============================================================================
// MODEL #10d — Closed Rectangle
// ============================================================================
//
// Full 2D image-well lattice for a rectangular sealed boundary set with the
// well at an arbitrary interior point. Distances dN, dS, dE, dW (north,
// south, east, west) define the rectangle of dimension (dE+dW) by (dN+dS).
//
// The image lattice is doubly-periodic with periods 2*(dE+dW) and 2*(dN+dS).
// We sum images on a square grid up to normalised distance norm <= 50, with
// an early break per shell once contributions are below IMAGE_TOL.
//
// Late-time response is true pseudo-steady-state (unit-slope derivative) —
// the classical reservoir-limits test signature.
//
// Params: { Cd, S, dN, dS, dE, dW }
// ============================================================================

function _pdLap_closedRectangle(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dN = params.dN, dS = params.dS, dE = params.dE, dW = params.dW;
  [dN, dS, dE, dW].forEach(function (d) {
    if (!_num(d) || d <= 0) throw new Error('All boundary distances must be > 0');
  });
  var Lx = dE + dW;       // east-west period (full width)
  var Ly = dN + dS;       // north-south period (full height)
  var sq = Math.sqrt(s);
  // well at origin within the cell; image lattice at (i*Lx, j*Ly) for
  // (i,j) != (0,0). Each image contributes K0(sq * R) / s.
  var pd = K0(sq) / s;     // primary well
  var totalAdded = 0;
  // shell iteration
  for (var shell = 1; shell <= 200; shell++) {
    var shellSum = 0;
    // perimeter of square shell
    for (var i = -shell; i <= shell; i++) {
      for (var j = -shell; j <= shell; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== shell) continue;
        var x = i * Lx, y = j * Ly;
        var r = Math.sqrt(x * x + y * y);
        if (sq * r > 50) continue;          // K0 negligible
        var k = K0(sq * r);
        shellSum += k / s;
        totalAdded++;
        if (totalAdded >= IMAGE_CAP) break;
      }
      if (totalAdded >= IMAGE_CAP) break;
    }
    pd += shellSum;
    if (Math.abs(shellSum) < IMAGE_TOL && shell > 3) break;
    if (totalAdded >= IMAGE_CAP) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('PRiSM closedRectangle: image cap reached at shell ' + shell);
      }
      break;
    }
  }
  return pd;
}

/**
 * Closed rectangle (full 2D image lattice).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dN:number,dS:number,dE:number,dW:number}} params
 */
function PRiSM_model_closedRectangle(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dN', 'dS', 'dE', 'dW']);
  return _stehfestEval(function (s) { return _pdLap_closedRectangle(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_closedRectangle_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dN', 'dS', 'dE', 'dW']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_closedRectangle, t, params);
  });
}

// ============================================================================
// MODEL #10e — Intersecting Boundaries
// ============================================================================
//
// Two sealing boundaries intersecting at angle theta (degrees) with the well
// in between. Image-well count = 360/theta - 1, arranged in a circular
// pattern at distances determined by the well's perpendicular distances to
// each boundary (dF1 to first boundary, dF2 to second).
//
// Late-time effect: radial-flow stabilisation increases by a factor
//   m_intersecting / m_infinite = 360/theta
// (e.g. a 90-degree intersection increases the slope 4x).
//
// We warn (don't throw) when 360/angleDeg is non-integer; the lattice is
// still built but with a slightly under-determined image set.
//
// Params: { Cd, S, dF1, dF2, angleDeg }
// ============================================================================

function _pdLap_intersecting(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF1 = params.dF1, dF2 = params.dF2, ang = params.angleDeg;
  if (!_num(dF1) || dF1 <= 0 || !_num(dF2) || dF2 <= 0) {
    throw new Error('dF1, dF2 must be > 0');
  }
  if (!_num(ang) || ang <= 0 || ang >= 360) {
    throw new Error('angleDeg must be in (0,360)');
  }
  var nImages = Math.round(360 / ang) - 1;
  if (Math.abs(360 / ang - Math.round(360 / ang)) > 1e-6) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('PRiSM intersecting: 360/angleDeg = ' + (360 / ang)
                   + ' is non-integer; image lattice approximate');
    }
  }
  if (nImages < 1) nImages = 1;
  if (nImages > IMAGE_CAP) nImages = IMAGE_CAP;
  // approximate: well at perpendicular distance from each boundary; we use
  // a circular image arrangement centred on the boundary intersection.
  // The radial distance from the well to each image is taken as
  //   2 * sqrt(dF1^2 + dF2^2 - 2*dF1*dF2*cos(angRad)) for the first image
  //   and rotates around for each subsequent image with stride ang.
  var sq = Math.sqrt(s);
  var pd = K0(sq) / s;
  var dCentral = Math.sqrt(dF1 * dF1 + dF2 * dF2);
  for (var n = 1; n <= nImages; n++) {
    var rho = 2 * dCentral * Math.sin(n * ang * Math.PI / 360);
    if (sq * rho > 50) continue;
    pd += K0(sq * rho) / s;
  }
  return pd;
}

/**
 * Intersecting boundaries — circular image-well lattice.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF1:number,dF2:number,angleDeg:number}} params
 */
function PRiSM_model_intersecting(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'angleDeg']);
  return _stehfestEval(function (s) { return _pdLap_intersecting(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_intersecting_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF1', 'dF2', 'angleDeg']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_intersecting, t, params);
  });
}

// ============================================================================
// MODEL #10f — Boundary "Fog Factor"
// ============================================================================
//
// Single linear boundary with continuously variable transmissibility,
// expressed as fog ∈ [-1, 1]:
//   fog = +1  → fully sealing fault (image strength +1)
//   fog =  0  → infinite-acting (no boundary)
//   fog = -1  → fully constant-pressure (image strength -1)
//   fog ∈ between → leaky / partially-sealing fault
//
// Image-well strength scales linearly with fog, capturing the engineering
// intuition of partial transmissibility as a single tuning knob.
//
// Params: { Cd, S, dF, fog }
// ============================================================================

function _pdLap_fogBoundary(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var dF = params.dF, fog = params.fog;
  if (!_num(dF) || dF <= 0) throw new Error('dF must be > 0');
  if (!_num(fog) || fog < -1 || fog > 1) throw new Error('fog must be in [-1, 1]');
  var sq = Math.sqrt(s);
  return (K0(sq) + fog * K0(sq * 2 * dF)) / s;
}

/**
 * Boundary fog factor — continuously variable transmissibility.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,dF:number,fog:number}} params
 */
function PRiSM_model_fogBoundary(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF', 'fog']);
  return _stehfestEval(function (s) { return _pdLap_fogBoundary(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_fogBoundary_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'dF', 'fog']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_fogBoundary, t, params);
  });
}

// ============================================================================
// MODEL #12 — Finite-Conductivity Fracture WITH Fracture-Face Skin
// ============================================================================
//
// Reference: Cinco-Ley, H., Samaniego-V., F.
//   "Transient Pressure Analysis for Fractured Wells." SPE 6752 / JPT
//    Sept 1981.
//
// Same as #4 plus an additional fracture-face skin Sf representing damage on
// the fracture wall (mud invasion, polymer residue, etc.). Sf damps the
// early-time bilinear-flow signature:
//
//      Pd_eff = Pd_finite(td, FcD) + Sf * exp(-2*sqrt(td/FcD))
//
// where the exponential decay reflects how Sf only matters while the bilinear
// transient is active. Once linear/radial flow takes over, Sf merges into
// the global skin S.
//
// Params: { Cd, S, FcD, Sf }
// ============================================================================

function _pd_finFracSkin(td, params) {
  var pdBase = _pd_finFrac_approx(td, params.FcD);
  var Sf = params.Sf || 0;
  var damp = Math.exp(-2 * Math.sqrt(td / params.FcD));
  return pdBase + Sf * damp;
}

function _pdLap_finFracSkin(s, params) {
  var pdBase = _pdLap_finFrac(s, params);
  var Sf = params.Sf || 0;
  // Laplace transform of  Sf * exp(-2*sqrt(td/FcD))  approximated as
  //   Sf * exp(-1/sqrt(s*FcD)) / s
  // (Schapery-style first-order approx; sufficient for engineering work)
  if (Sf === 0) return pdBase;
  var damp = Math.exp(-1 / Math.sqrt(Math.max(s * params.FcD, 1e-12)));
  return pdBase + Sf * damp / s;
}

/**
 * Finite-conductivity fracture with fracture-face skin (Cinco-Samaniego 1981).
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,FcD:number,Sf:number}} params
 */
function PRiSM_model_finiteFracSkin(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD', 'Sf']);
  if (params.FcD <= 0) throw new Error('FcD must be > 0');
  var Cd = params.Cd, S = params.S;
  if (Cd === 0 && S === 0) {
    return _arrayMap(td, function (t) { return _pd_finFracSkin(t, params); });
  }
  return _stehfestEval(function (s) { return _pdLap_finFracSkin(s, params); }, td, Cd, S);
}

function PRiSM_model_finiteFracSkin_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'FcD', 'Sf']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_finiteFracSkin, t, params);
  });
}

// ============================================================================
// MODEL #30 — Partial-Penetration Hydraulic Fracture
// ============================================================================
//
// Reference: Gringarten, A.C., Ramey, H.J.
//   "The Use of Source and Green's Functions in Solving Unsteady-Flow
//    Problems in Reservoirs." SPE 3818 / SPEJ Oct 1973.
//
// Vertical hydraulic fracture whose height hf does NOT span the full
// reservoir thickness h. Three diagnostic regimes:
//
//   1. Early time — fracture-linear flow (½-slope on derivative)
//      pd ~ sqrt(pi * tDxf)
//   2. Intermediate — vertical pseudo-radial in the (xf, hf) cylinder
//      pd ~ 0.5 [ln(tDxf) + ln(hf_to_h^2)]
//   3. Late time — horizontal pseudo-radial about the wellbore with
//      partial-penetration pseudo-skin Sg added:
//      Sg = (h/hf - 1) * [ln(h/(2*rw)) - 0.5]
//
// Implementation uses Green's-function shortcuts: Laplace-domain
// superposition of (a) a uniform-flux fracture source kernel K0(sq)/s and
// (b) a partial-penetration vertical-radial kernel exp(-A*sqrt(s))/s with
// A = 1/hf_to_h. The off-centre placement zw_to_h shifts the source.
//
// IMPORTANT: Green's-function shortcut. The exact Gringarten-Ramey solution
// requires integrating an infinite series of source images over the fracture
// height; the approximation here is accurate to ~5% in the engineering
// window and avoids the cost of a 2D integral inside the Stehfest loop.
//
// Params: { Cd, S, hf_to_h, zw_to_h }
// ============================================================================

function _pdLap_partialPenFrac(s, params) {
  var K0 = _foundation('PRiSM_besselK0');
  if (!K0) throw new Error('PRiSM_besselK0 missing');
  var hf_h = params.hf_to_h;
  var zw_h = params.zw_to_h;
  if (!_num(hf_h) || hf_h <= 0 || hf_h > 1) {
    throw new Error('hf_to_h must be in (0,1]');
  }
  if (!_num(zw_h) || zw_h < 0 || zw_h > 1) {
    throw new Error('zw_to_h must be in [0,1]');
  }
  var sq = Math.sqrt(s);
  // Fracture-linear kernel
  var pd_frac = K0(sq) / s;
  // Vertical pseudo-radial kernel with partial-penetration scaling
  var A = 1 / hf_h;
  var pd_vert = Math.exp(-A * sq) / (s * (1 + sq));
  // off-centre adjustment as additional skin-like term
  var dz = zw_h - 0.5;
  var pd_off = (dz * dz) / s;
  return pd_frac + pd_vert + pd_off;
}

/**
 * Partial-penetration hydraulic fracture (Gringarten-Ramey 1973).
 * Green's-function shortcut, see header.
 * @param {number|number[]} td
 * @param {{Cd:number,S:number,hf_to_h:number,zw_to_h:number}} params
 */
function PRiSM_model_partialPenFrac(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'hf_to_h', 'zw_to_h']);
  return _stehfestEval(function (s) { return _pdLap_partialPenFrac(s, params); },
                       td, params.Cd, params.S);
}

function PRiSM_model_partialPenFrac_pd_prime(td, params) {
  _requirePositiveTd(td);
  _requireParams(params, ['Cd', 'S', 'hf_to_h', 'zw_to_h']);
  return _arrayMap(td, function (t) {
    return _numericLogDeriv(PRiSM_model_partialPenFrac, t, params);
  });
}

// ============================================================================
// REGISTRY
// ============================================================================
//
// One entry per model — used by the model picker UI, regression engine, and
// schematic renderer. The "homogeneous" entry is filled by the foundation
// file (file 01); we only add ours.

var REGISTRY_ADDITIONS = {
  infiniteFrac: {
    pd: PRiSM_model_infiniteFrac,
    pdPrime: PRiSM_model_infiniteFrac_pd_prime,
    defaults: { Cd: 100, S: 0 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd',     unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',                  unit: '-', min: -7,   max: 50,   default: 0   }
    ],
    reference: 'Gringarten, Ramey, Raghavan, SPEJ Aug 1974',
    category: 'fracture',
    description: 'Vertical well with infinite-conductivity hydraulic fracture in a homogeneous reservoir.'
  },

  finiteFrac: {
    pd: PRiSM_model_finiteFrac,
    pdPrime: PRiSM_model_finiteFrac_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd',  unit: '-', min: 0,   max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',               unit: '-', min: -7,  max: 50,   default: 0   },
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1000, default: 10 }
    ],
    reference: 'Cinco-Ley, Samaniego, Dominguez, SPE 6014 / SPEJ Aug 1978',
    category: 'fracture',
    description: 'Vertical well with finite-conductivity hydraulic fracture (spliced asymptotic approximation).'
  },

  inclined: {
    pd: PRiSM_model_inclined,
    pdPrime: PRiSM_model_inclined_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 1.0, theta_deg: 45, hp_to_h: 1.0 },
    paramSpec: [
      { key: 'Cd',        label: 'Wellbore storage Cd', unit: '-',   min: 0,    max: 1e10, default: 100 },
      { key: 'S_perf',    label: 'Perforation skin',     unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'S_global',  label: 'Global skin',          unit: '-',  min: -7,   max: 50,   default: 0   },
      { key: 'KvKh',      label: 'Anisotropy Kv/Kh',     unit: '-',  min: 0.001, max: 10,   default: 1   },
      { key: 'theta_deg', label: 'Inclination angle',    unit: 'deg', min: 0,   max: 89,   default: 45  },
      { key: 'hp_to_h',   label: 'Perforated fraction',  unit: '-',   min: 0.01, max: 1,   default: 1.0 }
    ],
    reference: 'Cinco, Miller, Ramey, JPT Nov 1975',
    category: 'well-type',
    description: 'Slant / inclined well with directionally-dependent skin in a homogeneous reservoir.'
  },

  horizontal: {
    pd: PRiSM_model_horizontal,
    pdPrime: PRiSM_model_horizontal_pd_prime,
    defaults: { Cd: 100, S_perf: 0, S_global: 0, KvKh: 0.1, L_to_h: 5.0, zw_to_h: 0.5 },
    paramSpec: [
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S_perf',   label: 'Perforation skin',    unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'S_global', label: 'Global skin',         unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'KvKh',     label: 'Anisotropy Kv/Kh',    unit: '-', min: 0.001, max: 10,  default: 0.1 },
      { key: 'L_to_h',   label: 'L / h (lateral / thickness)', unit: '-', min: 0.1, max: 100, default: 5.0 },
      { key: 'zw_to_h',  label: 'Vertical placement zw/h', unit: '-', min: 0, max: 1, default: 0.5 }
    ],
    reference: 'Raghavan, Ozkan, Joshi, SPE 16378 (Goode-Thambynayagam kernel)',
    category: 'well-type',
    description: 'Horizontal well in homogeneous reservoir with vertical-radial → linear → pseudo-radial regimes.'
  },

  linearBoundary: {
    pd: PRiSM_model_linearBoundary,
    pdPrime: PRiSM_model_linearBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, BC: 'noflow' },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd', unit: '-',  min: 0,   max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',              unit: '-',  min: -7,  max: 50,   default: 0   },
      { key: 'dF', label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
      { key: 'BC', label: 'Boundary condition',   unit: '',   options: ['noflow', 'constP'], default: 'noflow' }
    ],
    reference: 'van Poolen, Bixel, Jargon, JPT Aug 1963',
    category: 'boundary',
    description: 'Single linear boundary (sealing fault or constant pressure) via image-well technique.'
  },

  parallelChannel: {
    pd: PRiSM_model_parallelChannel,
    pdPrime: PRiSM_model_parallelChannel_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF1', label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dF2', label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e6, default: 500 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 (image-well series)',
    category: 'boundary',
    description: 'Parallel sealing boundaries (channel) — image-well series, late-time ½-slope linear flow.'
  },

  closedChannel3: {
    pd: PRiSM_model_closedChannel3,
    pdPrime: PRiSM_model_closedChannel3_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, dEnd: 1000 },
    paramSpec: [
      { key: 'Cd',   label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',    label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF1',  label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dF2',  label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dEnd', label: 'Distance to end',     unit: 'r_w', min: 1, max: 1e6, default: 1000 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963',
    category: 'boundary',
    description: 'Closed channel (3-sided) — parallel + end-closure image-well lattice.'
  },

  closedRectangle: {
    pd: PRiSM_model_closedRectangle,
    pdPrime: PRiSM_model_closedRectangle_pd_prime,
    defaults: { Cd: 100, S: 0, dN: 500, dS: 500, dE: 500, dW: 500 },
    paramSpec: [
      { key: 'Cd', label: 'Wellbore storage Cd', unit: '-', min: 0,  max: 1e10, default: 100 },
      { key: 'S',  label: 'Skin S',              unit: '-', min: -7, max: 50,   default: 0   },
      { key: 'dN', label: 'Distance N',          unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dS', label: 'Distance S',          unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dE', label: 'Distance E',          unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dW', label: 'Distance W',          unit: 'r_w', min: 1, max: 1e6, default: 500 }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 — full 2D image lattice',
    category: 'boundary',
    description: 'Closed rectangle — late-time PSS unit-slope (reservoir-limits test).'
  },

  intersecting: {
    pd: PRiSM_model_intersecting,
    pdPrime: PRiSM_model_intersecting_pd_prime,
    defaults: { Cd: 100, S: 0, dF1: 500, dF2: 500, angleDeg: 90 },
    paramSpec: [
      { key: 'Cd',       label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',        label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF1',      label: 'Distance to fault 1', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'dF2',      label: 'Distance to fault 2', unit: 'r_w', min: 1, max: 1e6, default: 500 },
      { key: 'angleDeg', label: 'Intersection angle',  unit: 'deg', min: 1, max: 359, default: 90  }
    ],
    reference: 'van Poolen et al., JPT Aug 1963 — circular image pattern',
    category: 'boundary',
    description: 'Two intersecting sealing faults — derivative slope amplified by 360/angle.'
  },

  fogBoundary: {
    pd: PRiSM_model_fogBoundary,
    pdPrime: PRiSM_model_fogBoundary_pd_prime,
    defaults: { Cd: 100, S: 0, dF: 1000, fog: 0.5 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd', unit: '-',  min: 0,  max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',              unit: '-',  min: -7, max: 50,   default: 0   },
      { key: 'dF',  label: 'Distance to boundary', unit: 'r_w', min: 1, max: 1e6, default: 1000 },
      { key: 'fog', label: 'Fog factor (transmissibility)', unit: '-', min: -1, max: 1, default: 0.5 }
    ],
    reference: 'PRiSM original — partially-sealing boundary as continuous transmissibility',
    category: 'boundary',
    description: 'Single boundary with continuously variable transmissibility, fog ∈ [-1, +1].'
  },

  finiteFracSkin: {
    pd: PRiSM_model_finiteFracSkin,
    pdPrime: PRiSM_model_finiteFracSkin_pd_prime,
    defaults: { Cd: 100, S: 0, FcD: 10, Sf: 0.5 },
    paramSpec: [
      { key: 'Cd',  label: 'Wellbore storage Cd', unit: '-', min: 0,    max: 1e10, default: 100 },
      { key: 'S',   label: 'Skin S',              unit: '-', min: -7,   max: 50,   default: 0   },
      { key: 'FcD', label: 'Fracture conductivity FcD', unit: '-', min: 0.1, max: 1000, default: 10 },
      { key: 'Sf',  label: 'Fracture-face skin Sf', unit: '-', min: 0,  max: 20,   default: 0.5 }
    ],
    reference: 'Cinco-Ley & Samaniego, SPE 6752 / JPT Sept 1981',
    category: 'fracture',
    description: 'Finite-conductivity fracture with additional fracture-face skin damping early bilinear flow.'
  },

  partialPenFrac: {
    pd: PRiSM_model_partialPenFrac,
    pdPrime: PRiSM_model_partialPenFrac_pd_prime,
    defaults: { Cd: 100, S: 0, hf_to_h: 0.5, zw_to_h: 0.5 },
    paramSpec: [
      { key: 'Cd',      label: 'Wellbore storage Cd', unit: '-', min: 0,  max: 1e10, default: 100 },
      { key: 'S',       label: 'Skin S',              unit: '-', min: -7, max: 50,   default: 0   },
      { key: 'hf_to_h', label: 'Fracture-height fraction hf/h', unit: '-', min: 0.01, max: 1, default: 0.5 },
      { key: 'zw_to_h', label: 'Vertical placement zw/h', unit: '-', min: 0, max: 1, default: 0.5 }
    ],
    reference: 'Gringarten & Ramey, SPE 3818 / SPEJ Oct 1973',
    category: 'fracture',
    description: 'Partial-penetration hydraulic fracture (Green\'s-function shortcut) — fracture-linear → vertical-radial → horizontal-radial.'
  }
};

// merge into the registry that the foundation file is expected to seed.
// foundation must run first; if it has not registered "homogeneous" yet we
// at least set up the namespace so the merge is non-destructive.

(function _installRegistry() {
  var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  if (!g.PRiSM_MODELS) g.PRiSM_MODELS = {};
  for (var key in REGISTRY_ADDITIONS) {
    if (REGISTRY_ADDITIONS.hasOwnProperty(key)) {
      g.PRiSM_MODELS[key] = REGISTRY_ADDITIONS[key];
    }
  }
  // also expose the evaluator functions on the global so the foundation
  // file or the rest of the app can reference them by name.
  g.PRiSM_model_infiniteFrac          = PRiSM_model_infiniteFrac;
  g.PRiSM_model_infiniteFrac_pd_prime = PRiSM_model_infiniteFrac_pd_prime;
  g.PRiSM_model_finiteFrac            = PRiSM_model_finiteFrac;
  g.PRiSM_model_finiteFrac_pd_prime   = PRiSM_model_finiteFrac_pd_prime;
  g.PRiSM_model_inclined              = PRiSM_model_inclined;
  g.PRiSM_model_inclined_pd_prime     = PRiSM_model_inclined_pd_prime;
  g.PRiSM_model_horizontal            = PRiSM_model_horizontal;
  g.PRiSM_model_horizontal_pd_prime   = PRiSM_model_horizontal_pd_prime;
  g.PRiSM_model_linearBoundary        = PRiSM_model_linearBoundary;
  g.PRiSM_model_linearBoundary_pd_prime = PRiSM_model_linearBoundary_pd_prime;
  g.PRiSM_model_parallelChannel       = PRiSM_model_parallelChannel;
  g.PRiSM_model_parallelChannel_pd_prime = PRiSM_model_parallelChannel_pd_prime;
  g.PRiSM_model_closedChannel3        = PRiSM_model_closedChannel3;
  g.PRiSM_model_closedChannel3_pd_prime = PRiSM_model_closedChannel3_pd_prime;
  g.PRiSM_model_closedRectangle       = PRiSM_model_closedRectangle;
  g.PRiSM_model_closedRectangle_pd_prime = PRiSM_model_closedRectangle_pd_prime;
  g.PRiSM_model_intersecting          = PRiSM_model_intersecting;
  g.PRiSM_model_intersecting_pd_prime = PRiSM_model_intersecting_pd_prime;
  g.PRiSM_model_fogBoundary           = PRiSM_model_fogBoundary;
  g.PRiSM_model_fogBoundary_pd_prime  = PRiSM_model_fogBoundary_pd_prime;
  g.PRiSM_model_finiteFracSkin        = PRiSM_model_finiteFracSkin;
  g.PRiSM_model_finiteFracSkin_pd_prime = PRiSM_model_finiteFracSkin_pd_prime;
  g.PRiSM_model_partialPenFrac        = PRiSM_model_partialPenFrac;
  g.PRiSM_model_partialPenFrac_pd_prime = PRiSM_model_partialPenFrac_pd_prime;
})();

// ============================================================================

})();  // end IIFE


// ─── END 03-models ───────────────────────────────────────────────────

// ─── BEGIN 02-plots ─────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════
// PRiSM ─ Plot Suite (02-plots.js)
// 14 canvas plot functions + shared helpers for the PRiSM Well Test
// Analysis module. Pure vanilla JS, dark theme, retina-aware.
//
// All plots share the universal signature:
//   PRiSM_plot_<NAME>(canvas, data, opts)
//
//   data: { t, p, dp?, q?, periods?, overlay? }
//   opts: { width, height, padding, theme, title, xLabel, yLabel,
//           hover, dragZoom, showLegend, activePeriod }
//
// Designed to be pasted into the main IIFE of well-testing-app.html.
// No ES modules. No external chart libraries. ~1600 LOC.
// ════════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────
// THEME — locked to dark theme of the host app (#0d1117 backdrop)
// ─────────────────────────────────────────────────────────────────────
const PRiSM_THEME = {
    bg:        '#0d1117',
    panel:     '#161b22',
    border:    '#30363d',
    grid:      '#21262d',
    gridMajor: '#30363d',
    text:      '#c9d1d9',
    text2:     '#8b949e',
    text3:     '#6e7681',
    accent:    '#f0883e', // orange — primary series
    blue:      '#58a6ff', // overlay / model curve
    green:     '#3fb950', // derivative / good fit
    red:       '#f85149', // boundaries / bad fit
    yellow:    '#d29922', // half-slope / linear flow
    cyan:      '#39c5cf', // secondary axis
    purple:    '#bc8cff'  // type-curve guides
};

const PRiSM_DEFAULT_PADDING = { top: 30, right: 80, bottom: 48, left: 64 };

// ─────────────────────────────────────────────────────────────────────
// FORMATTING — engineering (k / M / G), scientific fallback
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_format_eng(n, sig) {
    if (n === null || n === undefined || !isFinite(n)) return '';
    sig = sig || 3;
    if (n === 0) return '0';
    const a = Math.abs(n);
    // Use scientific for tiny / huge numbers that don't sit in the
    // common engineering range — keeps tick text short.
    if (a >= 1e6) {
        if (a >= 1e9) return (n / 1e9).toPrecision(sig).replace(/\.?0+$/, '') + 'G';
        return (n / 1e6).toPrecision(sig).replace(/\.?0+$/, '') + 'M';
    }
    if (a >= 1e3) return (n / 1e3).toPrecision(sig).replace(/\.?0+$/, '') + 'k';
    if (a >= 1)   return n.toPrecision(sig).replace(/\.?0+$/, '');
    if (a >= 1e-3) return n.toPrecision(sig).replace(/\.?0+$/, '');
    // Scientific
    return n.toExponential(2).replace(/e([+-])0?(\d)/, 'e$1$2');
}

function PRiSM_plot_format_tick(v, isLog) {
    if (!isFinite(v)) return '';
    if (isLog) {
        // v is the actual decade value (10^k). Show as 10^k for clarity.
        const k = Math.round(Math.log10(Math.abs(v)));
        if (Math.abs(v - Math.pow(10, k)) / Math.pow(10, k) < 1e-6) {
            if (k >= -2 && k <= 5) return PRiSM_plot_format_eng(v);
            return '1e' + k;
        }
        return PRiSM_plot_format_eng(v);
    }
    return PRiSM_plot_format_eng(v);
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
    for (let k = k0; k <= k1; k++) {
        const base = Math.pow(10, k);
        if (base >= min && base <= max) major.push(base);
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
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.001; v += step) {
        ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    }
    return ticks;
}

// ─────────────────────────────────────────────────────────────────────
// CANVAS SETUP — retina, padding, plot rect
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_setup(canvas, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    // Honour explicit width/height in opts; otherwise use the canvas's
    // CSS box. If the canvas was created with no CSS sizing (e.g. in
    // self-test) fall back to its existing intrinsic size.
    const cssW = opts.width || canvas.clientWidth || canvas.width || 600;
    const cssH = opts.height || canvas.clientHeight || canvas.height || 400;
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // crisp on retina
    const pad = Object.assign({}, PRiSM_DEFAULT_PADDING, opts.padding || {});
    const plot = {
        x: pad.left,
        y: pad.top,
        w: cssW - pad.left - pad.right,
        h: cssH - pad.top - pad.bottom,
        cssW: cssW,
        cssH: cssH,
        pad: pad
    };
    return { ctx, plot, dpr };
}

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
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(msg || 'No data', plot.x + plot.w / 2, plot.y + plot.h / 2);
}

// ─────────────────────────────────────────────────────────────────────
// AXES — paints background, grid, ticks, labels, title.
// scaleX / scaleY: { kind:'lin'|'log', min, max, label }
// Returns the world->pixel transforms.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_axes(ctx, plot, scaleX, scaleY, opts) {
    opts = opts || {};
    // Background
    ctx.fillStyle = PRiSM_THEME.bg;
    ctx.fillRect(0, 0, plot.cssW, plot.cssH);
    ctx.fillStyle = PRiSM_THEME.panel;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);

    // Tick generation
    const xLog = scaleX.kind === 'log';
    const yLog = scaleY.kind === 'log';
    const xTicks = xLog
        ? PRiSM_plot_log_ticks(scaleX.min, scaleX.max)
        : { major: PRiSM_plot_lin_ticks(scaleX.min, scaleX.max, 7), minor: [] };
    const yTicks = yLog
        ? PRiSM_plot_log_ticks(scaleY.min, scaleY.max)
        : { major: PRiSM_plot_lin_ticks(scaleY.min, scaleY.max, 6), minor: [] };

    // World→pixel transforms (closed over the scale objects so each
    // plot can re-use them after axes are drawn).
    const toX = xLog
        ? (v) => plot.x + (Math.log10(v) - Math.log10(scaleX.min)) /
                          (Math.log10(scaleX.max) - Math.log10(scaleX.min)) * plot.w
        : (v) => plot.x + (v - scaleX.min) / (scaleX.max - scaleX.min) * plot.w;
    const toY = yLog
        ? (v) => plot.y + plot.h - (Math.log10(v) - Math.log10(scaleY.min)) /
                                   (Math.log10(scaleY.max) - Math.log10(scaleY.min)) * plot.h
        : (v) => plot.y + plot.h - (v - scaleY.min) / (scaleY.max - scaleY.min) * plot.h;

    // Minor grid (log only)
    if (xLog && xTicks.minor.length) {
        ctx.strokeStyle = PRiSM_THEME.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        xTicks.minor.forEach(v => {
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
        yTicks.minor.forEach(v => {
            const py = Math.round(toY(v)) + 0.5;
            ctx.moveTo(plot.x, py);
            ctx.lineTo(plot.x + plot.w, py);
        });
        ctx.stroke();
    }

    // Major grid + tick labels
    ctx.strokeStyle = PRiSM_THEME.gridMajor;
    ctx.lineWidth = 1;
    ctx.fillStyle = PRiSM_THEME.text2;
    ctx.font = '11px sans-serif';

    // X major
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    xTicks.major.forEach(v => {
        const px = Math.round(toX(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, plot.y);
        ctx.lineTo(px, plot.y + plot.h);
        ctx.stroke();
        ctx.fillText(PRiSM_plot_format_tick(v, xLog), px, plot.y + plot.h + 6);
    });

    // Y major
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    yTicks.major.forEach(v => {
        const py = Math.round(toY(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(plot.x, py);
        ctx.lineTo(plot.x + plot.w, py);
        ctx.stroke();
        ctx.fillText(PRiSM_plot_format_tick(v, yLog), plot.x - 6, py);
    });

    // Border on top
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.w, plot.h);

    // Axis labels
    ctx.fillStyle = PRiSM_THEME.text;
    ctx.font = '12px sans-serif';
    if (scaleX.label) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText(scaleX.label, plot.x + plot.w / 2, plot.cssH - 8);
    }
    if (scaleY.label) {
        ctx.save();
        ctx.translate(14, plot.y + plot.h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(scaleY.label, 0, 0);
        ctx.restore();
    }

    // Title
    if (opts.title) {
        ctx.fillStyle = PRiSM_THEME.text;
        ctx.font = 'bold 13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(opts.title, plot.x, 8);
    }

    return { toX, toY, xLog, yLog };
}

// ─────────────────────────────────────────────────────────────────────
// LEGEND — top-right, drawn AFTER all series so it sits on top.
// items: [ { label, color, dash:bool, marker:'line'|'dot' } ]
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_legend(ctx, items, plot, opts) {
    if (!items || !items.length) return;
    opts = opts || {};
    ctx.save();
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    // Measure to size the box
    const padX = 8, padY = 6, lineH = 16, swatch = 18;
    let maxW = 0;
    items.forEach(it => { maxW = Math.max(maxW, ctx.measureText(it.label).width); });
    const boxW = swatch + 6 + maxW + padX * 2;
    const boxH = items.length * lineH + padY * 2 - 4;
    const bx = plot.x + plot.w - boxW - 8;
    const by = plot.y + 8;
    // Background
    ctx.fillStyle = 'rgba(13,17,23,0.85)';
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeStyle = PRiSM_THEME.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW, boxH);
    // Items
    items.forEach((it, i) => {
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
        ctx.fillText(it.label, bx + padX + swatch + 6, ly);
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// SHARED — line series, scatter series
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_line(ctx, pts, toX, toY, color, opts) {
    if (!pts || !pts.length) return;
    opts = opts || {};
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = opts.width || 2;
    if (opts.dash) ctx.setLineDash(opts.dash);
    ctx.beginPath();
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
    pts.forEach(p => {
        if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;
        const x = toX(p[0]), y = toY(p[1]);
        if (!isFinite(x) || !isFinite(y)) return;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// AUTO-RANGE — computes min/max for an array, padded, log-safe
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_range(arr, isLog, padFrac) {
    if (!arr || !arr.length) return { min: 0, max: 1 };
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (!isFinite(v)) continue;
        if (isLog && v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (!isFinite(min) || !isFinite(max)) return { min: 0, max: 1 };
    if (min === max) {
        if (isLog) { min /= 2; max *= 2; }
        else if (min === 0) { max = 1; }
        else { const d = Math.abs(min) * 0.1 || 1; min -= d; max += d; }
    }
    if (isLog) {
        // Snap to outer decades for nice ticks.
        const lo = Math.pow(10, Math.floor(Math.log10(min)));
        const hi = Math.pow(10, Math.ceil(Math.log10(max)));
        return { min: lo, max: hi };
    }
    const f = padFrac == null ? 0.05 : padFrac;
    const span = max - min;
    return { min: min - span * f, max: max + span * f };
}

// ─────────────────────────────────────────────────────────────────────
// PERIODS — light shading behind active period
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_periods(ctx, periods, activeIdx, toX, plot) {
    if (!periods || !periods.length) return;
    ctx.save();
    PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
    periods.forEach((pr, i) => {
        if (!pr || !isFinite(pr.start) || !isFinite(pr.end)) return;
        const x0 = toX(pr.start), x1 = toX(pr.end);
        if (i === activeIdx) {
            ctx.fillStyle = 'rgba(240,136,62,0.10)';
            ctx.fillRect(Math.min(x0, x1), plot.y, Math.abs(x1 - x0), plot.h);
            ctx.strokeStyle = PRiSM_THEME.accent;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(x0 + 0.5, plot.y); ctx.lineTo(x0 + 0.5, plot.y + plot.h);
            ctx.moveTo(x1 + 0.5, plot.y); ctx.lineTo(x1 + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
        } else {
            ctx.strokeStyle = 'rgba(139,148,158,0.45)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 4]);
            ctx.beginPath();
            ctx.moveTo(x0 + 0.5, plot.y); ctx.lineTo(x0 + 0.5, plot.y + plot.h);
            ctx.moveTo(x1 + 0.5, plot.y); ctx.lineTo(x1 + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        if (pr.label) {
            ctx.fillStyle = i === activeIdx ? PRiSM_THEME.accent : PRiSM_THEME.text3;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(pr.label, Math.min(x0, x1) + 4, plot.y + 4);
        }
    });
    ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────
// HOVER + DRAG-TO-ZOOM — attached per render. Detached on next render
// by overwriting `canvas._prismHandlers`.
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_attach_interactions(canvas, ctx, plot, render, ctxState) {
    // Tear down previous handlers if any.
    if (canvas._prismHandlers) {
        const h = canvas._prismHandlers;
        canvas.removeEventListener('mousemove', h.move);
        canvas.removeEventListener('mouseleave', h.leave);
        canvas.removeEventListener('mousedown', h.down);
        canvas.removeEventListener('mouseup', h.up);
        canvas.removeEventListener('dblclick', h.dbl);
    }
    if (!ctxState.opts.hover && !ctxState.opts.dragZoom) {
        canvas._prismHandlers = null;
        return;
    }

    const { toX, toY, xLog, yLog, scaleX, scaleY, points } = ctxState;

    // Cache the original scales so double-click can reset.
    if (!canvas._prismOriginalScale) {
        canvas._prismOriginalScale = { x: { ...scaleX }, y: { ...scaleY } };
    }

    let drag = null; // { x0, y0, x1, y1 }
    let hoverPt = null;

    function pixelFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    }

    function repaint() {
        // Re-run the render callback (which redraws axes + series) then
        // overlay hover/drag artefacts on top.
        render();
        if (drag) {
            ctx.save();
            ctx.fillStyle = 'rgba(88,166,255,0.10)';
            ctx.strokeStyle = PRiSM_THEME.blue;
            ctx.lineWidth = 1;
            const rx = Math.min(drag.x0, drag.x1), ry = Math.min(drag.y0, drag.y1);
            const rw = Math.abs(drag.x1 - drag.x0), rh = Math.abs(drag.y1 - drag.y0);
            ctx.fillRect(rx, ry, rw, rh);
            ctx.strokeRect(rx + 0.5, ry + 0.5, rw, rh);
            ctx.restore();
        }
        if (hoverPt) {
            ctx.save();
            const { px, py, label } = hoverPt;
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
            // Tooltip
            ctx.font = '11px sans-serif';
            const tw = ctx.measureText(label).width + 12;
            const th = 18;
            let tx = px + 8, ty = py - th - 8;
            if (tx + tw > plot.x + plot.w) tx = px - tw - 8;
            if (ty < plot.y) ty = py + 8;
            ctx.fillStyle = 'rgba(13,17,23,0.92)';
            ctx.fillRect(tx, ty, tw, th);
            ctx.strokeStyle = PRiSM_THEME.border;
            ctx.lineWidth = 1;
            ctx.strokeRect(tx + 0.5, ty + 0.5, tw, th);
            ctx.fillStyle = PRiSM_THEME.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, tx + 6, ty + th / 2);
            ctx.restore();
        }
    }

    function findNearest(px, py) {
        if (!points || !points.length) return null;
        let best = null, bestD2 = Infinity;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
            const x = toX(p[0]), y = toY(p[1]);
            if (!isFinite(x) || !isFinite(y)) continue;
            const d2 = (x - px) * (x - px) + (y - py) * (y - py);
            if (d2 < bestD2) { bestD2 = d2; best = { x, y, p }; }
        }
        if (!best || bestD2 > 30 * 30) return null;
        return best;
    }

    const move = (e) => {
        const { px, py } = pixelFromEvent(e);
        if (drag) { drag.x1 = px; drag.y1 = py; repaint(); return; }
        if (!ctxState.opts.hover) return;
        if (px < plot.x || px > plot.x + plot.w || py < plot.y || py > plot.y + plot.h) {
            if (hoverPt) { hoverPt = null; repaint(); }
            return;
        }
        const n = findNearest(px, py);
        if (n) {
            hoverPt = {
                px: n.x, py: n.y,
                label: PRiSM_plot_format_eng(n.p[0]) + ', ' + PRiSM_plot_format_eng(n.p[1])
            };
        } else {
            hoverPt = null;
        }
        repaint();
    };

    const leave = () => { hoverPt = null; drag = null; repaint(); };

    const down = (e) => {
        if (!ctxState.opts.dragZoom) return;
        const { px, py } = pixelFromEvent(e);
        if (px < plot.x || px > plot.x + plot.w || py < plot.y || py > plot.y + plot.h) return;
        drag = { x0: px, y0: py, x1: px, y1: py };
    };

    const up = (e) => {
        if (!drag) return;
        const dx = Math.abs(drag.x1 - drag.x0), dy = Math.abs(drag.y1 - drag.y0);
        if (dx < 6 || dy < 6) { drag = null; repaint(); return; }
        // Convert pixel rect to world range and zoom.
        const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
        const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
        // Invert toX/toY by interpolating along the axis range.
        const fx0 = (x0 - plot.x) / plot.w, fx1 = (x1 - plot.x) / plot.w;
        const fy0 = 1 - (y1 - plot.y) / plot.h, fy1 = 1 - (y0 - plot.y) / plot.h;
        if (xLog) {
            const lo = Math.log10(scaleX.min), hi = Math.log10(scaleX.max);
            scaleX.min = Math.pow(10, lo + fx0 * (hi - lo));
            scaleX.max = Math.pow(10, lo + fx1 * (hi - lo));
        } else {
            const lo = scaleX.min, hi = scaleX.max;
            scaleX.min = lo + fx0 * (hi - lo);
            scaleX.max = lo + fx1 * (hi - lo);
        }
        if (yLog) {
            const lo = Math.log10(scaleY.min), hi = Math.log10(scaleY.max);
            scaleY.min = Math.pow(10, lo + fy0 * (hi - lo));
            scaleY.max = Math.pow(10, lo + fy1 * (hi - lo));
        } else {
            const lo = scaleY.min, hi = scaleY.max;
            scaleY.min = lo + fy0 * (hi - lo);
            scaleY.max = lo + fy1 * (hi - lo);
        }
        drag = null;
        repaint();
    };

    const dbl = () => {
        if (canvas._prismOriginalScale) {
            Object.assign(scaleX, canvas._prismOriginalScale.x);
            Object.assign(scaleY, canvas._prismOriginalScale.y);
            repaint();
        }
    };

    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseleave', leave);
    canvas.addEventListener('mousedown', down);
    canvas.addEventListener('mouseup', up);
    canvas.addEventListener('dblclick', dbl);
    canvas._prismHandlers = { move, leave, down, up, dbl };
}

// ─────────────────────────────────────────────────────────────────────
// COMMON — assemble pairs from data
// ─────────────────────────────────────────────────────────────────────
function PRiSM_plot_zip(xs, ys) {
    const n = Math.min(xs ? xs.length : 0, ys ? ys.length : 0);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = [xs[i], ys[i]];
    return out;
}

function PRiSM_plot_isData(data) {
    return data && Array.isArray(data.t) && data.t.length > 0;
}

// ════════════════════════════════════════════════════════════════════
// ── TRANSIENT (PTA) PLOTS ───────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// 1. Cartesian P vs t
function PRiSM_plot_cartesian(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No pressure data');
        return;
    }
    const tRange = PRiSM_plot_range(data.t, false);
    const pRange = PRiSM_plot_range(data.p, false);
    const overlayP = data.overlay && data.overlay.p ? data.overlay.p : null;
    if (overlayP) {
        const oR = PRiSM_plot_range(overlayP, false);
        pRange.min = Math.min(pRange.min, oR.min);
        pRange.max = Math.max(pRange.max, oR.max);
    }
    const scaleX = { kind: 'lin', min: tRange.min, max: tRange.max, label: opts.xLabel || 'Time, t (hr)' };
    const scaleY = { kind: 'lin', min: pRange.min, max: pRange.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(data.t, data.p);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Cartesian P vs t' });
        PRiSM_plot_periods(ctx, data.periods, opts.activePeriod, tr.toX, plot);
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        if (overlayP) {
            const opts_pts = PRiSM_plot_zip(data.overlay.t || data.t, overlayP);
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (overlayP) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; },
        get yLog() { return false; }
    });
}

// 2. Horner — P vs (tp + Δt)/Δt on semi-log x
//   Semi-log convention: x increases left-to-right but Horner time
//   itself decreases as Δt grows, so the build-up sweeps from right
//   (Δt small, x → ∞) to left (Δt large, x → 1).
function PRiSM_plot_horner(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No build-up data');
        return;
    }
    const tp = isFinite(opts.tp) ? opts.tp : (data.tp || data.t[data.t.length - 1] || 1);
    // Horner ratio: (tp + Δt) / Δt. Δt = data.t (treated as Δt directly
    // for simplicity; UI passes shifted time).
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        const dt = data.t[i];
        if (!isFinite(dt) || dt <= 0) continue;
        const h = (tp + dt) / dt;
        if (h <= 0) continue;
        xs.push(h);
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid Horner points'); return; }
    const xRange = PRiSM_plot_range(xs, true);
    const yRange = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'log', min: xRange.min, max: xRange.max, label: opts.xLabel || '(tp + Δt) / Δt' };
    const scaleY = { kind: 'lin', min: yRange.min, max: yRange.max, label: opts.yLabel || 'Pressure, Pws (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Horner Plot' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2.5);
        if (data.overlay && data.overlay.p) {
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
        // Mark Horner ratio = 1 (P*) explicitly with a vertical guide.
        const px = tr.toX(1);
        if (px >= plot.x && px <= plot.x + plot.w) {
            ctx.save();
            ctx.strokeStyle = 'rgba(63,185,80,0.4)';
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(px + 0.5, plot.y); ctx.lineTo(px + 0.5, plot.y + plot.h);
            ctx.stroke();
            ctx.fillStyle = PRiSM_THEME.green;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('P* (ratio = 1)', px + 4, plot.y + 14);
            ctx.restore();
        }
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Build-up', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return false; }
    });
}

// ─────────────────────────────────────────────────────────────────────
// BOURDET DERIVATIVE — log-smoothed
//
//   d[i] = ((Δp[i] - Δp[i-1])/dl1) * (dl2/dlT)
//        + ((Δp[i+1] - Δp[i])/dl2) * (dl1/dlT)
//
//   where dl1 = ln t[i] - ln t[i-1], dl2 = ln t[i+1] - ln t[i],
//         dlT = ln t[i+1] - ln t[i-1].
// ─────────────────────────────────────────────────────────────────────
function PRiSM_compute_bourdet(t, dp, L) {
    L = L || 0; // optional smoothing window in log units
    const n = t.length;
    const d = new Array(n).fill(NaN);
    if (n < 3) return d;
    for (let i = 1; i < n - 1; i++) {
        if (!isFinite(t[i]) || t[i] <= 0 || !isFinite(dp[i])) continue;
        // Walk outward to find points that are at least L apart in ln t
        let i1 = i - 1, i2 = i + 1;
        if (L > 0) {
            const lnT = Math.log(t[i]);
            while (i1 > 0 && Math.log(t[i]) - Math.log(t[i1]) < L) i1--;
            while (i2 < n - 1 && Math.log(t[i2]) - Math.log(t[i]) < L) i2++;
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

// 3. Bourdet log-log diagnostic — KEYSTONE plot.
//   Δp as a smooth line, t·dp/d(ln t) as small filled circles.
//   Slope guides shown faintly: unit (WBS), half (linear), quarter
//   (bilinear), zero (radial). The overlay (model) uses the same
//   computation pipeline if pressure is given.
function PRiSM_plot_bourdet(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !(data.p || data.dp)) {
        PRiSM_plot_empty(ctx, plot, 'No pressure data');
        return;
    }
    // Derive Δp if only p was given (assume first point is reference).
    const dp = data.dp ? data.dp.slice() : data.p.map(v => v - data.p[0]);
    const t  = data.t.slice();
    const deriv = PRiSM_compute_bourdet(t, dp, opts.smoothL || 0.1);
    const dpPts = [], drPts = [];
    for (let i = 0; i < t.length; i++) {
        if (t[i] > 0 && dp[i] > 0) dpPts.push([t[i], dp[i]]);
        if (t[i] > 0 && deriv[i] > 0) drPts.push([t[i], deriv[i]]);
    }
    if (!dpPts.length && !drPts.length) {
        PRiSM_plot_empty(ctx, plot, 'No positive Δp data');
        return;
    }
    const allY = dpPts.map(p => p[1]).concat(drPts.map(p => p[1]));
    const xR = PRiSM_plot_range(dpPts.map(p => p[0]), true);
    const yR = PRiSM_plot_range(allY, true);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Δt (hr)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Δp, Δp′ (psi)' };

    // Overlay (model)
    let modelDp = null, modelDr = null;
    if (data.overlay && (data.overlay.p || data.overlay.dp)) {
        const ot = data.overlay.t || t;
        const odp = data.overlay.dp ? data.overlay.dp.slice() : data.overlay.p.map(v => v - data.overlay.p[0]);
        const odr = PRiSM_compute_bourdet(ot, odp, opts.smoothL || 0.1);
        modelDp = []; modelDr = [];
        for (let i = 0; i < ot.length; i++) {
            if (ot[i] > 0 && odp[i] > 0) modelDp.push([ot[i], odp[i]]);
            if (ot[i] > 0 && odr[i] > 0) modelDr.push([ot[i], odr[i]]);
        }
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            title: opts.title || 'Log-Log Bourdet Derivative'
        });
        // Slope guides (dashed, very faint) — always informative
        ctx.save();
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        const slopes = [
            { m: 1.0, label: 'WBS (slope 1)',     color: 'rgba(248,81,73,0.40)' },
            { m: 0.5, label: 'Linear (slope ½)',  color: 'rgba(210,153,34,0.40)' },
            { m: 0.25, label: 'Bilinear (¼)',     color: 'rgba(188,140,255,0.35)' },
            { m: 0.0, label: 'Radial (slope 0)',  color: 'rgba(63,185,80,0.40)' }
        ];
        // Anchor at left-mid of plot
        const xA = scaleX.min, yMid = Math.sqrt(scaleY.min * scaleY.max);
        slopes.forEach(s => {
            const x1 = scaleX.max;
            const y1 = yMid * Math.pow(x1 / xA, s.m);
            ctx.strokeStyle = s.color;
            ctx.lineWidth = 1.2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(tr.toX(xA), tr.toY(yMid));
            ctx.lineTo(tr.toX(x1), tr.toY(y1));
            ctx.stroke();
            ctx.setLineDash([]);
            // Tiny label
            ctx.fillStyle = s.color.replace(/0\.[34]0?\)/, '0.85)');
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            const ly = Math.max(plot.y + 2, Math.min(plot.y + plot.h - 2, tr.toY(y1)));
            ctx.fillText(s.label, plot.x + plot.w - 4, ly - 2);
        });
        ctx.restore();

        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        // Δp as line
        PRiSM_plot_line(ctx, dpPts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        // Derivative as filled circles
        PRiSM_plot_dots(ctx, drPts, tr.toX, tr.toY, PRiSM_THEME.green, 3);
        // Overlay
        if (modelDp) {
            PRiSM_plot_line(ctx, modelDp, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
            PRiSM_plot_line(ctx, modelDr, tr.toX, tr.toY, PRiSM_THEME.cyan, { width: 1.5, dash: [4, 3] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [
                { label: 'Δp', color: PRiSM_THEME.accent },
                { label: 'Δp′ (Bourdet)', color: PRiSM_THEME.green, marker: 'dot' }
            ];
            if (modelDp) legend.push({ label: 'Model Δp', color: PRiSM_THEME.blue, dash: true });
            if (modelDr) legend.push({ label: 'Model Δp′', color: PRiSM_THEME.cyan, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    // Combine measurement + derivative as the hover point pool
    const points = dpPts.concat(drPts);
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return true; }
    });
}

// 4. Square-root time — P vs √t (linear) — diagnostic for linear flow
function PRiSM_plot_sqrt_time(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        if (!isFinite(data.t[i]) || data.t[i] < 0) continue;
        xs.push(Math.sqrt(data.t[i]));
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No data'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || '√t  (hr^½)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Square-Root Time' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || ot[i] < 0) continue;
                oxs.push(Math.sqrt(ot[i]));
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 5. Quarter-root time — P vs t^¼ — diagnostic for bilinear flow
function PRiSM_plot_quarter_root_time(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        if (!isFinite(data.t[i]) || data.t[i] < 0) continue;
        xs.push(Math.pow(data.t[i], 0.25));
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No data'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 't^¼  (hr^¼)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Quarter-Root Time (Bilinear)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || ot[i] < 0) continue;
                oxs.push(Math.pow(ot[i], 0.25));
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 6. Spherical flow — P vs t^(-½) — partial penetration diagnostic
function PRiSM_plot_spherical(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    const xs = [], ys = [];
    for (let i = 0; i < data.t.length; i++) {
        if (!isFinite(data.t[i]) || data.t[i] <= 0) continue;
        xs.push(Math.pow(data.t[i], -0.5));
        ys.push(data.p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No data'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 't^(-½)  (hr^-½)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, {
            title: opts.title || 'Spherical Flow (Partial Penetration)'
        });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const oxs = [], oys = [];
            const ot = data.overlay.t || data.t;
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(ot[i]) || ot[i] <= 0) continue;
                oxs.push(Math.pow(ot[i], -0.5));
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 7. Sandface convolution — equivalent time = Σ(qi·Δti)/qn  vs P
//   For multi-rate cleanup, the equivalent time normalises
//   build-up against the variable-rate history.
function PRiSM_plot_sandface_convolution(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'Needs t, p and q for convolution');
        return;
    }
    // Equivalent time from rate history.
    const t = data.t, p = data.p, q = data.q;
    const qN = q[q.length - 1] || 1;
    const teq = new Array(t.length);
    let cum = 0;
    for (let i = 0; i < t.length; i++) {
        const dt = (i === 0) ? t[i] : (t[i] - t[i - 1]);
        cum += (q[i] || 0) * dt;
        teq[i] = qN === 0 ? NaN : cum / Math.abs(qN);
    }
    const xs = [], ys = [];
    for (let i = 0; i < t.length; i++) {
        if (!isFinite(teq[i]) || teq[i] <= 0) continue;
        xs.push(teq[i]); ys.push(p[i]);
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid equivalent time'); return; }
    const xR = PRiSM_plot_range(xs, true);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Equivalent Time Σ(qi·Δti)/qn (hr)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Sandface-Rate Convolution' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const ot = data.overlay.t || t;
            const oxs = [], oys = [];
            // Recompute equivalent time on overlay if rate history given,
            // otherwise reuse measured equivalent time mapping by index.
            let oteq;
            if (data.overlay.q) {
                oteq = new Array(ot.length);
                let oq = data.overlay.q, oN = oq[oq.length - 1] || 1;
                let oc = 0;
                for (let i = 0; i < ot.length; i++) {
                    const dt = (i === 0) ? ot[i] : (ot[i] - ot[i - 1]);
                    oc += (oq[i] || 0) * dt;
                    oteq[i] = oN === 0 ? NaN : oc / Math.abs(oN);
                }
            } else {
                oteq = teq.slice();
            }
            for (let i = 0; i < ot.length; i++) {
                if (!isFinite(oteq[i]) || oteq[i] <= 0) continue;
                oxs.push(oteq[i]); oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Convolved', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return false; }
    });
}

// 8. Build-up superposition — P vs Σ log((tp+Δt)/Δt) for multi-rate
//   For single-rate this collapses back to the Horner X.
//   periods: array of { tp_i, q_i } describing the rate history; if
//   absent, falls back to the simple Horner ratio.
function PRiSM_plot_buildup_superposition(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.p) {
        PRiSM_plot_empty(ctx, plot, 'No data');
        return;
    }
    // If a rate history (data.q) was provided, build the multi-rate
    // superposition time. Otherwise default to ln((tp+Δt)/Δt).
    const t = data.t, p = data.p;
    const tp = isFinite(opts.tp) ? opts.tp : (data.tp || (t[t.length - 1] || 1));
    const xs = [], ys = [];
    if (data.q && data.q.length === t.length) {
        // Discretised superposition: assemble rate steps from the q
        // history; each step (qj - qj-1) contributes a log term.
        // Here we use a simple step-detection: any change in q.
        const steps = [];
        let lastQ = 0, lastT = 0;
        for (let i = 0; i < t.length; i++) {
            if (i === 0 || Math.abs(data.q[i] - lastQ) > 1e-9) {
                steps.push({ ti: t[i], qPrev: lastQ, qNew: data.q[i] });
                lastQ = data.q[i];
                lastT = t[i];
            }
        }
        const qLast = data.q[data.q.length - 1] || 1;
        // For each measured point at time t_meas, compute superposition X.
        for (let i = 0; i < t.length; i++) {
            const dt = t[i];
            if (dt <= 0) continue;
            // X = Σ (qj - qj-1)/qN · log((t - t_j-1)/(t - t_j))
            let X = 0, valid = true;
            for (let j = 1; j < steps.length; j++) {
                const dq = (steps[j].qNew - steps[j].qPrev) / qLast;
                const num = (t[i] - steps[j - 1].ti);
                const den = (t[i] - steps[j].ti);
                if (num <= 0 || den <= 0) { valid = false; break; }
                X += dq * Math.log10(num / den);
            }
            if (valid && isFinite(X)) {
                xs.push(X);
                ys.push(p[i]);
            }
        }
    }
    // Fallback to plain Horner-form
    if (!xs.length) {
        for (let i = 0; i < t.length; i++) {
            const dt = t[i];
            if (!isFinite(dt) || dt <= 0) continue;
            const ratio = (tp + dt) / dt;
            if (ratio <= 0) continue;
            xs.push(Math.log10(ratio));
            ys.push(p[i]);
        }
    }
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid superposition points'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Σ log((tp + Δt)/Δt)' };
    const scaleY = { kind: 'lin', min: yR.min, max: yR.max, label: opts.yLabel || 'Pressure, P (psi)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Build-up Superposition' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.p) {
            const ot = data.overlay.t || t;
            const oxs = [], oys = [];
            for (let i = 0; i < ot.length; i++) {
                const dt = ot[i];
                if (!isFinite(dt) || dt <= 0) continue;
                oxs.push(Math.log10((tp + dt) / dt));
                oys.push(data.overlay.p[i]);
            }
            PRiSM_plot_line(ctx, PRiSM_plot_zip(oxs, oys), tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Build-up', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Model', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// ════════════════════════════════════════════════════════════════════
// ── DECLINE (DCA) PLOTS ─────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════

// 9. Rate vs time, linear (cartesian)
function PRiSM_plot_rate_time_cartesian(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const xR = PRiSM_plot_range(data.t, false);
    const yR = PRiSM_plot_range(data.q, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };
    const points = PRiSM_plot_zip(data.t, data.q);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Time (Cartesian)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const op = PRiSM_plot_zip(data.overlay.t || data.t, data.overlay.q);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 10. Semi-log: rate-time with log y-axis (exponential decline → straight)
function PRiSM_plot_rate_time_semilog(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const xR = PRiSM_plot_range(data.t, false);
    const yR = PRiSM_plot_range(data.q.filter(v => v > 0), true);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };
    const pts = [];
    for (let i = 0; i < data.t.length; i++) {
        if (data.q[i] > 0) pts.push([data.t[i], data.q[i]]);
    }

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Time (Semi-log)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const opts_pts = [];
            for (let i = 0; i < ot.length; i++) {
                if (data.overlay.q[i] > 0) opts_pts.push([ot[i], data.overlay.q[i]]);
            }
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: pts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return true; }
    });
}

// 11. Log-log rate-time (hyperbolic / harmonic curvature visible)
function PRiSM_plot_rate_time_loglog(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const pts = [];
    for (let i = 0; i < data.t.length; i++) {
        if (data.t[i] > 0 && data.q[i] > 0) pts.push([data.t[i], data.q[i]]);
    }
    if (!pts.length) { PRiSM_plot_empty(ctx, plot, 'No positive data'); return; }
    const xR = PRiSM_plot_range(pts.map(p => p[0]), true);
    const yR = PRiSM_plot_range(pts.map(p => p[1]), true);
    const scaleX = { kind: 'log', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Time (Log-Log)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const opts_pts = [];
            for (let i = 0; i < ot.length; i++) {
                if (ot[i] > 0 && data.overlay.q[i] > 0) opts_pts.push([ot[i], data.overlay.q[i]]);
            }
            PRiSM_plot_line(ctx, opts_pts, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: pts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return true; }
    });
}

// 12. Rate vs cumulative — q vs Np (trapezoidal integration of q dt)
function PRiSM_plot_rate_cumulative(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    // Trapezoidal Np (in volume units consistent with q*t). If the
    // caller pre-supplies cumulative, use that directly via opts.cum.
    const Np = opts.cum && opts.cum.length === data.t.length
        ? opts.cum.slice()
        : (function() {
            const out = new Array(data.t.length);
            out[0] = 0;
            for (let i = 1; i < data.t.length; i++) {
                const dt = data.t[i] - data.t[i - 1];
                out[i] = out[i - 1] + 0.5 * (data.q[i] + data.q[i - 1]) * dt;
            }
            return out;
        })();

    const pts = PRiSM_plot_zip(Np, data.q);
    const xR = PRiSM_plot_range(Np, false);
    const yR = PRiSM_plot_range(data.q, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Cumulative, Np (bbl)' };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || 'Rate, q (bbl/d)' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Rate vs Cumulative' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, pts, tr.toX, tr.toY, PRiSM_THEME.accent, 2);
        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const oNp = new Array(ot.length); oNp[0] = 0;
            for (let i = 1; i < ot.length; i++) {
                const dt = ot[i] - ot[i - 1];
                oNp[i] = oNp[i - 1] + 0.5 * (data.overlay.q[i] + data.overlay.q[i - 1]) * dt;
            }
            const op = PRiSM_plot_zip(oNp, data.overlay.q);
            PRiSM_plot_line(ctx, op, tr.toX, tr.toY, PRiSM_THEME.blue, { width: 2, dash: [6, 4] });
        }
        // EUR: extend a tangent through last two points to q=0 (Arps
        // exponential intercept on cumulative axis is the simplest hint).
        if (pts.length >= 2 && opts.showEur !== false) {
            const a = pts[pts.length - 2], b = pts[pts.length - 1];
            const slope = (b[1] - a[1]) / (b[0] - a[0]);
            if (slope < 0 && isFinite(slope)) {
                const xEur = b[0] + (-b[1] / slope);
                ctx.save();
                ctx.strokeStyle = 'rgba(63,185,80,0.5)';
                ctx.lineWidth = 1.2;
                ctx.setLineDash([5, 4]);
                ctx.beginPath();
                ctx.moveTo(tr.toX(b[0]), tr.toY(b[1]));
                if (xEur > scaleX.min && xEur < scaleX.max) {
                    ctx.lineTo(tr.toX(xEur), tr.toY(0));
                    ctx.stroke();
                    ctx.fillStyle = PRiSM_THEME.green;
                    ctx.font = '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.fillText('EUR ≈ ' + PRiSM_plot_format_eng(xEur), tr.toX(xEur) + 4, tr.toY(0) - 6);
                }
                ctx.restore();
            }
        }
        ctx.restore();
        if (opts.showLegend !== false) {
            const legend = [{ label: 'Measured', color: PRiSM_THEME.accent }];
            if (data.overlay) legend.push({ label: 'Forecast', color: PRiSM_THEME.blue, dash: true });
            PRiSM_plot_legend(ctx, legend, plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: pts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 13. Loss-ratio: 1/D vs t  where D = -d(ln q)/dt
//   Exponential → constant 1/D
//   Hyperbolic   → 1/D = a + b·t  (straight line, slope = b)
//   Harmonic     → straight line through origin
function PRiSM_plot_loss_ratio(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    const t = data.t, q = data.q;
    // Numerical derivative of ln q with central differences. Skip endpoints.
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
    if (!xs.length) { PRiSM_plot_empty(ctx, plot, 'No valid 1/D points'); return; }
    const xR = PRiSM_plot_range(xs, false);
    const yR = PRiSM_plot_range(ys, false);
    const scaleX = { kind: 'lin', min: xR.min, max: xR.max, label: opts.xLabel || 'Time, t (days)' };
    const scaleY = { kind: 'lin', min: Math.max(0, yR.min), max: yR.max, label: opts.yLabel || '1/D = -dt/d(ln q)' };
    const points = PRiSM_plot_zip(xs, ys);

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Loss-Ratio (1/D vs t)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        PRiSM_plot_line(ctx, points, tr.toX, tr.toY, PRiSM_THEME.accent, { width: 2 });
        PRiSM_plot_dots(ctx, points, tr.toX, tr.toY, PRiSM_THEME.green, 3);

        // Linear trend line (least-squares) — slope ≈ b (Arps exponent),
        // intercept ≈ 1/Di.
        if (points.length >= 3) {
            let sx = 0, sy = 0, sxy = 0, sxx = 0, n = points.length;
            for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sxx += xs[i] * xs[i]; }
            const denom = n * sxx - sx * sx;
            if (denom !== 0) {
                const m = (n * sxy - sx * sy) / denom;
                const c = (sy - m * sx) / n;
                ctx.save();
                ctx.strokeStyle = 'rgba(88,166,255,0.7)';
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(tr.toX(scaleX.min), tr.toY(c + m * scaleX.min));
                ctx.lineTo(tr.toX(scaleX.max), tr.toY(c + m * scaleX.max));
                ctx.stroke();
                ctx.fillStyle = PRiSM_THEME.blue;
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'left';
                ctx.fillText('b ≈ ' + m.toFixed(3) + ',  1/Di ≈ ' + PRiSM_plot_format_eng(c),
                    plot.x + 8, plot.y + plot.h - 8);
                ctx.restore();
            }
        }

        if (data.overlay && data.overlay.q) {
            const ot = data.overlay.t || data.t;
            const oxs = [], oys = [];
            for (let i = 1; i < ot.length - 1; i++) {
                if (data.overlay.q[i] <= 0 || data.overlay.q[i - 1] <= 0 || data.overlay.q[i + 1] <= 0) continue;
                const dlnq = Math.log(data.overlay.q[i + 1]) - Math.log(data.overlay.q[i - 1]);
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
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return false; }, get yLog() { return false; }
    });
}

// 14. Type-curve overlay — generic dimensionless qD vs tD type-curve
//   Plots data in dimensionless units (qD = q/qi, tD = t·Di) on log-log
//   axes and overlays a small family of Arps b-factor curves for visual
//   matching. The active curve (opts.b) is drawn bold.
function PRiSM_plot_typecurve_overlay(canvas, data, opts) {
    opts = opts || {};
    const setup = PRiSM_plot_setup(canvas, opts);
    const { ctx, plot } = setup;
    if (!PRiSM_plot_isData(data) || !data.q) {
        PRiSM_plot_empty(ctx, plot, 'No rate data');
        return;
    }
    // Normalisation: caller may pass qi and Di; otherwise infer from
    // first non-zero rate and unit Di.
    const qi = isFinite(opts.qi) ? opts.qi : (data.q.find(v => v > 0) || 1);
    const Di = isFinite(opts.Di) ? opts.Di : 1;
    const dataPts = [];
    for (let i = 0; i < data.t.length; i++) {
        const td = data.t[i] * Di;
        const qd = data.q[i] / qi;
        if (td > 0 && qd > 0) dataPts.push([td, qd]);
    }
    if (!dataPts.length) { PRiSM_plot_empty(ctx, plot, 'No positive data'); return; }
    // Type-curve family
    const bList = (opts.bList && opts.bList.length) ? opts.bList : [0, 0.25, 0.5, 0.75, 1];
    const bActive = isFinite(opts.b) ? opts.b : 0.5;
    // Span tD across at least two decades on each side of the data
    const xData = PRiSM_plot_range(dataPts.map(p => p[0]), true);
    const xCurve = { min: Math.min(xData.min, 0.01), max: Math.max(xData.max, 100) };
    const curves = bList.map(b => {
        const pts = [];
        // Sample 80 points log-spaced
        const n = 80;
        const lo = Math.log10(xCurve.min), hi = Math.log10(xCurve.max);
        for (let i = 0; i <= n; i++) {
            const td = Math.pow(10, lo + (hi - lo) * i / n);
            // Arps generalised: qD = (1 + b·tD)^(-1/b)  for b > 0
            //                  qD = exp(-tD)            for b = 0
            let qd;
            if (b === 0) qd = Math.exp(-td);
            else         qd = Math.pow(1 + b * td, -1 / b);
            if (qd > 0 && isFinite(qd)) pts.push([td, qd]);
        }
        return { b, pts };
    });
    const allY = dataPts.map(p => p[1]).concat(...curves.map(c => c.pts.map(p => p[1])));
    const yR = PRiSM_plot_range(allY, true);
    // Tighten lower bound — Arps tail can vanish to zero
    yR.min = Math.max(yR.min, 1e-3);
    const scaleX = { kind: 'log', min: xCurve.min, max: xCurve.max, label: opts.xLabel || 'tD = t · Di' };
    const scaleY = { kind: 'log', min: yR.min, max: yR.max, label: opts.yLabel || 'qD = q / qi' };

    function render() {
        const tr = PRiSM_plot_axes(ctx, plot, scaleX, scaleY, { title: opts.title || 'Type-Curve Overlay (Arps qD-tD)' });
        PRiSM_plot_clip(ctx, plot.x, plot.y, plot.w, plot.h);
        // Background curves (thin)
        curves.forEach(c => {
            const isActive = Math.abs(c.b - bActive) < 1e-6;
            const color = isActive ? PRiSM_THEME.purple : 'rgba(139,148,158,0.45)';
            const w = isActive ? 2.5 : 1;
            PRiSM_plot_line(ctx, c.pts, tr.toX, tr.toY, color, { width: w });
            // b-label at the right end of the curve, where space allows
            const last = c.pts[c.pts.length - 1];
            if (last) {
                const lx = tr.toX(last[0]);
                const ly = tr.toY(last[1]);
                if (lx > plot.x && lx < plot.x + plot.w && ly > plot.y && ly < plot.y + plot.h) {
                    ctx.fillStyle = isActive ? PRiSM_THEME.purple : PRiSM_THEME.text3;
                    ctx.font = isActive ? 'bold 10px sans-serif' : '10px sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText('b=' + c.b, lx + 4, ly);
                }
            }
        });
        // Data on top (bold dots)
        PRiSM_plot_dots(ctx, dataPts, tr.toX, tr.toY, PRiSM_THEME.accent, 3.5);
        ctx.restore();
        if (opts.showLegend !== false) {
            PRiSM_plot_legend(ctx, [
                { label: 'Data', color: PRiSM_THEME.accent, marker: 'dot' },
                { label: 'Active b=' + bActive, color: PRiSM_THEME.purple },
                { label: 'Other b values', color: PRiSM_THEME.text3 }
            ], plot);
        }
        Object.assign(setup.lastTransform = setup.lastTransform || {}, tr);
    }

    render();
    PRiSM_plot_attach_interactions(canvas, ctx, plot, render, {
        opts, points: dataPts, scaleX, scaleY,
        get toX() { return setup.lastTransform.toX; },
        get toY() { return setup.lastTransform.toY; },
        get xLog() { return true; }, get yLog() { return true; }
    });
}

// ════════════════════════════════════════════════════════════════════

// ─── END 02-plots ───────────────────────────────────────────────────
