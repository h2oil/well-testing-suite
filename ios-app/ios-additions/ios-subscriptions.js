// ══════════════════════════════════════════════════════════════
// iOS Subscription Gate — RevenueCat (RC 13 + Capacitor 8)
//   @revenuecat/purchases-capacitor      — StoreKit bridge
//   @revenuecat/purchases-capacitor-ui   — native paywall + Customer Center
//
// Flow on launch:
//   1. Configure RC with the iOS public key.
//   2. Check the cached entitlement for instant offline unlock.
//   3. Verify with RC in the background via getCustomerInfo.
//   4. If the user lacks the "pro" entitlement, present RC's native
//      paywall (presentPaywallIfNeeded). The paywall is fully designed
//      in the RC dashboard — no local HTML.
//   5. Re-evaluate whenever the app returns from background (visibility
//      change), the Customer Center closes, or H2OilSubs.refresh() is
//      called.
//
// Exposes window.H2OilSubs for in-app "Manage Subscription" buttons and
// dev helpers (diag, forcePaywall, resetCache).
//
// ─── CONFIG ────────────────────────────────────────────────────
//   1. RC dashboard → Project Settings → API Keys → iOS public key
//      (starts "appl_") → REVENUECAT_API_KEY below. iOS native StoreKit
//      requires an appl_ key; the runtime guard rejects everything else.
//   2. Entitlements → create identifier "pro".
//   3. Products → import com.h2oil.welltesting.pro.monthly, attach to "pro".
//   4. Offerings → "default" → Monthly package pointing at the product,
//      marked Current. Paywalls tab → design + Publish.
// ──────────────────────────────────────────────────────────────
const REVENUECAT_API_KEY = 'appl_ZgPLTWenoIgrqCgSDmqMRdMXyFF';
const ENTITLEMENT_ID = 'pro';
const OFFERING_ID    = 'default';
const PRODUCT_ID     = 'com.h2oil.welltesting.pro.monthly';
const ENTITLEMENT_CACHE_KEY = 'h2oil.entitlement';
// ══════════════════════════════════════════════════════════════

