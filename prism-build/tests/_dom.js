// prism-build/tests/_dom.js — a small, deterministic browser-DOM stub for the
// headless acceptance harness (_harness.js). Owned by WP0.
//
// What it models (enough to exercise the PRiSM tab renderers + handlers):
//   • a real node tree (Element / Text / Comment / DocumentFragment) built by
//     a tolerant HTML parser (innerHTML / outerHTML / insertAdjacentHTML);
//   • getElementById backed by an id registry (one live element per id —
//     the most recently created *connected* element wins);
//   • querySelector / querySelectorAll with tag, #id, .class, [attr op val],
//     descendant / child / sibling combinators, selector lists and the
//     pseudo-classes :checked :disabled :enabled :first-child :last-child
//     :nth-child(n) :not(...) :scope (other pseudo-classes match everything);
//   • classList, dataset, style (+ cssText), attribute reflection,
//     form-control value / checked / selected / options;
//   • EventTarget with capture / target / bubble phases, on<event> props and
//     inline on<event>="…" attributes (compiled in the app realm);
//   • a recording CanvasRenderingContext2D (every call / property set is
//     appended to canvas._log) — see canvasLog() in _harness.js;
//   • a trivial layout model: connected, displayed elements report
//     layout.width × layout.height (canvas: its CSS/attribute size);
//     display:none (self or ancestor) and detached elements report 0.
//
// Everything here runs in the harness (outer) realm; the app code only sees
// these objects through the vm context globals.

'use strict';

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style']);
const RCDATA = new Set(['textarea', 'title']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  deg: '°', times: '×', divide: '÷', middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', le: '≤', ge: '≥', ne: '≠', plusmn: '±',
  micro: 'µ', sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', infin: '∞',
  radic: '√', sum: '∑', part: '∂', prime: '′', Prime: '″', asymp: '≈', equiv: '≡', minus: '−',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', epsilon: 'ε', eta: 'η', theta: 'θ',
  lambda: 'λ', mu: 'μ', pi: 'π', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', tau: 'τ', phi: 'φ', Phi: 'Φ',
  psi: 'ψ', omega: 'ω', Omega: 'Ω', check: '✓', cross: '✗', euro: '€', pound: '£', sect: '§',
  para: '¶', dagger: '†', loz: '◊', empty: '∅', isin: '∈', and: '∧', or: '∨', cap: '∩', cup: '∪',
  int: '∫', there4: '∴', sim: '∼', cong: '≅', sub: '⊂', sup: '⊃', oplus: '⊕', perp: '⊥',
  lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', ensp: ' ', emsp: ' ', thinsp: ' ',
  zwj: '‍', zwnj: '‌', shy: '­', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª',
  half: '½', starf: '★', star: '☆', squ: '□', square: '□', hearts: '♥', spades: '♠', clubs: '♣',
  diams: '♦', crarr: '↵', nabla: '∇', prop: '∝', ang: '∠', Uuml: 'Ü', uuml: 'ü', ouml: 'ö',
  auml: 'ä', eacute: 'é', egrave: 'è', aacute: 'á', oacute: 'ó', ntilde: 'ñ', ccedil: 'ç',
};

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);?/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (_) { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
  });
}
const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/ /g, '&nbsp;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/ /g, '&nbsp;');
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

// ─────────────────────────────────────────────────────────────────────────
// Events
// ─────────────────────────────────────────────────────────────────────────
class Event {
  constructor(type, init) {
    init = init || {};
    this.type = String(type);
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.composed = !!init.composed;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this.srcElement = null;
    this.eventPhase = 0;
    this.isTrusted = false;
    this.timeStamp = Date.now();
    this._stop = false;
    this._stopImm = false;
    this.returnValue = true;
  }
  preventDefault() { if (this.cancelable) { this.defaultPrevented = true; this.returnValue = false; } }
  stopPropagation() { this._stop = true; }
  stopImmediatePropagation() { this._stop = true; this._stopImm = true; }
  composedPath() { return this._path ? this._path.slice() : []; }
  initEvent(type, bubbles, cancelable) { this.type = type; this.bubbles = !!bubbles; this.cancelable = !!cancelable; }
  get cancelBubble() { return this._stop; }
  set cancelBubble(v) { if (v) this._stop = true; }
}
Event.NONE = 0; Event.CAPTURING_PHASE = 1; Event.AT_TARGET = 2; Event.BUBBLING_PHASE = 3;
function copyInit(ev, init, skip) {
  if (!init) return;
  for (const k of Object.keys(init)) if (!skip.has(k)) ev[k] = init[k];
}
const BASE_KEYS = new Set(['bubbles', 'cancelable', 'composed']);
class CustomEvent extends Event {
  constructor(type, init) { super(type, init); this.detail = init && 'detail' in init ? init.detail : null; }
  initCustomEvent(type, b, c, detail) { this.initEvent(type, b, c); this.detail = detail; }
}
class UIEvent extends Event { constructor(t, i) { super(t, i); this.detail = 0; this.view = null; copyInit(this, i, BASE_KEYS); } }
class MouseEvent extends UIEvent {
  constructor(t, i) {
    super(t, i);
    const d = { clientX: 0, clientY: 0, screenX: 0, screenY: 0, pageX: 0, pageY: 0, offsetX: 0, offsetY: 0,
      movementX: 0, movementY: 0, button: 0, buttons: 0, altKey: false, ctrlKey: false, metaKey: false,
      shiftKey: false, relatedTarget: null };
    for (const k of Object.keys(d)) if (!(i && k in i)) this[k] = d[k];
    if (i && !('pageX' in i) && 'clientX' in i) this.pageX = i.clientX;
    if (i && !('pageY' in i) && 'clientY' in i) this.pageY = i.clientY;
    if (i && !('offsetX' in i) && 'clientX' in i) this.offsetX = i.clientX;
    if (i && !('offsetY' in i) && 'clientY' in i) this.offsetY = i.clientY;
  }
  get x() { return this.clientX; }
  get y() { return this.clientY; }
}
class PointerEvent extends MouseEvent { constructor(t, i) { super(t, i); if (!(i && 'pointerId' in i)) this.pointerId = 1; if (!(i && 'pointerType' in i)) this.pointerType = 'mouse'; } }
class WheelEvent extends MouseEvent { constructor(t, i) { super(t, i); for (const k of ['deltaX', 'deltaY', 'deltaZ', 'deltaMode']) if (!(i && k in i)) this[k] = 0; } }
class KeyboardEvent extends UIEvent {
  constructor(t, i) {
    super(t, i);
    const d = { key: '', code: '', keyCode: 0, which: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false };
    for (const k of Object.keys(d)) if (!(i && k in i)) this[k] = d[k];
  }
}
class FocusEvent extends UIEvent {}
class InputEvent extends UIEvent { constructor(t, i) { super(t, i); if (!(i && 'data' in i)) this.data = null; if (!(i && 'inputType' in i)) this.inputType = ''; } }
class TouchEvent extends UIEvent { constructor(t, i) { super(t, i); for (const k of ['touches', 'targetTouches', 'changedTouches']) if (!(i && k in i)) this[k] = []; } }
class ErrorEvent extends Event { constructor(t, i) { super(t, i); copyInit(this, i, BASE_KEYS); } }
class ProgressEvent extends Event { constructor(t, i) { super(t, i); copyInit(this, i, BASE_KEYS); } }
class StorageEvent extends Event { constructor(t, i) { super(t, i); copyInit(this, i, BASE_KEYS); } }
class DragEvent extends MouseEvent { constructor(t, i) { super(t, i); if (!(i && 'dataTransfer' in i)) this.dataTransfer = null; } }

