// ══════════════════════════════════════════════════════════════
// iOS Subscription Gate (RevenueCat — @revenuecat/purchases-capacitor)
//
// Blocks the app behind a paywall until the user has an active
// entitlement. Gracefully no-ops on non-iOS platforms.
//
// ─── CONFIG ────────────────────────────────────────────────────
//   1. Sign up at https://app.revenuecat.com
//   2. Add your iOS app → copy the PUBLIC iOS API key (starts "appl_")
//   3. In the dashboard create:
//        • Entitlement identifier: "pro"
//        • Product: com.h2oil.welltesting.pro.monthly
//        • Offering: "default" with a monthly Package linked to the
//          product above
//   4. Paste the API key below ↓
// ──────────────────────────────────────────────────────────────
const REVENUECAT_API_KEY = 'appl_REPLACE_ME_WITH_REVENUECAT_IOS_KEY';
const ENTITLEMENT_ID = 'pro';               // matches RC dashboard
const PRODUCT_ID = 'com.h2oil.welltesting.pro.monthly';
const TNC_URL = 'https://h2oil.sitify.app';
const PRIVACY_URL = 'https://h2oil.sitify.app/privacy';
const ENTITLEMENT_CACHE_KEY = 'h2oil.entitlement';   // offline cache
// ══════════════════════════════════════════════════════════════