(function(){
  if (typeof window === 'undefined') return;
  const isNative = window.Capacitor
      && window.Capacitor.isNativePlatform
      && window.Capacitor.isNativePlatform();
  if (!isNative) return;

  // Plugin references are late-bound. Capacitor 8 registers native
  // plugins asynchronously after the JS bundle parses, so capturing
  // refs at module-init can grab nulls. These `let` bindings get
  // rebound by refreshPluginRefs() from waitForPurchasesPlugin().
  let Plugins     = (window.Capacitor && window.Capacitor.Plugins) || {};
  let Purchases   = Plugins.Purchases || null;
  let PurchasesUI = Plugins.RevenueCatUI || Plugins.PurchasesUI || null;
  let Prefs       = Plugins.Preferences || null;
  function refreshPluginRefs() {
    Plugins     = (window.Capacitor && window.Capacitor.Plugins) || {};
    Purchases   = Plugins.Purchases || null;
    PurchasesUI = Plugins.RevenueCatUI || Plugins.PurchasesUI || null;
    Prefs       = Plugins.Preferences || null;
  }

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
    if (!/^appl_[A-Za-z0-9]{10,}$/.test(REVENUECAT_API_KEY || '')) {
      console.error('[iOS Subs] RevenueCat iOS API key invalid. Expected format: appl_XXXXXXXX... App will launch without a gate.');
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
        // Reset promise on failure so a later fix (dashboard change,
        // CDN propagation) can retry instead of locking us out until
        // a full app restart.
        configurePromise = null;
        return false;
      }
    })();
    return configurePromise;
  }

  // Far-future sentinel for entitlements without an expirationDate
  // (lifetime / non-subscription entitlements).
  const NO_EXPIRY = 8640000000000000; // max safe Date ms

  function entitlementFromCustomerInfo(customerInfo) {
    if (!customerInfo) return null;
    const active = customerInfo.entitlements && customerInfo.entitlements.active;
    if (!active) return null;
    const ent = active[ENTITLEMENT_ID];
    if (!ent) return null;
    const expiry = ent.expirationDate ? new Date(ent.expirationDate).getTime() : NO_EXPIRY;
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

  // ── Native RC paywall ────────────────────────────────────────
  // Returns:
  //   true  → the user now has the entitlement (purchased / restored)
  //   false → paywall was shown and user dismissed without subscribing
  //   null  → UI plugin unavailable OR the call threw (RC misconfigured,
  //           network, etc.) — the app will log and stay locked until
  //           the next gate re-evaluation (visibility change / refresh).
  async function presentRCPaywallIfNeeded() {
    if (!PurchasesUI) return null;
    if (!(await configureOnce())) return null;
    try {
      await PurchasesUI.presentPaywallIfNeeded({
        requiredEntitlementIdentifier: ENTITLEMENT_ID
      });
      const ent = await queryLiveEntitlement();
      return !!(ent && ent.active);
    } catch (e) {
      console.warn('[iOS Subs] RC paywall presentation failed:', e);
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
      const ent = await queryLiveEntitlement();
      writeCache(ent && ent.active ? ent : { active: false });
      evaluateGate();
    } catch (e) {
      console.warn('[iOS Subs] Customer Center failed:', e);
    }
  }

  // ── Manage Subscription FAB (visible when entitled) ──────────
  function renderManageButton() {
    if (document.getElementById('iosManageSub')) return;
    if (!PurchasesUI) return;
    const fab = document.createElement('button');
    fab.id = 'iosManageSub';
    fab.type = 'button';
    fab.title = 'Manage subscription';
    fab.textContent = '\u2699\ufe0e';
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
  // `gating` prevents overlapping evaluations. `pendingRecheck` captures
  // any re-check request that arrives mid-flight so it isn't dropped.
  let gating = false;
  let pendingRecheck = false;
  async function evaluateGate() {
    if (gating) { pendingRecheck = true; return; }
    gating = true;
    try {
      do {
        pendingRecheck = false;

        // Optimistic unlock if cached entitlement is still valid — lets
        // existing subscribers launch instantly even offline.
        const cached = readCache();
        if (isCacheValid(cached)) {
          setManageButtonVisible(true);
        }

        // Authoritative check against RC's backend.
        const live = await queryLiveEntitlement();
        if (live && live.active) {
          writeCache(live);
          setManageButtonVisible(true);
          continue;
        }

        // No active entitlement → present the native RC paywall. Designed
        // in the RC dashboard; if you don't have one published the SDK
        // will no-op and the gate stays open (see warning below).
        const nativeOk = await presentRCPaywallIfNeeded();
        if (nativeOk === true) {
          const ent = await queryLiveEntitlement();
          if (ent && ent.active) {
            writeCache(ent);
            setManageButtonVisible(true);
            continue;
          }
        }

        // Three reasons we land here:
        //   null  — RC UI plugin missing or the call threw
        //   false — user dismissed the paywall without subscribing
        //   true but re-query didn't show the entitlement (rare race)
        // In all cases we've done what we can on this pass. Mark the
        // gate closed, hide the manage button, and rely on the next
        // visibility change (or explicit H2OilSubs.refresh()) to
        // retry. There is no local fallback paywall any more.
        writeCache({ active: false });
        setManageButtonVisible(false);
        if (nativeOk === null) {
          console.error('[iOS Subs] RC paywall unavailable — check dashboard offering/paywall config.');
        }
      } while (pendingRecheck);
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
    resetCache: () => { writeCache({ active: false }); evaluateGate(); },
    diag: async () => {
      refreshPluginRefs();
      const out = {
        isNative,
        pluginsRegistered: Object.keys(Plugins || {}),
        hasPurchases: !!Purchases,
        hasPurchasesUI: !!PurchasesUI,
        apiKeyLooksValid: /^appl_[A-Za-z0-9]{10,}$/.test(REVENUECAT_API_KEY || ''),
        cachedEntitlement: readCache(),
      };
      try { out.liveEntitlement = await queryLiveEntitlement(); } catch (e) { out.liveEntitlementError = String(e); }
      try {
        const o = await loadOfferings();
        out.currentOffering = o ? {
          id: o.identifier,
          packages: (o.availablePackages || []).length,
          hasPaywall: !!(o.paywall || o.paywallComponents),
        } : null;
      } catch (e) { out.offeringsError = String(e); }
      console.log('[iOS Subs diag]', out);
      return out;
    },
    // Force the native paywall to present regardless of cached state.
    // Useful for demos / sandbox re-testing without uninstalling.
    forcePaywall: async () => {
      writeCache({ active: false });
      const ok = await presentRCPaywallIfNeeded();
      if (ok === null) console.error('[iOS Subs] forcePaywall: RC paywall unavailable (UI plugin missing or configure failed).');
    },
  };
  // Back-compat dev helper
  window.__h2oilResetEntitlement = window.H2OilSubs.resetCache;

  // Re-check when the app returns from background — covers cancels or
  // renewals done via iOS Settings, and the return from Customer Center.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) evaluateGate();
  });

  // Capacitor 8 registers native plugins asynchronously. Poll for
  // Purchases to appear before running init() so the first configure
  // call doesn't race an empty plugin registry.
  async function waitForPurchasesPlugin(timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      refreshPluginRefs();
      if (Purchases) return true;
      await new Promise(r => setTimeout(r, 80));
    }
    refreshPluginRefs();
    return !!Purchases;
  }

  async function init() {
    renderManageButton();
    const ready = await waitForPurchasesPlugin();
    console.log('[iOS Subs] Plugins at init:', Object.keys(Plugins || {}).join(','),
                '| Purchases:', !!Purchases, '| PurchasesUI:', !!PurchasesUI);
    if (!ready) {
      console.error('[iOS Subs] Purchases plugin never registered — subscription gate disabled. Fix: `cd ios-app && npx cap sync ios` then rebuild.');
    }
    await configureOnce();
    evaluateGate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('[H2Oil iOS] Subscription gate active (RevenueCat native paywall only)');
})();
