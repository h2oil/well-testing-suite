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

  // ── PDF export: load jsPDF + html2canvas on demand, override exportReport ──
  // Bundled offline — no CDN calls, safe for App Store.
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = () => resolve(); s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function ensurePdfLibs() {
    if (window.jspdf && window.html2canvas) return;
    // Libraries are copied next to index.html by the sync script
    await loadScript('jspdf.umd.min.js');
    await loadScript('html2canvas.min.js');
  }

  async function htmlToPdfBase64(html, title) {
    await ensurePdfLibs();
    // Render the HTML report into an off-screen iframe, then snapshot it.
    const ifr = document.createElement('iframe');
    ifr.setAttribute('aria-hidden','true');
    ifr.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;border:0;background:#fff;';
    document.body.appendChild(ifr);
    try {
      await new Promise((resolve) => {
        ifr.onload = () => resolve();
        const doc = ifr.contentDocument || ifr.contentWindow.document;
        doc.open(); doc.write(html); doc.close();
        // onload sometimes fires too early for document.write — wait a tick
        setTimeout(resolve, 400);
      });
      const body = ifr.contentDocument.body;
      const canvas = await window.html2canvas(body, {
        backgroundColor: '#ffffff',
        scale: 2,
        useCORS: true,
        logging: false,
        windowWidth: 794,   // A4 @ 96 dpi
        windowHeight: body.scrollHeight
      });
      const imgData = canvas.toDataURL('image/png');
      // Multi-page A4 PDF
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = 210, pageH = 297;
      const imgW = pageW;
      const imgH = canvas.height * pageW / canvas.width;
      let remaining = imgH;
      let y = 0;
      if (imgH <= pageH) {
        pdf.addImage(imgData, 'PNG', 0, 0, imgW, imgH);
      } else {
        // Split across pages
        while (remaining > 0) {
          pdf.addImage(imgData, 'PNG', 0, -y, imgW, imgH);
          remaining -= pageH;
          y += pageH;
          if (remaining > 0) pdf.addPage();
        }
      }
      const datauri = pdf.output('datauristring'); // "data:application/pdf;base64,..."
      const comma = datauri.indexOf(',');
      return datauri.slice(comma + 1); // base64 only
    } finally {
      ifr.remove();
    }
  }

  // Register the app's report-override hook. The main HTML's exportReport
  // checks window.__reportOverride first and delegates to us. This is the only
  // way to intercept, because the real exportReport lives inside an IIFE and
  // isn't reachable via window.exportReport.
  window.__reportOverride = async function(title, contentHTML) {
    try {
      // Build the styled HTML with cover page (client info + H2Oil logo).
      // window.buildReportHTML is exposed by the main app.
      const html = typeof window.buildReportHTML === 'function'
          ? window.buildReportHTML(title, contentHTML)
          : `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1>${contentHTML}</body></html>`;
      const safeTitle = String(title || 'report').replace(/[^A-Za-z0-9._-]+/g, '_');
      const filename = safeTitle + '.pdf';
      const base64 = await htmlToPdfBase64(html, title);
      const ok = await writeAndShare(filename, base64, true);
      if (!ok) {
        // Last-ditch: show the HTML in a printable window so the user still
        // has access to the system print → Save-as-PDF fallback.
        const w = window.open('', '_blank');
        if (w && w.document) {
          w.document.open(); w.document.write(html); w.document.close();
        }
      }
    } catch (e) {
      console.warn('[iOS] PDF export failed:', e);
      try {
        const w = window.open('', '_blank');
        if (w && w.document) {
          const html = typeof window.buildReportHTML === 'function'
              ? window.buildReportHTML(title, contentHTML)
              : `<!DOCTYPE html><html><body>${contentHTML}</body></html>`;
          w.document.open(); w.document.write(html); w.document.close();
        }
      } catch (_) {}
    }
  };

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
