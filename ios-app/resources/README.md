# App Icons and Splash Screen

Source images for the iOS app icon and launch screen. Already populated from the
H2Oil sidebar logo embedded in `well-testing-app.html`.

## Files

| File                    | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `icon.png`              | 1024×1024 App Store icon (opaque `#0d1117`)    |
| `splash.png`            | 2732×2732 launch screen                        |
| `splash-dark.png`       | dark-mode launch screen (same — app is dark)   |
| `icon-foreground.png`   | transparent-bg version (Android adaptive)      |
| `icon-background.png`   | solid background tile (Android adaptive)       |

## Regenerating from the main logo

If the sidebar logo in `well-testing-app.html` changes:

```bash
cd ios-app
npm run assets          # runs make-assets.py + @capacitor/assets generate --ios
```

That does two things:
1. `python3 scripts/make-assets.py` — extracts the first base64 PNG from the
   main HTML and writes all source images here.
2. `npx @capacitor/assets generate --ios` — produces all required Apple sizes
   under `ios/App/App/Assets.xcassets/`.

Requires `pip install Pillow` on the host once.

## Manual edits

If you want to hand-author `icon.png` / `splash.png`:

- **icon.png**: 1024×1024, PNG, **opaque** (no alpha), corners not pre-rounded.
- **splash.png**: 2732×2732, background `#0d1117`, logo centered in middle
  ~1200×1200 (outside is cropped on some devices).

Then run `npx @capacitor/assets generate --ios` on a Mac.
