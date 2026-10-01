// prism-build/50-a11y.js — accessibility layer + decimal-comma input (ROADMAP P10).
//
// Loaded in Round-6 (feature layer). Everything here is additive: it only adds
// ARIA attributes, tabindex values and keyboard handlers, and — when the user
// turns the setting on — rewrites a typed decimal comma to a point. It never
// changes a calculation.
//
// What it does (idempotent; re-run on page change, PRiSM tab/step change, unit
// switch, focus and — in a browser — DOM mutations under #pgBody):
//   • sidebar: role=button + roving tabindex (one Tab stop; ↑/↓/Home/End move,
//     Enter/Space open), aria-current="page" on the active page;
//   • tab strips (.tabs > .tab-btn, role=tablist): role=tab, aria-selected,
//     roving tabindex, ←/→/Home/End move and activate (WAI-ARIA APG "Tabs");
//   • click-only elements (dashboard tiles, [onclick] divs/spans): role=button,
//     tabindex=0, Enter/Space activate; icon-only buttons get an aria-label;
//   • form controls without an accessible name: the .fg-item label, or for a
//     table cell the column header + row label ("Choke → Heater, Length (ft)");
//     generated labels carry data-a11y-auto so reports ignore them and the next
//     pass refreshes them (unit labels change with the unit system);
//   • result containers (id …_res / …_result / …_results) get aria-live=polite;
//   • canvases / SVG diagrams without a label get role=img + a label from their
//     card heading (drawLineChart and the PRiSM plots add a data summary);
//   • decimal comma (setting, default off; localStorage 'wtspref_decimal_comma'
//     — deliberately not a wts_* key, so it is a device preference that does not
//     travel in project files): "12,5" typed or pasted into a numeric field is
//     read as 12.5. Only a single comma with digits after it and no point is
//     converted, so "1,500" becomes 1.5 while the setting is on (stated in the
//     toggle's tooltip).
//
// Public API: window.WTS_a11y = { apply(root?), name(el), decimalComma(on?),
//   parseNumber(str) }, window.WTS_parseNumber(str).
// References: WAI-ARIA Authoring Practices 1.2 (Tabs, Button, roving tabindex);
//   W3C Accessible Name and Description Computation 1.2; WCAG 2.2 SC 1.1.1,
//   1.3.1, 2.1.1, 2.4.1, 2.4.3, 2.4.7, 4.1.2, 4.1.3.

