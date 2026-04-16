// ══════════════════════════════════════════════════════════════
// iOS Native Bridge (Capacitor plugins)
// Only active when running inside the native iOS wrapper.
// Gracefully falls back to browser behavior when not.
// ══════════════════════════════════════════════════════════════
if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    const { Haptics, Share, Filesystem, StatusBar, App, Preferences } = window.Capacitor.Plugins;

    // ── Haptic feedback on button taps ──
    if (Haptics) {
        document.addEventListener('click', (e) => {
            const t = e.target;
            if (t && (t.matches('.btn, .btn-primary, .btn-export, button, .nav-btn') || t.closest('.btn, .btn-primary, .btn-export, button, .nav-btn'))) {
                Haptics.impact({ style: 'light' }).catch(() => {});
            }
        }, true);
        // Medium haptic on calculate actions
        document.addEventListener('click', (e) => {
            const t = e.target;
            if (t && (t.textContent || '').trim().toLowerCase().startsWith('calculate')) {
                Haptics.impact({ style: 'medium' }).catch(() => {});
            }
        }, true);
    }

    // ── Native share sheet for CSV/PDF/text exports ──
    // Intercepts existing export functions and routes through iOS share sheet.
    if (Share) {
        window.iosShare = async (title, text, filename) => {
            try {
                await Share.share({ title, text, dialogTitle: 'Share ' + (title || 'Report') });
            } catch (e) { /* user cancelled */ }
        };

        // Monkey-patch window.open / a.download to use native share
        const origCreateElement = document.createElement.bind(document);
        document.createElement = function(tag) {
            const el = origCreateElement(tag);
            if (tag.toLowerCase() === 'a') {
                const origClick = el.click.bind(el);
                el.click = async function() {
                    if (el.download && el.href && el.href.startsWith('data:')) {
                        try {
                            // Decode data URL and use native share
                            const [meta, payload] = el.href.split(',');
                            const isBase64 = meta.indexOf('base64') >= 0;
                            const text = isBase64 ? atob(payload) : decodeURIComponent(payload);
                            await Share.share({
                                title: el.download,
                                text: text,
                                dialogTitle: 'Share ' + el.download
                            });
                            return;
                        } catch (e) { /* fallback */ }
                    }
                    origClick();
                };
            }
            return el;
        };
    }

    // ── Status bar styling ──
    if (StatusBar) {
        StatusBar.setStyle({ style: 'DARK' }).catch(() => {});
        StatusBar.setBackgroundColor({ color: '#0d1117' }).catch(() => {});
    }

    // ── App lifecycle: back-gesture support, resume handling ──
    if (App) {
        App.addListener('backButton', () => {
            // iOS doesn't have a back button but respect swipe gestures
            if (typeof window.closeMobileSidebar === 'function') {
                window.closeMobileSidebar();
            }
        });
        App.addListener('appStateChange', (state) => {
            // Save any pending state when backgrounded
            if (!state.isActive && typeof window.saveInputs === 'function') {
                try { document.dispatchEvent(new Event('app-backgrounded')); } catch (e) {}
            }
        });
    }

    // ── Persistent storage via Preferences (replaces localStorage for native) ──
    // We keep localStorage as primary but mirror to Preferences for iCloud/iTunes backup.
    if (Preferences) {
        const origSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(k, v) {
            origSetItem.call(this, k, v);
            if (this === window.localStorage) {
                Preferences.set({ key: k, value: v }).catch(() => {});
            }
        };
    }

    // ── Prevent rubber-band scroll bounce ──
    document.addEventListener('touchmove', (e) => {
        if (e.scale !== 1) e.preventDefault();
    }, { passive: false });

    // ── Expose a flag any calculator can check ──
    window.isIOSApp = true;
    console.log('[H2Oil iOS] Native bridge active');
} else {
    window.isIOSApp = false;
}
