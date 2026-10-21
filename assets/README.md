# Offline styling assets

`tailwind.css` is the exact Tailwind Play CDN v3.4.17 stylesheet captured from the original launcher in Chrome 155 before its remote dependency was removed. Its source SHA-256, before the final newline, is `efe0e52ae391d44714a6719abbd3dac0bc5e31ef613acd4d7342cd2db375bf03`. The official MIT notice is in `TailwindCSS-LICENSE.txt`.

`fonts.css` preserves the original discrete face weight descriptors and `font-display: swap`: Inter 400/600/800 and Orbitron 400/700, using unchanged Latin WOFF2 binaries. Other scripts use browser fallback.

The original CDN inserts its generated stylesheet after the embedded component stylesheet. Preserve that cascade order:

```html
<link rel="stylesheet" href="assets/fonts.css">
<style>/* Existing component styles */</style>
<link rel="stylesheet" href="assets/tailwind.css">
```

There are no runtime compiler scripts or package requirements. Responsive `sm:flex`, hover colors, transitions and component overrides are preserved. When adding utility classes, regenerate with Tailwind CSS 3.4.17 against `index.html`, compare desktop/mobile rendering, and increment the service-worker cache generation.

## Sources and licensing

- Original Google Fonts query: `https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Orbitron:wght@400;700&display=swap`. The captured Chrome CSS response SHA-256 is `d0cad6164ba153f3afabeebb2e7a9c8bb96e785bfeedda29806d45e47330b808`.
- Inter binary: Google Fonts Inter v20 Latin WOFF2 at `https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7.woff2`; SIL Open Font License 1.1 in `fonts/Inter-OFL.txt`; upstream `https://github.com/google/fonts/tree/main/ofl/inter`.
- Orbitron binary: Google Fonts Orbitron v35 Latin WOFF2 at `https://fonts.gstatic.com/s/orbitron/v35/yMJRMIlzdpvBhQQL_Qq7dy0.woff2`; SIL Open Font License 1.1 in `fonts/Orbitron-OFL.txt`; upstream `https://github.com/google/fonts/tree/main/ofl/orbitron`.
- Tailwind CSS v3.4.17 source and MIT license: `https://github.com/tailwindlabs/tailwindcss/tree/v3.4.17` and `https://github.com/tailwindlabs/tailwindcss/blob/v3.4.17/LICENSE`.
