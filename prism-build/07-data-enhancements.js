// =============================================================================
// PRiSM — Layer 07 — Data Tab Enhancements
// -----------------------------------------------------------------------------
// REPLACES the foundation's basic Data tab (Tab 1) with a much richer version:
//
//   1. Multi-format file loader  — CSV / TSV / TXT / DAT / ASC / XLSX / XLS
//      (XLSX via SheetJS lazy-loaded from CDN on first use)
//   2. Column mapper             — auto-suggest by header substring + by data
//      shape; per-column dropdown for role assignment; mappings cached by
//      header signature so re-uploads skip the picker
//   3. Time-unit & physical-unit handling — convert into canonical
//      hours / psi / bbl/d (or MMscfd for gas)
//   4. Cleanup panel             — outlier removal (MAD / Hampel), low-pass
//      moving average, decimation (Nth / log-spaced / time-bin), time-range
//      clip
//   5. Updated preview table     — role-labelled headers, stats row with
//      derived dt + auto period-boundary count
//
// Hooks:
//   • Overrides window.PRiSM_doParseData
//   • Adds   window.PRiSM_loadFile, window.PRiSM_renderDataTabEnhanced
//   • Wraps  window.PRiSM.setTab so each switch into Tab 1 re-renders the
//     enhanced tab body. The wrapper composes with Agent A's wrapper —
//     last-one-wins is fine because we handle Tab 1 only.
//
// Same dark-theme conventions as the rest of the app:
//   • CSS classes only — .card, .card-title, .fg, .fg-item, .btn,
//     .btn-primary, .btn-secondary, .dtable, .rbox, .rbox-title, .info-bar
//   • Helpers inherited from the page IIFE: $(id), el(tag, cls, html),
//     fmt(n, dp), saveInputs(key, ids), loadInputs(key, ids).
//   • All public symbols PRiSM_* / window.PRiSM_*.
//
// Persistence: keeps reading / writing 'wts_prism' so existing localStorage
// data continues to work. Adds 'wts_prism_mapping_<hash>' and
// 'wts_prism_units' for the new state.
// =============================================================================

