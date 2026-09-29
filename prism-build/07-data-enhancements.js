// =============================================================================
// PRiSM — Layer 07 — Data Tab Enhancements (step ① Data)
// -----------------------------------------------------------------------------
// The normal Tab 1 renderer (the foundation's basic Data tab is only the
// fallback). PRiSM_renderTab(1) in 01-foundation calls
// window.PRiSM_renderDataTabEnhanced directly — no setTab wrapping, no polling.
//
//   1. Loader         — CSV / TSV / TXT / DAT / ASC / XLSX / XLS (XLSX via
//                       SheetJS lazy-loaded from CDN on first use), paste, and
//                       "Try demo data". Reading the data also makes it the
//                       active dataset (no separate "use this data" step).
//   2. Column mapper  — header words first (rate headers before any
//                       shape-based pressure guess), data shape second; per-
//                       column role picker; settings cached per header shape.
//   3. Units          — time → hours (canonical), pressure → psia, liquid
//                       rate → STB/d, gas rate → Mscf/d; units inferred from
//                       headers / date columns; psig and barg offsets.
//   4. Cleanup        — MAD / Hampel outlier masks, moving average,
//                       decimation (Nth / log-spaced / time-bin), time clip.
//   5. Preview        — role-labelled table + summary (N, range, Δt, gaps,
//                       rate periods).
//
// Dataset produced (window.PRiSM_dataset):
//   { t:[h], p:[psia]|null, q:[STB/d | Mscf/d]|null,
//     phases?:{oil,gas,water}, period?:[…], name, source,
//     timeUnit:'h', timeUnitOriginal, rateUnit, ratePhase }
// Rate-only files ({t,q}, p = null) are accepted and offer rate-only
// (decline) analysis.
//
// Exports: PRiSM_renderDataTabEnhanced, PRiSM_doParseData (= commit),
//   PRiSM_doUseData, PRiSM_loadFile(file) → Promise<dataset|null>,
//   PRiSM_datasetFromText(text, meta), PRiSM_parseTextEnhanced,
//   PRiSM_autoMapColumns, PRiSM_inferColumnUnits, PRiSM_convert*,
//   PRiSM_filter*, PRiSM_decimate*, PRiSM_loadXLSX, PRiSM_parseWorkbook.
// Events: 'prism:dataset-loaded' (through window.PRiSM_commitDataset),
//   'prism:dataset-cleared' on Clear.
//
// Persistence: 'wts_prism' (textarea, loadInputs/saveInputs pattern),
// 'wts_prism_mapping_<hash>' (mapping + units + rate phase + cleanup per
// header shape), 'wts_prism_units' (display name of the loaded text).
// =============================================================================