(function(){
  if (typeof window === 'undefined') return;
  const isNative = window.Capacitor
      && window.Capacitor.isNativePlatform
      && window.Capacitor.isNativePlatform();
  if (!isNative) return;

  // RevenueCat's Capacitor plugin registers under Plugins.Purchases.
  const RC = (window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) || null;
  const Prefs = window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;

  let currentPackage = null;  // cached monthly package from getOfferings

  // ── Offline entitlement cache ────────────────────────────────
  //   RC also caches, but keeping our own lets the app launch
  //   instantly offline without hitting their CDN.
  function readCachedEntitlement() {
    try {
      const raw = localStorage.getItem(ENTITLEMENT_CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return o;
    } catch (_) { return null; }
  }
  function writeCachedEntitlement(e) {
    try { localStorage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(e || {})); } catch (_) {}
    if (Prefs) Prefs.set({ key: ENTITLEMENT_CACHE_KEY, value: JSON.stringify(e || {}) }).catch(() => {});
  }
  function isCacheValid(e) {
    return !!(e && e.active && typeof e.expiry === 'number' && Date.now() < e.expiry);
  }

  // ── RevenueCat setup ─────────────────────────────────────────
  let configured = false;
  async function ensureConfigured() {
    if (!RC || configured) return configured;
    if (!REVENUECAT_API_KEY || REVENUECAT_API_KEY.startsWith('appl_REPLACE_ME')) {
      console.warn('[iOS Subs] RevenueCat API key not configured');
      return false;
    }
    try {
      await RC.configure({ apiKey: REVENUECAT_API_KEY });
      configured = true;
      console.log('[iOS Subs] RevenueCat configured');
      return true;
    } catch (e) {
      console.warn('[iOS Subs] RevenueCat configure failed:', e);
      return false;
    }
  }

  async function loadOfferings() {
    if (!RC) return null;
    if (!(await ensureConfigured())) return null;
    try {
      const res = await RC.getOfferings();
      const offerings = res && (res.offerings || res);
      const current = offerings && (offerings.current || (offerings.all && offerings.all.default));
      if (!current) return null;
      // Prefer the typed .monthly package, fall back to first available.
      const pkg = current.monthly
          || (current.availablePackages && current.availablePackages.find(p =>
                (p.product && p.product.identifier === PRODUCT_ID) ||
                p.identifier === '$rc_monthly'))
          || (current.availablePackages && current.availablePackages[0]);
      currentPackage = pkg || null;
      return currentPackage;
    } catch (e) {
      console.warn('[iOS Subs] getOfferings failed:', e);
      return null;
    }
  }

  function entitlementFromCustomerInfo(customerInfo) {
    if (!customerInfo) return null;
    const active = customerInfo.entitlements && customerInfo.entitlements.active;
    if (!active) return null;
    const ent = active[ENTITLEMENT_ID];
    if (!ent) return null;
    const expiry = ent.expirationDate ? new Date(ent.expirationDate).getTime()
                 : (Date.now() + 24*60*60*1000);
    return {
      active: true,
      expiry,
      productId: ent.productIdentifier || PRODUCT_ID,
      willRenew: !!ent.willRenew,
      inTrial: ent.periodType === 'trial' || ent.periodType === 'TRIAL'
    };
  }

  async function queryLiveEntitlement() {
    if (!RC) return null;
    if (!(await ensureConfigured())) return null;
    try {
      const res = await RC.getCustomerInfo();
      const customerInfo = (res && (res.customerInfo || res)) || null;
      return entitlementFromCustomerInfo(customerInfo);
    } catch (e) {
      console.warn('[iOS Subs] getCustomerInfo failed:', e);
      return null;
    }
  }

  async function purchase() {
    if (!RC) throw new Error('Purchases plugin not available');
    if (!(await ensureConfigured())) throw new Error('RevenueCat not configured');
    if (!currentPackage) {
      await loadOfferings();
      if (!currentPackage) throw new Error('No subscription package available');
    }
    // RevenueCat's Capacitor bridge expects { aPackage: <Package> }.
    const res = await RC.purchasePackage({ aPackage: currentPackage });
    const info = res && (res.customerInfo || (res.purchaseResult && res.purchaseResult.customerInfo));
    return entitlementFromCustomerInfo(info);
  }

  async function restore() {
    if (!RC) throw new Error('Purchases plugin not available');
    if (!(await ensureConfigured())) throw new Error('RevenueCat not configured');
    const res = await RC.restorePurchases();
    const info = res && (res.customerInfo || res);
    return entitlementFromCustomerInfo(info);
  }

  // ── Paywall UI helpers ───────────────────────────────────────
  function paywallNode() { return document.getElementById('iosPaywall'); }

  function showPaywall() {
    const el = paywallNode();
    if (!el) return;
    el.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
  function hidePaywall() {
    const el = paywallNode();
    if (!el) return;
    el.style.display = 'none';
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  function setStatus(msg, isError) {
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
    const pkg = await loadOfferings();
    if (!pkg) return;
    const priceString = (pkg.product && (pkg.product.priceString || pkg.product.price_string))
                        || pkg.priceString
                        || '';
    const el = document.getElementById('iosPaywallPrice');
    if (el && priceString) {
      el.textContent = priceString + ' / month after 3-day free trial';
    }
  }

  // ── Gate evaluation ──────────────────────────────────────────
  async function evaluateGate() {
    const cached = readCachedEntitlement();
    if (isCacheValid(cached)) {
      hidePaywall();
    } else {
      showPaywall();
    }
    const live = await queryLiveEntitlement();
    if (live && live.active) {
      writeCachedEntitlement(live);
      hidePaywall();
    } else if (!isCacheValid(cached)) {
      writeCachedEntitlement({ active: false });
      showPaywall();
    }
  }

  // ── Button wiring ────────────────────────────────────────────
  function wireButtons() {
    const sub = document.getElementById('iosPaywallSubscribe');
    const rest = document.getElementById('iosPaywallRestore');
    if (sub && !sub.__wired) {
      sub.__wired = true;
      sub.addEventListener('click', async () => {
        setStatus('Processing…');
        setButtonsEnabled(false);
        try {
          const ent = await purchase();
          if (ent && ent.active) {
            writeCachedEntitlement(ent);
            setStatus('Subscription active. Welcome!');
            setTimeout(hidePaywall, 600);
          } else {
            setStatus('Purchase completed but entitlement not yet active. Try Restore Purchases.', true);
          }
        } catch (e) {
          const cancelled = !!(e && (e.userCancelled || e.user_cancelled));
          const msg = cancelled ? 'Purchase cancelled.' : (e && (e.message || e.errorMessage) || 'Purchase failed');
          setStatus(msg, true);
        } finally {
          setButtonsEnabled(true);
        }
      });
    }
    if (rest && !rest.__wired) {
      rest.__wired = true;
      rest.addEventListener('click', async () => {
        setStatus('Restoring…');
        setButtonsEnabled(false);
        try {
          const ent = await restore();
          if (ent && ent.active) {
            writeCachedEntitlement(ent);
            setStatus('Subscription restored.');
            setTimeout(hidePaywall, 600);
          } else {
            setStatus('No active subscription found on this Apple ID.', true);
          }
        } catch (e) {
          setStatus((e && (e.message || e.errorMessage)) || 'Restore failed', true);
        } finally {
          setButtonsEnabled(true);
        }
      });
    }
    const tnc = document.getElementById('iosPaywallTnc');
    if (tnc) tnc.setAttribute('href', TNC_URL);
    const priv = document.getElementById('iosPaywallPrivacy');
    if (priv) priv.setAttribute('href', PRIVACY_URL);
  }

  // Dev helper — reset cached entitlement (visible in Web Inspector)
  window.__h2oilResetEntitlement = function() {
    writeCachedEntitlement({ active: false });
    showPaywall();
  };

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) evaluateGate();
  });

  async function init() {
    wireButtons();
    await refreshPricingLabel();
    await evaluateGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[H2Oil iOS] Subscription gate active (RevenueCat)');
})();
