Place your app icons here before running npm run dist:win

Required files:
  icon.ico   — Windows icon (256x256 minimum, multi-size ICO recommended)
  icon.icns  — macOS icon (512x512)
  icon.png   — 512x512 PNG (used as source for both)

You can generate icon.ico from icon.png using a free tool like:
  https://convertico.com  or  https://icoconvert.com

Until you add icons, remove the "icon" keys from the "win" and "mac"
sections in package.json and electron-builder will use its default icon.
