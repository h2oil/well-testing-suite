// ══════════════════════════════════════════════════════════════
// iOS Subscription Gate — RevenueCat
//   @revenuecat/purchases-capacitor      (StoreKit bridge)
//   @revenuecat/purchases-capacitor-ui   (native paywall + Customer Center)
//
// Flow on launch:
//   1. Configure RC with the iOS public key.
//   2. Fetch customerInfo. If the "pro" entitlement is active → unlock.
//   3. Otherwise try the native RC paywall (presentPaywallIfNeeded).
//   4. If the native paywall isn't available (UI plugin missing or no
//      paywall configured for the offering), fall back to the custom
//      HTML paywall declared in ios-paywall.html.
//
// Exposes window.H2OilSubs for in-app "Manage Subscription" buttons.
//
// ─── CONFIG ────────────────────────────────────────────────────
//   1. RevenueCat dashboard → Project settings → API Keys → iOS public
//      key (starts "appl_") → paste into REVENUECAT_API_KEY below.
//      (The "test_…" string below works only if you've set up a
//      web/billing test project; iOS native StoreKit needs appl_).
//   2. Dashboard → Entitlements → create identifier "pro" (display name
//      can be "Well Testing Suite Pro").
//   3. Dashboard → Products → import com.h2oil.welltesting.pro.monthly,
//      attach to "pro".
//   4. Dashboard → Offerings → default offering, Monthly package →
//      points at that product. Build a Paywall on this offering in the
//      Paywalls tab to get native paywall UI.
// ──────────────────────────────────────────────────────────────
const REVENUECAT_API_KEY = 'test_GGthDkkadeNGttxyxmMdgZvpqDg';
const ENTITLEMENT_ID = 'pro';                                // must match dashboard id
const OFFERING_ID = 'default';                               // RC default offering
const PRODUCT_ID = 'com.h2oil.welltesting.pro.monthly';
const TNC_URL = 'https://h2oil.sitify.app';
const PRIVACY_URL = 'https://h2oil.sitify.app/privacy';
const ENTITLEMENT_CACHE_KEY = 'h2oil.entitlement';
// ══════════════════════════════════════════════════════════════

