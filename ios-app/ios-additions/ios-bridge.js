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

  // Project file (.h2oilproj) Save / Save As from the top-right File toolbar
  // (prism-build/29-project-save.js checks this hook before any download).
  // Writes the JSON to the app cache and opens the share sheet ("Save to
  // Files", AirDrop, Mail…). Resolves false so the caller can fall back.
  window.__projectSaveOverride = function(filename, jsonText) {
    const name = String(filename || 'project.h2oilproj').replace(/[\\/:*?"<>|]+/g, '-');
    return writeAndShare(name, String(jsonText == null ? '' : jsonText), false);
  };

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
      // Multi-page A4 PDF with margins. Page breaks are snapped to element
      // boundaries (sections, table rows, result rows) so nothing is sliced
      // through the middle.
      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
      const pageW = 210, pageH = 297, margin = 10, footer = 6;
      const contentW = pageW - 2 * margin, contentH = pageH - 2 * margin - footer;
      const pxPerMm = canvas.width / contentW;
      const pagePx = Math.floor(contentH * pxPerMm);
      const scale = canvas.width / body.scrollWidth;
      const bodyTop = body.getBoundingClientRect().top;
      const cuts = [];
      ifr.contentDocument.querySelectorAll('.rp-hero, .rp-meta, .rp-part, .rp-sec, .rp-kvr, .rp-fig, tr, .card, .rrow, .pair, h2, h3, figure, .rp-foot')
        .forEach(el => { cuts.push(Math.round((el.getBoundingClientRect().top - bodyTop) * scale)); });
      cuts.sort((a, b) => a - b);
      const slices = [];
      let start = 0;
      while (start < canvas.height - 2) {
        let end = start + pagePx;
        if (end >= canvas.height) end = canvas.height;
        else {
          // Latest element top that still leaves the page at least half full.
          let best = -1;
          for (const c of cuts) { if (c > start + pagePx * 0.5 && c <= end) best = c; }
          if (best > 0) end = best;
        }
        slices.push([start, end]);
        start = end;
      }
      slices.forEach(([s, e], i) => {
        if (i > 0) pdf.addPage();
        const pc = document.createElement('canvas');
        pc.width = canvas.width; pc.height = e - s;
        const pctx = pc.getContext('2d');
        pctx.fillStyle = '#ffffff'; pctx.fillRect(0, 0, pc.width, pc.height);
        pctx.drawImage(canvas, 0, s, canvas.width, e - s, 0, 0, canvas.width, e - s);
        pdf.addImage(pc.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, contentW, (e - s) / pxPerMm);
        pdf.setFontSize(7.5); pdf.setTextColor(140, 149, 159);
        pdf.text(String(title || 'Report'), margin, pageH - margin + 1);
        pdf.text('Page ' + (i + 1) + ' of ' + slices.length, pageW - margin, pageH - margin + 1, { align: 'right' });
      });
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

  // ── Sanity check: the main app must expose buildReportHTML so the
  // PDF override can generate the branded cover page. If this assignment
  // is ever refactored away, PDF export silently regresses — warn loudly.
  setTimeout(() => {
    if (typeof window.buildReportHTML !== 'function') {
      console.warn('[H2Oil iOS] window.buildReportHTML is not exposed — PDF export will fall back to a plain HTML wrapper without the client-info cover page.');
    }
  }, 1500);

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