(function () {
    'use strict';

    // -----------------------------------------------------------------------
    // SAFE ACCESSORS — tiny shims so the self-test can run outside the host
    // page (node) without crashing on missing globals.
    // -----------------------------------------------------------------------
    var _hasDoc = (typeof document !== 'undefined');
    var _hasWin = (typeof window !== 'undefined');
    var W = _hasWin ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
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
    var _ls = function () {
        try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
    };

    // Canonical role names. Order drives the column-mapper dropdown; the
    // first entry "" means "ignore this column".
    var ROLES = [
        { v: '',        label: '— ignore —' },
        { v: 'time',    label: 'Time' },
        { v: 'pressure',label: 'Pressure' },
        { v: 'rate',    label: 'Rate' },
        { v: 'rate_o',  label: 'Oil rate' },
        { v: 'rate_g',  label: 'Gas rate' },
        { v: 'rate_w',  label: 'Water rate' },
        { v: 'period',  label: 'Period marker' }
    ];
    var ROLE_LABELS = {
        time: 'Time (h)', pressure: 'Pressure (psia)', rate: 'Rate (STB/d)',
        rate_o: 'Oil (STB/d)', rate_g: 'Gas (Mscf/d)', rate_w: 'Water (STB/d)',
        period: 'Period'
    };

    // Canonical units: hours, psia, STB/d (liquid), Mscf/d (gas).
    var TIME_UNITS = [
        { v: 'h',    label: 'hours',   factor: 1 },
        { v: 's',    label: 'seconds', factor: 1 / 3600 },
        { v: 'min',  label: 'minutes', factor: 1 / 60 },
        { v: 'd',    label: 'days',    factor: 24 },
        { v: 'date', label: 'date / time stamps', factor: null } // special-cased
    ];
    var PRESSURE_UNITS = [
        { v: 'psi',  label: 'psia',   factor: 1,           offset: 0 },
        { v: 'psig', label: 'psig',   factor: 1,           offset: 14.696 },
        { v: 'bar',  label: 'bar(a)', factor: 14.5037738,  offset: 0 },
        { v: 'barg', label: 'barg',   factor: 14.5037738,  offset: 14.696 },
        { v: 'kPa',  label: 'kPa(a)', factor: 0.145037738, offset: 0 },
        { v: 'MPa',  label: 'MPa(a)', factor: 145.037738,  offset: 0 },
        { v: 'atm',  label: 'atm',    factor: 14.6959488,  offset: 0 }
    ];
    var RATE_UNITS_LIQ = [
        { v: 'bbl/d', label: 'STB/d (bbl/d)', factor: 1 },
        { v: 'stb/d', label: 'stb/d',         factor: 1 },
        { v: 'm3/d',  label: 'm³/d',          factor: 6.28981077 },
        { v: 'L/min', label: 'L/min',         factor: 1440 * 0.00628981077 }   // 9.0573 bbl/d
    ];
    var RATE_UNITS_GAS = [
        { v: 'Mscf/d', label: 'Mscf/d',  factor: 1 },
        { v: 'MMscfd', label: 'MMscf/d', factor: 1000 },
        { v: 'scf/d',  label: 'scf/d',   factor: 1e-3 },
        { v: 'm3/d',   label: 'm³/d',    factor: 0.0353146667 }
    ];
    var DEFAULT_UNITS = { time: 'h', pressure: 'psi', rate: 'bbl/d', rate_g: 'Mscf/d' };
    var DEFAULT_CLEANUP = { filter: 'none', decim: 'none', decimN: 5, decimTarget: 200, decimBinMin: 5, tStart: '', tEnd: '' };


    // =======================================================================
    // SECTION 1 — TEXT PARSER (CSV / TSV / DAT / ASC / TXT)
    // =======================================================================
    // Returns { rows: [[numbers…], …], headers: [strings] | null, sep,
    //           dateCols: [bool per column] | null, errors: [...] }.
    //   • strips comment lines starting with #, *, !, //, ;;
    //   • respects double-quoted fields with embedded separators
    //   • keeps "(unit)" / "[unit]" header annotations for unit inference
    //   • date/time stamp columns → ms (UTC); clock columns (hh:mm[:ss]) →
    //     decimal hours with midnight roll-over
    // =======================================================================

    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    var RE_DATE_ISO = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(.*)$/;
    var RE_DATE_DMY = /^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})(.*)$/;
    var RE_DATE_MON = /^(\d{1,2})[-\s]?([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{2,4})(.*)$/;
    var RE_CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/;

    function _unquote(s) {
        var t = String(s == null ? '' : s).trim();
        if (t.length > 1 && t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1).trim();
        return t;
    }

    function _looksDate(s) {
        var t = _unquote(s);
        return RE_DATE_ISO.test(t) || RE_DATE_DMY.test(t) || (RE_DATE_MON.test(t) && !!MONTHS[(t.match(RE_DATE_MON)[2] || '').toLowerCase()]);
    }

    // Date/time cell → ms since epoch (UTC, so no daylight-saving jumps).
    function _parseDateCell(s, dayFirst) {
        var t = _unquote(s);
        var m, y, mo, d, rest = '';
        if ((m = t.match(RE_DATE_ISO))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
        else if ((m = t.match(RE_DATE_DMY))) {
            var a = +m[1], b = +m[2];
            y = +m[3]; if (y < 100) y += 2000;
            if (dayFirst) { d = a; mo = b; } else { mo = a; d = b; }
            rest = m[4];
        } else if ((m = t.match(RE_DATE_MON))) {
            mo = MONTHS[m[2].toLowerCase()];
            if (!mo) return NaN;
            d = +m[1]; y = +m[3]; if (y < 100) y += 2000; rest = m[4];
        } else return NaN;
        if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return NaN;
        var hh = 0, mi = 0, ss = 0;
        var tm = rest.match(/^[T\s,]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(am|pm)?/i);
        if (tm) {
            hh = +tm[1]; mi = +tm[2]; ss = tm[3] ? +tm[3] : 0;
            if (tm[4]) {
                var pm = /pm/i.test(tm[4]);
                if (pm && hh < 12) hh += 12;
                if (!pm && hh === 12) hh = 0;
            }
        } else if (rest.trim() && !/^\s*(Z|[+-]\d{2}:?\d{2})?\s*$/i.test(rest)) {
            return NaN;
        }
        return Date.UTC(y, mo - 1, d, hh, mi, 0) + ss * 1000;
    }

    // Classify each column from its first data cells: 'date' | 'clock' | 'num'.
    function _columnKinds(cellRows, start) {
        var ncols = 0;
        for (var r = start; r < Math.min(cellRows.length, start + 5); r++) ncols = Math.max(ncols, cellRows[r].length);
        var kinds = new Array(ncols).fill('num');
        for (var c = 0; c < ncols; c++) {
            var dates = 0, clocks = 0, seen = 0;
            for (var r2 = start; r2 < Math.min(cellRows.length, start + 5); r2++) {
                var cell = cellRows[r2][c];
                if (cell == null || cell === '') continue;
                seen++;
                if (typeof cell === 'string' && _looksDate(cell)) dates++;
                else if (typeof cell === 'string' && RE_CLOCK.test(_unquote(cell))) clocks++;
            }
            if (seen && dates === seen) kinds[c] = 'date';
            else if (seen && clocks === seen) kinds[c] = 'clock';
        }
        return kinds;
    }

    // Day-first or month-first for a d/m/y column (day-first when ambiguous).
    function _dayFirst(cellRows, start, c) {
        for (var r = start; r < cellRows.length; r++) {
            var m = _unquote(cellRows[r][c]).match(RE_DATE_DMY);
            if (!m) continue;
            if (+m[1] > 12) return true;
            if (+m[2] > 12) return false;
        }
        return true;
    }

    // Cells → numeric rows (shared by the text and workbook paths).
    function _rowsFromCells(cellRows, start, decimalComma) {
        var kinds = _columnKinds(cellRows, start);
        var dayFirst = kinds.map(function (k, c) { return k === 'date' ? _dayFirst(cellRows, start, c) : false; });
        var expectedLen = cellRows[start] ? cellRows[start].length : 0;
        var rows = [], errors = [];
        for (var r = start; r < cellRows.length; r++) {
            var cells = cellRows[r];
            if (!cells || cells.length < 2) { errors.push('Row ' + (r + 1) + ': < 2 columns'); continue; }
            var nums = cells.map(function (cv, c) {
                if (typeof cv === 'number') return cv;
                if (kinds[c] === 'date') return _parseDateCell(cv, dayFirst[c]);
                if (kinds[c] === 'clock') {
                    var m = _unquote(cv).match(RE_CLOCK);
                    return m ? (+m[1] + (+m[2]) / 60 + (m[3] ? +m[3] / 3600 : 0)) : NaN;
                }
                return _parseNumberLoose(cv, decimalComma);
            });
            if (nums.every(function (n) { return n == null || isNaN(n); })) {
                errors.push('Row ' + (r + 1) + ': all cells non-numeric');
                continue;
            }
            while (nums.length < expectedLen) nums.push(NaN);
            if (nums.length > expectedLen) nums.length = expectedLen;
            rows.push(nums);
        }
        // Clock columns roll over at midnight → keep them increasing.
        kinds.forEach(function (k, c) {
            if (k !== 'clock') return;
            var add = 0, prev = null;
            rows.forEach(function (row) {
                var v = row[c];
                if (!isFinite(v)) return;
                if (prev != null && v + add < prev - 12) add += 24;
                row[c] = v + add;
                prev = row[c];
            });
        });
        var dateCols = kinds.map(function (k) { return k === 'date'; });
        return { rows: rows, errors: errors, dateCols: dateCols.some(Boolean) ? dateCols : null, kinds: kinds };
    }

    function _isHeaderCell(cell) {
        if (typeof cell === 'number') return false;
        var s = _unquote(cell);
        var stripped = s.replace(/[\(\[].*?[\)\]]/g, '').trim();
        if (!stripped.length) return true;
        if (_looksDate(stripped) || RE_CLOCK.test(stripped)) return false;
        return isNaN(parseFloat(stripped));
    }

    function PRiSM_parseTextEnhanced(text) {
        if (typeof text !== 'string') return { rows: [], headers: null, sep: 'n/a', dateCols: null, errors: ['Empty input'] };

        // Strip BOM + normalise line endings.
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        var rawLines = text.split(/\r\n|\r|\n/);

        // Filter comments + empty lines.
        var lines = [];
        for (var i = 0; i < rawLines.length; i++) {
            var ln = rawLines[i].trim();
            if (!ln.length) continue;
            if (ln.charAt(0) === '#' || ln.charAt(0) === '*' ||
                ln.charAt(0) === '!' || ln.indexOf('//') === 0 ||
                ln.indexOf(';;') === 0) continue;
            lines.push(ln);
        }
        if (!lines.length) return { rows: [], headers: null, sep: 'n/a', dateCols: null, errors: ['Empty input'] };

        // Detect the separator from the first 5 lines — highest consistent
        // column count wins. Whitespace is tried last because date/time
        // stamps contain spaces.
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
            if (counts.some(function (n) { return n < 2; })) continue;
            var avg = counts.reduce(function (a, b) { return a + b; }, 0) / counts.length;
            var consistent = counts.every(function (n) { return n === counts[0]; });
            var score = avg + (consistent ? 0.5 : 0);
            // "0,01;3861,4": semicolon-separated with decimal commas.
            if (cand.name === 'semicolon' && consistent && sample.every(function (l) { return l.indexOf(';') >= 0; })) score += 100;
            if (cand.name === 'whitespace' && bestSep) score = -1;   // only as a last resort
            if (score > bestScore) { bestScore = score; bestSep = cand; }
        }
        if (!bestSep) {
            return { rows: [], headers: null, sep: 'n/a', dateCols: null, errors: ['Could not detect a column separator'] };
        }

        var parsed = lines.map(function (l) {
            return _splitRespectQuotes(l, bestSep.re).map(function (s) { return s.trim(); });
        });

        // Header: the first row counts as a header if any cell is neither a
        // number nor a date / clock stamp. "0(s)" still counts as numeric.
        var first = parsed[0];
        var headers = null;
        var dataStart = 0;
        if (first.some(_isHeaderCell)) {
            headers = first.map(_unquote);
            dataStart = 1;
        }

        var built = _rowsFromCells(parsed, dataStart, bestSep.name !== 'comma');
        return { rows: built.rows, headers: headers, sep: bestSep.name, dateCols: built.dateCols, errors: built.errors };
    }

    // Split a single line respecting double-quoted fields. The separator may
    // be a regex; we don't try to be a full RFC-4180 parser, just handle the
    // common spreadsheet-export patterns. Empty fields ("1,,3") are kept so
    // later columns do not shift; only whitespace-separated lines drop them.
    function _splitRespectQuotes(line, sep) {
        var ws = sep && sep.source === '\\s+';
        var keep = function (arr) { return ws ? arr.filter(function (s) { return s.length > 0; }) : arr; };
        if (line.indexOf('"') < 0) {
            return keep(line.split(sep).map(function (s) { return s.trim(); }));
        }
        var out = [];
        var cur = '';
        var inQuote = false;
        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);
            if (ch === '"') {
                if (inQuote && line.charAt(i + 1) === '"') { cur += '"'; i++; }
                else inQuote = !inQuote;
                continue;
            }
            if (!inQuote) {
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
        return keep(out);
    }

    // Parse a number that might have a trailing unit ("12.3 psi") or commas
    // as thousands separators ("1,234.5"). decimalComma (files whose column
    // separator is not a comma) reads "3861,4" as 3861.4.
    function _parseNumberLoose(s, decimalComma) {
        if (s == null) return NaN;
        var t = String(s).trim();
        if (!t.length) return NaN;
        if (t.charAt(0) === '"' && t.charAt(t.length - 1) === '"') t = t.slice(1, -1);
        if (decimalComma) {
            var dm = t.match(/^([\-\+]?\d+,\d+(?:[eE][\-\+]?\d+)?)\s*[a-zA-Z%/³²]*$/);
            if (dm) return parseFloat(dm[1].replace(',', '.'));
        }
        var m = t.match(/^([\-\+]?\d[\d,]*(?:\.\d+)?(?:[eE][\-\+]?\d+)?)\s*[a-zA-Z%/³²]*$/);
        if (m) return parseFloat(m[1].replace(/,/g, ''));
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
        if (!_hasWin || !_hasDoc) return Promise.reject(new Error('No window'));
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
                s.onerror = function () { _xlsxLoadPromise = null; reject(new Error('Network blocked SheetJS')); };
                document.head.appendChild(s);
            } catch (e) {
                _xlsxLoadPromise = null;
                reject(e);
            }
        });
        return _xlsxLoadPromise;
    }

    // Parse a workbook ArrayBuffer with SheetJS. Returns
    // { sheets: [{name, rows, headers, dateCols}], defaultIdx }.
    function PRiSM_parseWorkbook(arrayBuffer) {
        if (!window.XLSX) throw new Error('XLSX not loaded');
        var wb = window.XLSX.read(arrayBuffer, { type: 'array' });
        var out = [];
        wb.SheetNames.forEach(function (name) {
            var ws = wb.Sheets[name];
            var aoa = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
            aoa = aoa.filter(function (r) {
                return r.some(function (c) { return c !== '' && c != null; });
            });
            if (!aoa.length) {
                out.push({ name: name, rows: [], headers: null, dateCols: null, empty: true });
                return;
            }
            var first = aoa[0];
            var headerLikely = first.some(function (cell) { return cell === '' || cell == null || _isHeaderCell(cell); });
            var headers = headerLikely ? first.map(function (c) { return String(c == null ? '' : c); }) : null;
            var cells = aoa.map(function (r) { return r.map(function (c) { return (typeof c === 'number') ? c : String(c == null ? '' : c); }); });
            var built = _rowsFromCells(cells, headerLikely ? 1 : 0);
            out.push({ name: name, rows: built.rows, headers: headers, dateCols: built.dateCols, empty: built.rows.length === 0 });
        });
        var def = out.findIndex(function (s) { return !s.empty; });
        if (def < 0) def = 0;
        return { sheets: out, defaultIdx: def };
    }


    // =======================================================================
    // SECTION 3 — COLUMN AUTO-MAPPER + UNIT INFERENCE
    // =======================================================================
    // Header words decide first. A column whose header names a rate is never
    // taken as pressure by shape; shape scoring only applies to columns with
    // no recognisable header (or to header-less files).
    // =======================================================================

    var RE_EXCL   = /\b(gor|glr|wor|cut|wc|wcut|watercut|ratio|bsw|api|temp|temperature|choke|density|sg|salinity|depth|tvd|comments?|notes?|flag|status|cum|cumulative|np|gp|wp|volume|total)\b/;
    var RE_PERIOD = /\b(period|stage|interval|event|flowperiod)\b/;
    var RE_TIME   = /\b(time|t|elapsed|etime|hours?|hrs?|hr|h|minutes?|mins?|seconds?|secs?|days?|date|datetime|timestamp|dt|delta t|epoch)\b/;
    var RE_PRES   = /\b(p|pres|press|pressure|pwf|pws|pwh|bhp|fbhp|sbhp|bhfp|whp|fwhp|swhp|thp|ftp|psia?|psig|barg?|bara|kpa|mpa|gauge|gage|bottomhole)\b/;
    var RE_PRES_BH = /\b(p|pwf|pws|bhp|fbhp|sbhp|bhfp|bottomhole|gauge|gage)\b/;
    var RE_RATE   = /\b(rate|q|flow|flowrate|prod|production|liquid|liq|ql|qliq|qt|bpd|bfpd|blpd|stbd|stb|bbl|m3d)\b/;
    var RE_OIL    = /\b(qo|oil|bopd|stbo)\b/;
    var RE_GAS    = /\b(qg|gas|mscf|mscfd|mmscf|mmscfd|scf|scfd|mcf|mcfd|mmcfd)\b/;
    var RE_WAT    = /\b(qw|water|wat|bwpd)\b/;

    // Header → {raw, words, unit}: unit = text inside ()/[]; words = the rest,
    // camelCase split, lower-cased, punctuation → spaces, Δ → "delta ".
    function _normHeader(h) {
        var raw = String(h == null ? '' : h);
        var um = raw.match(/[\(\[]([^\)\]]*)[\)\]]/);
        var unit = um ? um[1].toLowerCase().replace(/\s+/g, ' ').trim() : '';
        var words = raw.replace(/[\(\[].*?[\)\]]/g, ' ')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .toLowerCase()
            .replace(/[δΔ]/g, 'delta ')
            .replace(/[_\-.,:;\/\\|#*+=~]+/g, ' ')
            .replace(/\s+/g, ' ').trim();
        return { raw: raw, words: words, unit: unit };
    }

    // Header → role scores ({} when unrecognised, {ignore:1} for
    // non-rate/pressure quantities such as GOR or water cut).
    function _headerRoles(h) {
        var w = _normHeader(h).words;
        if (!w) return {};
        if (RE_EXCL.test(w)) return { ignore: 1 };
        if (RE_PERIOD.test(w)) return { period: 10 };
        var isT = RE_TIME.test(w), isP = RE_PRES.test(w), isR = RE_RATE.test(w);
        var isO = RE_OIL.test(w), isG = RE_GAS.test(w), isW = RE_WAT.test(w);
        var anyRate = isR || isO || isG || isW;
        var s = {};
        if (/\b(time|date|datetime|timestamp)\b/.test(w) || (isT && !isP && !anyRate)) { s.time = 10; return s; }
        if (isP && !isR) { s.pressure = RE_PRES_BH.test(w) ? 11 : 9; return s; }
        if (isO) s.rate_o = 12;
        if (isG) s.rate_g = 12;
        if (isW) s.rate_w = 12;
        if (isR) s.rate = 10;
        return s;
    }

    // Data-shape scores for a column (used only without a header match).
    function _shapeScore(col) {
        var s = {};
        var clean = col.filter(function (v) { return isFinite(v); });
        if (clean.length < 2) return s;
        var n = clean.length;
        var min = Math.min.apply(null, clean), max = Math.max.apply(null, clean);
        var mono = true;
        for (var i = 1; i < clean.length; i++) {
            if (clean[i] < clean[i - 1] - 1e-12) { mono = false; break; }
        }
        if (mono && (max - min) > 0) s.time = 3;
        var zeros = clean.filter(function (v) { return Math.abs(v) < 1e-12; }).length;
        var positives = clean.filter(function (v) { return v > 0; }).length;
        if (zeros >= 0.05 * n && positives >= 0.3 * n) s.rate = 2;
        var uniques = new Set(clean.map(function (v) { return Math.round(v * 100) / 100; })).size;
        if (min >= 0.1 && max <= 1e6 && uniques > Math.min(50, n / 4)) s.pressure = 2;
        if (uniques <= 10 && Number.isInteger(min) && Number.isInteger(max)) s.period = 1;
        return s;
    }

    function PRiSM_autoMapColumns(headers, rows, dateCols) {
        rows = rows || [];
        var ncols = (rows[0]) ? rows[0].length : (headers ? headers.length : 0);
        var map = new Array(ncols).fill('');
        if (!ncols) return map;
        var hs = [], ss = [], known = [];
        for (var c = 0; c < ncols; c++) {
            var h = headers ? _headerRoles(headers[c]) : {};
            if (dateCols && dateCols[c]) h = { time: 11 };
            hs.push(h);
            known.push(Object.keys(h).length > 0);
            ss.push(_shapeScore(rows.map(function (r) { return r[c]; })));
        }
        var taken = new Array(ncols).fill(false);
        var best = function (scoreFn) {
            var bc = -1, bs = 0;
            for (var c2 = 0; c2 < ncols; c2++) {
                if (taken[c2]) continue;
                var s = scoreFn(c2) || 0;
                if (s > bs) { bs = s; bc = c2; }
            }
            return bc;
        };
        var assign = function (c3, role) {
            if (c3 < 0) return false;
            map[c3] = role; taken[c3] = true;
            return true;
        };
        var has = function (roles) { return map.some(function (r) { return roles.indexOf(r) !== -1; }); };

        // 1. Time — header, else the monotone column among unrecognised ones.
        if (!assign(best(function (k) { return hs[k].time; }), 'time')) {
            assign(best(function (k) { return known[k] ? 0 : ss[k].time; }), 'time');
        }
        // 2. Rates named in headers — phase-specific first, then generic.
        ['rate_o', 'rate_g', 'rate_w'].forEach(function (r) { assign(best(function (k) { return hs[k][r]; }), r); });
        assign(best(function (k) { return hs[k].rate; }), 'rate');
        // 3. Pressure — header, else shape among unrecognised columns that do
        //    not look more like a rate.
        if (!assign(best(function (k) { return hs[k].pressure; }), 'pressure')) {
            assign(best(function (k) {
                if (known[k]) return 0;
                var p = ss[k].pressure || 0, r = ss[k].rate || 0;
                return p > r ? p : 0;
            }), 'pressure');
        }
        // 4. Rate by shape (unrecognised columns) when no rate is mapped yet.
        if (!has(['rate', 'rate_o', 'rate_g', 'rate_w'])) {
            assign(best(function (k) { return known[k] ? 0 : ss[k].rate; }), 'rate');
        }
        // 5. Period marker — header only.
        assign(best(function (k) { return hs[k].period; }), 'period');
        // 6. Header-less files keep the classic order time, pressure, rate.
        if (!headers) {
            if (!has(['time']) && !taken[0]) assign(0, 'time');
            if (!has(['pressure']) && ncols > 1 && !taken[1] && !has(['rate', 'rate_o', 'rate_g', 'rate_w'])) assign(1, 'pressure');
            if (!has(['rate', 'rate_o', 'rate_g', 'rate_w']) && ncols > 2 && !taken[2]) assign(2, 'rate');
        }
        if (!has(['time']) && !taken[0] && !known[0]) assign(0, 'time');
        return map;
    }

    // Unit hints from one header ("time (d)", "BHP psig", "Gas (MMscf/d)").
    function _unitHints(header) {
        var n = _normHeader(header);
        var u = n.unit, w = n.words, all = (u + ' ' + w).trim();
        var hint = {};
        if (/\b(date|datetime|timestamp)\b/.test(w)) hint.time = 'date';
        else if (/\b(days?|d)\b/.test(u) || /\bdays?\b/.test(w)) hint.time = 'd';
        else if (/\b(hours?|hrs?|hr|h)\b/.test(u) || /\b(hours?|hrs?)\b/.test(w)) hint.time = 'h';
        else if (/\b(minutes?|mins?|min)\b/.test(u) || /\b(minutes?|mins?)\b/.test(w)) hint.time = 'min';
        else if (/\b(seconds?|secs?|sec|s)\b/.test(u) || /\b(seconds?|secs?)\b/.test(w)) hint.time = 's';
        if (/\bpsig\b/.test(all)) hint.pressure = 'psig';
        else if (/\bpsia?\b/.test(all)) hint.pressure = 'psi';
        else if (/\bbarg\b/.test(all)) hint.pressure = 'barg';
        else if (/\bbara?\b/.test(all)) hint.pressure = 'bar';
        else if (/\bkpa\b/.test(all)) hint.pressure = 'kPa';
        else if (/\bmpa\b/.test(all)) hint.pressure = 'MPa';
        else if (/\batm\b/.test(all)) hint.pressure = 'atm';
        if (/\bmmscf|\bmmcf/.test(all)) hint.rateGas = 'MMscfd';
        else if (/\bmscf|\bmcf/.test(all)) hint.rateGas = 'Mscf/d';
        else if (/\bscf/.test(all)) hint.rateGas = 'scf/d';
        if (/\b(s?m3|m³)/.test(all)) { hint.rateLiq = 'm3/d'; if (!hint.rateGas) hint.rateGasM3 = true; }
        else if (/\b(bbl|stb|bopd|bwpd|bpd|bfpd|blpd|stbd)\b/.test(all)) hint.rateLiq = 'bbl/d';
        else if (/\b(l min|lpm)\b/.test(all) || /\bl\/min\b/.test(u)) hint.rateLiq = 'L/min';
        return hint;
    }

    // Units implied by the headers of the mapped columns.
    // → { units:{time?,pressure?,rate?,rate_g?}, source:{…:'header'|'data'},
    //     genericIsGas:bool }
    function PRiSM_inferColumnUnits(headers, mapping, dateCols) {
        var units = {}, source = {}, genericIsGas = false;
        (mapping || []).forEach(function (role, c) {
            if (!role) return;
            var hint = headers ? _unitHints(headers[c]) : {};
            if (role === 'time') {
                if (dateCols && dateCols[c]) { units.time = 'date'; source.time = 'data'; }
                else if (hint.time) { units.time = hint.time; source.time = 'header'; }
            } else if (role === 'pressure') {
                if (hint.pressure && !units.pressure) { units.pressure = hint.pressure; source.pressure = 'header'; }
            } else if (role === 'rate_g') {
                if (hint.rateGas && !units.rate_g) { units.rate_g = hint.rateGas; source.rate_g = 'header'; }
                else if (hint.rateGasM3 && !units.rate_g) { units.rate_g = 'm3/d'; source.rate_g = 'header'; }
            } else if (role === 'rate' && hint.rateGas && !hint.rateLiq) {
                genericIsGas = true;
                if (!units.rate_g) { units.rate_g = hint.rateGas; source.rate_g = 'header'; }
            } else if (role === 'rate' || role === 'rate_o' || role === 'rate_w') {
                if (hint.rateLiq && !units.rate) { units.rate = hint.rateLiq; source.rate = 'header'; }
            }
        });
        return { units: units, source: source, genericIsGas: genericIsGas };
    }

    // FNV-1a 32-bit.
    function _fnv(s) {
        var h = 0x811C9DC5;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h * 0x01000193) >>> 0;
        }
        return h.toString(16);
    }

    // Hash a header signature so settings can be kept per file shape.
    function _headerHash(headers, ncols) {
        var s = (headers || []).slice(0, ncols).map(function (h) {
            return String(h || '').toLowerCase().trim();
        }).join('|') + '#' + ncols;
        return _fnv(s);
    }


    // =======================================================================
    // SECTION 4 — UNIT CONVERSION + DATE PARSING
    // =======================================================================

    function PRiSM_convertTime(rawCol, unit) {
        // Returns { hours: [...], factor: number, fromDate: bool }.
        var u = TIME_UNITS.find(function (x) { return x.v === unit; }) || TIME_UNITS[0];
        if (u.v === 'date') {
            // Numbers: Excel serial days (25 500 – 80 000) or ms since epoch;
            // strings: Date.parse. Hours are measured from the earliest stamp.
            var ms = rawCol.map(function (v) {
                if (typeof v === 'number' && isFinite(v)) {
                    if (v > 25500 && v < 80000) return (v - 25569) * 86400000;
                    return v;
                }
                var t = Date.parse(v);
                return isFinite(t) ? t : NaN;
            });
            var origin = Infinity;
            for (var i = 0; i < ms.length; i++) if (isFinite(ms[i]) && ms[i] < origin) origin = ms[i];
            if (!isFinite(origin)) return { hours: rawCol.slice(), factor: 1, fromDate: true, error: 'no parseable dates' };
            var hours = ms.map(function (m) { return (m - origin) / 3600000; });
            return { hours: hours, factor: 1 / 3600000, fromDate: true, originMs: origin };
        }
        return {
            hours: rawCol.map(function (v) { return v * u.factor; }),
            factor: u.factor,
            fromDate: false
        };
    }

    function PRiSM_convertPressure(col, unit) {
        var u = PRESSURE_UNITS.find(function (x) { return x.v === unit; }) || PRESSURE_UNITS[0];
        return { values: col.map(function (v) { return v * u.factor + u.offset; }), factor: u.factor, offset: u.offset };
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
    // deviations of the median. Default k = 5 (conservative).
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

    // Moving average (low-pass). Returns a NEW array same length; edge points
    // use shorter windows.
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

    // Hampel filter — windowed MAD-based outlier mask (true = keep).
    function PRiSM_filterHampel(values, win, k) {
        if (win == null) win = 7;
        if (k == null) k = 3;
        var half = Math.floor(win / 2);
        var n = values.length;
        var keep = new Array(n).fill(true);
        for (var i = 0; i < n; i++) {
            var wnd = [];
            for (var j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
                if (isFinite(values[j])) wnd.push(values[j]);
            }
            if (wnd.length < 3) continue;
            wnd.sort(function (a, b) { return a - b; });
            var med = wnd[Math.floor(wnd.length / 2)];
            var devs = wnd.map(function (v) { return Math.abs(v - med); }).sort(function (a, b) { return a - b; });
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
            var bestIdx = 0, bestD = Infinity;
            for (var j = 0; j < indices.length; j++) {
                var d = Math.abs(times[indices[j]] - tt);
                if (d < bestD) { bestD = d; bestIdx = j; }
            }
            if (!seen.has(bestIdx)) { seen.add(bestIdx); picked.push(indices[bestIdx]); }
        }
        if (picked[0] !== indices[0]) picked.unshift(indices[0]);
        if (picked[picked.length - 1] !== indices[indices.length - 1]) picked.push(indices[indices.length - 1]);
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
        if (out[out.length - 1] !== indices[indices.length - 1]) out.push(indices[indices.length - 1]);
        return out;
    }


    // =======================================================================
    // SECTION 6 — STATE + PERSISTENCE
    // =======================================================================

    var _st = null;
    function _getState() {
        if (!_st) {
            _st = {
                source: null,        // 'paste' | 'workbook'
                fileName: null,
                workbook: null,      // {sheets, defaultIdx}
                sheetIdx: 0,
                rawRows: null,
                headers: null,
                dateCols: null,
                mapping: null,       // [role per column]
                hash: null,
                units: Object.assign({}, DEFAULT_UNITS),
                unitSource: {},
                genericIsGas: false,
                ratePhase: 'auto',
                cleanup: Object.assign({}, DEFAULT_CLEANUP),
                lastApplied: null,   // last built dataset (preview)
                sorted: false,
                errors: []
            };
        }
        return _st;
    }

    function _resetState() { _st = null; return _getState(); }

    function _loadShapeSettings(hash) {
        var ls = _ls();
        if (!ls || !hash) return null;
        try {
            var raw = ls.getItem('wts_prism_mapping_' + hash);
            if (!raw) return null;
            var o = JSON.parse(raw);
            if (Array.isArray(o)) return { mapping: o };      // older builds stored the mapping only
            return (o && typeof o === 'object') ? o : null;
        } catch (e) { return null; }
    }

    function _saveShapeSettings(st) {
        var ls = _ls();
        if (!ls || !st.hash) return;
        try {
            ls.setItem('wts_prism_mapping_' + st.hash, JSON.stringify({
                v: 2, mapping: st.mapping, units: st.units, ratePhase: st.ratePhase, cleanup: st.cleanup
            }));
        } catch (e) { /* ignore */ }
    }

    // Display name of a text (file name / "Demo data"), kept by content hash.
    function _rememberName(text, name) {
        var st = _getState();
        st.nameFor = { hash: _fnv(String(text || '')), name: name };
        var ls = _ls();
        if (ls) { try { ls.setItem('wts_prism_units', JSON.stringify({ v: 2, name: name, hash: st.nameFor.hash })); } catch (e) { /* ignore */ } }
    }
    function _nameForText(text) {
        var st = _getState();
        var h = _fnv(String(text || ''));
        if (st.nameFor && st.nameFor.hash === h) return st.nameFor.name;
        var ls = _ls();
        if (ls) {
            try {
                var o = JSON.parse(ls.getItem('wts_prism_units') || 'null');
                if (o && o.hash === h && o.name) { st.nameFor = { hash: h, name: o.name }; return o.name; }
            } catch (e) { /* ignore */ }
        }
        return null;
    }

    // Persist the Data-tab text without needing the textarea on screen.
    function _persistText(text) {
        var ls = _ls();
        if (!ls) return;
        try {
            var o = {};
            var raw = ls.getItem('wts_prism');
            if (raw) { try { o = JSON.parse(raw); } catch (e) { o = {}; } }
            if (!o || typeof o !== 'object' || Array.isArray(o)) o = {};
            o.prism_data_paste = String(text == null ? '' : text);
            ls.setItem('wts_prism', JSON.stringify(o));
        } catch (e) { /* ignore */ }
    }

    // Adopt parsed rows into the state: mapping (cached per header shape or
    // auto), units (cached, else inferred from headers), rate phase, cleanup.
    function _adoptRows(st, rows, headers, dateCols, errors) {
        st.rawRows = rows;
        st.headers = headers || null;
        st.dateCols = dateCols || null;
        st.errors = errors || [];
        var ncols = rows[0] ? rows[0].length : (headers ? headers.length : 0);
        st.hash = _headerHash(st.headers, ncols);
        var saved = _loadShapeSettings(st.hash);
        var auto = PRiSM_autoMapColumns(st.headers, rows, st.dateCols);
        st.mapping = (saved && Array.isArray(saved.mapping) && saved.mapping.length === ncols) ? saved.mapping.slice() : auto;
        var inf = PRiSM_inferColumnUnits(st.headers, st.mapping, st.dateCols);
        st.units = Object.assign({}, DEFAULT_UNITS, inf.units, (saved && saved.units) || {});
        st.unitSource = Object.assign({}, inf.source);
        if (saved && saved.units) Object.keys(saved.units).forEach(function (k) { st.unitSource[k] = 'saved'; });
        st.genericIsGas = !!inf.genericIsGas;
        st.ratePhase = (saved && saved.ratePhase) || 'auto';
        st.cleanup = Object.assign({}, DEFAULT_CLEANUP, (saved && saved.cleanup) || {});
    }

    function _adoptText(text) {
        var st = _getState();
        var res = PRiSM_parseTextEnhanced(String(text == null ? '' : text));
        if (!res.rows.length) { st.parseErrors = res.errors; return false; }
        st.source = 'paste';
        st.workbook = null;
        st.sheetIdx = 0;
        st.sep = res.sep;
        _adoptRows(st, res.rows, res.headers, res.dateCols, res.errors);
        return true;
    }

    function _adoptSheet(st) {
        var s = st.workbook && st.workbook.sheets[st.sheetIdx];
        if (!s) return false;
        _adoptRows(st, s.rows.slice(), s.headers ? s.headers.slice() : null, s.dateCols, []);
        return s.rows.length > 0;
    }

    // Make ds the active dataset (single commit path in 01-foundation).
    function _commit(ds, source) {
        if (typeof W.PRiSM_commitDataset === 'function') return W.PRiSM_commitDataset(ds, { source: source });
        W.PRiSM_dataset = ds;
        try {
            if (typeof W.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                W.dispatchEvent(new CustomEvent('prism:dataset-loaded', { detail: { source: source, dataset: ds } }));
            }
        } catch (e) { /* CustomEvent not supported */ }
        return ds;
    }

    function _setMsg(html) {
        var msg = _byId('prism_data_msg');
        if (msg) msg.innerHTML = html;
    }

    function _activeStatusHTML() {
        var ds = W.PRiSM_dataset;
        if (!ds || !ds.t || !ds.t.length) return '';
        return '<span style="color:var(--text2);">Active dataset: <b style="color:var(--text);">' +
            _escapeHTML(ds.name || 'Data') + '</b> · ' + ds.t.length + ' points' +
            (ds.p ? '' : ' (rates only)') + '.</span>';
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
            + '  <div style="min-width:0;">'
            // ── Loader card ──
            + '    <div class="card" id="prism_load_card">'
            + '      <div class="card-title">Load Data</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px; line-height:1.5;">'
            + '        Choose a CSV / TSV / TXT / DAT / ASC / XLSX file or paste from a spreadsheet.'
            + '        Header, separator, column roles and units are detected, and the data is'
            + '        used as soon as it is read — check the mapping and units below.'
            + '      </div>'
            + '      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:10px;">'
            + '        <input type="file" id="prism_data_file" accept=".csv,.tsv,.txt,.dat,.asc,.xls,.xlsx" style="font-size:12px; color:var(--text2); max-width:100%;">'
            + '        <span id="prism_data_filename" style="font-size:12px; color:var(--text3); overflow-wrap:anywhere;"></span>'
            + '      </div>'
            + '      <textarea id="prism_data_paste" class="data-textarea" aria-label="Pasted data" style="min-height:160px; font-family:monospace; font-size:12px; width:100%;" placeholder="time,pressure,rate&#10;0.01,3861.4,850&#10;0.02,3705.0,850"></textarea>'
            + '      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">'
            + '        <button class="btn btn-primary" id="prism_data_parse" type="button">Load data</button>'
            + '        <button class="btn btn-secondary" id="prism_data_demo" type="button">Try demo data</button>'
            + '        <button class="btn btn-secondary" id="prism_data_clear" type="button">Clear</button>'
            + '      </div>'
            + '      <div id="prism_data_msg" role="status" aria-live="polite" style="margin-top:8px; font-size:12px; color:var(--text2);"></div>'
            + '      <div id="prism_rateonly_banner" class="info-bar" style="display:none; margin:10px 0 0;">'
            + '        This file has rates but no pressure column, so it looks like production data.'
            + '        <div style="margin-top:8px;"><button class="btn btn-secondary" id="prism_rateonly_switch" type="button">Analyse as rate-only (decline)</button></div>'
            + '      </div>'
            + '    </div>'

            // ── Sheet picker (only when a workbook is loaded) ──
            + '    <div class="card" id="prism_sheet_card" style="display:' + (st.workbook ? 'block' : 'none') + ';">'
            + '      <div class="card-title">Workbook Sheet</div>'
            + '      <div class="fg"><div class="fg-item"><label for="prism_sheet_pick">Active sheet</label>'
            + '      <select id="prism_sheet_pick"></select></div></div>'
            + '    </div>'

            // ── Column mapper ──
            + '    <div class="card" id="prism_map_card" style="display:none;">'
            + '      <div class="card-title">Column Mapping</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        What each column holds. Your choice is remembered for files with the same headers.'
            + '      </div>'
            + '      <div id="prism_map_grid" style="display:flex; flex-wrap:wrap; gap:10px;"></div>'
            + '      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap;">'
            + '        <button class="btn btn-primary" id="prism_map_apply" type="button">Apply mapping</button>'
            + '        <button class="btn btn-secondary" id="prism_map_reset" type="button">Detect again</button>'
            + '      </div>'
            + '    </div>'

            // ── Units ──
            + '    <div class="card" id="prism_units_card" style="display:none;">'
            + '      <div class="card-title">Units</div>'
            + '      <div style="display:flex; flex-wrap:wrap; gap:10px;">'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_time">Time</label><select id="prism_unit_time"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_pressure">Pressure</label><select id="prism_unit_pressure"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_rate">Rate (liquid)</label><select id="prism_unit_rate"></select></div>'
            + '        <div class="fg-item" style="flex:1 1 130px; min-width:0;"><label for="prism_unit_rate_g">Rate (gas)</label><select id="prism_unit_rate_g"></select></div>'
            + '        <div class="fg-item" id="prism_rate_phase_item" style="flex:1 1 150px; min-width:0; display:none;"><label for="prism_rate_phase">Rate used for analysis</label><select id="prism_rate_phase"></select></div>'
            + '      </div>'
            + '      <div id="prism_unit_msg" style="margin-top:8px; font-size:12px; color:var(--text3); line-height:1.5;"></div>'
            + '    </div>'

            // ── Cleanup ──
            + '    <div class="card" id="prism_clean_card" style="display:none;">'
            + '      <div class="card-title">Cleanup</div>'
            + '      <div style="display:flex; flex-wrap:wrap; gap:10px;">'
            + '        <div class="fg-item" style="flex:1 1 160px; min-width:0;"><label for="prism_clean_filter">Filter</label>'
            + '          <select id="prism_clean_filter">'
            + '            <option value="none">none</option>'
            + '            <option value="mad">Outlier removal (MAD)</option>'
            + '            <option value="ma">Low-pass (5-pt moving average)</option>'
            + '            <option value="hampel">Hampel (median outlier)</option>'
            + '          </select></div>'
            + '        <div class="fg-item" style="flex:1 1 160px; min-width:0;"><label for="prism_clean_decim">Thin out points</label>'
            + '          <select id="prism_clean_decim">'
            + '            <option value="none">none</option>'
            + '            <option value="nth">Every Nth point</option>'
            + '            <option value="log">Log-spaced (target N)</option>'
            + '            <option value="bin">One point per X minutes</option>'
            + '          </select></div>'
            + '        <div class="fg-item" style="flex:1 1 100px; min-width:0;"><label for="prism_clean_decimN">N / target</label>'
            + '          <input id="prism_clean_decimN" type="number" min="2" value="5" step="1"></div>'
            + '        <div class="fg-item" style="flex:1 1 100px; min-width:0;"><label for="prism_clean_bin">X (min)</label>'
            + '          <input id="prism_clean_bin" type="number" min="0.1" value="5" step="0.5"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px; min-width:0;"><label for="prism_clean_tstart">Time start (h)</label>'
            + '          <input id="prism_clean_tstart" type="number" step="any" placeholder="(min)"></div>'
            + '        <div class="fg-item" style="flex:1 1 110px; min-width:0;"><label for="prism_clean_tend">Time end (h)</label>'
            + '          <input id="prism_clean_tend" type="number" step="any" placeholder="(max)"></div>'
            + '      </div>'
            + '      <div style="margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">'
            + '        <button class="btn btn-secondary" id="prism_clean_preview" type="button">Preview</button>'
            + '        <button class="btn btn-primary" id="prism_clean_apply" type="button">Apply</button>'
            + '        <span id="prism_clean_msg" style="font-size:12px; color:var(--text3);"></span>'
            + '      </div>'
            + '      <canvas id="prism_clean_canvas" width="480" height="120" style="margin-top:10px; width:100%; max-width:480px; background:var(--bg1); border:1px solid var(--border); border-radius:6px; display:none;"></canvas>'
            + '    </div>'

            // ── Multi-rate editor ──
            + '    <div class="card">'
            + '      <div class="card-title">Multi-Rate History (optional)</div>'
            + '      <div style="font-size:12px; color:var(--text2); margin-bottom:10px;">'
            + '        For superposition. One [time (h), rate] pair per rate change; rate = 0'
            + '        for a shut-in. Leave empty when the rates are in the data or the test is single-rate.'
            + '      </div>'
            + '      <div style="overflow-x:auto;"><table class="dtable" id="prism_mrate_table">'
            + '        <thead><tr><th>Time (h)</th><th>Rate</th><th></th></tr></thead>'
            + '        <tbody id="prism_mrate_body"></tbody>'
            + '      </table></div>'
            + '      <div style="margin-top:8px;"><button class="btn btn-secondary" id="prism_mrate_add" type="button">+ Add row</button></div>'
            + '    </div>'
            + '  </div>'

            + '  <div style="min-width:0;">'
            + '    <div class="card">'
            + '      <div class="card-title">Summary</div>'
            + '      <div id="prism_data_stats">'
            + '        <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>'
            + '      </div>'
            + '    </div>'
            + '    <div class="card">'
            + '      <div class="card-title">Preview</div>'
            + '      <div id="prism_data_preview" style="overflow-x:auto;">'
            + '        <div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>'
            + '      </div>'
            + '    </div>'
            + '  </div>'
            + '</div>';

        // Persisted textarea (also registers the host autosave for it).
        _load('prism', ['prism_data_paste']);

        var fi = _byId('prism_data_file');
        if (fi) fi.onchange = function (ev) {
            var f = ev.target.files && ev.target.files[0];
            if (f) W.PRiSM_loadFile(f);
        };
        var pb = _byId('prism_data_parse');
        if (pb) pb.onclick = W.PRiSM_doParseData;
        var db = _byId('prism_data_demo');
        if (db) db.onclick = _loadDemo;
        var cb = _byId('prism_data_clear');
        if (cb) cb.onclick = _clearData;
        var rs = _byId('prism_rateonly_switch');
        if (rs) rs.onclick = function () {
            if (W.PRiSM && typeof W.PRiSM.setMode === 'function') W.PRiSM.setMode('decline');
            else if (W.PRiSM) W.PRiSM.mode = 'decline';
            _renderRateOnlyBanner(W.PRiSM_dataset);
        };

        if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows();
        var mra = _byId('prism_mrate_add');
        if (mra) mra.onclick = function () {
            if (!W.PRiSM) W.PRiSM = {};
            if (!Array.isArray(W.PRiSM.multiRate)) W.PRiSM.multiRate = [];
            W.PRiSM.multiRate.push({ t: 0, q: 0 });
            if (typeof PRiSM_renderMultiRateRows === 'function') PRiSM_renderMultiRateRows();
            if (typeof PRiSM_persistMultiRate === 'function') PRiSM_persistMultiRate();
        };

        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = st.fileName || '';

        var active = W.PRiSM_dataset;
        var hasActive = !!(active && active.t && active.t.length);
        if (st.rawRows && st.rawRows.length) {
            // Same session: repaint from state, never re-commit (keeps a crop).
            _paintAll();
            _renderPreview();
            _setMsg(_activeStatusHTML());
        } else {
            var ta = _byId('prism_data_paste');
            var text = ta ? ta.value : '';
            if (text.trim() && _adoptText(text)) {
                st.fileName = _nameForText(text);
                if (fnl) fnl.textContent = st.fileName || '';
                _paintAll();
                var ds = _buildDataset(true);
                if (!hasActive && ds && ds.t.length) {
                    ds.name = st.fileName || 'Pasted data';
                    ds.source = st.fileName ? 'file' : 'paste';
                    _commit(ds, 'restored');
                }
                _renderPreview();
                _setMsg(_activeStatusHTML());
            } else if (hasActive) {
                _setMsg(_activeStatusHTML());
            }
        }
        _renderRateOnlyBanner(W.PRiSM_dataset);
    }

    // Repaint every card that depends on the parsed state.
    function _paintAll() {
        var st = _getState();
        if (st.workbook) PRiSM_renderSheetPicker();
        PRiSM_renderColumnMapper();
        PRiSM_renderUnitPickers();
        PRiSM_renderCleanupPanel();
    }

    function _renderRateOnlyBanner(ds) {
        var ban = _byId('prism_rateonly_banner');
        if (!ban) return;
        var mode = W.PRiSM && W.PRiSM.mode;
        var show = !!(ds && ds.t && ds.t.length && !ds.p && ds.q && mode !== 'decline');
        ban.style.display = show ? '' : 'none';
    }

    function _loadDemo() {
        var ds = null;
        if (typeof W.PRiSM_loadDemoData === 'function') {
            ds = W.PRiSM_loadDemoData();
        } else if (typeof W.PRiSM_DEFAULT_SAMPLE_CSV === 'string') {
            try { var ls = _ls(); if (ls) ls.removeItem('wts_prism_sample_suppress'); } catch (e) { /* ignore */ }
            var ta = _byId('prism_data_paste');
            if (ta) ta.value = W.PRiSM_DEFAULT_SAMPLE_CSV;
            _persistText(W.PRiSM_DEFAULT_SAMPLE_CSV);
            _rememberName(W.PRiSM_DEFAULT_SAMPLE_CSV, 'Demo data');
            ds = _enhParse(W.PRiSM_DEFAULT_SAMPLE_CSV, { source: 'sample', name: 'Demo data' });
        }
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = '';
        if (ds && ds.t) {
            _setMsg('<span style="color:var(--green);">Demo data loaded: ' + ds.t.length +
                ' points, homogeneous-reservoir drawdown (q = 850 STB/d, pi = 4200 psia).</span>');
        } else {
            _setMsg('<span style="color:var(--red);">The demo data could not be loaded.</span>');
        }
        _renderRateOnlyBanner(W.PRiSM_dataset);
        return ds;
    }

    function _clearData() {
        var ta = _byId('prism_data_paste');
        if (ta) ta.value = '';
        _setMsg('');
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = '';
        var prev = _byId('prism_data_preview'), stats = _byId('prism_data_stats');
        if (prev) prev.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        if (stats) stats.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
        ['prism_map_card', 'prism_units_card', 'prism_clean_card', 'prism_sheet_card'].forEach(function (id) {
            var e = _byId(id); if (e) e.style.display = 'none';
        });
        W.PRiSM_dataset = null;
        _resetState();
        try { var ls = _ls(); if (ls) ls.setItem('wts_prism_sample_suppress', '1'); } catch (e) { /* ignore */ }
        if (ta) _save('prism', ['prism_data_paste']);
        else _persistText('');
        _renderRateOnlyBanner(null);
        try {
            if (typeof W.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
                W.dispatchEvent(new CustomEvent('prism:dataset-cleared', { detail: { source: 'clear' } }));
            }
        } catch (e) { /* ignore */ }
    }


    // =======================================================================
    // SECTION 8 — FILE LOADER (CSV/TSV/TXT/DAT/ASC/XLSX)
    // =======================================================================
    // Resolves with the committed dataset (or null). Works without the Data
    // tab on screen (e.g. from the gauge-data manager).

    W.PRiSM_loadFile = function (file) {
        if (!file) return Promise.resolve(null);
        var st = _getState();
        var name = file.name || 'file';
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = name;
        var isXlsx = /\.(xlsx|xls|xlsm|xlsb|ods)$/i.test(name);

        if (isXlsx) {
            _setMsg('<span style="color:var(--text3);">Loading the spreadsheet reader…</span>');
            return PRiSM_loadXLSX().then(function () {
                return _readArrayBuffer(file);
            }).then(function (buf) {
                var wb = PRiSM_parseWorkbook(buf);
                st.source = 'workbook';
                st.workbook = wb;
                st.sheetIdx = wb.defaultIdx;
                st.fileName = name;
                _adoptSheet(st);
                return _enhParse(undefined, { fromWorkbook: true });
            }).catch(function (e) {
                _setMsg('<span style="color:var(--red);">'
                    + 'Reading XLSX needs an internet connection the first time; please save the sheet as CSV instead. '
                    + '(' + _escapeHTML(e && e.message ? e.message : 'load failed') + ')</span>');
                return null;
            });
        }

        return _readText(file).then(function (text) {
            var ta = _byId('prism_data_paste');
            if (ta) { ta.value = text; _save('prism', ['prism_data_paste']); }
            else _persistText(text);
            _rememberName(text, name);
            st.source = 'paste';
            st.workbook = null;
            return _enhParse(text);
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


    // =======================================================================
    // SECTION 9 — PARSE = COMMIT
    // =======================================================================
    // window.PRiSM_doParseData (the "Load data" button): read the textarea
    // (or the current workbook sheet), map, convert, clean, and make the
    // result the active dataset — 'prism:dataset-loaded' fires once.

    function _enhParse(textArg, meta) {
        var st = _getState();
        meta = (meta && typeof meta === 'object') ? meta : {};
        var fromText = (typeof textArg === 'string');
        var source;
        var useSheet = !fromText && st.source === 'workbook' && !!st.workbook;
        if (useSheet && !meta.fromWorkbook) {
            // "Load data" after a workbook: use the sheet only while the
            // textarea still holds the text written from it; new text wins.
            var taW = _byId('prism_data_paste');
            if (taW && _fnv(taW.value) !== st.wbCsvHash) { useSheet = false; st.source = 'paste'; st.workbook = null; }
        }
        if (useSheet) {
            source = 'file';
        } else {
            var text = fromText ? textArg : null;
            if (text == null) {
                var ta = _byId('prism_data_paste');
                if (!ta) return null;
                text = ta.value;
                _save('prism', ['prism_data_paste']);
            }
            if (!_adoptText(text)) {
                _setMsg('<span style="color:var(--red);">No valid data rows. '
                    + _escapeHTML((st.parseErrors || []).slice(0, 3).join(' · ')) + '</span>');
                var prev0 = _byId('prism_data_preview'), stats0 = _byId('prism_data_stats');
                if (prev0) prev0.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
                if (stats0) stats0.innerHTML = '<div style="color:var(--text3); font-size:12px;">No data parsed yet.</div>';
                return null;
            }
            if (meta.name) _rememberName(text, meta.name);
            st.fileName = meta.name || _nameForText(text);
            source = meta.source || (st.fileName ? 'file' : 'paste');
        }
        var fnl = _byId('prism_data_filename');
        if (fnl) fnl.textContent = st.fileName || '';
        _paintAll();
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) {
            _renderPreview();
            _setMsg('<span style="color:var(--red);">Parsed ' + st.rawRows.length + ' rows but none are usable — check the column mapping, units and cleanup.</span>');
            return null;
        }
        ds.name = st.fileName || meta.name || 'Pasted data';
        ds.source = source;
        _commit(ds, source);
        // A workbook sheet is kept as canonical CSV text so a reload restores it.
        if (source === 'file' && st.source === 'workbook') {
            var csv = _datasetToCSV(ds);
            var ta2 = _byId('prism_data_paste');
            if (ta2) { ta2.value = csv; _save('prism', ['prism_data_paste']); } else _persistText(csv);
            _rememberName(csv, ds.name);
            st.wbCsvHash = _fnv(csv);
        }
        _renderPreview();
        _renderRateOnlyBanner(ds);
        var ncols = st.rawRows[0] ? st.rawRows[0].length : 0;
        _setMsg('<span style="color:var(--green);">Parsed ' + st.rawRows.length + ' rows (' + ncols + ' cols). '
            + 'Dataset active: ' + ds.t.length + ' points' + (ds.p ? '' : ' (rates only)') + '.</span>'
            + (st.errors && st.errors.length ? ' <span style="color:var(--yellow);">' + st.errors.length + ' rows skipped.</span>' : ''));
        return ds;
    }

    function _datasetToCSV(ds) {
        var cols = ['time'], get = [function (i) { return ds.t[i]; }];
        if (ds.p) { cols.push('pressure'); get.push(function (i) { return ds.p[i]; }); }
        if (ds.q) { cols.push(ds.rateUnit === 'Mscf/d' ? 'gas rate' : 'rate'); get.push(function (i) { return ds.q[i]; }); }
        var lines = [cols.join(',')];
        for (var i = 0; i < ds.t.length; i++) {
            lines.push(get.map(function (g) { var v = g(i); return (v == null || !isFinite(v)) ? '' : String(v); }).join(','));
        }
        return lines.join('\n');
    }

    W.PRiSM_doParseData = function PRiSM_doParseData(arg) {
        return _enhParse(typeof arg === 'string' ? arg : undefined);
    };

    // API compatibility: build with the current settings and commit.
    W.PRiSM_doUseData = function PRiSM_doUseData() {
        var st = _getState();
        if (!st.rawRows || !st.rawRows.length) return _enhParse();
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) {
            _setMsg('<span style="color:var(--red);">No usable rows after cleanup. Loosen the filter or time range.</span>');
            return null;
        }
        ds.name = st.fileName || 'Pasted data';
        ds.source = st.fileName ? 'file' : 'paste';
        _commit(ds, ds.source);
        _renderPreview();
        _renderRateOnlyBanner(ds);
        _setMsg('<span style="color:var(--green);">Dataset of ' + ds.t.length + ' points active.</span>');
        return ds;
    };

    // Text → dataset through this pipeline, adopted into the Data tab state
    // (and repainted when the tab is on screen). Does NOT commit — the caller
    // (01-foundation seed / restore) does.
    function PRiSM_datasetFromText(text, meta) {
        meta = meta || {};
        var st = _getState();
        text = String(text == null ? '' : text);
        if (!_adoptText(text)) return null;
        if (meta.name) _rememberName(text, meta.name);
        st.fileName = meta.name || _nameForText(text);
        var ta = _byId('prism_data_paste');
        if (ta && ta.value !== text) ta.value = text;
        var ds = _buildDataset(true);
        if (!ds || !ds.t || !ds.t.length) return null;
        ds.name = st.fileName || 'Pasted data';
        if (meta.source) ds.source = meta.source;
        if (_byId('prism_map_card')) {
            var fnl = _byId('prism_data_filename');
            if (fnl) fnl.textContent = (meta.source === 'sample') ? '' : (st.fileName || '');
            _paintAll();
            _renderPreview();
            _renderRateOnlyBanner(ds);
        }
        return ds;
    }


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
            st.source = 'workbook';
            _adoptSheet(st);
            _enhParse(undefined, { fromWorkbook: true });
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
            var preview = [];
            for (var r = 0; r < Math.min(3, st.rawRows.length); r++) {
                var v = st.rawRows[r][c];
                preview.push((st.dateCols && st.dateCols[c] && isFinite(v)) ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : _fmt(v, 3));
            }
            var div = document.createElement('div');
            div.className = 'fg-item';
            div.style.flex = '1 1 140px';
            div.style.minWidth = '0';
            var optsHTML = ROLES.map(function (ro) {
                return '<option value="' + ro.v + '"' + (st.mapping[c] === ro.v ? ' selected' : '') + '>' + ro.label + '</option>';
            }).join('');
            div.innerHTML =
                '<label for="prism_mapcol_' + c + '" title="' + _escapeHTML(String(label)) + '">'
                + _escapeHTML(String(label).slice(0, 28)) + '</label>'
                + '<select id="prism_mapcol_' + c + '" data-mapcol="' + c + '">' + optsHTML + '</select>'
                + '<div style="font-size:10px; color:var(--text3); margin-top:4px; overflow-wrap:anywhere;">e.g. ' + _escapeHTML(preview.join(', ')) + '</div>';
            grid.appendChild(div);
        }
        grid.querySelectorAll('select[data-mapcol]').forEach(function (s) {
            s.onchange = function () {
                var i = parseInt(s.dataset.mapcol, 10);
                st.mapping[i] = s.value;
            };
        });
        var apply = _byId('prism_map_apply');
        var reset = _byId('prism_map_reset');
        if (apply) apply.onclick = function () {
            var inf = PRiSM_inferColumnUnits(st.headers, st.mapping, st.dateCols);
            Object.keys(inf.units).forEach(function (k) {
                if (st.unitSource[k] !== 'user' && st.unitSource[k] !== 'saved') { st.units[k] = inf.units[k]; st.unitSource[k] = inf.source[k]; }
            });
            st.genericIsGas = !!inf.genericIsGas;
            _saveShapeSettings(st);
            PRiSM_renderUnitPickers();
            _recommit('Mapping applied.');
        };
        if (reset) reset.onclick = function () {
            st.mapping = PRiSM_autoMapColumns(st.headers, st.rawRows, st.dateCols);
            PRiSM_renderColumnMapper();
        };
    }

    // Rebuild with the current settings and commit (mapping / units / phase /
    // cleanup changes all change the dataset).
    function _recommit(note) {
        var ds = W.PRiSM_doUseData();
        if (ds && note) {
            _setMsg('<span style="color:var(--green);">' + _escapeHTML(note) + ' Dataset active: ' + ds.t.length + ' points.</span>');
        }
        return ds;
    }


    // =======================================================================
    // SECTION 11 — UNITS + CLEANUP UI
    // =======================================================================

    function _ratePhasesPresent(st) {
        var m = st.mapping || [];
        var out = [];
        if (m.indexOf('rate') !== -1) out.push({ v: 'rate', label: st.genericIsGas ? 'Rate column (gas)' : 'Rate column' });
        if (m.indexOf('rate_o') !== -1) out.push({ v: 'oil', label: 'Oil' });
        if (m.indexOf('rate_g') !== -1) out.push({ v: 'gas', label: 'Gas' });
        if (m.indexOf('rate_w') !== -1) out.push({ v: 'water', label: 'Water' });
        return out;
    }

    function PRiSM_renderUnitPickers() {
        var st = _getState();
        var card = _byId('prism_units_card');
        if (!card) return;
        card.style.display = 'block';
        var fill = function (selId, list, current, key) {
            var s = _byId(selId);
            if (!s) return;
            s.innerHTML = list.map(function (u) {
                return '<option value="' + u.v + '"' + (u.v === current ? ' selected' : '') + '>' + u.label + '</option>';
            }).join('');
            s.onchange = function () {
                st.units[key] = s.value;
                st.unitSource[key] = 'user';
                _saveShapeSettings(st);
                _showUnitMsg();
                _recommit('Units updated.');
            };
        };
        fill('prism_unit_time',     TIME_UNITS,      st.units.time,     'time');
        fill('prism_unit_pressure', PRESSURE_UNITS,  st.units.pressure, 'pressure');
        fill('prism_unit_rate',     RATE_UNITS_LIQ,  st.units.rate,     'rate');
        fill('prism_unit_rate_g',   RATE_UNITS_GAS,  st.units.rate_g,   'rate_g');

        var phases = _ratePhasesPresent(st);
        var item = _byId('prism_rate_phase_item'), ps = _byId('prism_rate_phase');
        if (item && ps) {
            item.style.display = phases.length > 1 ? '' : 'none';
            ps.innerHTML = '<option value="auto">Automatic</option>' + phases.map(function (p) {
                return '<option value="' + p.v + '">' + p.label + '</option>';
            }).join('');
            ps.value = st.ratePhase || 'auto';
            ps.onchange = function () {
                st.ratePhase = ps.value;
                _saveShapeSettings(st);
                _recommit('Rate column changed.');
            };
        }
        _showUnitMsg();
    }

    function _showUnitMsg() {
        var st = _getState();
        var msg = _byId('prism_unit_msg');
        if (!msg) return;
        var u = TIME_UNITS.find(function (x) { return x.v === st.units.time; });
        var tLabel = u ? u.label : st.units.time;
        var parts = [];
        if (st.units.time === 'date') parts.push('Time: date/time stamps → hours from the first stamp');
        else parts.push('Time: ' + tLabel + ' → hours' + (st.unitSource.time === 'header' ? ' (from the header)' : ''));
        parts.push('Pressure: ' + st.units.pressure + ' → psia');
        parts.push('Liquid: ' + st.units.rate + ' → STB/d');
        parts.push('Gas: ' + st.units.rate_g + ' → Mscf/d');
        var html = _escapeHTML(parts.join(' · '));
        var mapsTime = (st.mapping || []).indexOf('time') !== -1;
        if (mapsTime && !st.unitSource.time && st.units.time === 'h') {
            html = '<span style="color:var(--yellow);">The time unit could not be read from the file — hours assumed. Change it above if the time column is in other units.</span><br>' + html;
        }
        msg.innerHTML = html;
    }

    function PRiSM_renderCleanupPanel() {
        var st = _getState();
        var card = _byId('prism_clean_card');
        if (!card) return;
        card.style.display = 'block';
        var f = _byId('prism_clean_filter'); if (f) f.value = st.cleanup.filter;
        var d = _byId('prism_clean_decim');  if (d) d.value = st.cleanup.decim;
        var n = _byId('prism_clean_decimN'); if (n) n.value = String(st.cleanup.decimN);
        var b = _byId('prism_clean_bin');    if (b) b.value = String(st.cleanup.decimBinMin);
        var ts = _byId('prism_clean_tstart'); if (ts) ts.value = st.cleanup.tStart;
        var te = _byId('prism_clean_tend');   if (te) te.value = st.cleanup.tEnd;

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
            _saveShapeSettings(st);
            var ds = _recommit('Cleanup applied.');
            var msg = _byId('prism_clean_msg');
            if (msg) msg.innerHTML = ds ? '<span style="color:var(--green);">Cleanup applied: ' + ds.t.length + ' points.</span>'
                                        : '<span style="color:var(--red);">No points left — loosen the settings.</span>';
        };
    }

    function _previewCleanup() {
        var before = _buildDataset(false, true);
        var after  = _buildDataset(true, true);
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
        var Wd = cvs.width, H = cvs.height;
        ctx.clearRect(0, 0, Wd, H);
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
            var px = pad + (Wd - 2 * pad) * (x[k] - xMin) / (xMax - xMin);
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

        var idx = { time: -1, pressure: -1, rate: -1, rate_o: -1, rate_g: -1, rate_w: -1, period: -1 };
        for (var c = 0; c < ncols; c++) {
            var role = st.mapping[c];
            if (role && idx[role] === -1) idx[role] = c;
        }
        var anyRate = idx.rate >= 0 || idx.rate_o >= 0 || idx.rate_g >= 0 || idx.rate_w >= 0;
        if (idx.time < 0) {
            var free0 = !st.mapping[0];
            if (!free0) return null;
            idx.time = 0;
        }
        // Classic default: column 1 is pressure — only when nothing else is
        // mapped and column 1 is not assigned to another role.
        if (idx.pressure < 0 && !anyRate && ncols > 1 && !st.mapping[1] && idx.time !== 1) idx.pressure = 1;

        var col = function (k) { return k >= 0 ? rows.map(function (r) { return r[k]; }) : null; };
        var rawT = col(idx.time);
        var rawP = col(idx.pressure);
        var rawQ = col(idx.rate);
        var rawO = col(idx.rate_o);
        var rawG = col(idx.rate_g);
        var rawW = col(idx.rate_w);
        var rawPer = col(idx.period);

        var tConv = PRiSM_convertTime(rawT, st.units.time);
        var t = tConv.hours;
        var p = rawP ? PRiSM_convertPressure(rawP, st.units.pressure).values : null;
        var qGen = rawQ ? (st.genericIsGas ? PRiSM_convertRate(rawQ, st.units.rate_g, true).values
                                            : PRiSM_convertRate(rawQ, st.units.rate, false).values) : null;
        var qo = rawO ? PRiSM_convertRate(rawO, st.units.rate, false).values : null;
        var qg = rawG ? PRiSM_convertRate(rawG, st.units.rate_g, true).values : null;
        var qw = rawW ? PRiSM_convertRate(rawW, st.units.rate, false).values : null;

        // Rate used for analysis: the picked phase, else generic → oil → gas → water.
        var cand = { rate: qGen, oil: qo, gas: qg, water: qw };
        var phase = st.ratePhase || 'auto';
        var order = ['rate', 'oil', 'gas', 'water'];
        if (phase !== 'auto' && cand[phase]) order = [phase];
        var q = null, qPhase = null;
        for (var oi = 0; oi < order.length; oi++) { if (cand[order[oi]]) { q = cand[order[oi]]; qPhase = order[oi]; break; } }
        var qIsGas = (qPhase === 'gas') || (qPhase === 'rate' && st.genericIsGas);

        // Valid rows: finite time, and finite pressure (or rate, for rate-only data).
        var indices = [];
        for (var i = 0; i < t.length; i++) {
            if (!isFinite(t[i])) continue;
            if (p) { if (!isFinite(p[i])) continue; }
            else if (q && !isFinite(q[i])) continue;
            indices.push(i);
        }
        // Keep time increasing (logger exports are sometimes newest-first).
        var sorted = false;
        for (var s2 = 1; s2 < indices.length; s2++) {
            if (t[indices[s2]] < t[indices[s2 - 1]]) { sorted = true; break; }
        }
        if (sorted) indices.sort(function (a, b) { return (t[a] - t[b]) || (a - b); });

        if (applyCleanup) {
            var tStart = parseFloat(st.cleanup.tStart);
            var tEnd   = parseFloat(st.cleanup.tEnd);
            indices = indices.filter(function (k) {
                if (isFinite(tStart) && t[k] < tStart) return false;
                if (isFinite(tEnd)   && t[k] > tEnd)   return false;
                return true;
            });
            var sig = p || q;
            if (sig && st.cleanup.filter !== 'none') {
                var sub = indices.map(function (k) { return sig[k]; });
                var keep = null;
                if (st.cleanup.filter === 'mad') keep = PRiSM_filterMAD(sub, 5);
                else if (st.cleanup.filter === 'hampel') keep = PRiSM_filterHampel(sub, 7, 3);
                else if (st.cleanup.filter === 'ma') {
                    var smoothed = PRiSM_filterMovingAvg(sub, 5);
                    indices.forEach(function (k, j) { sig[k] = smoothed[j]; });
                }
                if (keep) indices = indices.filter(function (_, j) { return keep[j]; });
            }
            if (st.cleanup.decim === 'nth') {
                indices = PRiSM_decimateNth(t, indices, Math.max(2, Math.floor(st.cleanup.decimN)));
            } else if (st.cleanup.decim === 'log') {
                indices = PRiSM_decimateLog(t, indices, Math.max(10, Math.floor(st.cleanup.decimTarget)));
            } else if (st.cleanup.decim === 'bin') {
                indices = PRiSM_decimateTimeBin(t, indices, Math.max(0.1, st.cleanup.decimBinMin));
            }
        }

        var pickAt = function (arr) { return indices.map(function (k) { return arr[k]; }); };
        var ds = { t: pickAt(t) };
        ds.p = p ? pickAt(p) : null;
        ds.q = q ? pickAt(q) : null;
        if (qo || qg || qw) ds.phases = {
            oil:   qo ? pickAt(qo) : null,
            gas:   qg ? pickAt(qg) : null,
            water: qw ? pickAt(qw) : null
        };
        if (rawPer) ds.period = pickAt(rawPer);
        ds.timeUnit = 'h';
        ds.timeUnitOriginal = st.units.time;
        if (ds.q) {
            ds.rateUnit = qIsGas ? 'Mscf/d' : 'STB/d';
            ds.ratePhase = qPhase === 'rate' ? (st.genericIsGas ? 'gas' : 'liquid') : qPhase;
        }

        if (!dryRun) { st.lastApplied = ds; st.sorted = sorted; }
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

        var qLabel = 'Rate for analysis (' + (ds.rateUnit || 'STB/d') + ')';
        var cols = [];
        cols.push({ label: ROLE_LABELS.time, values: ds.t });
        if (ds.p) cols.push({ label: ROLE_LABELS.pressure, values: ds.p });
        if (ds.q) cols.push({ label: qLabel, values: ds.q });
        if (ds.phases) {
            if (ds.phases.oil && ds.phases.oil !== ds.q)     cols.push({ label: ROLE_LABELS.rate_o, values: ds.phases.oil });
            if (ds.phases.gas && ds.phases.gas !== ds.q)     cols.push({ label: ROLE_LABELS.rate_g, values: ds.phases.gas });
            if (ds.phases.water && ds.phases.water !== ds.q) cols.push({ label: ROLE_LABELS.rate_w, values: ds.phases.water });
        }
        if (ds.period) cols.push({ label: ROLE_LABELS.period, values: ds.period });

        var N = ds.t.length;
        var tMin = Math.min.apply(null, ds.t);
        var tMax = Math.max.apply(null, ds.t);
        var dts = [];
        for (var i = 1; i < ds.t.length; i++) dts.push(ds.t[i] - ds.t[i - 1]);
        var dtSorted = dts.slice().sort(function (a, b) { return a - b; });
        var medianDt = dtSorted.length ? dtSorted[Math.floor(dtSorted.length / 2)] : NaN;
        var gaps = 0;
        if (medianDt > 0) dts.forEach(function (d) { if (d > 10 * medianDt) gaps++; });

        // Rate periods: jumps larger than 1 % of the largest rate.
        var periodCount = 1;
        var rateForPeriod = ds.q || (ds.phases && (ds.phases.oil || ds.phases.gas || ds.phases.water));
        if (rateForPeriod) {
            var maxRate = 0;
            rateForPeriod.forEach(function (v) { if (isFinite(v) && Math.abs(v) > maxRate) maxRate = Math.abs(v); });
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
        if (gaps) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Gaps (Δt &gt; 10× median)</span><span class="rv">' + gaps + '</span></div>';
        if (ds.p) {
            var pMin = Math.min.apply(null, ds.p), pMax = Math.max.apply(null, ds.p);
            statsHTML += '<div class="rrow"><span class="rl">Pressure (psia)</span><span class="rv">' + _fmt(pMin, 2) + ' .. ' + _fmt(pMax, 2) + '</span></div>';
        } else {
            statsHTML += '<div class="rrow"><span class="rl">Pressure</span><span class="rv">— (rates only)</span></div>';
        }
        if (rateForPeriod) {
            statsHTML += '<div class="rrow"><span class="rl">Rate periods (auto)</span><span class="rv">' + periodCount + '</span></div>';
        }
        if (st.sorted) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Rows re-ordered</span><span class="rv">by time</span></div>';
        if (st.fileName) statsHTML += '<div class="rrow"><span class="rl">File</span><span class="rv" style="overflow-wrap:anywhere;">' + _escapeHTML(st.fileName) + '</span></div>';
        if (st.errors && st.errors.length) statsHTML += '<div class="rrow"><span class="rl" style="color:var(--yellow);">Warnings</span><span class="rv">' + st.errors.length + ' rows skipped</span></div>';
        statsHTML += '</div>';
        statsEl.innerHTML = statsHTML;

        var html = '<table class="dtable"><thead><tr>';
        cols.forEach(function (c) { html += '<th>' + _escapeHTML(c.label) + '</th>'; });
        html += '</tr></thead><tbody>';
        var head = Math.min(10, N);
        var tail = N > 15 ? 5 : 0;
        var cell = function (v) { return '<td>' + (typeof v === 'number' ? _fmt(v, 4) : _escapeHTML(String(v == null ? '' : v))) + '</td>'; };
        for (var ii = 0; ii < head; ii++) {
            html += '<tr>';
            cols.forEach(function (c) { html += cell(c.values[ii]); });
            html += '</tr>';
        }
        if (tail) {
            html += '<tr><td colspan="' + cols.length + '" style="text-align:center; color:var(--text3); font-style:italic;">… ' + (N - head - tail) + ' rows omitted …</td></tr>';
            for (var jj = N - tail; jj < N; jj++) {
                html += '<tr>';
                cols.forEach(function (c) { html += cell(c.values[jj]); });
                html += '</tr>';
            }
        }
        html += '</tbody></table>';
        prev.innerHTML = html;
    }
    var _renderPreview = PRiSM_renderPreview;

    function _escapeHTML(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }


    // =======================================================================
    // EXPORT — helpers for other layers and tests.
    // =======================================================================
    W.PRiSM_renderDataTabEnhanced = PRiSM_renderDataTabEnhanced;
    W.PRiSM_datasetFromText       = PRiSM_datasetFromText;
    W.PRiSM_parseTextEnhanced     = PRiSM_parseTextEnhanced;
    W.PRiSM_autoMapColumns        = PRiSM_autoMapColumns;
    W.PRiSM_inferColumnUnits      = PRiSM_inferColumnUnits;
    W.PRiSM_convertTime           = PRiSM_convertTime;
    W.PRiSM_convertPressure       = PRiSM_convertPressure;
    W.PRiSM_convertRate           = PRiSM_convertRate;
    W.PRiSM_filterMAD             = PRiSM_filterMAD;
    W.PRiSM_filterMovingAvg       = PRiSM_filterMovingAvg;
    W.PRiSM_filterHampel          = PRiSM_filterHampel;
    W.PRiSM_decimateNth           = PRiSM_decimateNth;
    W.PRiSM_decimateLog           = PRiSM_decimateLog;
    W.PRiSM_decimateTimeBin       = PRiSM_decimateTimeBin;
    W.PRiSM_loadXLSX              = PRiSM_loadXLSX;
    W.PRiSM_parseWorkbook         = PRiSM_parseWorkbook;
    W.PRiSM_dataTabState          = function () { return _getState(); };


    // =======================================================================
    // SELF-TEST
    // =======================================================================
    // === SELF-TEST ===
    (function PRiSM_dataEnhSelfTest() {
        var log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : function () {};
        var err = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : function () {};
        var checks = [];
        var mapOf = function (text) { var r = PRiSM_parseTextEnhanced(text); return PRiSM_autoMapColumns(r.headers, r.rows, r.dateCols); };

        var t1 = PRiSM_parseTextEnhanced('time,pressure,rate\n0,1000,500\n1,990,500\n2,985,500\n');
        checks.push({ name: 'CSV w/ header parses 3 rows × 3 cols',
            ok: t1.rows.length === 3 && t1.rows[0].length === 3 && t1.headers && t1.headers[0] === 'time' });
        checks.push({ name: 'CSV separator detected as comma', ok: t1.sep === 'comma' });

        var t2 = PRiSM_parseTextEnhanced('0  1000  500\n1  990  500\n2  985  500');
        checks.push({ name: 'Whitespace ASCII: no header, 3 rows', ok: t2.rows.length === 3 && t2.headers == null });

        var t3 = PRiSM_parseTextEnhanced('time(h),pressure(psi),rate(bbl/d)\n0,1000,500\n1,990,500\n');
        checks.push({ name: 'Units-in-header parses + first row numeric',
            ok: t3.rows.length === 2 && t3.headers && t3.headers[0].indexOf('time') >= 0 });

        var t4 = PRiSM_parseTextEnhanced('﻿# this is a comment\n# another\ntime,pressure\n0,1000\n1,990\n');
        checks.push({ name: 'Comments + BOM stripped', ok: t4.rows.length === 2 && t4.headers && t4.headers[0] === 'time' });

        var map1 = PRiSM_autoMapColumns(['time', 'pressure', 'rate'], t1.rows);
        checks.push({ name: 'Auto-map: time/pressure/rate by header',
            ok: map1[0] === 'time' && map1[1] === 'pressure' && map1[2] === 'rate' });

        var rowsShape = [];
        for (var i = 0; i < 100; i++) rowsShape.push([i * 0.1, 2000 + i * 5, i % 10 === 0 ? 0 : 500]);
        var mapShape = PRiSM_autoMapColumns(null, rowsShape);
        checks.push({ name: 'Auto-map: shape detects time at col 0', ok: mapShape[0] === 'time' && mapShape[1] === 'pressure' && mapShape[2] === 'rate' });

        // Rate headers are never shape-mapped to pressure.
        var mA = mapOf('time,rate\n0,500\n1,480\n2,470\n3,460\n4,455\n5,450\n');
        checks.push({ name: 'time,rate → [time, rate]', ok: mA[0] === 'time' && mA[1] === 'rate', val: mA });
        var mB = mapOf('days,oil_rate\n1,900\n2,850\n3,810\n');
        checks.push({ name: 'days,oil_rate → [time, rate_o]', ok: mB[0] === 'time' && mB[1] === 'rate_o', val: mB });
        var mC = mapOf('time,oil,gas\n1,900,1500\n2,850,1450\n');
        checks.push({ name: 'time,oil,gas → [time, rate_o, rate_g]', ok: mC[0] === 'time' && mC[1] === 'rate_o' && mC[2] === 'rate_g', val: mC });
        var mD = mapOf('Date,Production\n2024-01-01,900\n2024-02-01,850\n2024-03-01,810\n');
        checks.push({ name: 'Date,Production → [time, rate]', ok: mD[0] === 'time' && mD[1] === 'rate', val: mD });
        var mE = mapOf('Time,Water cut,Pressure\n0,0.1,3000\n1,0.1,2990\n');
        checks.push({ name: 'water cut is not a rate', ok: mE[0] === 'time' && mE[1] === '' && mE[2] === 'pressure', val: mE });

        // Unit inference + conversions.
        var rB = PRiSM_parseTextEnhanced('days,oil_rate\n1,900\n');
        var uB = PRiSM_inferColumnUnits(rB.headers, ['time', 'rate_o'], rB.dateCols);
        checks.push({ name: 'days header → time unit d', ok: uB.units.time === 'd' });
        var rD = PRiSM_parseTextEnhanced('Date,Production\n2024-01-01,900\n2024-01-02,850\n');
        checks.push({ name: 'date column detected', ok: !!(rD.dateCols && rD.dateCols[0]) });
        var tD = PRiSM_convertTime(rD.rows.map(function (r) { return r[0]; }), 'date');
        checks.push({ name: 'date column → hours from first stamp', ok: Math.abs(tD.hours[1] - 24) < 1e-9 });
        var dmy = _parseDateCell('13/02/2024 06:30', true) - _parseDateCell('13/02/2024 00:00', true);
        checks.push({ name: 'dd/mm/yyyy hh:mm parsed', ok: Math.abs(dmy - 6.5 * 3600000) < 1 });
        var gs = PRiSM_parseTextEnhanced('time,gas rate (MMscf/d)\n0,1.5\n');
        var uG = PRiSM_inferColumnUnits(gs.headers, PRiSM_autoMapColumns(gs.headers, gs.rows), null);
        checks.push({ name: 'MMscf/d header → gas unit', ok: uG.units.rate_g === 'MMscfd' });
        checks.push({ name: 'gas MMscf/d → 1500 Mscf/d', ok: Math.abs(PRiSM_convertRate([1.5], 'MMscfd', true).values[0] - 1500) < 1e-9 });
        checks.push({ name: 'L/min → 9.057 bbl/d', ok: Math.abs(PRiSM_convertRate([1], 'L/min', false).values[0] - 9.0573) < 1e-3 });
        checks.push({ name: 'psig → psia (+14.696)', ok: Math.abs(PRiSM_convertPressure([100], 'psig').values[0] - 114.696) < 1e-9 });

        var keep = PRiSM_filterMAD([1, 2, 3, 4, 100, 5, 6], 3);
        checks.push({ name: 'MAD drops the 100 outlier', ok: keep[4] === false && keep[0] === true && keep[3] === true });
        var keepH = PRiSM_filterHampel([1, 2, 3, 4, 100, 5, 6], 5, 3);
        checks.push({ name: 'Hampel drops the 100 outlier', ok: keepH[4] === false });
        var ma = PRiSM_filterMovingAvg([1, 2, 3, 4, 100, 5, 6], 5);
        checks.push({ name: 'Moving avg attenuates spike (val < 100)', ok: ma[4] < 100 && ma[4] > 5 });

        var times = [];
        for (var k = 0; k < 1000; k++) times.push(Math.pow(10, -3 + 6 * k / 999));
        var idxAll = times.map(function (_, j) { return j; });
        var picked = PRiSM_decimateLog(times, idxAll, 50);
        checks.push({ name: 'Log decimation: ~50 unique picks from 1000', ok: picked.length >= 40 && picked.length <= 60 });
        checks.push({ name: 'Log decimation preserves endpoints', ok: picked[0] === 0 && picked[picked.length - 1] === 999 });
        var nth = PRiSM_decimateNth(times, idxAll, 10);
        checks.push({ name: 'Nth decimation roughly 1/N', ok: nth.length >= 95 && nth.length <= 105 });
        var binIdx = PRiSM_decimateTimeBin([0, 0.5, 1, 1.5, 2, 2.5, 3], [0, 1, 2, 3, 4, 5, 6], 60);
        checks.push({ name: 'Time-bin decimation collapses by 1h bins', ok: binIdx.length === 4 || binIdx.length === 5 });

        var tConv = PRiSM_convertTime([0, 60, 120], 'min');
        checks.push({ name: 'Time minutes → hours',
            ok: Math.abs(tConv.hours[0]) < 1e-9 && Math.abs(tConv.hours[1] - 1) < 1e-9 && Math.abs(tConv.hours[2] - 2) < 1e-9 });
        var pConv = PRiSM_convertPressure([1, 10], 'bar');
        checks.push({ name: 'Pressure bar → psi (≈ ×14.504)', ok: Math.abs(pConv.values[0] - 14.5037738) < 1e-4 });

        var h1 = _headerHash(['time', 'p', 'q'], 3);
        var h2 = _headerHash(['time', 'p', 'q'], 3);
        var h3 = _headerHash(['time', 'p', 'r'], 3);
        checks.push({ name: 'Header hash stable + sensitive', ok: h1 === h2 && h1 !== h3 });

        var fails = checks.filter(function (c) { return !c.ok; });
        if (fails.length) {
            err('PRiSM data-enhancements self-test FAILED:', fails);
        } else {
            log('✓ data enhancements self-test passed (' + checks.length + ' checks).');
        }
    })();

})();
