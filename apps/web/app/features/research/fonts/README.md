# Research UI font

This variable UI subset is derived from Google Fonts' Noto Sans SC under SIL OFL 1.1.
The modified family is **EP Reader Sans UI**. Copyright and license records stay in the font;
the full license is distributed at `apps/web/public/fonts/noto-sans-sc-OFL.txt`.

The subset covers fixed interface copy and synthetic reading labels. Other Chinese paper
titles and author names remain readable through system font fallback. No paper abstract is
part of the font corpus. Manrope is separately installed at a pinned version, with its
license distributed at `apps/web/public/fonts/manrope-OFL.txt`.

To regenerate after changing interface copy:

```sh
python -m pip install fonttools[woff]==4.66.1 brotli==1.2.0
# Obtain NotoSansSC[wght].ttf from the official Google Fonts source, preserve its OFL.
python scripts/build-ep-ui-font.py --source .data/frontend/noto-sans-sc-source.ttf --out-dir apps/web/app/features/research/fonts
```

`manifest.json` records the source and artifact hashes. The full 17 MB TTF and build tools
stay outside Git. Vite emits the small WOFF2 with a content hash in its asset URL.