(function(){
  if (typeof window === 'undefined') return;
  const isNative = window.Capacitor
      && window.Capacitor.isNativePlatform
      && window.Capacitor.isNativePlatform();
  if (!isNative) return;

  const Plugins = window.Capacitor.Plugins || {};
  const Purchases = Plugins.Purchases || null;
  // UI plugin exposes presentPaywall / presentPaywallIfNeeded / presentCustomerCenter
  const PurchasesUI = Plugins.RevenueCatUI || Plugins.PurchasesUI || null;
  const Prefs = Plugins.Preferences || null;

  // ── Offline entitlement cache ────────────────────────────────
  function readCache() {
    try {
      const raw = localStorage.getItem(ENTITLEMENT_CACHE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (_) { return null; }
  }
  function writeCache(e) {
    try { localStorage.setItem(ENTITLEMENT_CACHE_KEY, JSON.stringify(e || {})); } catch (_) {}
    if (Prefs) Prefs.set({ key: ENTITLEMENT_CACHE_KEY, value: JSON.stringify(e || {}) }).catch(() => {});
  }
  function isCacheValid(e) {
    return !!(e && e.active && typeof e.expiry === 'number' && Date.now() < e.expiry);
  }

  // ── RC setup ─────────────────────────────────────────────────
  let configurePromise = null;
  function configureOnce() {
    if (configurePromise) return configurePromise;
    if (!Purchases) {
      configurePromise = Promise.resolve(false);
      return configurePromise;
    }
    if (!REVENUECAT_API_KEY || REVENUECAT_API_KEY.startsWith('appl_REPLACE_ME')) {
      console.warn('[iOS Subs] RevenueCat API key not set — paywall will run in offline/fallback mode');
      configurePromise = Promise.resolve(false);
      return configurePromise;
    }
    configurePromise = (async () => {
      try {
        await Purchases.setLogLevel({ level: 'ERROR' }).catch(() => {});
        await Purchases.configure({ apiKey: REVENUECAT_API_KEY });
        console.log('[iOS Subs] RevenueCat configured');
        return true;
      } catch (e) {
        console.warn('[iOS Subs] RevenueCat configure failed:', e);
        return false;
      }
    })();
    return configurePromise;
  }

  // Maps RevenueCat's CustomerInfo → our minimal entitlement shape.
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

  async function getCustomerInfo() {
    if (!Purchases) return null;
    if (!(await configureOnce())) return null;
    try {
      const res = await Purchases.getCustomerInfo();
      return (res && (res.customerInfo || res)) || null;
    } catch (e) {
      console.warn('[iOS Subs] getCustomerInfo failed:', e);
      return null;
    }
  }

  async function queryLiveEntitlement() {
    return entitlementFromCustomerInfo(await getCustomerInfo());
  }

  async function loadOfferings() {
    if (!Purchases) return null;
    if (!(await configureOnce())) return null;
    try {
      const res = await Purchases.getOfferings();
      const offerings = res && (res.offerings || res);
      return (offerings && (offerings.current || (offerings.all && offerings.all[OFFERING_ID]))) || null;
    } catch (e) {
      console.warn('[iOS Subs] getOfferings failed:', e);
      return null;
    }
  }

  async function currentMonthlyPackage() {
    const off = await loadOfferings();
    if (!off) return null;
    return off.monthly
        || (off.availablePackages && off.availablePackages.find(p =>
              (p.product && p.product.identifier === PRODUCT_ID) ||
              p.identifier === '$rc_monthly'))
        || (off.availablePackages && off.availablePackages[0])
        || null;
  }

  // ── Native RC paywall ────────────────────────────────────────
  // Returns true if an active entitlement is present AFTER the paywall
  // interaction (purchase/restore), false if user dismissed without
  // buying, or null if the UI plugin isn't available.
  async function presentRCPaywallIfNeeded() {
    if (!PurchasesUI) return null;
    if (!(await configureOnce())) return null;
    try {
      // presentPaywallIfNeeded: shows only if user lacks the entitlement.
      // Returns a result string ("PURCHASED" | "RESTORED" | "CANCELLED" | ...).
      const res = await PurchasesUI.presentPaywallIfNeeded({
        requiredEntitlementIdentifier: ENTITLEMENT_ID
      });
      const outcome = (res && (res.result || res)) || '';
      // Regardless of the reported outcome string, re-query entitlement
      // — the source of truth is always customerInfo.
      const ent = await queryLiveEntitlement();
      return !!(ent && ent.active);
    } catch (e) {
      console.warn('[iOS Subs] RC paywall failed, falling back:', e);
      return null;
    }
  }

  async function presentRCPaywall() {
    if (!PurchasesUI) return null;
    if (!(await configureOnce())) return null;
    try {
      await PurchasesUI.presentPaywall({ displayCloseButton: true });
      const ent = await queryLiveEntitlement();
      return !!(ent && ent.active);
    } catch (e) {
      console.warn('[iOS Subs] RC paywall failed:', e);
      return null;
    }
  }

  async function presentCustomerCenter() {
    if (!PurchasesUI) { alert('Customer Center not available on this device.'); return; }
    if (!(await configureOnce())) { alert('Subscription service not configured.'); return; }
    try {
      await PurchasesUI.presentCustomerCenter();
      // Re-check entitlement after the user returns — they may have cancelled.
      const ent = await queryLiveEntitlement();
      if (ent && ent.active) writeCache(ent);
      else writeCache({ active: false });
      evaluateGate();
    } catch (e) {
      console.warn('[iOS Subs] Customer Center failed:', e);
    }
  }

  // ── Fallback custom HTML paywall ─────────────────────────────
  function paywallNode() { return document.getElementById('iosPaywall'); }
  function showFallbackPaywall() {
    const el = paywallNode();
    if (!el) return;
    el.style.display = 'flex';
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
  }
  function hideFallbackPaywall() {
    const el = paywallNode();
    if (!el) return;
    el.style.display = 'none';
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }
  function setFallbackStatus(msg, isError) {
    const s = document.getElementById('iosPaywallStatus');
    if (!s) return;
    s.textContent = msg || '';
    s.classList.toggle('pw-err', !!isError);
  }
  function setFallbackButtonsEnabled(enabled) {
    ['iosPaywallSubscribe','iosPaywallRestore'].forEach(id => {
      const b = document.getElementById(id);
      if (b) b.disabled = !enabled;
    });
  }

  async function refreshFallbackPricingLabel() {
    const pkg = await currentMonthlyPackage();
    if (!pkg) return;
    const price = (pkg.product && (pkg.product.priceString || pkg.product.price_string))
                  || pkg.priceString || '';
    const el = document.getElementById('iosPaywallPrice');
    if (el && price) el.textContent = price + ' / month after 3-day free trial';
  }

  async function purchaseViaFallback() {
    if (!Purchases) throw new Error('Purchases plugin not available');
    if (!(await configureOnce())) throw new Error('RevenueCat not configured');
    const pkg = await currentMonthlyPackage();
    if (!pkg) throw new Error('No subscription package available');
    const res = await Purchases.purchasePackage({ aPackage: pkg });
    const info = res && (res.customerInfo || (res.purchaseResult && res.purchaseResult.customerInfo));
    return entitlementFromCustomerInfo(info);
  }

  async function restoreViaFallback() {
    if (!Purchases) throw new Error('Purchases plugin not available');
    if (!(await configureOnce())) throw new Error('RevenueCat not configured');
    const res = await Purchases.restorePurchases();
    return entitlementFromCustomerInfo(res && (res.customerInfo || res));
  }

  function wireFallbackButtons() {
    const sub = document.getElementById('iosPaywallSubscribe');
    const rest = document.getElementById('iosPaywallRestore');
    if (sub && !sub.__wired) {
      sub.__wired = true;
      sub.addEventListener('click', async () => {
        setFallbackStatus('Processing…');
        setFallbackButtonsEnabled(false);
        try {
          const ent = await purchaseViaFallback();
          if (ent && ent.active) {
            writeCache(ent);
            setFallbackStatus('Subscription active. Welcome!');
            setTimeout(hideFallbackPaywall, 600);
          } else {
            setFallbackStatus('Purchase completed but entitlement not yet active. Try Restore Purchases.', true);
          }
        } catch (e) {
          const cancelled = !!(e && (e.userCancelled || e.user_cancelled));
          const msg = cancelled ? 'Purchase cancelled.' : ((e && (e.message || e.errorMessage)) || 'Purchase failed');
          setFallbackStatus(msg, true);
        } finally {
          setFallbackButtonsEnabled(true);
        }
      });
    }
    if (rest && !rest.__wired) {
      rest.__wired = true;
      rest.addEventListener('click', async () => {
        setFallbackStatus('Restoring…');
        setFallbackButtonsEnabled(false);
        try {
          const ent = await restoreViaFallback();
          if (ent && ent.active) {
            writeCache(ent);
            setFallbackStatus('Subscription restored.');
            setTimeout(hideFallbackPaywall, 600);
          } else {
            setFallbackStatus('No active subscription found on this Apple ID.', true);
          }
        } catch (e) {
          setFallbackStatus((e && (e.message || e.errorMessage)) || 'Restore failed', true);
        } finally {
          setFallbackButtonsEnabled(true);
        }
      });
    }
    const tnc = document.getElementById('iosPaywallTnc');
    if (tnc) tnc.setAttribute('href', TNC_URL);
    const priv = document.getElementById('iosPaywallPrivacy');
    if (priv) priv.setAttribute('href', PRIVACY_URL);
  }

  // ── Manage Subscription FAB (visible when entitled) ──────────
  function renderManageButton() {
    if (document.getElementById('iosManageSub')) return;
    if (!PurchasesUI) return;  // no Customer Center → no button
    const fab = document.createElement('button');
    fab.id = 'iosManageSub';
    fab.type = 'button';
    fab.title = 'Manage subscription';
    fab.textContent = '⚙︎';
    fab.style.cssText = `
      position: fixed;
      right: calc(14px + env(safe-area-inset-right));
      bottom: calc(14px + env(safe-area-inset-bottom));
      z-index: 9998;
      width: 40px; height: 40px;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 50%;
      background: rgba(13,17,23,0.85);
      color: #58a6ff;
      font-size: 18px;
      cursor: pointer;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      display: none;
    `;
    fab.addEventListener('click', () => presentCustomerCenter());
    document.body.appendChild(fab);
  }
  function setManageButtonVisible(visible) {
    const b = document.getElementById('iosManageSub');
    if (b) b.style.display = visible ? 'block' : 'none';
  }

  // ── Gate evaluation ──────────────────────────────────────────
  let gating = false;
  async function evaluateGate() {
    if (gating) return;
    gating = true;
    try {
      // Optimistic unlock if we have a valid cached entitlement — app
      // launches instantly offline for existing subscribers.
      const cached = readCache();
      if (isCacheValid(cached)) {
        hideFallbackPaywall();
        setManageButtonVisible(true);
      } else {
        showFallbackPaywall();
        setManageButtonVisible(false);
      }

      // Always verify with RC in the background.
      const live = await queryLiveEntitlement();
      if (live && live.active) {
        writeCache(live);
        hideFallbackPaywall();
        setManageButtonVisible(true);
        return;
      }

      // No entitlement — try the native RC paywall first.
      const nativeOk = await presentRCPaywallIfNeeded();
      if (nativeOk === true) {
        const ent = await queryLiveEntitlement();
        if (ent && ent.active) {
          writeCache(ent);
          hideFallbackPaywall();
          setManageButtonVisible(true);
          return;
        }
      }

      // Native paywall unavailable OR user dismissed without buying → fallback.
      writeCache({ active: false });
      showFallbackPaywall();
      setManageButtonVisible(false);
      refreshFallbackPricingLabel();
    } finally {
      gating = false;
    }
  }

  // ── Public API ───────────────────────────────────────────────
  window.H2OilSubs = {
    getEntitlement: queryLiveEntitlement,
    isEntitled: async () => {
      const c = readCache();
      if (isCacheValid(c)) return true;
      const live = await queryLiveEntitlement();
      return !!(live && live.active);
    },
    presentPaywall: presentRCPaywall,
    presentCustomerCenter,
    refresh: evaluateGate,
    resetCache: () => { writeCache({ active: false }); evaluateGate(); }
  };
  // Back-compat dev helper
  window.__h2oilResetEntitlement = window.H2OilSubs.resetCache;

  // Re-check when app comes back from background (covers cancel/renew
  // via Settings and return from the Customer Center).
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) evaluateGate();
  });

  async function init() {
    wireFallbackButtons();
    renderManageButton();
    await configureOnce();
    refreshFallbackPricingLabel();
    evaluateGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[H2Oil iOS] Subscription gate active (RevenueCat + native paywall)');
})();