(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // SAFE ACCESSORS — provide tiny shims so the self-test can run outside
    // the host page (e.g. node REPL) without crashing on missing globals.
    // -----------------------------------------------------------------------
    var _hasDoc = (typeof document !== 'undefined');
    var _byId = function (id) {
        if (typeof $ === 'function') return $(id);
        if (_hasDoc) return document.getElementById(id);
        return null;
    };
    var _fmt = function (n, dp) {
        if (typeof fmt === 'function') return fmt(n, dp);
        if (n == null || isNaN(n)) return '—';
        return Number(n).toFixed(dp == null ? 4 : dp);
    };
    var _save = function (key, ids) {
        if (typeof saveInputs === 'function') return saveInputs(key, ids);
    };
    var _load = function (key, ids) {
        if (typeof loadInputs === 'function') return loadInputs(key, ids);
    };

    // Constant — the canonical role names. Order drives the column mapper
    // dropdown; first entry "" means "ignore this column".
    var ROLES = [
        { v: '',        label: '— ignore —' },
        { v: 'time',    label: 'Time' },
        { v: 'pressure',label: 'Pressure' },
        { v: 'rate',    label: 'Rate (single phase)' },
        { v: 'rate_o',  label: 'Oil Rate' },
        { v: 'rate_g',  label: 'Gas Rate' },
        { v: 'rate_w',  label: 'Water Rate' },
        { v: 'period',  label: 'Period Marker' }
    ];
    var ROLE_LABELS = {
        time: 'Time (h)', pressure: 'Pressure (psi)', rate: 'Rate (bbl/d)',
        rate_o: 'Oil (bbl/d)', rate_g: 'Gas (MMscfd)', rate_w: 'Water (bbl/d)',
        period: 'Period'
    };

    // Canonical unit choices.
    var TIME_UNITS = [
        { v: 'h',    label: 'hours',   factor: 1 },
        { v: 's',    label: 'seconds', factor: 1 / 3600 },
        { v: 'min',  label: 'minutes', factor: 1 / 60 },
        { v: 'd',    label: 'days',    factor: 24 },
        { v: 'date', label: 'dates (parsed)', factor: null } // special-cased
    ];
    var PRESSURE_UNITS = [
        { v: 'psi',  label: 'psi',  factor: 1 },
        { v: 'bar',  label: 'bar',  factor: 14.5037738 },
        { v: 'kPa',  label: 'kPa',  factor: 0.145037738 },
        { v: 'MPa',  label: 'MPa',  factor: 145.037738 },
        { v: 'atm',  label: 'atm',  factor: 14.6959488 }
    ];
    var RATE_UNITS_LIQ = [
        { v: 'bbl/d', label: 'bbl/d',     factor: 1 },
        { v: 'm3/d',  label: 'm³/d',      factor: 6.28981077 },
        { v: 'stb/d', label: 'stb/d',     factor: 1 },
        { v: 'L/min', label: 'L/min',     factor: 9.05352 / 1000 * 1440 } // approx; ~ 9.054 bbl/d per L/min
    ];
    var RATE_UNITS_GAS = [
        { v: 'MMscfd', label: 'MMscf/d',  factor: 1 },
        { v: 'Mscf/d', label: 'Mscf/d',   factor: 1e-3 },
        { v: 'scf/d',  label: 'scf/d',    factor: 1e-6 },
        { v: 'm3/d',   label: 'm³/d',     factor: 0.000035314667 }
    ];


    // =======================================================================
    // SECTION 1 — TEXT PARSER (CSV / TSV / DAT / ASC / TXT)
    // =======================================================================
    // Returns { rows: [[cells…], …], headers: [strings] | null,
    //           sep: detected separator description, errors: [...] }.
    // More permissive than the foundation parser:
    //   • strips ASCII comment lines starting with #, *, !, //, ;;
    //   • respects double-quoted fields with embedded separators
    //   • detects unit annotations like "time(s)" or "p [psi]" — keeps the
    //     bare name as the header, exposes the unit hint for auto-mapping
    // =======================================================================

    function PRiSM_parseTextEnhanced(text) {
        if (typeof text !== 'string') return { rows: [], headers: null, sep: 'n/a', errors: ['Empty input'] };

        // Strip BOM + normalise line endings.
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        var rawLines = text.split(/\r\n|\r|\n/);

        // Filter comments + empty lines but remember which ones we kept.
        var lines = [];
        for (var i = 0; i < rawLines.length; i++) {
            var ln = rawLines[i].trim();
            if (!ln.length) continue;
            if (ln.charAt(0) === '#' || ln.charAt(0) === '*' ||
                ln.charAt(0) === '!' || ln.indexOf('//') === 0 ||
                ln.indexOf(';;') === 0) continue;
            lines.push(ln);
        }
        if (!lines.length) return { rows: [], headers: null, sep: 'n/a', errors: ['Empty input'] };

        // Detect separator from first 5 lines — score each candidate and pick
        // the one with the highest consistent column count.
        var candidates = [
            { name: 'tab',       re: /\t/ },
            { name: 'comma',     re: /,/ },
            { name: 'semicolon', re: /;/ },
            { name: 'pipe',      re: /\|/ },
            { name: 'whitespace',re: /\s+/ }
        ];
        var sample = lines.slice(0, Math.min(5, lines.length));
        var bestSep = null, bestScore = -1;
        for (var c = 0; c < candidates.length; c++) {
            var cand = candidates[c];
            var counts = sample.map(function (l) {
                return _splitRespectQuotes(l, cand.re).length;
            });
            // Skip if any line yields < 2 cols.
            if (counts.some(function (n) { return n < 2; })) continue;
            // Score: average columns × consistency bonus
            var avg = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
            var consistent = counts.every(function (n) { return n === counts[0]; });
            var score = avg + (consistent ? 0.5 : 0);
            if (score > bestScore) { bestScore = score; bestSep = cand; }
        }
        if (!bestSep) {
            return { rows: [], headers: null, sep: 'n/a', errors: ['Could not detect a column separator'] };
        }

        // Re-parse all lines with the chosen separator.
        var parsed = lines.map(function (l) {
            return _splitRespectQuotes(l, bestSep.re).map(function (s) { return s.trim(); });
        });

        // Header detection: first row counts as a header if any cell isn't a
        // pure number. We strip "(unit)" / "[unit]" suffixes when checking
        // for numericness, e.g. "0(s)" -> still numeric.
        var first = parsed[0];
        var headerLikely = first.some(function (cell) {
            var stripped = cell.replace(/[\(\[].*?[\)\]]/g, '').trim();
            if (!stripped.length) return true;
            return isNaN(parseFloat(stripped));
        });
        var headers = null;
        var dataStart = 0;
        if (headerLikely) {
            headers = first.slice();
            dataStart = 1;
        }

        // Build numeric rows.
        var rows = [];
        var errors = [];
        var expectedLen = parsed[dataStart] ? parsed[dataStart].length : 0;
        for (var r = dataStart; r < parsed.length; r++) {
            var cells = parsed[r];
            if (cells.length < 2) { errors.push('Row ' + (r + 1) + ': < 2 columns'); continue; }
            var nums = cells.map(function (cv) { return _parseNumberLoose(cv); });
            if (nums.every(function (n) { return n == null || isNaN(n); })) {
                errors.push('Row ' + (r + 1) + ': all cells non-numeric');
                continue;
            }
            // Pad / truncate to a consistent column count if rows are jagged.
            while (nums.length < expectedLen) nums.push(NaN);
            if (nums.length > expectedLen) nums.length = expectedLen;
            rows.push(nums);
        }

        return { rows: rows, headers: headers, sep: bestSep.name, errors: errors };
    }

    // Split a single line respecting double-quoted fields. The separator may
    // be a regex; we don't try to be a full RFC-4180 parser, just handle the
    // common spreadsheet-export patterns.
    function _splitRespectQuotes(line, sep) {
        // If there are no quote chars, fall through to the simple fast path.
        if (line.indexOf('"') < 0) {
            var simple = line.split(sep).map(function (s) { return s.trim(); });
            return simple.filter(function (s) { return s.length > 0; });
        }
        var out = [];
        var cur = '';
        var inQuote = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (ch === '"') {
                // Doubled quote inside a quoted field -> literal quote.
                if (inQuote && line.charAt(i + 1) === '"') { cur += '"'; i++; }
                else inQuote = !inQuote;
                continue;
            }
            if (!inQuote) {
                // Test the separator against the current char (or rest-of-line for whitespace).
                var rest = line.slice(i);
                var m = rest.match(sep);
                if (m && m.index === 0) {
                    out.push(cur.trim());
                    cur = '';
                    i += m[0].length - 1;
                    continue;
                }
            }
            cur += ch;
        }
        out.push(cur.trim());
        return out.filter(function (s) { return s.length > 0; });
    }

    // Parse a number that might have a trailing unit ("12.3 psi"), commas as
    // thousands separators ("1,234.5"), or be a date string. Returns null
    // for unparseable strings (so date-strings can be detected separately).
    function _parseNumberLoose(s) {
        if (s == null) return NaN;
        var t = String(s).trim();
        if (!t.length) return NaN;
        // Strip surrounding quotes.
        if (t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1);
        // Strip trailing alpha unit ("12.3 psi", "1.5e3 kPa").
        var m = t.match(/^([\-\+]?\d[\d,]*(?:\.\d+)?(?:[eE][\-\+]?\d+)?)\s*[a-zA-Z%/³²]*$/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
        // Plain ',' as decimal (locale).
        if (/^[\-\+]?\d+,\d+$/.test(t)) return parseFloat(t.replace(',', '.'));
        return parseFloat(t);
    }


    // =======================================================================
    // SECTION 2 — XLSX LOADER (lazy via CDN)
    // =======================================================================
    // Loads SheetJS once on first XLSX upload; caches on window.XLSX. If the
    // load fails (offline iOS), shows a friendly notice and asks for CSV.
    // =======================================================================

    var _xlsxLoadPromise = null;
    function PRiSM_loadXLSX() {
        if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (_xlsxLoadPromise) return _xlsxLoadPromise;
        _xlsxLoadPromise = new Promise(function (resolve, reject) {
            try {
                var s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
                s.async = true;
                s.onload = function () {
                    if (window.XLSX) resolve(window.XLSX);
                    else reject(new Error('XLSX failed to register on window'));
                };
                s.onerror = function () { reject(new Error('Network blocked SheetJS')); };
                document.head.appendChild(s);
            } catch (e) {
                reject(e);
            }
        });
        return _xlsxLoadPromise;
    }

    // Parse a workbook ArrayBuffer with SheetJS. Returns
    // { sheets: [{name, rows, headers}], default: idx }.
    function PRiSM_parseWorkbook(arrayBuffer) {
        if (!window.XLSX) throw new Error('XLSX not loaded');
        var wb = window.XLSX.read(arrayBuffer, { type: 'array' });
        var out = [];
        wb.SheetNames.forEach(function (name) {
            var ws = wb.Sheets[name];
            // Get as 2D array of raw values.
            var aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            // Filter empty rows.
            aoa = aoa.filter(function (r) {
                return r.some(function (c) { return c !== '' && c != null; });
            });
            if (!aoa.length) {
                out.push({ name: name, rows: [], headers: null, empty: true });
                return;
            }
            // Header detection — same rule as the text parser.
            var first = aoa[0].map(function (c) { return String(c == null ? '' : c); });
            var headerLikely = first.some(function (cell) {
                if (!cell.length) return true;
                return isNaN(parseFloat(cell));
            });
            var headers = headerLikely ? first.slice() : null;
            var dataStart = headerLikely ? 1 : 0;
            var rows = [];
            for (var i = dataStart; i < aoa.length; i++) {
                var row = aoa[i].map(function (c) {
                    if (typeof c === 'number') return c;
                    return _parseNumberLoose(String(c));
                });
                if (row.every(function (n) { return n == null || isNaN(n); })) continue;
                rows.push(row);
            }
            out.push({ name: name, rows: rows, headers: headers, empty: rows.length === 0 });
        });
        // Default = first non-empty.
        var def = out.findIndex(function (s) { return !s.empty; });
        if (def < 0) def = 0;
        return { sheets: out, defaultIdx: def };
    }


    // =======================================================================
    // SECTION 3 — COLUMN AUTO-MAPPER
    // =======================================================================
    // Two heuristics:
    //   (a) header-name substring matching (case-insensitive)
    //   (b) data-shape inspection (monotonic, value range, zero count)
    // Combined, weighting (a) > (b) when headers are present.
    // =======================================================================

    function PRiSM_autoMapColumns(headers, rows) {
        var ncols = (rows && rows[0]) ? rows[0].length : (headers ? headers.length : 0);
        var map = new Array(ncols).fill('');
        if (!ncols) return map;

        // (a) Header-substring scoring. Higher score = stronger match.
        var nameScore = function (header) {
            if (!header) return {};
            var h = String(header).toLowerCase().replace(/[\(\[].*?[\)\]]/g, '').trim();
            var s = {};
            // Time
            if (/\b(time|t|elapsed|hours?|hrs?|min|sec|seconds?|days?|date|datetime|timestamp|dt|epoch)\b/.test(h)) s.time = 4;
            // Pressure
            if (/(pressure|press|p|bhp|whp|psi|bar|kpa|mpa|atm|wellhead|bottomhole|gauge)/.test(h)) s.pressure = 4;
            // Generic rate
            if (/(rate|q|flow|prod|production)/.test(h)) s.rate = 3;
            // Phase-specific rates
            if (/\b(qo|oil|liquid)\b/.test(h)) s.rate_o = 4;
            if (/\b(qg|gas|gor|mscf|mmscf)\b/.test(h)) s.rate_g = 4;
            if (/\b(qw|water|wc|wcut)\b/.test(h)) s.rate_w = 4;
            // Period
            if (/(period|stage|phase|step|interval|build|draw|flow.?id)/.test(h)) s.period = 4;
            return s;
        };

        // (b) Data-shape scoring. Always positive, used for tie-breaking and
        // when headers are missing entirely.
        var shapeScore = function (col) {
            var s = {};
            var clean = col.filter(function (v) { return isFinite(v); });
            if (clean.length < 2) return s;
            var n = clean.length;
            var min = Math.min.apply(null, clean), max = Math.max.apply(null, clean);
            // Monotone-increasing → time
            var mono = true;
            for (var i = 1; i < clean.length; i++) {
                if (clean[i] < clean[i - 1] - 1e-12) { mono = false; break; }
            }
            if (mono && (max - min) > 0) s.time = 3;
            // Mostly-zero column with sustained-positive periods → rate-like
            var zeros = clean.filter(function (v) { return Math.abs(v) < 1e-12; }).length;
            var positives = clean.filter(function (v) { return v > 0; }).length;
            if (zeros >= 0.05 * n && positives >= 0.3 * n) s.rate = 2;
            // Values 1..1e6, many distinct → pressure
            var uniques = new Set(clean.map(function (v) { return Math.round(v * 100) / 100; })).size;
            if (min >= 0.1 && max <= 1e6 && uniques > Math.min(50, n / 4)) s.pressure = 2;
            // Small-int range → period markers
            if (uniques <= 10 && Number.isInteger(min) && Number.isInteger(max)) s.period = 2;
            return s;
        };

        // Build per-column scores then assign greedily, ensuring time + pressure
        // are picked at most once (rate-* may legitimately occur multiple).
        var perCol = [];
        for (var c = 0; c < ncols; c++) {
            var col = rows.map(function (r) { return r[c]; });
            var sc = shapeScore(col);
            var hsc = headers ? nameScore(headers[c]) : {};
            var combined = {};
            Object.keys(sc).forEach(function (k) { combined[k] = (combined[k] || 0) + sc[k]; });
            Object.keys(hsc).forEach(function (k) { combined[k] = (combined[k] || 0) + hsc[k]; });
            perCol.push(combined);
        }

        // Greedy: assign each unique-required role (time, pressure) to the
        // best-scoring column; then assign rate-roles to anything left with a
        // positive rate score.
        var taken = new Array(ncols).fill(false);
        var pickBest = function (role) {
            var bestC = -1, bestS = 0;
            for (var c = 0; c < ncols; c++) {
                if (taken[c]) continue;
                var s = perCol[c][role] || 0;
                if (s > bestS) { bestS = s; bestC = c; }
            }
            if (bestC >= 0) { map[bestC] = role; taken[bestC] = true; }
        };
        pickBest('time');
        pickBest('pressure');
        // Phase-specific rates first (higher selectivity).
        ['rate_o', 'rate_g', 'rate_w'].forEach(function (r) {
            var bestC = -1, bestS = 3.5; // require a header match at minimum
            for (var c = 0; c < ncols; c++) {
                if (taken[c]) continue;
                var s = perCol[c][r] || 0;
                if (s > bestS) { bestS = s; bestC = c; }
            }
            if (bestC >= 0) { map[bestC] = r; taken[bestC] = true; }
        });
        // Generic rate.
        pickBest('rate');
        // Period marker.
        pickBest('period');

        return map;
    }

    // Hash a header signature so we can persist the mapping per file shape.
    function _headerHash(headers, ncols) {
        var s = (headers || []).slice(0, ncols).map(function (h) {
            return String(h || '').toLowerCase().trim();
        }).join('|') + '#' + ncols;
        // FNV-1a 32-bit.
        var h = 0x811C9DC5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16);
    }


    // =======================================================================
    // SECTION 4 — UNIT CONVERSION + DATE PARSING
    // =======================================================================

    function PRiSM_convertTime(rawCol, unit) {
        // Returns { hours: [...], factor: number, fromDate: bool }.
        var u = TIME_UNITS.find(function (x) { return x.v === unit; }) || TIME_UNITS[0];
        if (u.v === 'date') {
            // Try parsing each cell as a date string. If raw is already a
            // number we let the page treat it as ms-since-epoch.
            var firstMs = null;
            var ms = rawCol.map(function (v) {
                if (typeof v === 'number' && isFinite(v)) {
                    // Excel serial date detection: 25569 ≈ 1970-01-01. Crude.
                    if (v > 25500 && v < 80000) {
                        // Excel days since 1900-01-00.
                        return (v - 25569) * 86400000;
                    }
                    return v;
                }
                var t = Date.parse(v);
                return isFinite(t) ? t : NaN;
            });
            for (var i = 0; i < ms.length; i++) { if (isFinite(ms[i])) { firstMs = ms[i]; break; } }
            if (firstMs == null) return { hours: rawCol.slice(), factor: 1, fromDate: true, error: 'no parseable dates' };
            var hours = ms.map(function (m) { return (m - firstMs) / 3600000; });
            return { hours: hours, factor: 1 / 3600000, fromDate: true };
        }
        return {
            hours: rawCol.map(function (v) { return v * u.factor; }),
            factor: u.factor,
            fromDate: false
        };
    }

    function PRiSM_convertPressure(col, unit) {
        var u = PRESSURE_UNITS.find(function (x) { return x.v === unit; }) || PRESSURE_UNITS[0];
        return { values: col.map(function (v) { return v * u.factor; }), factor: u.factor };
    }

    function PRiSM_convertRate(col, unit, isGas) {
        var arr = isGas ? RATE_UNITS_GAS : RATE_UNITS_LIQ;
        var u = arr.find(function (x) { return x.v === unit; }) || arr[0];
        return { values: col.map(function (v) { return v * u.factor; }), factor: u.factor };
    }


    // =======================================================================
    // SECTION 5 — FILTERS & DECIMATION
    // =======================================================================

    // MAD-based outlier rejection. Keeps points within k median-absolute-
    // deviations of the rolling median. Default k = 5 (conservative).
    function PRiSM_filterMAD(values, k) {
        if (k == null) k = 5;
        var n = values.length;
        if (n < 5) return new Array(n).fill(true);
        var sorted = values.slice().filter(function (v) { return isFinite(v); }).sort(function (a, b) { return a - b; });
        var median = sorted[Math.floor(sorted.length / 2)];
        var devs = sorted.map(function (v) { return Math.abs(v - median); }).sort(function (a, b) { return a - b; });
        var mad = devs[Math.floor(devs.length / 2)] || 1e-9;
        var thresh = k * 1.4826 * mad; // 1.4826 = scale to σ for normal data
        return values.map(function (v) { return Math.abs(v - median) <= thresh; });
    }

    // 5-point moving average (low-pass). Returns a NEW array same length;
    // edge points use shorter windows.
    function PRiSM_filterMovingAvg(values, win) {
        if (win == null) win = 5;
        var half = Math.floor(win / 2);
        var n = values.length;
        var out = new Array(n);
        for (var i = 0; i < n; i++) {
            var sum = 0, ct = 0;
            for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
                if (isFinite(values[j])) { sum += values[j]; ct++; }
            }
            out[i] = ct ? sum / ct : values[i];
        }
        return out;
    }

    // Hampel filter — windowed MAD-based outlier replacement. Returns
    // a "keep" mask (true = keep original; false = treated as outlier).
    function PRiSM_filterHampel(values, win, k) {
        if (win == null) win = 7;
        if (k == null) k = 3;
        var half = Math.floor(win / 2);
        var n = values.length;
        var keep = new Array(n).fill(true);
        for (var i = 0; i < n; i++) {
            var window = [];
            for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
                if (isFinite(values[j])) window.push(values[j]);
            }
            if (window.length < 3) continue;
            window.sort(function (a, b) { return a - b; });
            var med = window[Math.floor(window.length / 2)];
            var devs = window.map(function (v) { return Math.abs(v - med); }).sort(function (a, b) { return a - b; });
            var mad = devs[Math.floor(devs.length / 2)] || 1e-9;
            if (Math.abs(values[i] - med) > k * 1.4826 * mad) keep[i] = false;
        }
        return keep;
    }

    // Decimation: every Nth point.
    function PRiSM_decimateNth(times, indices, N) {
        if (N == null || N < 2) return indices.slice();
        var out = [];
        for (var i = 0; i < indices.length; i += N) out.push(indices[i]);
        if (out[out.length - 1] !== indices[indices.length - 1]) out.push(indices[indices.length - 1]);
        return out;
    }

    // Decimation: log-spaced — pick approximately N indices whose times are
    // roughly log-uniform. Always preserves first + last index.
    function PRiSM_decimateLog(times, indices, target) {
        if (target == null || indices.length <= target) return indices.slice();
        var t0 = times[indices[0]], tN = times[indices[indices.length - 1]];
        // Use a small offset so log() works for t0=0.
        var offset = 0;
        if (t0 <= 0) {
            var minPos = Infinity;
            for (var i = 0; i < indices.length; i++) {
                var v = times[indices[i]];
                if (v > 0 && v < minPos) minPos = v;
            }
            offset = (minPos === Infinity) ? 1 : minPos / 2;
        }
        var lo = Math.log(t0 + offset || 1e-12);
        var hi = Math.log(tN + offset);
        var picked = [];
        var seen = new Set();
        for (var k = 0; k < target; k++) {
            var lt = lo + (hi - lo) * (k / (target - 1));
            var tt = Math.exp(lt) - offset;
            // Find nearest index.
            var bestIdx = 0, bestD = Infinity;
            for (var j = 0; j < indices.length; j++) {
                var d = Math.abs(times[indices[j]] - tt);
                if (d < bestD) { bestD = d; bestIdx = j; }
            }
            if (!seen.has(bestIdx)) { seen.add(bestIdx); picked.push(indices[bestIdx]); }
        }
        // Always include endpoints.
        if (picked[0] !== indices[0]) picked.unshift(indices[0]);
        if (picked[picked.length - 1] !== indices[indices.length - 1]) picked.push(indices[indices.length - 1]);
        // Sort by original index order.
        picked.sort(function (a, b) { return a - b; });
        return picked;
    }

    // Decimation: time-bin (1 sample per X minutes). Keeps the first sample
    // in each bin window.
    function PRiSM_decimateTimeBin(times, indices, binMinutes) {
        if (binMinutes == null || binMinutes <= 0) return indices.slice();
        var binHours = binMinutes / 60;
        var out = [];
        var lastBin = -Infinity;
        for (var i = 0; i < indices.length; i++) {
            var t = times[indices[i]];
            var bin = Math.floor(t / binHours);
            if (bin > lastBin) { out.push(indices[i]); lastBin = bin; }
        }
        // Always include final point.
        if (out[out.length - 1] !== indices[indices.length - 1]) out.push(indices[indices.length - 1]);
        return out;
    }


    // =======================================================================
    // SECTION 6 — STATE STORAGE
    // =======================================================================
    // We keep a small private state object on window.PRiSM._dataEnh so the
    // various render functions can pick up where each other left off without
    // round-tripping everything through the DOM.
    // =======================================================================

    function _getState() {
        if (!window.PRiSM) window.PRiSM = {};
        if (!window.PRiSM._dataEnh) {
            window.PRiSM._dataEnh = {
                source: null,        // 'paste' | 'file' | 'workbook'
                fileName: null,
                workbook: null,      // {sheets, defaultIdx}
                sheetIdx: 0,
                rawRows: null,       // [[...], ...]
                headers: null,
                mapping: null,       // [role-string per column]
                units: { time: 'h', pressure: 'psi', rate: 'bbl/d', rate_g: 'MMscfd' },
                cleanup: { filter: 'none', decim: 'none', decimN: 5, decimTarget: 200, decimBinMin: 5, tStart: '', tEnd: '' },
                lastApplied: null,   // built dataset for preview
                errors: []
            };
        }
        return window.PRiSM._dataEnh;
    }


    // =======================================================================
    // SECTION 7 — RENDER THE ENHANCED DATA TAB
    // =======================================================================

    function PRiSM_renderDataTabEnhanced() {
        var host = _byId('prism_tab_1');
        if (!host) return;

        var st = _getState();

        host.innerHTML = ''
            + '<div class="cols-2">'
            + '  <div>'
            // ── File/paste loader card ──
            + '    <div class="card">'
            + '      <div class="card-title">Load Data</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        Drop a CSV / TSV / TXT / DAT / ASC / XLSX / XLS file, or paste'
            + '        from Excel below. Header row, separator and column'
            + '        roles are auto-detected; you can override every choice.'
            + '      </div>'
            + '      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">'
            + '        <input type="file" id="prism_data_file" accept=".csv,.tsv,.txt,.dat,.asc,.xls,.xlsx" style="font-size:12px; color:var(--text2);">'
            + '        <span id="prism_data_filename" style="font-size:12px; color:var(--text3);"></span>'
            + '      </div>'
            + '      <textarea id="prism_data_paste" class="data-textarea" style="min-height:160px; font-family:monospace; font-size:12px; width:100%;" placeholder="time,pressure,rate&#10;0,2500,0&#10;0.01,2520,500&#10;0.02,2550,500"></textarea>'
            + '      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">'
            + '        <button class="btn btn-secondary" id="prism_data_parse">Parse</button>'
            + '        <button class="btn btn-primary" id="prism_data_use">Use this data</button>'
            + '        <button class="btn btn-secondary" id="prism_data_clear">Clear</button>'
            + '      </div>'
            + '      <div id="prism_data_msg" style="margin-top:8px; font-size:12px; color:var(--text2);"></div>'
            + '    </div>'

            // ── Sheet picker (only when XLSX loaded) ──
            + '    <div class="card" id="prism_sheet_card" style="display:' + (st.workbook ? 'block' : 'none') + ';">'
            + '      <div class="card-title">Workbook Sheet</div>'
            + '      <div class="fg"><div class="fg-item"><label>Active sheet</label>'
            + '      <select id="prism_sheet_pick"></select></div></div>'
            + '    </div>'

            // ── Column mapper card ──
            + '    <div class="card" id="prism_map_card" style="display:none;">'
            + '      <div class="card-title">Column Mapping</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        Assign a role to each detected column. Mapping is cached per file shape.'
            + '      </div>'
            + '      <div id="prism_map_grid" style="display:flex; flex-wrap:wrap; gap:10px;"></div>'
            + '      <div style="margin-top:10px; display:flex; gap:8px;">'
            + '        <button class="btn btn-primary" id="prism_map_apply">Apply mapping</button>'
            + '        <button class="btn btn-secondary" id="prism_map_reset">Auto-detect again</button>'
            + '      </div>'
            + '    </div>'

            // ── Units card ──
            + '    <div class="card" id="prism_units_card" style="display:none;">'
            + '      <div class="card-title">Units</div>'
            + '      <div class="fg" style="display:flex; flex-wrap:wrap; gap:10px;">'
            + '        <div class="fg-item" style="flex:1 1 130px;"><label>Time</label><select id="prism_unit_time"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px;"><label>Pressure</label><select id="prism_unit_pressure"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px;"><label>Rate (liquid)</label><select id="prism_unit_rate"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px;"><label>Rate (gas)</label><select id="prism_unit_rate_g"></select></div>'
            + '      </div>'
            + '      <div id="prism_unit_msg" style="margin-top:8px; font-size:12px; color:var(--text3);"></div>'
            + '    </div>'

            // ── Cleanup card ──
            + '    <div class="card" id="prism_clean_card" style="display:none;">'
            + '      <div class="card-title">Cleanup</div>'
            + '      <div class="fg" style="display:flex; flex-wrap:wrap; gap:10px;">'
            + '        <div class="fg-item" style="flex:1 1 160px;"><label>Filter</label>'
            + '          <select id="prism_clean_filter">'
            + '            <option value="none">none</option>'
            + '            <option value="mad">Outlier removal (MAD)</option>'
            + '            <option value="ma">Low-pass (5-pt MA)</option>'
            + '            <option value="hampel">Hampel (median outlier)</option>'
            + '          </select></div>'
            + '        <div class="fg-item" style="flex:1 1 160px;"><label>Decimation</label>'
            + '          <select id="prism_clean_decim">'
            + '            <option value="none">none</option>'
            + '            <option value="nth">Every Nth point</option>'
            + '            <option value="log">Log-spaced (target N)</option>'
            + '            <option value="bin">Time-bin (1 / X min)</option>'
            + '          </select></div>'
            + '        <div class="fg-item" style="flex:1 1 100px;"><label>N / target</label>'
            + '          <input id="prism_clean_decimN" type="number" min="2" value="5" step="1"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px;"><label>Bin (min)</label>'
            + '          <input id="prism_clean_bin" type="number" min="0.1" value="5" step="0.5"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px;"><label>Time start (h)</label>'
            + '          <input id="prism_clean_tstart" type="number" step="any" placeholder="(min)"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px;"><label>Time end (h)</label>'
            + '          <input id="prism_clean_tend" type="number" step="any" placeholder="(max)"></div>'
            + '      </div>'
            + '      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">'
            + '        <button class="btn btn-secondary" id="prism_clean_preview">Preview</button>'
            + '        <button class="btn btn-primary" id="prism_clean_apply">Apply</button>'
            + '        <span id="prism_clean_msg" style="font-size:12px; color:var(--text3);"></span>'
            + '      </div>'
            + '      <canvas id="prism_clean_canvas" width="480" height="120" style="margin-top:10px; width:100%; max-width:480px; background:var(--bg1); border:1px solid var(--border); border-radius:6px; display:none;"></canvas>'
            + '    </div>'

            // ── Multi-rate editor card (preserved from foundation) ──
            + '    <div class="card">'
            + '      <div class="card-title">Multi-Rate History (optional)</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        For superposition / convolution. One [time, rate] pair per row.'
            + '        Use rate = 0 for a shut-in. Leave empty for single-rate datasets.'
            + '      </div>'
            + '      <table class="dtable" id="prism_mrate_table">'
            + '        <thead><tr><th>Time</th><th>Rate</th><th></th></tr></thead>'
            + '        <tbody id="prism_mrate_body"></tbody>'
            + '      </table>'
            + '      <div style="margin-top:8px;"><button class="btn btn-secondary" id="prism_mrate_add">+ Add row</button></div>'
            + '    </div>'

            + '  </div>'  // end left col

            + '  <div>'
            // ── Stats card ──
            + '    <div class="card">'
            + '      <div class="card-title">Summary</div>'
            + '      <div id="prism_data_stats">'
            + '        <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>'
            + '      </div>'
            + '    </div>'
            // ── Preview table card ──
            + '    <div class="card">'
            + '      <div class="card-title">Preview</div>'
            + '      <div id="prism_data_preview" style="overflow-x:auto;">'
            + '        <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>'
            + '      </div>'
            + '    </div>'
            + '  </div>'

            + '</div>';

        // ── Persistence: re-load paste textarea ──
        _load('prism', ['prism_data_paste']);

        // Wire file input.
        var fi = _byId('prism_data_file');
        if (fi) fi.onchange = function (ev) {
            var f = ev.target.files && ev.target.files[0];
            if (f) PRiSM_loadFile(f);
        };

        // Wire Parse / Use / Clear.
        var pb = _byId('prism_data_parse');
        if (pb) pb.onclick = PRiSM_doParseData;
        var ub = _byId('prism_data_use');
        if (ub) ub.onclick = PRiSM_doUseData;
        var cb = _byId('prism_data_clear');
        if (cb) cb.onclick = function () {
            _byId('prism_data_paste').value = '';
            _byId('prism_data_msg').textContent = '';
            _byId('prism_data_filename').textContent = '';
            _byId('prism_data_preview').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
            _byId('prism_data_stats').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
            _byId('prism_map_card').style.display = 'none';
            _byId('prism_units_card').style.display = 'none';
            _byId('prism_clean_card').style.display = 'none';
            _byId('prism_sheet_card').style.display = 'none';
            window.PRiSM_dataset = null;
            window.PRiSM._dataEnh = null;
            _save('prism', ['prism_data_paste']);
        };

        // Wire multi-rate editor (re-use the foundation function if present).
        if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows();
        var mra = _byId('prism_mrate_add');
        if (mra) mra.onclick = function () {
            if (!window.PRiSM.multiRate) window.PRiSM.multiRate = [];
            window.PRiSM.multiRate.push({ t: 0, q: 0 });
            if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows();
            if (typeof PRiSM_persistMultiRate === 'function') PRiSM_persistMultiRate();
        };

        // If state already has a parsed result (from a previous render), repaint.
        if (st.rawRows && st.rawRows.length) {
            if (st.workbook) PRiSM_renderSheetPicker();
            PRiSM_renderColumnMapper();
            PRiSM_renderUnitPickers();
            PRiSM_renderCleanupPanel();
            PRiSM_renderPreview();
        } else if (_byId('prism_data_paste').value.trim()) {
            // Auto-parse anything pre-filled.
            PRiSM_doParseData();
        }
    }


    // =======================================================================
    // SECTION 8 — FILE LOADER (CSV/TSV/TXT/DAT/ASC/XLSX)
    // =======================================================================

    window.PRiSM_loadFile = function (file) {
        if (!file) return Promise.resolve();
        var st = _getState();
        st.fileName = file.name;
        var msg = _byId('prism_data_msg');
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = file.name;
        var name = (file.name || '').toLowerCase();
        var isXlsx = /\.(xlsx|xls|xlsm|xlsb|ods)$/.test(name);

        if (isXlsx) {
            if (msg) msg.innerHTML = '<span style="color:var(--text3);">Loading SheetJS…</span>';
            return PRiSM_loadXLSX().then(function () {
                return _readArrayBuffer(file);
            }).then(function (buf) {
                var wb = PRiSM_parseWorkbook(buf);
                st.source = 'workbook';
                st.workbook = wb;
                st.sheetIdx = wb.defaultIdx;
                _adoptSheet(st);
                PRiSM_renderSheetPicker();
                _afterParseSuccess();
            }).catch(function (e) {
                if (msg) msg.innerHTML = '<span style="color:var(--red);">'
                    + 'XLSX support requires internet on first use; please save as CSV/TSV instead. '
                    + '(' + (e && e.message ? e.message : 'load failed') + ')</span>';
            });
        }

        // Text formats.
        return _readText(file).then(function (text) {
            _byId('prism_data_paste').value = text;
            _save('prism', ['prism_data_paste']);
            PRiSM_doParseData();
        });
    };

    function _readArrayBuffer(file) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function (e) { resolve(e.target.result); };
            r.onerror = function () { reject(new Error('FileReader failed')); };
            r.readAsArrayBuffer(file);
        });
    }
    function _readText(file) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function (e) { resolve(e.target.result); };
            r.onerror = function () { reject(new Error('FileReader failed')); };
            r.readAsText(file);
        });
    }

    function _adoptSheet(st) {
        var s = st.workbook.sheets[st.sheetIdx];
        if (!s) return;
        st.rawRows = s.rows.slice();
        st.headers = s.headers ? s.headers.slice() : null;
        // Try cached mapping first.
        var hash = _headerHash(st.headers, st.rawRows[0] ? st.rawRows[0].length : 0);
        var cached = null;
        try {
            var raw = localStorage.getItem('wts_prism_mapping_' + hash);
            if (raw) cached = JSON.parse(raw);
        } catch (e) { /* ignore */ }
        st.mapping = cached || PRiSM_autoMapColumns(st.headers, st.rawRows);
    }


    // =======================================================================
    // SECTION 9 — OVERRIDE PARSE / USE
    // =======================================================================

    window.PRiSM_doParseData = function () {
        var st = _getState();
        var msg = _byId('prism_data_msg');

        if (st.source !== 'workbook') {
            // Parse the textarea.
            var ta = _byId('prism_data_paste');
            if (!ta) return;
            var text = ta.value;
            _save('prism', ['prism_data_paste']);
            var res = PRiSM_parseTextEnhanced(text);
            if (!res.rows.length) {
                if (msg) msg.innerHTML = '<span style="color:var(--red);">No valid data rows. '
                    + (res.errors.length ? res.errors.slice(0, 3).join(' · ') : '') + '</span>';
                _byId('prism_data_preview').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
                _byId('prism_data_stats').innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
                return;
            }
            st.source = 'paste';
            st.rawRows = res.rows;
            st.headers = res.headers;
            st.errors = res.errors;
            // Cached mapping?
            var hash = _headerHash(st.headers, st.rawRows[0].length);
            var cached = null;
            try {
                var raw = localStorage.getItem('wts_prism_mapping_' + hash);
                if (raw) cached = JSON.parse(raw);
            } catch (e) { /* ignore */ }
            st.mapping = cached || PRiSM_autoMapColumns(st.headers, st.rawRows);
        }
        _afterParseSuccess();
    };

    function _afterParseSuccess() {
        var st = _getState();
        var msg = _byId('prism_data_msg');
        if (msg) msg.innerHTML = '<span style="color:var(--green);">Parsed '
            + st.rawRows.length + ' rows ('
            + (st.rawRows[0] ? st.rawRows[0].length : 0) + ' cols).'
            + (st.errors && st.errors.length ? ' <span style="color:var(--yellow);">' + st.errors.length + ' rows skipped.</span>' : '')
            + '</span>';

        PRiSM_renderColumnMapper();
        PRiSM_renderUnitPickers();
        PRiSM_renderCleanupPanel();
        // Build initial dataset using current mapping + units (no cleanup yet).
        _buildDataset(false);
        PRiSM_renderPreview();
    }

    window.PRiSM_doUseData = function () {
        var st = _getState();
        if (!st || !st.rawRows || !st.rawRows.length) {
            PRiSM_doParseData();
            st = _getState();
            if (!st || !st.rawRows || !st.rawRows.length) {
                var msg = _byId('prism_data_msg');
                if (msg) msg.innerHTML = '<span style="color:var(--red);">Nothing to use — paste or upload data first.</span>';
                return;
            }
        }
        // Build using current cleanup settings.
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) {
            var msg2 = _byId('prism_data_msg');
            if (msg2) msg2.innerHTML = '<span style="color:var(--red);">No usable rows after cleanup. Loosen the filter / range.</span>';
            return;
        }
        window.PRiSM_dataset = ds;
        var msg3 = _byId('prism_data_msg');
        if (msg3) msg3.innerHTML = '<span style="color:var(--green);">Dataset of '
            + ds.t.length + ' points active. Switch to the Plots tab to visualise.</span>';
    };


    // =======================================================================
    // SECTION 10 — SHEET PICKER + COLUMN MAPPER UI
    // =======================================================================

    function PRiSM_renderSheetPicker() {
        var st = _getState();
        var card = _byId('prism_sheet_card');
        var sel = _byId('prism_sheet_pick');
        if (!card || !sel || !st.workbook) return;
        card.style.display = 'block';
        sel.innerHTML = '';
        st.workbook.sheets.forEach(function (s, i) {
            var o = document.createElement('option');
            o.value = String(i);
            o.textContent = s.name + (s.empty ? ' (empty)' : ' — ' + s.rows.length + ' rows');
            if (i === st.sheetIdx) o.selected = true;
            sel.appendChild(o);
        });
        sel.onchange = function () {
            st.sheetIdx = parseInt(sel.value, 10);
            _adoptSheet(st);
            _afterParseSuccess();
        };
    }

    function PRiSM_renderColumnMapper() {
        var st = _getState();
        var card = _byId('prism_map_card');
        var grid = _byId('prism_map_grid');
        if (!card || !grid || !st.rawRows || !st.rawRows.length) return;
        card.style.display = 'block';
        var ncols = st.rawRows[0].length;
        grid.innerHTML = '';
        for (var c = 0; c < ncols; c++) {
            var label = (st.headers && st.headers[c]) ? st.headers[c] : ('Column ' + (c + 1));
            // Tiny preview of first 2 numeric values.
            var preview = [];
            for (var r = 0; r < Math.min(3, st.rawRows.length); r++) {
                preview.push(_fmt(st.rawRows[r][c], 3));
            }
            var div = document.createElement('div');
            div.className = 'fg-item';
            div.style.flex = '1 1 160px';
            div.style.minWidth = '160px';
            var optsHTML = ROLES.map(function (r) {
                return '<option value="' + r.v + '"' + (st.mapping[c] === r.v ? ' selected' : '') + '>' + r.label + '</option>';
            }).join('');
            div.innerHTML =
                '<label title="' + _escapeHTML(String(label)) + '">'
                + _escapeHTML(String(label).slice(0, 24)) + '</label>'
                + '<select data-mapcol="' + c + '">' + optsHTML + '</select>'
                + '<div style="font-size:10px; color:var(--text3); margin-top:4px;">e.g. ' + preview.join(', ') + '</div>';
            grid.appendChild(div);
        }
        // Wire dropdowns.
        grid.querySelectorAll('select[data-mapcol]').forEach(function (s) {
            s.onchange = function () {
                var i = parseInt(s.dataset.mapcol, 10);
                st.mapping[i] = s.value;
            };
        });
        // Wire buttons.
        var apply = _byId('prism_map_apply');
        var reset = _byId('prism_map_reset');
        if (apply) apply.onclick = function () {
            // Persist mapping per file shape.
            try {
                var hash = _headerHash(st.headers, ncols);
                localStorage.setItem('wts_prism_mapping_' + hash, JSON.stringify(st.mapping));
            } catch (e) { /* ignore */ }
            _buildDataset(false);
            PRiSM_renderPreview();
            var msg = _byId('prism_data_msg');
            if (msg) msg.innerHTML = '<span style="color:var(--green);">Mapping applied.</span>';
        };
        if (reset) reset.onclick = function () {
            st.mapping = PRiSM_autoMapColumns(st.headers, st.rawRows);
            PRiSM_renderColumnMapper();
        };
    }

    function PRiSM_renderUnitPickers() {
        var st = _getState();
        var card = _byId('prism_units_card');
        if (!card) return;
        card.style.display = 'block';
        var fill = function (selId, list, current) {
            var s = _byId(selId);
            if (!s) return;
            s.innerHTML = list.map(function (u) {
                return '<option value="' + u.v + '"' + (u.v === current ? ' selected' : '') + '>' + u.label + '</option>';
            }).join('');
            s.onchange = function () {
                var key = selId.replace('prism_unit_', '');
                st.units[key] = s.value;
                _buildDataset(false);
                PRiSM_renderPreview();
                _showUnitMsg();
            };
        };
        fill('prism_unit_time',     TIME_UNITS,      st.units.time);
        fill('prism_unit_pressure', PRESSURE_UNITS,  st.units.pressure);
        fill('prism_unit_rate',     RATE_UNITS_LIQ,  st.units.rate);
        fill('prism_unit_rate_g',   RATE_UNITS_GAS,  st.units.rate_g);
        _showUnitMsg();
    }

    function _showUnitMsg() {
        var st = _getState();
        var msg = _byId('prism_unit_msg');
        if (!msg) return;
        var u = TIME_UNITS.find(function (x) { return x.v === st.units.time; });
        var label = u ? u.label : st.units.time;
        var f = (u && u.factor != null) ? (' × ' + u.factor + ' = hours') : ' (parsed as date strings)';
        msg.textContent = 'Time: ' + label + f
            + ' · Pressure: ' + st.units.pressure + ' → psi'
            + ' · Liquid: ' + st.units.rate + ' → bbl/d'
            + ' · Gas: ' + st.units.rate_g + ' → MMscfd';
    }


    // =======================================================================
    // SECTION 11 — CLEANUP PANEL UI
    // =======================================================================

    function PRiSM_renderCleanupPanel() {
        var st = _getState();
        var card = _byId('prism_clean_card');
        if (!card) return;
        card.style.display = 'block';
        // Restore selections
        var f = _byId('prism_clean_filter'); if (f) f.value = st.cleanup.filter;
        var d = _byId('prism_clean_decim');  if (d) d.value = st.cleanup.decim;
        var n = _byId('prism_clean_decimN'); if (n) n.value = String(st.cleanup.decimN);
        var b = _byId('prism_clean_bin');    if (b) b.value = String(st.cleanup.decimBinMin);
        var ts = _byId('prism_clean_tstart'); if (ts) ts.value = st.cleanup.tStart;
        var te = _byId('prism_clean_tend');   if (te) te.value = st.cleanup.tEnd;

        // Sync N input semantics: when "log-spaced" is picked, treat N as the
        // target sample count; when "nth", as the stride.
        if (f) f.onchange = function () { st.cleanup.filter = f.value; };
        if (d) d.onchange = function () { st.cleanup.decim  = d.value; };
        if (n) n.oninput  = function () { st.cleanup.decimN = parseFloat(n.value) || 5; st.cleanup.decimTarget = st.cleanup.decimN; };
        if (b) b.oninput  = function () { st.cleanup.decimBinMin = parseFloat(b.value) || 5; };
        if (ts) ts.oninput = function () { st.cleanup.tStart = ts.value; };
        if (te) te.oninput = function () { st.cleanup.tEnd   = te.value; };

        var prev = _byId('prism_clean_preview');
        var apply = _byId('prism_clean_apply');
        if (prev) prev.onclick = function () { _previewCleanup(); };
        if (apply) apply.onclick = function () {
            _buildDataset(true);
            PRiSM_renderPreview();
            var msg = _byId('prism_clean_msg');
            if (msg) msg.innerHTML = '<span style="color:var(--green);">Cleanup applied.</span>';
        };
    }

    // Build the BEFORE / AFTER counts and draw a tiny inline canvas.
    function _previewCleanup() {
        var st = _getState();
        var before = _buildDataset(false);
        var after  = _buildDataset(true, /*dryRun*/ true);
        var msg = _byId('prism_clean_msg');
        if (msg) msg.innerHTML = (before && after)
            ? ('<span style="color:var(--text2);">Before: ' + (before.t ? before.t.length : 0)
               + ' points → After: ' + (after.t ? after.t.length : 0) + ' points</span>')
            : '<span style="color:var(--red);">Nothing to preview.</span>';
        var cvs = _byId('prism_clean_canvas');
        if (!cvs || !after || !after.t || !after.t.length) return;
        cvs.style.display = 'block';
        _drawTinyCurve(cvs, after.t, after.p || after.q || after.t);
    }

    function _drawTinyCurve(cvs, x, y) {
        var ctx = cvs.getContext && cvs.getContext('2d');
        if (!ctx) return;
        var W = cvs.width, H = cvs.height;
        ctx.clearRect(0, 0, W, H);
        var pad = 6;
        var xMin = Math.min.apply(null, x), xMax = Math.max.apply(null, x);
        var yMin = Infinity, yMax = -Infinity;
        for (var i = 0; i < y.length; i++) { if (isFinite(y[i])) { if (y[i] < yMin) yMin = y[i]; if (y[i] > yMax) yMax = y[i]; } }
        if (!isFinite(xMin) || xMin === xMax) xMax = xMin + 1;
        if (!isFinite(yMin) || yMin === yMax) yMax = yMin + 1;
        ctx.strokeStyle = '#f0883e';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (var k = 0; k < x.length; k++) {
            var px = pad + (W - 2 * pad) * (x[k] - xMin) / (xMax - xMin);
            var py = H - pad - (H - 2 * pad) * (y[k] - yMin) / (yMax - yMin);
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }


    // =======================================================================
    // SECTION 12 — BUILD DATASET (mapping + units + cleanup)
    // =======================================================================

    function _buildDataset(applyCleanup, dryRun) {
        var st = _getState();
        if (!st.rawRows || !st.rawRows.length) return null;
        var rows = st.rawRows;
        var ncols = rows[0].length;

        // Find which raw column is each role.
        var idx = { time: -1, pressure: -1, rate: -1, rate_o: -1, rate_g: -1, rate_w: -1, period: -1 };
        for (var c = 0; c < ncols; c++) {
            var role = st.mapping[c];
            if (role && idx[role] === -1) idx[role] = c;
        }

        // Time column is required.
        if (idx.time < 0) {
            // Default to column 0 if user hasn't mapped anything.
            idx.time = 0;
        }
        if (idx.pressure < 0 && ncols > 1) idx.pressure = 1;

        var rawT = rows.map(function (r) { return r[idx.time]; });
        var rawP = idx.pressure >= 0 ? rows.map(function (r) { return r[idx.pressure]; }) : null;
        var rawQ = idx.rate    >= 0 ? rows.map(function (r) { return r[idx.rate]; }) : null;
        var rawO = idx.rate_o  >= 0 ? rows.map(function (r) { return r[idx.rate_o]; }) : null;
        var rawG = idx.rate_g  >= 0 ? rows.map(function (r) { return r[idx.rate_g]; }) : null;
        var rawW = idx.rate_w  >= 0 ? rows.map(function (r) { return r[idx.rate_w]; }) : null;
        var rawPer = idx.period >= 0 ? rows.map(function (r) { return r[idx.period]; }) : null;

        // Unit conversion → canonical.
        var tConv = PRiSM_convertTime(rawT, st.units.time);
        var t = tConv.hours;
        var p = rawP ? PRiSM_convertPressure(rawP, st.units.pressure).values : null;
        var q = rawQ ? PRiSM_convertRate(rawQ, st.units.rate, false).values : null;
        var qo = rawO ? PRiSM_convertRate(rawO, st.units.rate, false).values : null;
        var qg = rawG ? PRiSM_convertRate(rawG, st.units.rate_g, true).values : null;
        var qw = rawW ? PRiSM_convertRate(rawW, st.units.rate, false).values : null;

        // Build initial keep-mask (all valid finite times + pressures).
        var indices = [];
        for (var i = 0; i < t.length; i++) {
            if (!isFinite(t[i])) continue;
            if (p && !isFinite(p[i])) continue;
            indices.push(i);
        }

        if (applyCleanup) {
            // Time-range clip.
            var tStart = parseFloat(st.cleanup.tStart);
            var tEnd   = parseFloat(st.cleanup.tEnd);
            indices = indices.filter(function (i) {
                if (isFinite(tStart) && t[i] < tStart) return false;
                if (isFinite(tEnd)   && t[i] > tEnd)   return false;
                return true;
            });
            // Outlier filter.
            if (p && st.cleanup.filter !== 'none') {
                var subP = indices.map(function (i) { return p[i]; });
                var keep = null;
                if (st.cleanup.filter === 'mad') keep = PRiSM_filterMAD(subP, 5);
                else if (st.cleanup.filter === 'hampel') keep = PRiSM_filterHampel(subP, 7, 3);
                else if (st.cleanup.filter === 'ma') {
                    // Low-pass replaces values rather than dropping them.
                    var smoothed = PRiSM_filterMovingAvg(subP, 5);
                    indices.forEach(function (i, j) { p[i] = smoothed[j]; });
                }
                if (keep) indices = indices.filter(function (_, j) { return keep[j]; });
            }
            // Decimation.
            if (st.cleanup.decim === 'nth') {
                indices = PRiSM_decimateNth(t, indices, Math.max(2, Math.floor(st.cleanup.decimN)));
            } else if (st.cleanup.decim === 'log') {
                indices = PRiSM_decimateLog(t, indices, Math.max(10, Math.floor(st.cleanup.decimTarget)));
            } else if (st.cleanup.decim === 'bin') {
                indices = PRiSM_decimateTimeBin(t, indices, Math.max(0.1, st.cleanup.decimBinMin));
            }
        }

        var ds = {
            t: indices.map(function (i) { return t[i]; })
        };
        if (p) ds.p = indices.map(function (i) { return p[i]; });
        if (q) ds.q = indices.map(function (i) { return q[i]; });
        else ds.q = null;
        if (qo || qg || qw) ds.phases = {
            oil:   qo ? indices.map(function (i) { return qo[i]; }) : null,
            gas:   qg ? indices.map(function (i) { return qg[i]; }) : null,
            water: qw ? indices.map(function (i) { return qw[i]; }) : null
        };
        if (rawPer) ds.period = indices.map(function (i) { return rawPer[i]; });

        if (!dryRun) st.lastApplied = ds;
        return ds;
    }


    // =======================================================================
    // SECTION 13 — PREVIEW TABLE + STATS
    // =======================================================================

    function PRiSM_renderPreview() {
        var st = _getState();
        var ds = st.lastApplied;
        var prev = _byId('prism_data_preview');
        var statsEl = _byId('prism_data_stats');
        if (!prev || !statsEl) return;
        if (!ds || !ds.t || !ds.t.length) {
            prev.innerHTML = '<div style="color:var(--text3); font-size:12px;">No mapped data yet.</div>';
            statsEl.innerHTML = '<div style="color:var(--text3); font-size:12px;">No mapped data yet.</div>';
            return;
        }

        // Header + per-column arrays in display order.
        var cols = [];
        cols.push({ key: 'time', label: ROLE_LABELS.time, values: ds.t });
        if (ds.p) cols.push({ key: 'pressure', label: ROLE_LABELS.pressure, values: ds.p });
        if (ds.q) cols.push({ key: 'rate', label: ROLE_LABELS.rate, values: ds.q });
        if (ds.phases) {
            if (ds.phases.oil)   cols.push({ key: 'rate_o', label: ROLE_LABELS.rate_o, values: ds.phases.oil });
            if (ds.phases.gas)   cols.push({ key: 'rate_g', label: ROLE_LABELS.rate_g, values: ds.phases.gas });
            if (ds.phases.water) cols.push({ key: 'rate_w', label: ROLE_LABELS.rate_w, values: ds.phases.water });
        }
        if (ds.period) cols.push({ key: 'period', label: ROLE_LABELS.period, values: ds.period });

        // Stats: N, time range, pressure range, derived dt, period count.
        var N = ds.t.length;
        var tMin = Math.min.apply(null, ds.t);
        var tMax = Math.max.apply(null, ds.t);
        var dts = [];
        for (var i = 1; i < ds.t.length; i++) dts.push(ds.t[i] - ds.t[i - 1]);
        var dtSorted = dts.slice().sort(function (a, b) { return a - b; });
        var medianDt = dtSorted.length ? dtSorted[Math.floor(dtSorted.length / 2)] : NaN;

        // Period detection: count rate jumps > 1% of max-rate.
        var periodCount = 1;
        var rateForPeriod = ds.q || (ds.phases && (ds.phases.oil || ds.phases.gas || ds.phases.water));
        if (rateForPeriod) {
            var maxRate = Math.max.apply(null, rateForPeriod.map(function (v) { return Math.abs(v) || 0; }));
            var thresh = 0.01 * maxRate;
            for (var k = 1; k < rateForPeriod.length; k++) {
                if (Math.abs(rateForPeriod[k] - rateForPeriod[k - 1]) > thresh) periodCount++;
            }
        } else if (ds.period) {
            periodCount = new Set(ds.period).size;
        }

        var statsHTML = '<div class="rbox" style="margin-bottom:0;">';
        statsHTML += '<div class="rrow"><span class="rl">N points</span><span class="rv">' + N + '</span></div>';
        statsHTML += '<div class="rrow"><span class="rl">Time (h)</span><span class="rv">' + _fmt(tMin, 4) + ' .. ' + _fmt(tMax, 4) + '</span></div>';
        statsHTML += '<div class="rrow"><span class="rl">Median Δt</span><span class="rv">' + _fmt(medianDt, 5) + ' h</span></div>';
        if (ds.p) {
            var pMin = Math.min.apply(null, ds.p), pMax = Math.max.apply(null, ds.p);
            statsHTML += '<div class="rrow"><span class="rl">Pressure (psi)</span><span class="rv">' + _fmt(pMin, 2) + ' .. ' + _fmt(pMax, 2) + '</span></div>';
        }
        if (rateForPeriod) {
            statsHTML += '<div class="rrow"><span class="rl">Periods (auto)</span><span class="rv">' + periodCount + '</span></div>';
        }
        if (st.fileName) statsHTML += '<div class="rrow"><span class="rl">File</span><span class="rv">' + _escapeHTML(st.fileName) + '</span></div>';
        if (st.errors && st.errors.length) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Warnings</span><span class="rv">' + st.errors.length + ' rows skipped</span></div>';
        statsHTML += '</div>';
        statsEl.innerHTML = statsHTML;

        // Preview table — first 10 + last 5.
        var html = '<table class="dtable"><thead><tr>';
        cols.forEach(function (c) { html += '<th>' + _escapeHTML(c.label) + '</th>'; });
        html += '</tr></thead><tbody>';
        var head = Math.min(10, N);
        var tail = N > 15 ? 5 : 0;
        for (var ii = 0; ii < head; ii++) {
            html += '<tr>';
            cols.forEach(function (c) {
                var v = c.values[ii];
                html += '<td>' + (typeof v === 'number' ? _fmt(v, 4) : _escapeHTML(String(v == null ? '' : v))) + '</td>';
            });
            html += '</tr>';
        }
        if (tail) {
            html += '<tr><td colspan="' + cols.length + '" style="text-align:center; color:var(--text3); font-style:italic;">… ' + (N - head - tail) + ' rows omitted …</td></tr>';
            for (var jj = N - tail; jj < N; jj++) {
                html += '<tr>';
                cols.forEach(function (c) {
                    var v2 = c.values[jj];
                    html += '<td>' + (typeof v2 === 'number' ? _fmt(v2, 4) : _escapeHTML(String(v2 == null ? '' : v2))) + '</td>';
                });
                html += '</tr>';
            }
        }
        html += '</tbody></table>';
        prev.innerHTML = html;
    }

    function _escapeHTML(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }


    // =======================================================================
    // SECTION 14 — TAB-SWITCH HOOK
    // =======================================================================
    // Wrap window.PRiSM.setTab so each switch into Tab 1 re-renders the
    // enhanced body. Last-wrapper-wins composes correctly with Agent A's
    // wrapper because we only handle Tab 1.
    // =======================================================================

    function _installTab1Hook() {
        if (!window.PRiSM || typeof window.PRiSM.setTab !== 'function') return false;
        if (window.PRiSM.setTab._prismDataEnhWired) return true;
        var orig = window.PRiSM.setTab;
        var wrapped = function (n) {
            orig(n);
            n = parseInt(n, 10);
            if (n === 1) PRiSM_renderDataTabEnhanced();
        };
        wrapped._prismDataEnhWired = true;
        // Preserve any flags set by upstream wrappers (Agent A's _prismWired).
        for (var k in orig) { try { wrapped[k] = orig[k]; } catch (e) {} }
        window.PRiSM.setTab = wrapped;
        return true;
    }

    if (!_installTab1Hook()) {
        var tries = 0;
        var iv = setInterval(function () {
            tries++;
            if (_installTab1Hook() || tries > 120) clearInterval(iv);
        }, 250);
    }

    // Initial paint — if Tab 1 is already in the DOM (shell mounted), repaint
    // it now. Defer slightly so any late-binding wrappers settle first.
    if (_hasDoc) {
        setTimeout(function () {
            if (_byId('prism_tab_1')) PRiSM_renderDataTabEnhanced();
        }, 0);
    }


    // =======================================================================
    // EXPORT — make a couple of helpers globally callable for other layers
    // and the self-test.
    // =======================================================================
    window.PRiSM_renderDataTabEnhanced = PRiSM_renderDataTabEnhanced;
    window.PRiSM_parseTextEnhanced     = PRiSM_parseTextEnhanced;
    window.PRiSM_autoMapColumns        = PRiSM_autoMapColumns;
    window.PRiSM_convertTime           = PRiSM_convertTime;
    window.PRiSM_convertPressure       = PRiSM_convertPressure;
    window.PRiSM_convertRate           = PRiSM_convertRate;
    window.PRiSM_filterMAD             = PRiSM_filterMAD;
    window.PRiSM_filterMovingAvg       = PRiSM_filterMovingAvg;
    window.PRiSM_filterHampel          = PRiSM_filterHampel;
    window.PRiSM_decimateNth           = PRiSM_decimateNth;
    window.PRiSM_decimateLog           = PRiSM_decimateLog;
    window.PRiSM_decimateTimeBin       = PRiSM_decimateTimeBin;
    window.PRiSM_loadXLSX              = PRiSM_loadXLSX;
    window.PRiSM_parseWorkbook         = PRiSM_parseWorkbook;


    // =======================================================================
    // SELF-TEST
    // =======================================================================
    // === SELF-TEST ===
    (function PRiSM_dataEnhSelfTest() {
        var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];

        // --- Parser test 1: CSV with header
        var t1 = PRiSM_parseTextEnhanced('time,pressure,rate\n0,1000,500\n1,990,500\n2,985,500\n');
        checks.push({ name: 'CSV w/ header parses 3 rows × 3 cols',
            ok: t1.rows.length === 3 && t1.rows[0].length === 3 && t1.headers && t1.headers[0] === 'time' });
        checks.push({ name: 'CSV separator detected as comma',
            ok: t1.sep === 'comma' });

        // --- Parser test 2: whitespace ASCII no header
        var t2 = PRiSM_parseTextEnhanced('0  1000  500\n1  990  500\n2  985  500');
        checks.push({ name: 'Whitespace ASCII: no header, 3 rows',
            ok: t2.rows.length === 3 && t2.headers == null });

        // --- Parser test 3: CSV with units in headers
        var t3 = PRiSM_parseTextEnhanced('time(h),pressure(psi),rate(bbl/d)\n0,1000,500\n1,990,500\n');
        checks.push({ name: 'Units-in-header parses + first row numeric',
            ok: t3.rows.length === 2 && t3.headers && t3.headers[0].indexOf('time') >= 0 });

        // --- Parser test 4: Comments + BOM
        var t4 = PRiSM_parseTextEnhanced('﻿# this is a comment\n# another\ntime,pressure\n0,1000\n1,990\n');
        checks.push({ name: 'Comments + BOM stripped',
            ok: t4.rows.length === 2 && t4.headers && t4.headers[0] === 'time' });

        // --- Auto-map: should pick column 0 = time, 1 = pressure, 2 = rate
        var map1 = PRiSM_autoMapColumns(['time', 'pressure', 'rate'], t1.rows);
        checks.push({ name: 'Auto-map: time/pressure/rate by header',
            ok: map1[0] === 'time' && map1[1] === 'pressure' && map1[2] === 'rate' });

        // --- Auto-map by data shape (no headers): monotone first col, big-range second
        var rowsShape = [];
        for (var i = 0; i < 100; i++) rowsShape.push([i * 0.1, 2000 + i * 5, i % 10 === 0 ? 0 : 500]);
        var mapShape = PRiSM_autoMapColumns(null, rowsShape);
        checks.push({ name: 'Auto-map: shape detects time at col 0',
            ok: mapShape[0] === 'time' });

        // --- Outlier filter test: [1,2,3,4,100,5,6] should drop the 100
        var keep = PRiSM_filterMAD([1, 2, 3, 4, 100, 5, 6], 3);
        checks.push({ name: 'MAD drops the 100 outlier',
            ok: keep[4] === false && keep[0] === true && keep[3] === true });

        // --- Hampel: same vector
        var keepH = PRiSM_filterHampel([1, 2, 3, 4, 100, 5, 6], 5, 3);
        checks.push({ name: 'Hampel drops the 100 outlier',
            ok: keepH[4] === false });

        // --- Moving average: should attenuate the spike
        var ma = PRiSM_filterMovingAvg([1, 2, 3, 4, 100, 5, 6], 5);
        checks.push({ name: 'Moving avg attenuates spike (val < 100)',
            ok: ma[4] < 100 && ma[4] > 5 });

        // --- Log-spaced decimation: 1000 logspace → ~50 points
        var times = [];
        for (var k = 0; k < 1000; k++) times.push(Math.pow(10, -3 + 6 * k / 999));
        var idxAll = times.map(function (_, i) { return i; });
        var picked = PRiSM_decimateLog(times, idxAll, 50);
        checks.push({ name: 'Log decimation: ~50 unique picks from 1000',
            ok: picked.length >= 40 && picked.length <= 60 });
        // First and last preserved
        checks.push({ name: 'Log decimation preserves endpoints',
            ok: picked[0] === 0 && picked[picked.length - 1] === 999 });

        // --- Nth decimation
        var nth = PRiSM_decimateNth(times, idxAll, 10);
        checks.push({ name: 'Nth decimation roughly 1/N',
            ok: nth.length >= 95 && nth.length <= 105 });

        // --- Time-bin decimation (every 5 min ≈ 0.0833h on a 0..1000h range)
        var binIdx = PRiSM_decimateTimeBin([0, 0.5, 1, 1.5, 2, 2.5, 3], [0, 1, 2, 3, 4, 5, 6], 60);
        checks.push({ name: 'Time-bin decimation collapses by 1h bins',
            ok: binIdx.length === 4 /* 0,1,2,3 + endpoint */ || binIdx.length === 5 });

        // --- Unit conversion
        var tConv = PRiSM_convertTime([0, 60, 120], 'min');
        checks.push({ name: 'Time minutes → hours',
            ok: Math.abs(tConv.hours[0]) < 1e-9 && Math.abs(tConv.hours[1] - 1) < 1e-9 && Math.abs(tConv.hours[2] - 2) < 1e-9 });
        var pConv = PRiSM_convertPressure([1, 10], 'bar');
        checks.push({ name: 'Pressure bar → psi (≈ ×14.504)',
            ok: Math.abs(pConv.values[0] - 14.5037738) < 1e-4 });

        // --- Header hash: same headers → same hash
        var h1 = _headerHash(['time', 'p', 'q'], 3);
        var h2 = _headerHash(['time', 'p', 'q'], 3);
        var h3 = _headerHash(['time', 'p', 'r'], 3);
        checks.push({ name: 'Header hash stable + sensitive',
            ok: h1 === h2 && h1 !== h3 });

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM data-enhancements self-test FAILED:', fails);
        } else {
            log('✓ data enhancements self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