// EventTarget mixin — used by Node, Document and the window.
const ON_EVENTS = ['click', 'dblclick', 'change', 'input', 'submit', 'reset', 'keydown', 'keyup', 'keypress',
  'mousedown', 'mouseup', 'mousemove', 'mouseenter', 'mouseleave', 'mouseover', 'mouseout', 'wheel',
  'contextmenu', 'focus', 'blur', 'focusin', 'focusout', 'load', 'error', 'abort', 'scroll', 'resize',
  'pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'pointercancel', 'pointerenter',
  'touchstart', 'touchmove', 'touchend', 'touchcancel', 'dragstart', 'drag', 'dragend', 'dragenter',
  'dragleave', 'dragover', 'drop', 'paste', 'copy', 'cut', 'select', 'toggle', 'animationend',
  'transitionend', 'beforeunload', 'unload', 'hashchange', 'popstate', 'storage', 'message'];

function listenersOf(t) {
  if (!t.__listeners) Object.defineProperty(t, '__listeners', { value: new Map(), enumerable: false });
  return t.__listeners;
}
function addEventListener(type, fn, opts) {
  if (!fn) return;
  const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
  const once = !!(opts && typeof opts === 'object' && opts.once);
  const m = listenersOf(this);
  if (!m.has(type)) m.set(type, []);
  const arr = m.get(type);
  if (arr.some((l) => l.fn === fn && l.capture === capture)) return;
  arr.push({ fn, capture, once });
}
function removeEventListener(type, fn, opts) {
  const capture = typeof opts === 'boolean' ? opts : !!(opts && opts.capture);
  const m = listenersOf(this);
  const arr = m.get(type);
  if (!arr) return;
  const i = arr.findIndex((l) => l.fn === fn && l.capture === capture);
  if (i !== -1) arr.splice(i, 1);
}

