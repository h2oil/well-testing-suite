# App Icons and Splash Screen

Place two source files here, then run `npx @capacitor/assets generate --ios`.

## Required

### `icon.png`
- **Size:** 1024×1024 pixels
- **Format:** PNG (no transparency — Apple requires opaque)
- **Corners:** DO NOT pre-round; iOS rounds automatically
- **Content:** H2Oil logo / mark, centered, with solid background

### `splash.png`
- **Size:** 2732×2732 pixels (covers all device sizes)
- **Format:** PNG or JPG
- **Content:** Logo centered in the middle ~1200×1200 area (outside that will be cropped on some devices)
- **Background:** Solid `#0d1117` (matches app theme)

## Generate

```bash
# from ios-app/
npm install -D @capacitor/assets
npx @capacitor/assets generate --ios
```

This produces all required sizes and writes them into `ios/App/App/Assets.xcassets/`.

## Design guidelines (Apple HIG)

- No text in the icon
- Flat, recognisable at tiny sizes (60×60 pts)
- Use the H2Oil accent orange `#f0883e` as dominant colour
- Avoid photographic textures
- Test at actual size: 60×60 pixels on a 1x display

## If you don't have a logo yet

A temporary placeholder you can generate with ImageMagick:

```bash
convert -size 1024x1024 xc:"#0d1117" \
    -fill "#f0883e" -font Helvetica-Bold -pointsize 480 \
    -gravity center -annotate +0+0 "H2" \
    icon.png

convert -size 2732x2732 xc:"#0d1117" \
    -fill "#f0883e" -font Helvetica-Bold -pointsize 400 \
    -gravity center -annotate +0+0 "H2Oil" \
    splash.png
```
