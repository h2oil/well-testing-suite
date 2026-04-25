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

// === SELF-TEST ===
(function PRiSM_selfTest() {
    const log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function(){};
    const err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function(){};
    const results = [];
    // 1. Stehfest on F̂(s) = 1/s should give f(t) = 1 for any t.
    const t1 = PRiSM_stehfest(s => 1 / s, 1.0, 12);
    results.push({ name: 'Stehfest 1/s -> 1', ok: Math.abs(t1 - 1) < 1e-6, val: t1 });
    // 2. Stehfest on F̂(s) = 1/s² should give f(t) = t.
    const t2 = PRiSM_stehfest(s => 1 / (s * s), 2.5, 12);
    results.push({ name: 'Stehfest 1/s^2 -> t', ok: Math.abs(t2 - 2.5) < 1e-5, val: t2 });
    // 3. Bessel K0(1) ≈ 0.4210244382. K1(1) ≈ 0.6019072302.
    results.push({ name: 'K0(1) ≈ 0.4210', ok: Math.abs(PRiSM_besselK0(1) - 0.4210244382) < 1e-5, val: PRiSM_besselK0(1) });
    results.push({ name: 'K1(1) ≈ 0.6019', ok: Math.abs(PRiSM_besselK1(1) - 0.6019072302) < 1e-5, val: PRiSM_besselK1(1) });
    // 4. Homogeneous-reservoir model returns finite, monotone-increasing pwd.
    const pwd = PRiSM_model_homogeneous([0.1, 1, 10], { Cd: 100, S: 0 });
    const monotone = pwd.every((v, i) => isFinite(v) && (i === 0 || v >= pwd[i - 1]));
    results.push({ name: 'Homogeneous pwd finite & monotone', ok: monotone, val: pwd });
    const fails = results.filter(r => !r.ok);
    if (fails.length) {
        err('PRiSM self-test FAILED:', fails);
    } else {
        log('PRiSM self-test passed (' + results.length + ' checks).', results);
    }
})();
