// ══════════════════════════════════════════════════════════════
// iOS Subscription Gate (@squareetlabs/capacitor-subscriptions)
//
// Blocks the app behind a paywall until the user has an active
// auto-renewing subscription (or is inside the Apple-granted free
// trial intro offer). Gracefully no-ops on non-iOS platforms.
//
// Product: com.h2oil.welltesting.pro.monthly  ($9.99 / month USD)
// Intro  : 3-day free trial (configured in App Store Connect)
// T&C    : https://h2oil.sitify.app
//
// Apple compliance checklist:
//   [x] Restore Purchases button (mandatory)
//   [x] Auto-renewal disclosure shown before purchase
//   [x] Price, duration, trial terms shown
//   [x] Links to EULA (T&C) + Privacy Policy
//   [x] StoreKit used for digital IAP (no external payment)
// ══════════════════════════════════════════════════════════════
(function(){
  if (typeof window === 'undefined') return;
  const isNative = window.Capacitor
      && window.Capacitor.isNativePlatform
      && window.Capacitor.isNativePlatform();
  if (!isNative) return;

  const PRODUCT_ID = 'com.h2oil.welltesting.pro.monthly';
  const TNC_URL = 'https://h2oil.sitify.app';
  const PRIVACY_URL = 'https://h2oil.sitify.app/privacy';
  const ENTITLEMENT_KEY = 'h2oil.entitlement';   // cached locally
  const Subs = (window.Capacitor.Plugins && window.Capacitor.Plugins.Subscriptions) || null;
  const Prefs = window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;

  // ── Entitlement cache ────────────────────────────────────────
  // Stores { active: bool, expiry: epochMs, productId, source }
  // so the app can launch offline without re-hitting StoreKit.
  async function readCachedEntitlement() {
    try {
      const raw = localStorage.getItem(ENTITLEMENT_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return o;
    } catch (e) { return null; }
  }
  function writeCachedEntitlement(e) {
    try { localStorage.setItem(ENTITLEMENT_KEY, JSON.stringify(e || {})); } catch (_) {}
    if (Prefs) Prefs.set({ key: ENTITLEMENT_KEY, value: JSON.stringify(e || {}) }).catch(() => {});
  }
  function isCacheValid(e) {
    return !!(e && e.active && typeof e.expiry === 'number' && Date.now() < e.expiry);
  }

  // ── StoreKit lookups via plugin ──────────────────────────────
  async function queryLiveEntitlement() {
    if (!Subs) return null;
    try {
      // Plugin exposes getCurrentEntitlements or isSubscriptionValid
      // depending on version — try both.
      if (typeof Subs.getCurrentEntitlements === 'function') {
        const r = await Subs.getCurrentEntitlements();
        const list = (r && (r.entitlements || r.data)) || [];
        const ent = list.find(x => x.productIdentifier === PRODUCT_ID || x.productId === PRODUCT_ID);
        if (ent) {
          const expiry = ent.expirationDate ? new Date(ent.expirationDate).getTime() : (Date.now() + 60*60*1000);
          return { active: true, expiry, productId: PRODUCT_ID, source: 'entitlements' };
        }
      }
      if (typeof Subs.isSubscriptionValid === 'function') {
        const r = await Subs.isSubscriptionValid({ productIdentifier: PRODUCT_ID });
        if (r && (r.isValid || r.responseCode === 0 || r.responseCode === '0')) {
          return { active: true, expiry: Date.now() + 24*60*60*1000, productId: PRODUCT_ID, source: 'isValid' };
        }
      }
    } catch (e) {
      console.warn('[iOS Subs] entitlement query failed:', e);
    }
    return null;
  }

  async function fetchProduct() {
    if (!Subs) return null;
    try {
      if (typeof Subs.getProductDetails === 'function') {
        const r = await Subs.getProductDetails({ productIdentifier: PRODUCT_ID });
        return (r && (r.data || r.product)) || r;
      }
    } catch (e) {
      console.warn('[iOS Subs] product fetch failed:', e);
    }
    return null;
  }

  async function purchase() {
    if (!Subs) throw new Error('Subscriptions plugin not available');
    if (typeof Subs.purchaseProduct !== 'function') throw new Error('purchaseProduct not implemented');
    const r = await Subs.purchaseProduct({ productIdentifier: PRODUCT_ID });
    // Success responses vary — treat any non-error response with an active
    // transaction / entitlement as success; re-query to confirm.
    return r;
  }

  async function restore() {
    if (!Subs) throw new Error('Subscriptions plugin not available');
    if (typeof Subs.restorePurchases === 'function') {
      return Subs.restorePurchases();
    }
    if (typeof Subs.getCurrentEntitlements === 'function') {
      return Subs.getCurrentEntitlements();
    }
    throw new Error('No restore method available');
  }

  // ── Paywall UI ────────────────────────────────────────────────
  function ensurePaywallNode() {
    return document.getElementById('iosPaywall');
  }

  function showPaywall() {
    const el = ensurePaywallNode();
    if (!el) return;
    el.style.display = 'flex';
    // Lock scroll underneath
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
  function hidePaywall() {
    const el = ensurePaywallNode();
    if (!el) return;
    el.style.display = 'none';
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  function setPaywallStatus(msg, isError) {
    const s = document.getElementById('iosPaywallStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('pw-err', !!isError);
  }
  function setButtonsEnabled(enabled) {
    ['iosPaywallSubscribe','iosPaywallRestore'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = !enabled;
    });
  }

  async function refreshPricingLabel() {
    const p = await fetchProduct();
    if (!p) return;
    const price = p.displayPrice || p.price || p.localizedPrice || '';
    const el = document.getElementById('iosPaywallPrice');
    if (el && price) {
      el.textContent = price + ' / month after 3-day free trial';
    }
  }

  // ── Gate logic ────────────────────────────────────────────────
  async function evaluateGate() {
    // 1) Cached valid → unlock immediately (offline-friendly)
    const cached = await readCachedEntitlement();
    if (isCacheValid(cached)) {
      hidePaywall();
    } else {
      showPaywall();
    }
    // 2) Always verify against StoreKit in the background.
    const live = await queryLiveEntitlement();
    if (live && live.active) {
      writeCachedEntitlement(live);
      hidePaywall();
    } else if (!isCacheValid(cached)) {
      // Cache expired AND no live entitlement → keep paywall up.
      writeCachedEntitlement({ active: false });
      showPaywall();
    }
  }

  // ── Event wiring ──────────────────────────────────────────────
  function wireButtons() {
    const sub = document.getElementById('iosPaywallSubscribe');
    const rest = document.getElementById('iosPaywallRestore');
    if (sub && !sub.__wired) {
      sub.__wired = true;
      sub.addEventListener('click', async () => {
        setPaywallStatus('Processing…');
        setButtonsEnabled(false);
        try {
          await purchase();
          const live = await queryLiveEntitlement();
          if (live && live.active) {
            writeCachedEntitlement(live);
            setPaywallStatus('Subscription active. Welcome!');
            setTimeout(hidePaywall, 600);
          } else {
            setPaywallStatus('Purchase completed but entitlement not yet active. Try Restore Purchases in a moment.', true);
          }
        } catch (e) {
          const msg = (e && (e.message || e.errorMessage)) || 'Purchase failed';
          if (/cancel/i.test(msg)) setPaywallStatus('Purchase cancelled.', true);
          else setPaywallStatus(msg, true);
        } finally {
          setButtonsEnabled(true);
        }
      });
    }
    if (rest && !rest.__wired) {
      rest.__wired = true;
      rest.addEventListener('click', async () => {
        setPaywallStatus('Restoring…');
        setButtonsEnabled(false);
        try {
          await restore();
          const live = await queryLiveEntitlement();
          if (live && live.active) {
            writeCachedEntitlement(live);
            setPaywallStatus('Subscription restored.');
            setTimeout(hidePaywall, 600);
          } else {
            setPaywallStatus('No active subscription found on this Apple ID.', true);
          }
        } catch (e) {
          setPaywallStatus((e && (e.message || e.errorMessage)) || 'Restore failed', true);
        } finally {
          setButtonsEnabled(true);
        }
      });
    }
    const tnc = document.getElementById('iosPaywallTnc');
    if (tnc && !tnc.__wired) {
      tnc.__wired = true;
      tnc.setAttribute('href', TNC_URL);
    }
    const priv = document.getElementById('iosPaywallPrivacy');
    if (priv && !priv.__wired) {
      priv.__wired = true;
      priv.setAttribute('href', PRIVACY_URL);
    }
  }

  // Expose a dev helper to force-reset entitlement (useful in TestFlight)
  window.__h2oilResetEntitlement = function() {
    writeCachedEntitlement({ active: false });
    showPaywall();
  };

  // Re-evaluate when the app returns from background (user may have
  // cancelled/renewed via Settings).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) evaluateGate();
  });

  function init() {
    wireButtons();
    refreshPricingLabel();
    evaluateGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[H2Oil iOS] Subscription gate active');
})();
