// ══════════════════════════════════════════════════════════════
// iOS Native Bridge (Capacitor plugins)
// Only active when running inside the native iOS wrapper.
// Gracefully falls back to browser behaviour when not.
// ══════════════════════════════════════════════════════════════
(function(){
  const isNative = typeof window !== 'undefined'
        && window.Capacitor
        && window.Capacitor.isNativePlatform
        && window.Capacitor.isNativePlatform();

  if (!isNative) {
    window.isIOSApp = false;
    return;
  }

  window.isIOSApp = true;
  const P = window.Capacitor.Plugins || {};
  const { Haptics, Share, Filesystem, StatusBar, App, Preferences } = P;

  // ── Haptic feedback on button taps ────────────────────────────
  if (Haptics) {
    document.addEventListener('click', (e) => {
      const t = e.target.closest && e.target.closest('.btn, .btn-primary, .btn-export, button, .nav-btn');
      if (!t) return;
      const label = (t.textContent || '').trim().toLowerCase();
      const style = label.startsWith('calculate') ? 'medium' : 'light';
      Haptics.impact({ style }).catch(() => {});
    }, true);
  }

  // ── Native file save/share for CSV, PDF, PNG exports ──────────
  // iOS cannot use <a download> — instead we write the file to the
  // app cache and trigger the native share sheet, which includes
  // "Save to Files", "Save Image", "Print", "Mail", etc.
  async function writeAndShare(filename, base64OrText, isBase64) {
    if (!Filesystem || !Share) return false;
    try {
      const res = await Filesystem.writeFile({
        path: filename,
        data: base64OrText,
        directory: 'CACHE',
        encoding: isBase64 ? undefined : 'utf8',
        recursive: true
      });
      await Share.share({
        title: filename,
        url: res.uri,
        dialogTitle: 'Share ' + filename
      });
      return true;
    } catch (e) {
      console.warn('[iOS] share failed:', e);
      return false;
    }
  }

  // Convert a blob to base64 (needed for blob: URLs from canvas.toBlob, etc.)
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => {
        const d = r.result;
        const i = d.indexOf(',');
        resolve(i >= 0 ? d.slice(i + 1) : d);
      };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function handleDownloadLink(el) {
    const filename = el.download || 'download';
    const href = el.href || '';
    try {
      if (href.startsWith('data:')) {
        const comma = href.indexOf(',');
        const meta = href.slice(5, comma);
        const payload = href.slice(comma + 1);
        const isBase64 = meta.indexOf('base64') >= 0;
        if (isBase64) {
          return await writeAndShare(filename, payload, true);
        }
        const text = decodeURIComponent(payload);
        return await writeAndShare(filename, text, false);
      } else if (href.startsWith('blob:')) {
        const resp = await fetch(href);
        const blob = await resp.blob();
        const base64 = await blobToBase64(blob);
        return await writeAndShare(filename, base64, true);
      }
    } catch (e) {
      console.warn('[iOS] download intercept failed:', e);
    }
    return false;
  }

  // Intercept programmatic <a download> clicks (the common pattern
  // used throughout the app for CSV/PDF/PNG exports).
  const origCreateElement = document.createElement.bind(document);
  document.createElement = function(tag) {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === 'a') {
      const origClick = el.click.bind(el);
      el.click = function() {
        if (el.download && el.href && (el.href.startsWith('data:') || el.href.startsWith('blob:'))) {
          handleDownloadLink(el).then(ok => {
            if (!ok) origClick();
          });
          return;
        }
        origClick();
      };
    }
    return el;
  };

  // Expose a direct API any calculator can call if it wants to bypass
  // the <a download> pattern entirely:
  //     window.iosSaveFile('report.pdf', base64String, true)
  window.iosSaveFile = writeAndShare;

  // ── Status bar ─────────────────────────────────────────────────
  if (StatusBar) {
    StatusBar.setStyle({ style: 'DARK' }).catch(() => {});
    StatusBar.setBackgroundColor({ color: '#0d1117' }).catch(() => {});
  }

  // ── App lifecycle ─────────────────────────────────────────────
  if (App) {
    App.addListener('appStateChange', (state) => {
      if (!state.isActive) {
        try { document.dispatchEvent(new Event('app-backgrounded')); } catch (e) {}
      }
    });
  }

  // ── Mirror localStorage to Preferences (iCloud-eligible backup) ─
  if (Preferences) {
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(k, v) {
      origSetItem.call(this, k, v);
      if (this === window.localStorage) {
        Preferences.set({ key: k, value: v }).catch(() => {});
      }
    };
  }

  // ── Prevent pinch-zoom (iOS PWA quirk) ────────────────────────
  document.addEventListener('gesturestart', e => e.preventDefault());

  console.log('[H2Oil iOS] Native bridge active');
})();