// ─────────────────────────────────────────────────────────────────────────
// DOM factory — one per loadApp() session
// ─────────────────────────────────────────────────────────────────────────
function createDOM(env) {
  // env: { win (app global, set later), compileHandler(code) → fn, reportError(err, where),
  //        layout:{width,height}, viewport:{width,height}, recordCanvas, canvasLogLimit,
  //        onDownload(rec), rootVars:{} }
  const ids = new Map();          // id → [elements] (latest last)
  let seq = 0;

  function register(el, id) {
    if (!id) return;
    let arr = ids.get(id);
    if (!arr) { arr = []; ids.set(id, arr); }
    const i = arr.indexOf(el);
    if (i !== -1) arr.splice(i, 1);
    arr.push(el);
    if (arr.length > 6) {
      const keep = arr.filter((e, k) => k === arr.length - 1 || e.isConnected);
      arr.length = 0; arr.push(...keep);
    }
  }

  function reportError(err, where) { if (env.reportError) env.reportError(err, where); }

  function dispatch(target, ev) {
    if (!ev || typeof ev.type !== 'string') throw new TypeError('dispatchEvent: argument is not an Event');
    ev.target = target; ev.srcElement = target;
    // Propagation path: node ancestors → document → window (if connected).
    const path = [target];
    if (target.nodeType) {
      let n = target.parentNode;
      while (n) { path.push(n); n = n.parentNode; }
      if (path[path.length - 1] === doc && env.win) path.push(env.win);
    } else if (target === doc && env.win) {
      path.push(env.win);
    }
    ev._path = path;
    const invoke = (cur, phase) => {
      ev.currentTarget = cur; ev.eventPhase = phase;
      const m = cur.__listeners && cur.__listeners.get(ev.type);
      if (m && m.length) {
        for (const l of m.slice()) {
          if (phase === 1 && !l.capture) continue;
          if (phase === 3 && l.capture) continue;
          if (l.once) removeEventListener.call(cur, ev.type, l.fn, l.capture);
          try {
            if (typeof l.fn === 'function') l.fn.call(cur, ev);
            else if (l.fn && typeof l.fn.handleEvent === 'function') l.fn.handleEvent(ev);
          } catch (e) { reportError(e, 'listener ' + ev.type); }
          if (ev._stopImm) return;
        }
      }
      if (phase !== 1) {
        const h = onHandler(cur, ev.type);
        if (typeof h === 'function') {
          try {
            const r = h.call(cur, ev);
            if (r === false) ev.preventDefault();
          } catch (e) { reportError(e, 'on' + ev.type); }
        }
      }
    };
    for (let i = path.length - 1; i > 0 && !ev._stop; i--) invoke(path[i], 1);
    if (!ev._stop) invoke(target, 2);
    if (ev.bubbles) for (let i = 1; i < path.length && !ev._stop; i++) invoke(path[i], 3);
    ev.currentTarget = null; ev.eventPhase = 0;
    return !ev.defaultPrevented;
  }

  function onHandler(cur, type) {
    const own = cur.__on && cur.__on[type];
    if (own !== undefined) return own;
    if (cur === env.win) { const w = env.win['on' + type]; return typeof w === 'function' ? w : null; }
    if (cur.nodeType === 1) {
      const code = cur.getAttribute('on' + type);
      if (code) return compiledAttr(cur, type, code);
    }
    return null;
  }
  function compiledAttr(el, type, code) {
    if (!el.__onAttr) Object.defineProperty(el, '__onAttr', { value: {}, enumerable: false });
    const c = el.__onAttr[type];
    if (c && c.code === code) return c.fn;
    let fn = null;
    try { fn = env.compileHandler(code); } catch (e) { reportError(e, 'compile on' + type + '="' + code + '"'); }
    el.__onAttr[type] = { code, fn };
    return fn;
  }

  // ── Style ──
  function makeStyle(el) {
    const st = {};
    Object.defineProperties(st, {
      setProperty: { value(name, val) { if (val == null || val === '') delete st[name.startsWith('--') ? name : camel(name)]; else st[name.startsWith('--') ? name : camel(name)] = String(val); }, enumerable: false },
      getPropertyValue: { value(name) { const v = st[name.startsWith('--') ? name : camel(name)]; return v == null ? '' : String(v); }, enumerable: false },
      removeProperty: { value(name) { const k = name.startsWith('--') ? name : camel(name); const v = st[k]; delete st[k]; return v == null ? '' : v; }, enumerable: false },
      cssText: {
        get() {
          return Object.keys(st).filter((k) => st[k] !== '' && st[k] != null && typeof st[k] !== 'function')
            .map((k) => (k.startsWith('--') ? k : kebab(k)) + ': ' + st[k]).join('; ') + (Object.keys(st).length ? ';' : '');
        },
        set(v) { for (const k of Object.keys(st)) delete st[k]; parseCss(st, v); },
        enumerable: false,
      },
      length: { get() { return Object.keys(st).length; }, enumerable: false },
      item: { value(i) { const k = Object.keys(st)[i]; return k ? (k.startsWith('--') ? k : kebab(k)) : ''; }, enumerable: false },
    });
    return st;
  }
  function parseCss(st, text) {
    String(text || '').split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i === -1) return;
      const k = decl.slice(0, i).trim(); const v = decl.slice(i + 1).trim();
      if (!k) return;
      st[k.startsWith('--') ? k : camel(k.toLowerCase())] = v;
    });
  }

  // ── Class list ──
  function makeClassList(el) {
    const get = () => (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const set = (arr) => el.setAttribute('class', arr.join(' '));
    const cl = {
      add(...c) { const a = get(); c.forEach((x) => { if (a.indexOf(x) === -1) a.push(x); }); set(a); },
      remove(...c) { set(get().filter((x) => c.indexOf(x) === -1)); },
      toggle(c, force) {
        const a = get(); const has = a.indexOf(c) !== -1;
        const want = force === undefined ? !has : !!force;
        if (want && !has) a.push(c);
        if (!want && has) a.splice(a.indexOf(c), 1);
        set(a); return want;
      },
      contains(c) { return get().indexOf(c) !== -1; },
      replace(a, b) { const arr = get(); const i = arr.indexOf(a); if (i === -1) return false; arr[i] = b; set(arr); return true; },
      item(i) { return get()[i] || null; },
      forEach(fn, t) { get().forEach(fn, t); },
      toString() { return el.getAttribute('class') || ''; },
      [Symbol.iterator]() { return get()[Symbol.iterator](); },
    };
    Object.defineProperty(cl, 'length', { get() { return get().length; } });
    Object.defineProperty(cl, 'value', { get() { return el.getAttribute('class') || ''; }, set(v) { el.setAttribute('class', v); } });
    return cl;
  }

  function makeDataset(el) {
    return new Proxy({}, {
      get(_, p) { if (typeof p !== 'string') return undefined; const v = el.getAttribute('data-' + kebab(p)); return v == null ? undefined : v; },
      set(_, p, v) { el.setAttribute('data-' + kebab(p), String(v)); return true; },
      has(_, p) { return typeof p === 'string' && el.hasAttribute('data-' + kebab(p)); },
      deleteProperty(_, p) { el.removeAttribute('data-' + kebab(p)); return true; },
      ownKeys() { return el.getAttributeNames().filter((n) => n.startsWith('data-')).map((n) => camel(n.slice(5))); },
      getOwnPropertyDescriptor(_, p) {
        const v = el.getAttribute('data-' + kebab(String(p)));
        return v == null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Node classes
  // ─────────────────────────────────────────────────────────────────────
  class Node {
    constructor() { this.parentNode = null; this.childNodes = []; }
    get ownerDocument() { return this === doc ? null : doc; }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] || null; }
    get previousSibling() { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) - 1] || null; }
    get isConnected() { let n = this; while (n) { if (n === doc) return true; n = n.parentNode; } return false; }
    hasChildNodes() { return this.childNodes.length > 0; }
    contains(o) { let n = o; while (n) { if (n === this) return true; n = n.parentNode; } return false; }
    getRootNode() { let n = this; while (n.parentNode) n = n.parentNode; return n; }
    _adopt(child) {
      if (child == null) throw new TypeError('Failed to execute appendChild: parameter 1 is not of type Node');
      if (typeof child !== 'object' || !('nodeType' in child)) throw new TypeError('Failed to execute appendChild: parameter 1 is not of type Node');
      if (child.nodeType === 11) { const kids = child.childNodes.slice(); child.childNodes.length = 0; kids.forEach((k) => { k.parentNode = null; }); return kids; }
      if (child.parentNode) child.parentNode.removeChild(child);
      return [child];
    }
    appendChild(child) {
      const nodes = this._adopt(child);
      for (const n of nodes) { n.parentNode = this; this.childNodes.push(n); n._connectedChanged(); }
      return child;
    }
    insertBefore(child, ref) {
      if (ref == null) return this.appendChild(child);
      const nodes = this._adopt(child);
      let i = this.childNodes.indexOf(ref);
      if (i === -1) throw new Error('NotFoundError: insertBefore reference is not a child');
      for (const n of nodes) { n.parentNode = this; this.childNodes.splice(i++, 0, n); n._connectedChanged(); }
      return child;
    }
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i === -1) throw new Error('NotFoundError: removeChild — node is not a child');
      this.childNodes.splice(i, 1); child.parentNode = null;
      return child;
    }
    replaceChild(nu, old) { this.insertBefore(nu, old); this.removeChild(old); return old; }
    _connectedChanged() {
      // (Re-)register ids of an inserted subtree so the newest connected wins.
      if (this.nodeType === 1) {
        const id = this.getAttribute('id');
        if (id) register(this, id);
        for (const c of this.childNodes) if (c.nodeType === 1) c._connectedChanged();
      }
    }
    get textContent() {
      if (this.nodeType === 3 || this.nodeType === 8) return this.data;
      let s = '';
      for (const c of this.childNodes) if (c.nodeType !== 8) s += c.textContent;
      return s;
    }
    set textContent(v) {
      if (this.nodeType === 3 || this.nodeType === 8) { this.data = String(v); return; }
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes.length = 0;
      if (v != null && v !== '') this.appendChild(new Text(String(v)));
    }
  }
  Object.assign(Node.prototype, { addEventListener, removeEventListener });
  Node.prototype.dispatchEvent = function (ev) { return dispatch(this, ev); };
  Node.ELEMENT_NODE = 1; Node.TEXT_NODE = 3; Node.COMMENT_NODE = 8; Node.DOCUMENT_NODE = 9; Node.DOCUMENT_FRAGMENT_NODE = 11;

  class Text extends Node {
    constructor(data) { super(); this.data = String(data); }
    get nodeType() { return 3; }
    get nodeName() { return '#text'; }
    get nodeValue() { return this.data; }
    set nodeValue(v) { this.data = String(v); }
    get wholeText() { return this.data; }
    cloneNode() { return new Text(this.data); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }
  class Comment extends Node {
    constructor(data) { super(); this.data = String(data); }
    get nodeType() { return 8; }
    get nodeName() { return '#comment'; }
    cloneNode() { return new Comment(this.data); }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  }

  // Shared parent-node API (Element, DocumentFragment, Document).
  const ParentMixin = {
    get children() { return this.childNodes.filter((n) => n.nodeType === 1); },
    get childElementCount() { return this.children.length; },
    get firstElementChild() { return this.children[0] || null; },
    get lastElementChild() { const c = this.children; return c[c.length - 1] || null; },
    append(...nodes) { for (const n of nodes) this.appendChild(typeof n === 'object' && n ? n : new Text(String(n))); },
    prepend(...nodes) { const f = this.firstChild; for (const n of nodes) this.insertBefore(typeof n === 'object' && n ? n : new Text(String(n)), f); },
    replaceChildren(...nodes) { for (const c of this.childNodes) c.parentNode = null; this.childNodes.length = 0; this.append(...nodes); },
    querySelector(sel) { return select(this, sel, true)[0] || null; },
    querySelectorAll(sel) { return nodeList(select(this, sel, false)); },
    getElementsByTagName(tag) { tag = String(tag).toLowerCase(); return nodeList(descendants(this).filter((e) => tag === '*' || e.localName.toLowerCase() === tag)); },
    getElementsByClassName(cls) { const want = String(cls).split(/\s+/).filter(Boolean); return nodeList(descendants(this).filter((e) => want.every((c) => e.classList.contains(c)))); },
  };
  function defineMixin(cls, mixin) {
    for (const k of Object.getOwnPropertyNames(mixin)) Object.defineProperty(cls.prototype, k, Object.getOwnPropertyDescriptor(mixin, k));
  }

  class DocumentFragment extends Node {
    get nodeType() { return 11; }
    get nodeName() { return '#document-fragment'; }
    cloneNode(deep) { const f = new DocumentFragment(); if (deep) for (const c of this.childNodes) f.appendChild(c.cloneNode(true)); return f; }
    getElementById(id) { return descendants(this).find((e) => e.getAttribute('id') === id) || null; }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
  }
  defineMixin(DocumentFragment, ParentMixin);

  class Element extends Node {
    constructor(localName, ns) {
      super();
      this.namespaceURI = ns || HTML_NS;
      this.localName = this.namespaceURI === HTML_NS ? String(localName).toLowerCase() : String(localName);
      this.__attrs = new Map();
      this.__uid = ++seq;
      Object.defineProperty(this, '__on', { value: {}, enumerable: false });
      this.style = makeStyle(this);
      this.classList = makeClassList(this);
      this.dataset = makeDataset(this);
      this.scrollTop = 0; this.scrollLeft = 0;
    }
    get nodeType() { return 1; }
    get tagName() { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
    get nodeName() { return this.tagName; }
    // ── attributes ──
    getAttribute(n) {
      n = this._an(n);
      if (n === 'style') { const t = this.style.cssText; return t ? t : (this.__attrs.has('style') ? '' : null); }
      return this.__attrs.has(n) ? this.__attrs.get(n) : null;
    }
    setAttribute(n, v) {
      n = this._an(n); v = String(v);
      if (n === 'style') { this.style.cssText = v; this.__attrs.set('style', ''); return; }
      this.__attrs.set(n, v);
      if (n === 'id') register(this, v);
    }
    removeAttribute(n) { n = this._an(n); if (n === 'style') this.style.cssText = ''; this.__attrs.delete(n); }
    hasAttribute(n) { n = this._an(n); return n === 'style' ? !!this.style.cssText || this.__attrs.has('style') : this.__attrs.has(n); }
    toggleAttribute(n, force) { const has = this.hasAttribute(n); const want = force === undefined ? !has : !!force; if (want && !has) this.setAttribute(n, ''); if (!want && has) this.removeAttribute(n); return want; }
    getAttributeNames() { const a = Array.from(this.__attrs.keys()); if (this.style.cssText && a.indexOf('style') === -1) a.push('style'); return a; }
    getAttributeNS(_, n) { return this.getAttribute(n); }
    setAttributeNS(_, n, v) { this.setAttribute(n.replace(/^xlink:/, 'xlink:'), v); }
    removeAttributeNS(_, n) { this.removeAttribute(n); }
    get attributes() { return this.getAttributeNames().map((name) => ({ name, value: this.getAttribute(name) })); }
    _an(n) { n = String(n); return this.namespaceURI === HTML_NS ? n.toLowerCase() : n; }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get className() { return this.getAttribute('class') || ''; }
    set className(v) { this.setAttribute('class', v); }
    // ── tree ──
    get nextElementSibling() { const p = this.parentNode; if (!p) return null; const c = p.childNodes; for (let i = c.indexOf(this) + 1; i < c.length; i++) if (c[i].nodeType === 1) return c[i]; return null; }
    get previousElementSibling() { const p = this.parentNode; if (!p) return null; const c = p.childNodes; for (let i = c.indexOf(this) - 1; i >= 0; i--) if (c[i].nodeType === 1) return c[i]; return null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    replaceWith(...nodes) { const p = this.parentNode; if (!p) return; const next = this.nextSibling; p.removeChild(this); for (const n of nodes) p.insertBefore(typeof n === 'object' ? n : new Text(String(n)), next); }
    before(...nodes) { const p = this.parentNode; if (!p) return; for (const n of nodes) p.insertBefore(typeof n === 'object' ? n : new Text(String(n)), this); }
    after(...nodes) { const p = this.parentNode; if (!p) return; let ref = this.nextSibling; for (const n of nodes) p.insertBefore(typeof n === 'object' ? n : new Text(String(n)), ref); }
    cloneNode(deep) {
      const e = createElementNS(this.namespaceURI, this.localName);
      for (const [k, v] of this.__attrs) if (k !== 'style') e.__attrs.set(k, v);
      e.style.cssText = this.style.cssText;
      if (this.__value !== undefined) e.__value = this.__value;
      if (this.__checked !== undefined) e.__checked = this.__checked;
      if (deep) for (const c of this.childNodes) e.appendChild(c.cloneNode(true));
      return e;
    }
    closest(sel) { let n = this; while (n && n.nodeType === 1) { if (n.matches(sel)) return n; n = n.parentNode; } return null; }
    matches(sel) { return parseSelector(sel).some((cx) => matchComplex(this, cx, cx.length - 1, null)); }
    get webkitMatchesSelector() { return this.matches; }
    // ── HTML ──
    get innerHTML() { return RAW.has(this.localName) || RCDATA.has(this.localName) ? this.textContent : this.childNodes.map(serialize).join(''); }
    set innerHTML(html) {
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes.length = 0;
      if (RAW.has(this.localName) || RCDATA.has(this.localName)) { if (html) this.appendChild(new Text(String(html))); return; }
      parseInto(this, String(html == null ? '' : html));
    }
    get outerHTML() { return serialize(this); }
    set outerHTML(html) {
      const p = this.parentNode; if (!p) return;
      const frag = new DocumentFragment(); parseInto(frag, String(html));
      p.replaceChild(frag, this);
    }
    insertAdjacentHTML(pos, html) {
      const frag = new DocumentFragment(); parseInto(frag, String(html), this);
      this._insertAdjacent(pos, frag);
    }
    insertAdjacentElement(pos, el) { this._insertAdjacent(pos, el); return el; }
    insertAdjacentText(pos, text) { this._insertAdjacent(pos, new Text(String(text))); }
    _insertAdjacent(pos, node) {
      switch (String(pos).toLowerCase()) {
        case 'beforebegin': if (this.parentNode) this.parentNode.insertBefore(node, this); break;
        case 'afterbegin': this.insertBefore(node, this.firstChild); break;
        case 'beforeend': this.appendChild(node); break;
        case 'afterend': if (this.parentNode) this.parentNode.insertBefore(node, this.nextSibling); break;
        default: throw new Error('insertAdjacent: bad position ' + pos);
      }
    }
    get innerText() { return this.textContent; }
    set innerText(v) { this.textContent = v; }
    get outerText() { return this.textContent; }
    // ── form controls ──
    get value() {
      const t = this.localName;
      if (t === 'select') { const o = this.options[this.selectedIndex]; return o ? o.value : ''; }
      if (t === 'option') return this.hasAttribute('value') ? this.getAttribute('value') : this.textContent.trim();
      if (t === 'textarea') return this.__value !== undefined ? this.__value : this.textContent;
      if (this.__value !== undefined) return this.__value;
      const a = this.getAttribute('value');
      if (a != null) return a;
      if (t === 'input' && (this.type === 'checkbox' || this.type === 'radio')) return 'on';
      return '';
    }
    set value(v) {
      v = v == null ? '' : String(v);
      if (this.localName === 'select') {
        const opts = this.options; let found = false;
        opts.forEach((o) => { const hit = !found && o.value === v; o.__selected = hit; if (hit) found = true; });
        return;
      }
      if (this.localName === 'option') { this.setAttribute('value', v); return; }
      this.__value = v;
    }
    get defaultValue() { return this.localName === 'textarea' ? this.textContent : (this.getAttribute('value') || ''); }
    set defaultValue(v) { if (this.localName === 'textarea') this.textContent = v; else this.setAttribute('value', v); }
    get checked() { return this.__checked !== undefined ? this.__checked : this.hasAttribute('checked'); }
    set checked(v) {
      v = !!v; this.__checked = v;
      if (v && this.type === 'radio' && this.getAttribute('name')) {
        const root = this.getRootNode();
        const name = this.getAttribute('name');
        if (root && root.querySelectorAll) root.querySelectorAll('input[type="radio"]').forEach((r) => { if (r !== this && r.getAttribute('name') === name) r.__checked = false; });
      }
    }
    get defaultChecked() { return this.hasAttribute('checked'); }
    get selected() {
      if (this.__selected !== undefined) return this.__selected;
      return this.hasAttribute('selected');
    }
    set selected(v) {
      const sel = this.closest('select');
      if (v && sel && !sel.hasAttribute('multiple')) sel.options.forEach((o) => { o.__selected = false; });
      this.__selected = !!v;
    }
    get options() { return this.localName === 'select' || this.localName === 'datalist' ? descendants(this).filter((e) => e.localName === 'option') : undefined; }
    get selectedOptions() { return this.localName === 'select' ? this.options.filter((o) => o.selected) : undefined; }
    get selectedIndex() {
      if (this.localName !== 'select') return undefined;
      const o = this.options; if (!o.length) return -1;
      let idx = -1;
      o.forEach((x, i) => { if (x.__selected === true) idx = i; });
      if (idx !== -1) return idx;
      o.forEach((x, i) => { if (idx === -1 && x.__selected === undefined && x.hasAttribute('selected')) idx = i; });
      if (idx !== -1) return idx;
      return this.hasAttribute('multiple') ? -1 : 0;
    }
    set selectedIndex(i) { if (this.localName === 'select') this.options.forEach((o, k) => { o.__selected = k === i; }); }
    get index() { const s = this.closest('select'); return s ? s.options.indexOf(this) : 0; }
    get text() { return this.textContent; }
    set text(v) { this.textContent = v; }
    get type() {
      const t = this.getAttribute('type');
      if (this.localName === 'input') return t ? t.toLowerCase() : 'text';
      if (this.localName === 'button') return t ? t.toLowerCase() : 'submit';
      if (this.localName === 'select') return this.hasAttribute('multiple') ? 'select-multiple' : 'select-one';
      if (this.localName === 'textarea') return 'textarea';
      return t || '';
    }
    set type(v) { this.setAttribute('type', v); }
    get files() { if (this.__files === undefined) this.__files = []; return this.__files; }
    set files(v) { this.__files = v; }
    get form() { return this.closest('form'); }
    get labels() { const id = this.id; return id ? doc.querySelectorAll('label[for="' + id + '"]') : []; }
    get valueAsNumber() { const n = parseFloat(this.value); return isFinite(n) ? n : NaN; }
    set valueAsNumber(v) { this.value = String(v); }
    checkValidity() { return true; }
    reportValidity() { return true; }
    setCustomValidity() {}
    setSelectionRange() {}
    submit() { dispatch(this, new Event('submit', { bubbles: true, cancelable: true })); }
    reset() {}
    // ── interaction ──
    click() {
      if (this.disabled) return;
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      const isToggle = this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio');
      const prev = isToggle ? this.checked : null;
      if (isToggle) this.checked = this.type === 'radio' ? true : !prev;
      const ok = dispatch(this, ev);
      if (isToggle) {
        if (!ok) this.checked = prev;
        else if (prev !== this.checked) {
          dispatch(this, new Event('input', { bubbles: true }));
          dispatch(this, new Event('change', { bubbles: true }));
        }
      }
      if (!ok) return;
      if (this.localName === 'label') {
        const f = this.getAttribute('for');
        const ctl = f ? doc.getElementById(f) : this.querySelector('input,select,textarea,button');
        if (ctl && ctl !== this) ctl.click();
      } else if (this.localName === 'a' && this.hasAttribute('download') && env.onDownload) {
        env.onDownload({ filename: this.getAttribute('download'), href: this.getAttribute('href') || this.href || '' });
      } else if (this.localName === 'button' && this.type === 'submit') {
        const form = this.closest('form');
        if (form) dispatch(form, new Event('submit', { bubbles: true, cancelable: true }));
      }
    }
    focus() { if (doc.activeElement === this) return; const prev = doc.activeElement; doc.activeElement = this; if (prev && prev !== doc.body) dispatch(prev, new FocusEvent('blur')); dispatch(this, new FocusEvent('focus')); dispatch(this, new FocusEvent('focusin', { bubbles: true })); }
    blur() { if (doc.activeElement !== this) return; doc.activeElement = doc.body; dispatch(this, new FocusEvent('blur')); dispatch(this, new FocusEvent('focusout', { bubbles: true })); }
    select() {}
    scrollIntoView() {}
    scrollTo() {}
    scrollBy() {}
    requestFullscreen() { return Promise.resolve(); }
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return false; }
    animate() { return { finished: Promise.resolve(), cancel() {}, play() {}, pause() {}, onfinish: null }; }
    getAnimations() { return []; }
    attachShadow() { const f = new DocumentFragment(); this.shadowRoot = f; return f; }
    // ── layout ──
    _hidden() {
      let n = this;
      while (n && n.nodeType === 1) {
        if (n.style.display === 'none' || n.hasAttribute('hidden')) return true;
        n = n.parentNode;
      }
      return !this.isConnected;
    }
    _cssPx(prop) { const v = this.style[prop]; const m = /^\s*([\d.]+)px\s*$/.exec(v || ''); return m ? parseFloat(m[1]) : null; }
    _box() {
      if (this._hidden()) return { w: 0, h: 0 };
      const L = env.layout;
      const vw = env.viewport.width;
      let w = this._cssPx('width');
      let h = this._cssPx('height');
      if (this.localName === 'canvas') {
        if (w == null) w = /%$/.test(this.style.width || '') ? Math.min(L.width, vw) : this.width;
        if (h == null) h = this.height;
      }
      if (w == null) w = Math.min(L.width, Math.max(0, vw - 32));
      if (h == null) h = L.height;
      const minW = this._cssPx('minWidth'), maxW = this._cssPx('maxWidth');
      const minH = this._cssPx('minHeight'), maxH = this._cssPx('maxHeight');
      if (maxW != null) w = Math.min(w, maxW);
      if (minW != null) w = Math.max(w, minW);
      if (maxH != null) h = Math.min(h, maxH);
      if (minH != null) h = Math.max(h, minH);
      return { w, h };
    }
    get offsetWidth() { return this._box().w; }
    get offsetHeight() { return this._box().h; }
    get clientWidth() { return this._box().w; }
    get clientHeight() { return this._box().h; }
    get scrollWidth() { return this._box().w; }
    get scrollHeight() { return this._box().h; }
    get offsetTop() { return 0; }
    get offsetLeft() { return 0; }
    get clientTop() { return 0; }
    get clientLeft() { return 0; }
    get offsetParent() { return this._hidden() ? null : (this.parentElement || null); }
    getBoundingClientRect() { const b = this._box(); return { x: 0, y: 0, left: 0, top: 0, width: b.w, height: b.h, right: b.w, bottom: b.h, toJSON() { return this; } }; }
    getClientRects() { const b = this._box(); return b.w || b.h ? [this.getBoundingClientRect()] : []; }
    // ── canvas ──
    get width() { if (this.localName === 'canvas' || this.localName === 'img' || this.localName === 'video') { const v = parseInt(this.getAttribute('width'), 10); return isFinite(v) ? v : (this.localName === 'canvas' ? 300 : 0); } return this.__w; }
    set width(v) { if (this.localName === 'canvas' || this.localName === 'img' || this.localName === 'video') { this.setAttribute('width', String(Math.max(0, v | 0))); if (this.__ctx2d) this.__ctx2d.__reset('width'); } else this.__w = v; }
    get height() { if (this.localName === 'canvas' || this.localName === 'img' || this.localName === 'video') { const v = parseInt(this.getAttribute('height'), 10); return isFinite(v) ? v : (this.localName === 'canvas' ? 150 : 0); } return this.__h; }
    set height(v) { if (this.localName === 'canvas' || this.localName === 'img' || this.localName === 'video') { this.setAttribute('height', String(Math.max(0, v | 0))); if (this.__ctx2d) this.__ctx2d.__reset('height'); } else this.__h = v; }
    getContext(kind) {
      if (this.localName !== 'canvas') return null;
      if (kind !== '2d') return null;
      if (!this.__ctx2d) this.__ctx2d = makeContext2D(this, env);
      return this.__ctx2d;
    }
    toDataURL() { return 'data:image/png;base64,'; }
    toBlob(cb, type) { const B = env.Blob; setTimeoutApp(() => cb(new B([''], { type: type || 'image/png' })), 0); }
    captureStream() { return {}; }
  }
  defineMixin(Element, ParentMixin);
  // Reflected string attributes.
  const REFLECT = { title: 'title', name: 'name', placeholder: 'placeholder', href: 'href', src: 'src', alt: 'alt',
    rel: 'rel', target: 'target', htmlFor: 'for', min: 'min', max: 'max', step: 'step', accept: 'accept',
    download: 'download', role: 'role', lang: 'lang', dir: 'dir', pattern: 'pattern', autocomplete: 'autocomplete',
    colSpan: 'colspan', rowSpan: 'rowspan', rows: 'rows', cols: 'cols', maxLength: 'maxlength', label: 'label',
    action: 'action', method: 'method', enctype: 'enctype', inputMode: 'inputmode', contentEditable: 'contenteditable',
    draggable: 'draggable', spellcheck: 'spellcheck', size: 'size', list: 'list', slot: 'slot', tabIndex: 'tabindex' };
  for (const [prop, attr] of Object.entries(REFLECT)) {
    Object.defineProperty(Element.prototype, prop, {
      get() { const v = this.getAttribute(attr); return v == null ? (prop === 'tabIndex' ? -1 : '') : (prop === 'tabIndex' || prop === 'colSpan' || prop === 'rowSpan' || prop === 'rows' || prop === 'cols' || prop === 'size' ? Number(v) : v); },
      set(v) { this.setAttribute(attr, v); },
      configurable: true,
    });
  }
  for (const b of ['disabled', 'hidden', 'readOnly', 'required', 'multiple', 'autofocus', 'open', 'noValidate']) {
    const attr = b.toLowerCase();
    Object.defineProperty(Element.prototype, b, {
      get() { return this.hasAttribute(attr); },
      set(v) { if (v) this.setAttribute(attr, ''); else this.removeAttribute(attr); },
      configurable: true,
    });
  }
  for (const t of ON_EVENTS) {
    Object.defineProperty(Element.prototype, 'on' + t, {
      get() { const own = this.__on[t]; if (own !== undefined) return own; const code = this.getAttribute('on' + t); return code ? compiledAttr(this, t, code) : null; },
      set(v) { this.__on[t] = typeof v === 'function' ? v : null; },
      configurable: true,
    });
  }

  function createElementNS(ns, name) { return new Element(name, ns || HTML_NS); }

  function descendants(root) {
    const out = [];
    const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); walk(c); } };
    walk(root);
    return out;
  }
  function nodeList(arr) {
    Object.defineProperty(arr, 'item', { value: (i) => arr[i] || null, enumerable: false });
    return arr;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Serializer + parser
  // ─────────────────────────────────────────────────────────────────────
  function serialize(n) {
    if (n.nodeType === 3) {
      const p = n.parentNode;
      return p && p.nodeType === 1 && (RAW.has(p.localName)) ? n.data : escText(n.data);
    }
    if (n.nodeType === 8) return '<!--' + n.data + '-->';
    if (n.nodeType === 11) return n.childNodes.map(serialize).join('');
    const tag = n.localName;
    let s = '<' + tag;
    for (const name of n.getAttributeNames()) {
      const v = n.getAttribute(name);
      s += ' ' + name + (v === '' && name !== 'value' && name !== 'style' ? '' : '="' + escAttr(v) + '"');
    }
    s += '>';
    if (VOID.has(tag) && n.namespaceURI === HTML_NS) return s;
    s += n.childNodes.map(serialize).join('');
    return s + '</' + tag + '>';
  }

  const AUTO_CLOSE = {
    li: ['li'], option: ['option'], dt: ['dt', 'dd'], dd: ['dt', 'dd'], p: ['p'],
    tr: ['td', 'th', 'tr'], td: ['td', 'th'], th: ['td', 'th'],
    tbody: ['td', 'th', 'tr', 'thead', 'tbody'], thead: ['td', 'th', 'tr', 'tbody'], tfoot: ['td', 'th', 'tr', 'tbody', 'thead'],
  };

  function parseInto(root, html, contextEl) {
    const stack = [root];
    const top = () => stack[stack.length - 1];
    const nsOf = (parent, name) => {
      if (name.toLowerCase() === 'svg') return SVG_NS;
      if (parent && parent.nodeType === 1 && parent.namespaceURI === SVG_NS && parent.localName !== 'foreignObject') return SVG_NS;
      if (parent && parent.nodeType === 11 && contextEl && contextEl.namespaceURI === SVG_NS) return SVG_NS;
      return HTML_NS;
    };
    let i = 0; const L = html.length;
    while (i < L) {
      const lt = html.indexOf('<', i);
      if (lt === -1) { top().appendChild(new Text(decodeEntities(html.slice(i)))); break; }
      if (lt > i) top().appendChild(new Text(decodeEntities(html.slice(i, lt))));
      i = lt;
      if (html.startsWith('<!--', i)) {
        const e = html.indexOf('-->', i + 4);
        const end = e === -1 ? L : e;
        top().appendChild(new Comment(html.slice(i + 4, end)));
        i = e === -1 ? L : e + 3; continue;
      }
      if (html[i + 1] === '!' || html[i + 1] === '?') {
        const e = html.indexOf('>', i); i = e === -1 ? L : e + 1; continue;
      }
      if (html[i + 1] === '/') {
        const m = /^<\/\s*([A-Za-z][\w:-]*)\s*[^>]*>/.exec(html.slice(i, i + 200));
        if (!m) { top().appendChild(new Text('<')); i++; continue; }
        const name = m[1].toLowerCase();
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].localName.toLowerCase() === name) { stack.length = k; break; }
        }
        i += m[0].length; continue;
      }
      if (!/[A-Za-z]/.test(html[i + 1] || '')) { top().appendChild(new Text('<')); i++; continue; }
      // start tag
      let j = i + 1;
      while (j < L && /[\w:-]/.test(html[j])) j++;
      const rawName = html.slice(i + 1, j);
      const attrs = [];
      let selfClose = false;
      while (j < L) {
        while (j < L && /\s/.test(html[j])) j++;
        if (html[j] === '>') { j++; break; }
        if (html[j] === '/' && html[j + 1] === '>') { selfClose = true; j += 2; break; }
        if (html[j] === '/') { j++; continue; }
        let k = j;
        while (k < L && !/[\s=>]/.test(html[k]) && !(html[k] === '/' && html[k + 1] === '>')) k++;
        const an = html.slice(j, k);
        j = k;
        while (j < L && /\s/.test(html[j])) j++;
        let av = '';
        if (html[j] === '=') {
          j++;
          while (j < L && /\s/.test(html[j])) j++;
          const q = html[j];
          if (q === '"' || q === "'") {
            const e = html.indexOf(q, j + 1);
            av = html.slice(j + 1, e === -1 ? L : e);
            j = e === -1 ? L : e + 1;
          } else {
            let e = j;
            while (e < L && !/[\s>]/.test(html[e])) e++;
            av = html.slice(j, e); j = e;
          }
        }
        if (an) attrs.push([an, decodeEntities(av)]);
      }
      const parent = top();
      const ns = nsOf(parent, rawName);
      const lname = ns === HTML_NS ? rawName.toLowerCase() : rawName;
      if (ns === HTML_NS && AUTO_CLOSE[lname]) {
        while (stack.length > 1 && AUTO_CLOSE[lname].indexOf(top().localName) !== -1) stack.pop();
      }
      const el = createElementNS(ns, lname);
      for (const [an, av] of attrs) {
        const n = ns === HTML_NS ? an.toLowerCase() : an;
        if (n === 'style') { el.style.cssText = av; el.__attrs.set('style', ''); }
        else el.__attrs.set(n, av);
      }
      top().appendChild(el);   // registers id (appendChild → _connectedChanged)
      if (el.__attrs.has('id') && !el.isConnected) register(el, el.__attrs.get('id'));
      i = j;
      if (ns === HTML_NS && (RAW.has(lname) || RCDATA.has(lname))) {
        const re = new RegExp('</' + lname + '\\s*>', 'i');
        const rest = html.slice(i);
        const m = re.exec(rest);
        const text = m ? rest.slice(0, m.index) : rest;
        if (text) el.appendChild(new Text(RCDATA.has(lname) ? decodeEntities(text) : text));
        i = m ? i + m.index + m[0].length : L;
        continue;
      }
      if (selfClose || (ns === HTML_NS && VOID.has(lname))) continue;
      stack.push(el);
    }
    return root;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Selector engine
  // ─────────────────────────────────────────────────────────────────────
  const selCache = new Map();
  function splitTop(s, sepChar) {
    const out = []; let depth = 0, q = null, cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[') depth++;
      if (c === ')' || c === ']') depth--;
      if (c === sepChar && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  }
  function parseSelector(sel) {
    sel = String(sel).trim();
    if (selCache.has(sel)) return selCache.get(sel);
    const list = splitTop(sel, ',').map((s) => parseComplex(s.trim())).filter((x) => x.length);
    if (!list.length) throw new SyntaxError("'" + sel + "' is not a valid selector");
    selCache.set(sel, list);
    return list;
  }
  // complex = [{comb, cmp}] left→right; comb is the combinator BEFORE this compound.
  function parseComplex(s) {
    const out = []; let i = 0; let comb = null;
    while (i < s.length) {
      let sawSpace = false;
      while (i < s.length && /\s/.test(s[i])) { i++; sawSpace = true; }
      if (i >= s.length) break;
      if ('>+~'.indexOf(s[i]) !== -1) { comb = s[i]; i++; continue; }
      if (sawSpace && out.length && !comb) comb = ' ';
      const cmp = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
      const start = i;
      while (i < s.length && !/[\s>+~]/.test(s[i])) {
        const c = s[i];
        if (c === '*') { i++; continue; }
        if (c === '#' || c === '.') {
          let j = i + 1; let name = '';
          while (j < s.length && /[^\s#.[\]:>+~(),]/.test(s[j])) { if (s[j] === '\\') { name += s[j + 1]; j += 2; } else { name += s[j]; j++; } }
          if (c === '#') cmp.id = name; else cmp.classes.push(name);
          i = j; continue;
        }
        if (c === '[') {
          let depth = 0, j = i, q = null;
          for (; j < s.length; j++) {
            const d = s[j];
            if (q) { if (d === q) q = null; continue; }
            if (d === '"' || d === "'") { q = d; continue; }
            if (d === '[') depth++;
            if (d === ']') { depth--; if (!depth) break; }
          }
          const body = s.slice(i + 1, j);
          const m = /^\s*([^\s~|^$*!=]+)\s*(?:([~|^$*!]?=)\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s\]]+)\s*(i)?)?\s*$/.exec(body);
          if (!m) throw new SyntaxError('bad attribute selector [' + body + ']');
          let v = m[3];
          if (v && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1);
          cmp.attrs.push({ name: m[1], op: m[2] || null, value: v == null ? null : v, ci: !!m[4] });
          i = j + 1; continue;
        }
        if (c === ':') {
          let j = i + 1; if (s[j] === ':') j++;
          let name = '';
          while (j < s.length && /[\w-]/.test(s[j])) name += s[j++];
          let arg = null;
          if (s[j] === '(') {
            let depth = 0, k = j;
            for (; k < s.length; k++) { if (s[k] === '(') depth++; if (s[k] === ')') { depth--; if (!depth) break; } }
            arg = s.slice(j + 1, k); j = k + 1;
          }
          cmp.pseudos.push({ name: name.toLowerCase(), arg });
          i = j; continue;
        }
        let j = i; let name = '';
        while (j < s.length && /[\w-]/.test(s[j])) name += s[j++];
        if (!name) throw new SyntaxError('bad selector near "' + s.slice(i) + '"');
        cmp.tag = name; i = j;
      }
      if (i === start) { i++; continue; }
      out.push({ comb: out.length ? (comb || ' ') : null, cmp });
      comb = null;
    }
    return out;
  }
  function matchCompound(el, c, scope) {
    if (c.tag && el.localName.toLowerCase() !== c.tag.toLowerCase()) return false;
    if (c.id != null && el.getAttribute('id') !== c.id) return false;
    for (const cl of c.classes) if (!el.classList.contains(cl)) return false;
    for (const a of c.attrs) {
      let v = el.getAttribute(a.name);
      if (a.name === 'value' && (el.localName === 'input' || el.localName === 'option')) v = v == null ? null : v;
      if (v == null) return false;
      if (!a.op) continue;
      let want = a.value; if (a.ci) { v = v.toLowerCase(); want = want.toLowerCase(); }
      switch (a.op) {
        case '=': if (v !== want) return false; break;
        case '~=': if (v.split(/\s+/).indexOf(want) === -1) return false; break;
        case '|=': if (!(v === want || v.startsWith(want + '-'))) return false; break;
        case '^=': if (!want || !v.startsWith(want)) return false; break;
        case '$=': if (!want || !v.endsWith(want)) return false; break;
        case '*=': if (!want || v.indexOf(want) === -1) return false; break;
        case '!=': if (v === want) return false; break;
      }
    }
    for (const p of c.pseudos) {
      switch (p.name) {
        case 'checked': if (!(el.checked || (el.localName === 'option' && el.selected))) return false; break;
        case 'selected': if (!el.selected) return false; break;
        case 'disabled': if (!el.disabled) return false; break;
        case 'enabled': if (el.disabled) return false; break;
        case 'first-child': if (!el.parentNode || el.parentNode.children[0] !== el) return false; break;
        case 'last-child': { const k = el.parentNode ? el.parentNode.children : []; if (k[k.length - 1] !== el) return false; break; }
        case 'only-child': if (!el.parentNode || el.parentNode.children.length !== 1) return false; break;
        case 'first-of-type': if (!el.parentNode || el.parentNode.children.find((x) => x.localName === el.localName) !== el) return false; break;
        case 'nth-child': {
          const k = el.parentNode ? el.parentNode.children.indexOf(el) + 1 : 0;
          const a = String(p.arg).trim();
          if (a === 'odd') { if (k % 2 !== 1) return false; }
          else if (a === 'even') { if (k % 2 !== 0) return false; }
          else if (/^\d+$/.test(a)) { if (k !== +a) return false; }
          break;
        }
        case 'not': if (parseSelector(p.arg).some((cx) => matchComplex(el, cx, cx.length - 1, scope))) return false; break;
        case 'is': case 'where': case 'matches': if (!parseSelector(p.arg).some((cx) => matchComplex(el, cx, cx.length - 1, scope))) return false; break;
        case 'has': if (!select(el, p.arg, true).length) return false; break;
        case 'scope': if (scope ? el !== scope : el !== doc.documentElement) return false; break;
        case 'root': if (el !== doc.documentElement) return false; break;
        case 'empty': if (el.childNodes.length) return false; break;
        case 'focus': case 'focus-within': case 'focus-visible': if (doc.activeElement !== el) return false; break;
        case 'hover': case 'active': case 'visited': return false;
        default: break;   // unsupported pseudo-classes / pseudo-elements match everything
      }
    }
    return true;
  }
  function matchComplex(el, cx, idx, scope) {
    if (!matchCompound(el, cx[idx].cmp, scope)) return false;
    if (idx === 0) return true;
    const comb = cx[idx].comb;
    if (comb === '>') { const p = el.parentNode; return !!(p && p.nodeType === 1 && matchComplex(p, cx, idx - 1, scope)); }
    if (comb === ' ') { let p = el.parentNode; while (p && p.nodeType === 1) { if (matchComplex(p, cx, idx - 1, scope)) return true; p = p.parentNode; } return false; }
    if (comb === '+') { const s = el.previousElementSibling; return !!(s && matchComplex(s, cx, idx - 1, scope)); }
    if (comb === '~') { let s = el.previousElementSibling; while (s) { if (matchComplex(s, cx, idx - 1, scope)) return true; s = s.previousElementSibling; } return false; }
    return false;
  }
  function select(root, sel, first) {
    const list = parseSelector(sel);
    const scope = root.nodeType === 1 ? root : null;
    // Fast path: plain #id
    if (list.length === 1 && list[0].length === 1) {
      const c = list[0][0].cmp;
      if (c.id && !c.tag && !c.classes.length && !c.attrs.length && !c.pseudos.length) {
        const out = [];
        for (const e of descendants(root)) if (e.getAttribute('id') === c.id) { out.push(e); if (first) break; }
        return out;
      }
    }
    const out = [];
    for (const e of descendants(root)) {
      if (list.some((cx) => matchComplex(e, cx, cx.length - 1, scope))) { out.push(e); if (first) break; }
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────────
  // Document
  // ─────────────────────────────────────────────────────────────────────
  let setTimeoutApp = (fn) => fn();
  class Document extends Node {
    get nodeType() { return 9; }
    get nodeName() { return '#document'; }
    get documentElement() { return this.childNodes.find((n) => n.nodeType === 1) || null; }
    get head() { const h = this.documentElement; return h ? h.children.find((c) => c.localName === 'head') || null : null; }
    get body() { const h = this.documentElement; return h ? h.children.find((c) => c.localName === 'body') || null : null; }
    get scrollingElement() { return this.documentElement; }
    getElementById(id) {
      id = String(id);
      const arr = ids.get(id);
      if (arr) for (let k = arr.length - 1; k >= 0; k--) { const e = arr[k]; if (e.getAttribute('id') === id && e.isConnected) return e; }
      // Fallback: tree walk (ids set via attribute maps that bypassed registration).
      for (const e of descendants(this)) if (e.getAttribute('id') === id) { register(e, id); return e; }
      return null;
    }
    createElement(name) { return createElementNS(HTML_NS, name); }
    createElementNS(ns, name) { return createElementNS(ns, name); }
    createTextNode(t) { return new Text(t); }
    createComment(t) { return new Comment(t); }
    createDocumentFragment() { return new DocumentFragment(); }
    createEvent(type) { return /custom/i.test(type) ? new CustomEvent('') : new Event(''); }
    createRange() { return { selectNodeContents() {}, setStart() {}, setEnd() {}, collapse() {}, createContextualFragment: (h) => { const f = new DocumentFragment(); parseInto(f, String(h)); return f; }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }; }
    createTreeWalker(root) { const all = descendants(root); let i = -1; return { currentNode: root, nextNode() { i++; this.currentNode = all[i] || null; return this.currentNode; } }; }
    getSelection() { return env.win ? env.win.getSelection() : null; }
    execCommand() { return false; }
    queryCommandSupported() { return false; }
    hasFocus() { return true; }
    elementFromPoint() { return null; }
    elementsFromPoint() { return []; }
    importNode(n, deep) { return n.cloneNode(deep); }
    adoptNode(n) { return n; }
    open() {} write() {} writeln() {} close() {}
    get forms() { return this.getElementsByTagName('form'); }
    get images() { return this.getElementsByTagName('img'); }
    get links() { return this.querySelectorAll('a[href]'); }
    get scripts() { return this.getElementsByTagName('script'); }
    get defaultView() { return env.win; }
  }
  defineMixin(Document, ParentMixin);

  const doc = new Document();
  doc.readyState = 'loading';
  doc.visibilityState = 'visible';
  doc.hidden = false;
  doc.cookie = '';
  doc.referrer = '';
  doc.characterSet = 'UTF-8';
  doc.compatMode = 'CSS1Compat';
  doc.designMode = 'off';
  doc.dir = 'ltr';
  doc.fonts = { ready: Promise.resolve(), load: () => Promise.resolve([]), check: () => true, add() {}, addEventListener() {} };
  doc.styleSheets = [];
  doc.title = '';
  const htmlEl = createElementNS(HTML_NS, 'html');
  htmlEl.appendChild(createElementNS(HTML_NS, 'head'));
  htmlEl.appendChild(createElementNS(HTML_NS, 'body'));
  doc.appendChild(htmlEl);
  doc.activeElement = doc.body;

  return {
    document: doc,
    Node, Element, Text, Comment, DocumentFragment, Document,
    HTMLElement: Element, SVGElement: Element, HTMLCanvasElement: Element, HTMLInputElement: Element,
    HTMLSelectElement: Element, HTMLTextAreaElement: Element, HTMLButtonElement: Element, HTMLAnchorElement: Element,
    HTMLImageElement: Element, HTMLDivElement: Element, HTMLFormElement: Element, HTMLTableElement: Element,
    parseInto, serialize, descendants, dispatch,
    setTimer(fn) { setTimeoutApp = fn; },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Recording 2D context
// ─────────────────────────────────────────────────────────────────────────
const CTX_DEFAULTS = {
  fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, lineCap: 'butt', lineJoin: 'miter',
  miterLimit: 10, lineDashOffset: 0, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
  direction: 'ltr', globalAlpha: 1, globalCompositeOperation: 'source-over', shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)', shadowOffsetX: 0, shadowOffsetY: 0, imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low', filter: 'none', letterSpacing: '0px', wordSpacing: '0px', fontKerning: 'auto',
};
function makeContext2D(canvas, env) {
  const log = [];
  Object.defineProperty(canvas, '_log', { value: log, configurable: true, enumerable: false });
  canvas._logDropped = 0;
  const limit = env.canvasLogLimit || 200000;
  const record = env.recordCanvas !== false;
  const push = (entry) => {
    if (!record) return;
    if (log.length >= limit) { canvas._logDropped++; return; }
    log.push(entry);
  };
  let state = Object.assign({}, CTX_DEFAULTS);
  let dash = [];
  let transform = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const fontPx = () => { const m = /(\d+(?:\.\d+)?)px/.exec(state.font); return m ? parseFloat(m[1]) : 10; };
  const special = {
    save() { stack.push({ state: Object.assign({}, state), dash: dash.slice(), transform: transform.slice() }); push({ op: 'save', args: [] }); },
    restore() { const s = stack.pop(); if (s) { state = s.state; dash = s.dash; transform = s.transform; } push({ op: 'restore', args: [] }); },
    measureText(t) {
      const w = String(t).length * fontPx() * 0.55;
      return { width: w, actualBoundingBoxLeft: 0, actualBoundingBoxRight: w, actualBoundingBoxAscent: fontPx() * 0.8,
        actualBoundingBoxDescent: fontPx() * 0.2, fontBoundingBoxAscent: fontPx() * 0.8, fontBoundingBoxDescent: fontPx() * 0.2 };
    },
    getImageData(x, y, w, h) { w = Math.max(1, Math.min(w | 0, 64)); h = Math.max(1, Math.min(h | 0, 64)); return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    createImageData(w, h) { if (typeof w === 'object') { h = w.height; w = w.width; } return { width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }; },
    createLinearGradient() { const g = { stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; return g; },
    createRadialGradient() { const g = { stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; return g; },
    createConicGradient() { const g = { stops: [], addColorStop(o, c) { g.stops.push([o, c]); } }; return g; },
    createPattern() { return { setTransform() {} }; },
    isPointInPath() { return false; },
    isPointInStroke() { return false; },
    getLineDash() { return dash.slice(); },
    setLineDash(d) { dash = Array.from(d || []); push({ op: 'setLineDash', args: [dash.slice()] }); },
    getTransform() { const [a, b, c, d, e, f] = transform; return { a, b, c, d, e, f, m11: a, m12: b, m21: c, m22: d, m41: e, m42: f, is2D: true, isIdentity: a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0, inverse() { return this; } }; },
    setTransform(a, b, c, d, e, f) {
      if (typeof a === 'object' && a) transform = [a.a, a.b, a.c, a.d, a.e, a.f];
      else if (a === undefined) transform = [1, 0, 0, 1, 0, 0];
      else transform = [a, b, c, d, e, f];
      push({ op: 'setTransform', args: transform.slice() });
    },
    resetTransform() { transform = [1, 0, 0, 1, 0, 0]; push({ op: 'resetTransform', args: [] }); },
    scale(x, y) { transform[0] *= x; transform[1] *= x; transform[2] *= y; transform[3] *= y; push({ op: 'scale', args: [x, y] }); },
    translate(x, y) { transform[4] += transform[0] * x + transform[2] * y; transform[5] += transform[1] * x + transform[3] * y; push({ op: 'translate', args: [x, y] }); },
    getContextAttributes() { return { alpha: true }; },
    reset() { state = Object.assign({}, CTX_DEFAULTS); dash = []; transform = [1, 0, 0, 1, 0, 0]; stack.length = 0; push({ op: 'reset', args: [] }); },
  };
  const target = {
    __reset(which) {
      state = Object.assign({}, CTX_DEFAULTS); dash = []; transform = [1, 0, 0, 1, 0, 0]; stack.length = 0;
      push({ op: 'resize', args: [canvas.width, canvas.height], which });
    },
  };
  const fnCache = new Map();
  return new Proxy(target, {
    get(t, p) {
      if (p === 'canvas') return canvas;
      if (p === '__reset') return t.__reset;
      if (p === '__log') return log;
      if (typeof p !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(state, p)) return state[p];
      if (fnCache.has(p)) return fnCache.get(p);
      let fn;
      if (special[p]) fn = special[p];
      else if (p === 'then' || p === 'toJSON') return undefined;
      else fn = function (...args) { push({ op: p, args }); };
      fnCache.set(p, fn);
      return fn;
    },
    set(t, p, v) {
      state[p] = v;
      push({ op: 'set', prop: p, value: v });
      return true;
    },
    has(t, p) { return p === 'canvas' || Object.prototype.hasOwnProperty.call(state, p) || !!special[p] || typeof p === 'string'; },
  });
}

module.exports = {
  createDOM, decodeEntities,
  Event, CustomEvent, UIEvent, MouseEvent, PointerEvent, WheelEvent, KeyboardEvent, FocusEvent, InputEvent,
  TouchEvent, ErrorEvent, ProgressEvent, StorageEvent, DragEvent,
  addEventListener, removeEventListener,
};