(function () {
    'use strict';
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var _hasDoc = typeof document !== 'undefined' && !!document && typeof document.querySelectorAll === 'function';

    var AUTO = 'data-a11y-auto';
    var PREF_KEY = 'wtspref_decimal_comma';
    var CONTROL_SEL = 'input, select, textarea';
    var SKIP_TYPES = { hidden: 1, button: 1, submit: 1, reset: 1, image: 1 };
    var DEC_COMMA_RE = /^\s*([-+]?\d*),(\d+(?:[eE][-+]?\d+)?)\s*$/;

    // ── text helpers ─────────────────────────────────────────────────────
    function _clean(el) {
        if (!el) return '';
        var c;
        try { c = el.cloneNode(true); } catch (e) { return ''; }
        try {
            var rm = c.querySelectorAll('button, input, select, textarea, script, style, svg, .wts-help-icon, [aria-hidden="true"]');
            for (var i = 0; i < rm.length; i++) if (rm[i].parentNode) rm[i].parentNode.removeChild(rm[i]);
        } catch (e) { /* ignore */ }
        return String(c.textContent || '').replace(/\s+/g, ' ').trim();
    }
    function _short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    function _attr(el, a) { return (el && el.getAttribute) ? (el.getAttribute(a) || '') : ''; }
    function _byId(id) { return _hasDoc ? document.getElementById(id) : null; }

    var _forMap = null;          // id → <label for> during a pass (one document scan, not one per control)
    // Accessible name, following the accname algorithm closely enough for our
    // markup: aria-labelledby → aria-label → <label for> / wrapping <label> →
    // content (buttons, links, role=button/tab) → title → placeholder / alt.
    function name(el) {
        if (!el || el.nodeType !== 1) return '';
        var lb = _attr(el, 'aria-labelledby');
        if (lb) {
            var s = lb.split(/\s+/).map(function (id) { var r = _byId(id); return r ? _clean(r) : ''; }).join(' ').trim();
            if (s) return s;
        }
        var al = _attr(el, 'aria-label').trim();
        if (al) return al;
        var tag = String(el.localName || el.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'meter' || tag === 'progress') {
            if (el.id) {
                var lf = null;
                if (_forMap) lf = _forMap[el.id] || null;
                else try { lf = document.querySelector('label[for="' + String(el.id).replace(/"/g, '\\"') + '"]'); } catch (e) { lf = null; }
                if (lf) { var t = _clean(lf); if (t) return t; }
            }
            var wrap = el.closest && el.closest('label');
            if (wrap) { var tw = _clean(wrap); if (tw) return tw; }
            if (tag === 'input' && /^(button|submit|reset)$/i.test(el.type || '')) { if (el.value) return String(el.value); }
        } else if (tag === 'img') {
            var alt = _attr(el, 'alt').trim(); if (alt) return alt;
        } else if (tag === 'button' || tag === 'a' || /^(button|tab|link|menuitem|option)$/.test(_attr(el, 'role'))) {
            var tc = String(el.textContent || '').replace(/\s+/g, ' ').trim();
            if (/[A-Za-z0-9À-ɏͰ-Ͽ]/.test(tc)) return tc;
        }
        var ti = _attr(el, 'title').trim(); if (ti) return ti;
        var ph = _attr(el, 'placeholder').trim(); if (ph) return ph;
        return '';
    }
    // Name from author markup only (ignores a label this layer generated earlier).
    function _authorName(el) {
        if (el.hasAttribute && el.hasAttribute(AUTO)) {
            var keep = el.getAttribute('aria-label');
            el.removeAttribute('aria-label');
            var n = name(el);
            if (keep != null) el.setAttribute('aria-label', keep);
            return n;
        }
        return name(el);
    }
    function _setAuto(el, attr, value) {
        if (!value) return;
        if (el.getAttribute(attr) !== value) el.setAttribute(attr, value);
        if (!el.hasAttribute(AUTO)) el.setAttribute(AUTO, '1');
    }

    // ── table cell → "row label, column header" ─────────────────────────
    function _colIndex(cell) {
        var row = cell.parentNode, idx = 0;
        var cells = row && row.children ? row.children : [];
        for (var i = 0; i < cells.length && cells[i] !== cell; i++) idx += Math.max(1, +cells[i].colSpan || 1);
        return idx;
    }
    function _cellAt(row, idx) {
        var cells = row.children || [], at = 0;
        for (var i = 0; i < cells.length; i++) {
            var span = Math.max(1, +cells[i].colSpan || 1);
            if (idx >= at && idx < at + span) return cells[i];
            at += span;
        }
        return null;
    }
    function _headerRow(table, ownRow) {
        var rows = table.rows || table.querySelectorAll('tr');
        if (table.tHead && table.tHead.rows && table.tHead.rows.length) return table.tHead.rows[table.tHead.rows.length - 1];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (r === ownRow) return null;
            var ths = 0, all = 0;
            for (var k = 0; k < r.children.length; k++) { var t = String(r.children[k].localName || '').toLowerCase(); if (t === 'th') ths++; if (t === 'th' || t === 'td') all++; }
            if (all && ths === all) return r;
            if (i >= 2) return null;
        }
        return null;
    }
    function _tableName(ctl) {
        var cell = ctl.closest && ctl.closest('td, th');
        var table = cell && cell.closest('table');
        if (!cell || !table) return '';
        var row = cell.parentNode;
        var idx = _colIndex(cell);
        var col = '';
        var hr = _headerRow(table, row);
        if (hr && hr !== row) { var hc = _cellAt(hr, idx); if (hc) col = _clean(hc); }
        var rowLabel = '';
        var cells = row.children || [];
        for (var i = 0; i < cells.length; i++) {
            var c = cells[i];
            if (c === cell) break;
            if (c.querySelector && c.querySelector(CONTROL_SEL)) {
                // a select naming the row (e.g. a segment picker) labels the row
                var sel = c.querySelector('select');
                if (sel && i === 0 && sel.options && sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]) {
                    rowLabel = String(sel.options[sel.selectedIndex].text || '').trim();
                    break;
                }
                continue;
            }
            var t = _clean(c);
            if (t) { rowLabel = t; break; }
        }
        // several controls in one cell (value + unit select): number them
        var inCell = cell.querySelectorAll(CONTROL_SEL), nth = '';
        if (inCell.length > 1) {
            for (var j = 0; j < inCell.length; j++) if (inCell[j] === ctl) nth = String(ctl.localName).toLowerCase() === 'select' ? ' (unit / option)' : (j ? ' (' + (j + 1) + ')' : '');
        }
        if (!rowLabel) {
            var ri = typeof row.rowIndex === 'number' && row.rowIndex >= 0 ? row.rowIndex : -1;
            if (hr && ri >= 0) { var hri = hr.rowIndex; if (typeof hri === 'number' && hri >= 0 && ri > hri) ri -= hri; }
            if (ri >= 0) rowLabel = 'Row ' + (ri + (hr ? 0 : 1));
        }
        if (!col) col = 'column ' + (idx + 1);
        return _short((rowLabel ? rowLabel + ', ' : '') + col + nth, 160);
    }

    function _contextHeading(el) {
        var box = el.closest && el.closest('.card, .rbox, .chart-wrap, section, [data-rp-block]');
        var guard = 0;
        while (box && guard++ < 6) {
            var h = box.querySelector && box.querySelector('.card-title, .rbox-title, h1, h2, h3, h4, h5, legend');
            if (h) { var t = _clean(h); if (t) return _short(t, 90); }
            box = box.parentNode && box.parentNode.closest ? box.parentNode.closest('.card, .rbox, .chart-wrap, section') : null;
        }
        var pt = _byId('pgTitle');
        return pt ? _short(_clean(pt), 90) : '';
    }
    function _humanId(id) {
        id = String(id || '').replace(/^[a-z0-9]{1,6}_/i, '');
        return id.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    }

    function _labelControl(ctl) {
        var type = String(ctl.type || '').toLowerCase();
        if (SKIP_TYPES[type] && String(ctl.localName).toLowerCase() === 'input') return;
        if (_authorName(ctl)) { if (ctl.hasAttribute(AUTO)) { ctl.removeAttribute('aria-label'); ctl.removeAttribute(AUTO); } return; }
        var label = '';
        var fg = ctl.closest && ctl.closest('.fg-item');
        if (fg && !(ctl.closest('table') && fg.contains(ctl.closest('table')))) {
            var l = fg.querySelector('label');
            var lt = l ? _clean(l) : '';
            if (lt) {
                var ctls = fg.querySelectorAll(CONTROL_SEL), k = 0;
                for (var i = 0; i < ctls.length; i++) if (ctls[i] === ctl) k = i;
                label = k === 0 ? lt : lt + (String(ctl.localName).toLowerCase() === 'select' ? ' — unit / option' : ' (' + (k + 1) + ')');
            }
        }
        if (!label && ctl.closest && ctl.closest('td, th')) label = _tableName(ctl);
        if (!label) {
            var prev = ctl.previousElementSibling;
            if (prev && /^(label|span|b|strong|small|div)$/i.test(prev.localName || '') && !prev.querySelector(CONTROL_SEL)) {
                var pt = _clean(prev); if (pt && pt.length <= 80) label = pt;
            }
        }
        if (!label && type === 'file') label = 'Choose file';
        if (!label) {
            var ctx = _contextHeading(ctl), hid = _humanId(ctl.id);
            label = (ctx && hid) ? ctx + ' — ' + hid : (hid || ctx || '');
        }
        _setAuto(ctl, 'aria-label', _short(label, 160));
    }

    // Icon-only native buttons: fall back to their title, then a symbol map.
    var ICONS = { '×': 'Remove', '✕': 'Close', '✖': 'Close', '☰': 'Menu', '↶': 'Undo', '↷': 'Redo',
        '↑': 'Move up', '↓': 'Move down', '▲': 'Move up', '▼': 'Move down', '+': 'Add', '−': 'Remove', '-': 'Remove',
        '⤢': 'Expand', '⛶': 'Full screen', '⟲': 'Reset', '↺': 'Reset', '⚙': 'Settings', '?': 'Help', 'i': 'Help',
        '▶': 'Play', '⏸': 'Pause', '■': 'Stop', '⏹': 'Stop', '‹': 'Back', '›': 'Next', '«': 'First', '»': 'Last' };
    function _labelButton(b) {
        if (_authorName(b)) return;
        var tc = String(b.textContent || '').replace(/\s+/g, '').trim();
        var lab = ICONS[tc] || '';
        if (!lab) { var ctx = _contextHeading(b); lab = ctx ? ctx + ' — button' : ''; }
        if (lab) _setAuto(b, 'aria-label', lab);
    }

    // ── roving tabindex helpers ──────────────────────────────────────────
    function _rove(items, current) {
        for (var i = 0; i < items.length; i++) {
            var want = items[i] === current ? '0' : '-1';
            if (items[i].getAttribute('tabindex') !== want) items[i].setAttribute('tabindex', want);
        }
    }
    function _navButtons() { return _hasDoc ? Array.prototype.slice.call(document.querySelectorAll('#sidebar .nav-btn')) : []; }
    // Buttons the sidebar shows right now (accordion + hubs, v3.1): search hits while searching;
    // otherwise no hub members and, in a collapsed group, only the active button. ↑/↓ and the
    // single tab stop move over these only, so the tab stop is never on a hidden button.
    function _navShown(btns) {
        var sb = _byId('sidebar'), searching = !!(sb && sb.classList && sb.classList.contains('sb-searching'));
        return btns.filter(function (b) {
            var c = b.classList;
            if (!c) return true;
            if (c.contains('sb-hide')) return false;
            if (searching) return true;
            if (c.contains('nav-hub-member')) return false;
            var g = b.closest ? b.closest('.nav-group') : null;
            return !(g && g.classList && g.classList.contains('collapsed') && !c.contains('active'));
        });
    }
    function _syncSidebar() {
        var btns = _navButtons();
        if (!btns.length) return;
        var active = null;
        for (var i = 0; i < btns.length; i++) {
            var b = btns[i];
            if (b.getAttribute('role') !== 'button' && String(b.localName).toLowerCase() !== 'button') b.setAttribute('role', 'button');
            var on = b.classList && b.classList.contains('active');
            if (on) { active = active || b; if (b.getAttribute('aria-current') !== 'page') b.setAttribute('aria-current', 'page'); }
            else if (b.hasAttribute('aria-current')) b.removeAttribute('aria-current');
        }
        var shown = _navShown(btns), focused = document.activeElement;
        if (active && shown.indexOf(active) === -1) active = null;
        _rove(btns, shown.indexOf(focused) !== -1 ? focused : (active || shown[0] || btns[0]));
    }
    function _tabsOf(list) {
        var out = [], ch = list.children || [];
        for (var i = 0; i < ch.length; i++) {
            var c = ch[i];
            if ((c.classList && c.classList.contains('tab-btn')) || c.getAttribute('role') === 'tab') out.push(c);
        }
        return out;
    }
    function _syncTablist(list) {
        var tabs = _tabsOf(list);
        if (tabs.length < 2) return;
        if (!list.getAttribute('role')) list.setAttribute('role', 'tablist');
        var sel = null, byClass = false;
        for (var a = 0; a < tabs.length; a++) if (tabs[a].classList && tabs[a].classList.contains('active')) byClass = true;
        for (var i = 0; i < tabs.length; i++) {
            var t = tabs[i];
            if (t.getAttribute('role') !== 'tab') t.setAttribute('role', 'tab');
            // the .active class is the source of truth where the strip uses it, else aria-selected
            var on = byClass ? t.classList.contains('active') : t.getAttribute('aria-selected') === 'true';
            if (on && !sel) sel = t;
            var want = on ? 'true' : 'false';
            if (t.getAttribute('aria-selected') !== want) t.setAttribute('aria-selected', want);
        }
        var focused = _hasDoc ? document.activeElement : null;
        _rove(tabs, tabs.indexOf(focused) !== -1 ? focused : (sel || tabs[0]));
    }
    function _syncTabs(root) {
        var lists = (root || document).querySelectorAll('.tabs, [role="tablist"]');
        for (var i = 0; i < lists.length; i++) _syncTablist(lists[i]);
    }

    // ── the pass ─────────────────────────────────────────────────────────
    function apply(root) {
        if (!_hasDoc) return 0;
        var n = 0;
        try {
            _forMap = {};
            var fl = document.querySelectorAll('label[for]');
            for (var f = fl.length - 1; f >= 0; f--) _forMap[fl[f].getAttribute('for')] = fl[f];   // first label wins
            var sb = _byId('sidebar');
            if (sb && !sb.getAttribute('role')) { sb.setAttribute('role', 'navigation'); sb.setAttribute('aria-label', 'Calculators'); }
            _syncSidebar();
            var pg = _byId('pgBody');
            if (pg && !pg.hasAttribute('tabindex')) pg.setAttribute('tabindex', '-1');   // skip-link target
            var sf = _byId('saveFlash');
            if (sf && !sf.getAttribute('role')) { sf.setAttribute('role', 'status'); sf.setAttribute('aria-live', 'polite'); }
            var hdr = document.querySelector('.page-header');   // header controls live outside #pgBody
            if (hdr && root) _labelArea(hdr);
            root = root || document.body || document;
            _syncTabs(root);

            // click-only elements → buttons
            var clickables = root.querySelectorAll('.dash-card, [data-dc], [onclick]');
            for (var i = 0; i < clickables.length; i++) {
                var el = clickables[i], tag = String(el.localName || '').toLowerCase();
                if (/^(button|a|input|select|textarea|label|option|body|html|summary|tr|td|th|table|tbody|thead)$/.test(tag)) continue;
                if (el.id === 'sidebarOverlay' || (el.classList && el.classList.contains('sidebar-overlay'))) continue;
                if (el.querySelector && el.querySelector('button, a[href], input, select, textarea')) continue;   // a container, not a control
                if (!el.getAttribute('role')) el.setAttribute('role', 'button');
                if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
                if (el.classList && el.classList.contains('dash-card') && !_authorName(el)) {
                    var h = el.querySelector('h3, .dc-title');
                    if (h) _setAuto(el, 'aria-label', _clean(h));
                }
                n++;
            }
            // native buttons without a name
            var btns = root.querySelectorAll('button, [role="button"]');
            for (var b = 0; b < btns.length; b++) _labelButton(btns[b]);
            // form controls
            var ctls = root.querySelectorAll(CONTROL_SEL);
            for (var c = 0; c < ctls.length; c++) { _labelControl(ctls[c]); n++; }
            // result areas → polite live regions (WCAG 4.1.3 status messages)
            var res = root.querySelectorAll('[id$="_res"], [id$="_result"], [id$="_results"], [data-wts-project-toolbar] [data-role="msg"]');
            for (var r = 0; r < res.length; r++) {
                var re = res[r], rt = String(re.localName || '').toLowerCase();
                if (rt === 'input' || rt === 'select' || rt === 'textarea' || rt === 'canvas') continue;
                if (!re.hasAttribute('aria-live')) re.setAttribute('aria-live', 'polite');
            }
            // canvases and diagrams → images with a name
            var imgs = root.querySelectorAll('canvas, svg');
            for (var m = 0; m < imgs.length; m++) {
                var im = imgs[m];
                if (im.getAttribute('aria-hidden') === 'true' || /^(presentation|none)$/.test(im.getAttribute('role') || '')) continue;
                if (String(im.localName).toLowerCase() === 'svg' && im.parentNode && im.parentNode.closest && im.parentNode.closest('button, a, svg, .nav-icon, [role="button"]')) continue;
                if (im.getAttribute('aria-label') || im.getAttribute('aria-labelledby')) continue;
                var ttl = '';
                if (String(im.localName).toLowerCase() === 'svg') { var te = im.querySelector('title'); ttl = te ? _clean(te) : ''; }
                var ctxh = _contextHeading(im);
                var kind = String(im.localName).toLowerCase() === 'svg' ? 'diagram' : 'chart';
                if (!im.getAttribute('role')) im.setAttribute('role', 'img');
                _setAuto(im, 'aria-label', ttl || (ctxh ? ctxh + ' ' + kind : kind.charAt(0).toUpperCase() + kind.slice(1)));
            }
            _renderDecimalToggle();
        } catch (e) {
            try { console.warn('[a11y] pass failed', e); } catch (_) { /* ignore */ }
        }
        _forMap = null;
        return n;
    }

    function _labelArea(area) {
        var c = area.querySelectorAll(CONTROL_SEL);
        for (var i = 0; i < c.length; i++) _labelControl(c[i]);
        var b = area.querySelectorAll('button');
        for (var j = 0; j < b.length; j++) _labelButton(b[j]);
    }
    function _applyPage() { apply(_byId('pgBody') || undefined); }

    // ── keyboard ─────────────────────────────────────────────────────────
    function _isNative(el) { return /^(button|a|input|select|textarea|summary)$/i.test(el.localName || ''); }
    function _move(list, cur, key) {
        var i = list.indexOf(cur);
        if (i === -1) return null;
        if (key === 'Home') return list[0];
        if (key === 'End') return list[list.length - 1];
        var d = (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1;
        return list[(i + d + list.length) % list.length];
    }
    function _onKey(ev) {
        var t = ev.target;
        if (!t || t.nodeType !== 1 || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey) return;
        var key = ev.key;
        // sidebar: ↑/↓/Home/End move the single tab stop
        if (t.classList && t.classList.contains('nav-btn') && t.closest && t.closest('#sidebar')) {
            if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
                var nb = _move(_navShown(_navButtons()), t, key);
                if (nb) { ev.preventDefault(); _rove(_navButtons(), nb); try { nb.focus(); } catch (e) { /* ignore */ } }
                return;
            }
        }
        // tabs: ←/→/Home/End move and activate (automatic activation)
        if (t.getAttribute('role') === 'tab' && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End')) {
            var list = t.parentNode ? _tabsOf(t.parentNode) : [];
            var nt = _move(list, t, key);
            if (nt) {
                ev.preventDefault();
                _rove(list, nt);
                try { nt.focus(); } catch (e) { /* ignore */ }
                try { nt.click(); } catch (e) { /* ignore */ }
                var nf = nt.id ? _byId(nt.id) : null;            // tab strip may have been re-rendered
                if (nf && nf !== nt) try { nf.focus(); } catch (e) { /* ignore */ }
            }
            return;
        }
        // Enter / Space on a non-native button
        if ((key === 'Enter' || key === ' ' || key === 'Spacebar') && !_isNative(t) && /^(button|tab|link|menuitem)$/.test(t.getAttribute('role') || '')) {
            if (t.isContentEditable) return;
            ev.preventDefault();
            try { t.click(); } catch (e) { /* ignore */ }
            return;
        }
        if (key === 'Escape') {
            var sb = _byId('sidebar'), ov = _byId('sidebarOverlay');
            if (ov && ov.classList && ov.classList.contains('show') && typeof G.closeMobileSidebar === 'function') {
                G.closeMobileSidebar();
                var burger = _byId('mobBurger'); if (burger) try { burger.focus(); } catch (e) { /* ignore */ }
            } else if (sb && sb.contains && sb.contains(t)) { /* nothing */ }
        }
    }

    // ── decimal comma ────────────────────────────────────────────────────
    function _prefGet() { try { return G.localStorage && G.localStorage.getItem(PREF_KEY) === '1'; } catch (e) { return false; } }
    function decimalComma(on) {
        if (on === undefined) return _prefGet();
        try { if (on) G.localStorage.setItem(PREF_KEY, '1'); else G.localStorage.removeItem(PREF_KEY); } catch (e) { /* storage blocked */ }
        _renderDecimalToggle();
        return !!on;
    }
    function parseNumber(s) {
        if (typeof s === 'number') return s;
        s = String(s == null ? '' : s);
        if (_prefGet()) { var m = DEC_COMMA_RE.exec(s); if (m) s = m[1] + '.' + m[2]; }
        return parseFloat(s);
    }
    function _numericField(t) {
        if (!t || String(t.localName || '').toLowerCase() !== 'input') return false;
        if (t.hasAttribute && t.hasAttribute('data-no-decimal-comma')) return false;
        var ty = String(t.getAttribute('type') || 'text').toLowerCase();
        return ty === 'number' || ty === 'text' || ty === 'tel' || ty === '' || (ty === 'search' && t.getAttribute('inputmode') === 'decimal');
    }
    function _onValue(ev) {
        var t = ev.target;
        if (!_numericField(t) || !_prefGet()) return;
        var v = String(t.value == null ? '' : t.value), m = DEC_COMMA_RE.exec(v);
        if (m) { try { t.value = m[1] + '.' + m[2]; } catch (e) { /* ignore */ } }
    }
    function _insert(text) {
        try { return !!(document.execCommand && document.execCommand('insertText', false, text)); } catch (e) { return false; }
    }
    function _onKeyComma(ev) {
        if (ev.key !== ',' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        var t = ev.target;
        if (!t || String(t.getAttribute && t.getAttribute('type') || '').toLowerCase() !== 'number' || !_prefGet()) return;
        if (_insert('.')) ev.preventDefault();          // a number field would otherwise drop "12,5" to ""
    }
    function _onPaste(ev) {
        var t = ev.target;
        if (!_numericField(t) || !_prefGet()) return;
        var d = ev.clipboardData || G.clipboardData, s = '';
        try { s = d ? d.getData('text') : ''; } catch (e) { s = ''; }
        var m = DEC_COMMA_RE.exec(String(s || ''));
        if (m && _insert(m[1] + '.' + m[2])) ev.preventDefault();
    }
    function _renderDecimalToggle() {
        if (!_hasDoc) return;
        var host = _byId('wts_unit_toggle_host');
        if (!host) return;
        var b = _byId('wts_dec_comma');
        if (!b) {
            b = document.createElement('button');
            b.type = 'button';
            b.id = 'wts_dec_comma';
            b.className = 'btn btn-secondary';
            b.textContent = '1,5';
            b.setAttribute('title', 'Decimal comma: when on, 12,5 typed or pasted into a number field is read as 12.5 ' +
                '(a single comma with digits after it and no point; 1,500 then means 1.5)');
            b.style.cssText = 'padding:3px 8px;font-size:11px;border-radius:4px;border:1px solid var(--border,#30363d);' +
                'cursor:pointer;background:transparent;color:var(--text2,#8b949e);margin-left:6px;';
            b.addEventListener('click', function () { decimalComma(!_prefGet()); });
            try { host.appendChild(b); } catch (e) { return; }
        }
        var on = _prefGet();
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.setAttribute('aria-label', 'Accept decimal comma in number fields');
        b.style.background = on ? 'var(--accent, #f0883e)' : 'transparent';
        b.style.color = on ? 'var(--on-accent, #0d1117)' : 'var(--text2, #8b949e)';
    }

    // ── wiring ───────────────────────────────────────────────────────────
    // One-shot, coalescing scheduler (not polling): a full #pgBody pass after PRiSM
    // events, or — for DOM mutations — a pass over just the added subtrees.
    var _moTimer = null, _full = false, _roots = [];
    function _scheduleApply(roots) {
        if (Array.isArray(roots)) { for (var i = 0; i < roots.length && _roots.length < 200; i++) _roots.push(roots[i]); }
        else _full = true;
        if (_moTimer) return;
        _moTimer = setTimeout(function () {
            _moTimer = null;
            var full = _full || _roots.length >= 200, list = _roots;
            _full = false; _roots = [];
            if (full) { _applyPage(); return; }
            for (var k = 0; k < list.length; k++) {
                var r = list[k];
                if (!r || !r.isConnected && r.isConnected !== undefined) continue;
                if (r.matches && r.matches(CONTROL_SEL)) _labelControl(r);
                else if (r.querySelectorAll) apply(r);
            }
        }, 0);
    }
    function _labelOne(ev) {
        var t = ev.target;
        if (!t || t.nodeType !== 1) return;
        try {
            if (t.matches && t.matches(CONTROL_SEL)) _labelControl(t);
            else if (String(t.localName).toLowerCase() === 'button') _labelButton(t);
        } catch (e) { /* ignore */ }
    }
    function _init() {
        if (!_hasDoc || G.__wtsA11yWired) return;
        G.__wtsA11yWired = true;
        document.addEventListener('keydown', _onKey);
        document.addEventListener('keydown', _onKeyComma, true);
        document.addEventListener('paste', _onPaste, true);
        document.addEventListener('input', _onValue, true);
        document.addEventListener('change', _onValue, true);
        document.addEventListener('focusin', _labelOne);
        // after any click the tab strips / sidebar may have changed state
        document.addEventListener('click', function (ev) {
            var t = ev.target;
            if (!t || !t.closest) return;
            var list = t.closest('.tabs, [role="tablist"]');
            if (list) _syncTablist(list);
            if (t.closest('#sidebar .nav-group-label')) _syncSidebar();   // accordion: keep the tab stop on a shown button
            if (t.closest('#wts_skip_link')) {
                ev.preventDefault();
                var pg = _byId('pgBody');
                if (pg) { if (!pg.hasAttribute('tabindex')) pg.setAttribute('tabindex', '-1'); try { pg.focus(); } catch (e) { /* ignore */ } }
            }
        });
        // end of every host render(): label the new page now (synchronously)
        document.addEventListener('h2oil:pagechange', _applyPage);
        document.addEventListener('wts:unit-system-changed', _applyPage);
        // PRiSM re-renders tabs / panels in place: one coalesced pass after the burst
        if (typeof G.addEventListener === 'function') {
            ['prism:tab-open', 'prism:step-changed', 'prism:fit-updated', 'prism:dataset-loaded'].forEach(function (e) {
                G.addEventListener(e, function () { _scheduleApply(); });
            });
        }
        if (G.MutationObserver) {
            try {
                var pg = _byId('pgBody');
                if (pg) new G.MutationObserver(function (muts) {
                    var add = [];
                    for (var i = 0; i < muts.length; i++) {
                        var an = muts[i].addedNodes || [];
                        for (var j = 0; j < an.length; j++) if (an[j].nodeType === 1) add.push(an[j]);
                    }
                    if (add.length) _scheduleApply(add);
                }).observe(pg, { childList: true, subtree: true });
            } catch (e) { /* ignore */ }
        }
        apply();
    }
    if (_hasDoc) {
        if (document.readyState === 'loading' && typeof document.addEventListener === 'function') document.addEventListener('DOMContentLoaded', _init);
        else _init();
    }

    G.WTS_a11y = { apply: apply, name: name, decimalComma: decimalComma, parseNumber: parseNumber };
    G.WTS_parseNumber = parseNumber;
})();

// === SELF-TEST ===
(function () {
    var G = (typeof window !== 'undefined') ? window : globalThis;
    var A = G.WTS_a11y, fails = [];
    if (!A || typeof A.apply !== 'function') fails.push('WTS_a11y missing');
    else {
        if (A.parseNumber('12.5') !== 12.5) fails.push('parseNumber 12.5');
        if (A.parseNumber(' -3 ') !== -3) fails.push('parseNumber -3');
    }
    if (fails.length && typeof console !== 'undefined') console.error('[a11y self-test] FAILED: ' + fails.join('; '));
})();
