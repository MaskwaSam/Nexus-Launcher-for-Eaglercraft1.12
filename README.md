# Patterson Classroom Launcher for Eaglercraft 1.12

A browser launcher with local JavaScript and WebAssembly Garbage-Collected (WASM-GC) editions, fullscreen play, optional downloadable HTML bundles, controller mappings, and classroom world-export guidance. The About page retains the existing classroom instructions. World export, multiplayer, and gameplay have not been verified for this integration candidate.

## Integration candidate

This draft retains the compatible classroom, controller and runtime repairs originally reviewed in PRs #1–#3, plus the integration fixes below. Those source PRs were merged separately into `main` at `1b8ce0f6dafd156e88e7834f6cc9bbdd2740e751` during this follow-up. PR #4 is reconciled with that revision and remains a draft; this work does not merge into production or deploy.

| Original source | Reviewed head | Original target |
| --- | --- | --- |
| [PR #1: classroom baseline](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/1) | `c98ff7962068ceaa17b86c824a4ae585e8a756c7` | `main` at `958d9128d653db1b08e78be4c2ec6d07c6b798a0` |
| [PR #2: controller focus recovery](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/2) | `52afc7b23d87b4bc2a738904328c1c596e4eef80` | PR #1 |
| [PR #3: bundled runtime repair](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/3) | `aa204954f2b829a1c53f3802d92ee19378663e12` | PR #1 |

The original functional changes were separate: PR #2 changed `index.html` and controller checks; PR #3 changed the two game bundles and runtime checks. Integration routes right-stick movement to the runtime canvas and sends each keyboard transition once through document bubbling to the game's window listeners. Current main's corrected world-export guidance and both instrumented controller checks are retained. Export conversion and gameplay remain unverified.

**Warning decision, approved October 20, 2026:** stop forcing the phishing and default-username warnings hidden. Startup no longer writes either preference. New profiles use the runtime's normal warning behavior; existing saved preferences, including prior dismissals, remain intact. No preference migration is performed. PR #1's bundled attribution text is preserved.

This is a review candidate, not a production release or hardware acceptance result. Authentication, server routes, and existing saves are outside these changes.

## Automated regression checks

Run with Node.js 18 or newer; this candidate was exercised with Node.js **26.5.1**:

```sh
node --test tests/*.test.cjs
```

The combined suite contains **54 checks**:

- **26 controller checks:** actual launcher scripts in a VM, with modeled gamepads, iframe reloads, and Window/Document/Canvas event propagation. They cover mappings and deadzones, shared Back/Start, disconnect and handover, sparse gamepad slots, exit/relaunch, focus/visibility cleanup, fresh refocus transitions, stable WindowProxy reloads, and canvas delivery. The first connected gamepad in the browser's list is used, including when earlier slots are empty.
- **20 runtime checks:** the actual bundled native WASM container decoder with mocked host imports, valid decoding and corruption rejection, preserved component hashes, the real TeaVM mobile suspension/resumption lifecycle, the actual WASM host's canvas handlers, and main's two stricter startup guards against saved-setting access and warning-suppression code. The touch checks cover native-tap defaults, retained touch records, movement/cancellation, desktop mouse/wheel mappings, pointer lock, and exact restoration of the original host by reversing its two call removals. The decoder tests model a JSPI-capable host; they do not establish browser JSPI support.
- **4 startup-option checks:** fresh profiles and saved warning preferences in both editions; startup performs no forced preference writes and retains the existing container and world-database options.
- **4 service-worker checks:** precache files exist and include the manifest start URL, cache versions rotate, activation preserves unrelated caches, fetches use only the current launcher cache with network fallback, and a missing required asset rejects installation.

These checks do not establish physical-controller, phone, gameplay, or multiplayer compatibility. The VM model omits browser capture/cancellation details, so loaded-runtime browser checks are also needed for input delivery.

The optional `node tests/browser.integration.cjs` runner requires Playwright, a Chromium browser, and Tesseract for rendered-menu assertions. Set `NEXUS_BROWSER_EXECUTABLE` to use an installed browser; `NEXUS_PLAYWRIGHT_MODULE` can select an existing Playwright module, and `NEXUS_TESSERACT_EXECUTABLE` can select the OCR executable. It serves this checkout on a temporary loopback port, uses fresh browser profiles, and prints the directory containing screenshots, OCR text and JSON results. `NEXUS_BROWSER_OUTPUT` selects that directory. `NEXUS_BROWSER_SCENARIOS` can select comma-separated scenario names, such as `android-wasm-iframe`; `NEXUS_BROWSER_ROOT` can serve a separate distribution for before/after checks. Native tab-focus transitions that headless Chrome cannot produce remain explicitly unavailable.

The retained `checks/controller-runtime-browser.cjs` and `checks/controller-runtime-live.cjs` use `PLAYWRIGHT_MODULE` and `CHROME_PATH`. They exercise extracted native camera consumers and an instrumented JS runtime with simulated controllers and modeled focus/pointer lock. Their results are separate from native-focus browser checks and physical-controller acceptance.

## Browser and device acceptance

Desktop and Android-emulated startup/menu evidence is recorded separately from the Node checks in the integration validation record. Browser automation uses simulated gamepads; trusted emulated touch is not a physical-phone test. The WASM edition requires browser support for JavaScript Promise Integration, including `WebAssembly.Suspending`; the runtime's capability, checksum, and decompression checks remain enabled.

The WASM touch-menu blocker is repaired at the bundled browser-host boundary. That host cancelled canvas touch-start/end while queuing touch events that the compiled game discards. Removing those two cancellations restores the browser's native compatibility mouse path, matching the JS edition. It fabricates no DOM mouse events and retains touch-move cancellation, native touch records, keyboard-zone handling and compiled game bytes.

Mobile checks exercise direct and launcher-iframe paths in Android emulation. They require one trusted native mouse down/up/click sequence per tap and assert rendered profile-to-title, Options and Controls transitions with Touchscreen Mode OFF and ON. They also check cancelled touches, drags, multitouch, repeated taps and restoration of the mode setting. These menu checks do not establish touch gameplay or physical-phone compatibility.

Before release, exercise both editions with physical controllers and phones. Hold movement/Jump while disconnecting, leaving fullscreen, switching windows, and hiding the tab; then reconnect, relaunch, and refocus. Confirm no held key survives and new input works. With two controllers connected, disconnect each in turn and confirm handover. Check Back and Start individually and together, inventory, right-stick camera movement, keyboard/mouse play, touch menus, and in-world controls. Verify saved worlds and the classroom world-export workflow independently.

## Service-worker precache and updates

The worker precaches the actual `./index.html`, `./manifest.json`, and both bundled game files in `nexus-launcher-v3`. This repairs the inherited missing-`launcher.html` install failure and avoids reusing v1 or main's separately published v2 entries. Activation removes only obsolete `nexus-launcher-v<digits>` caches; unrelated caches remain intact. Fetches read only the current launcher cache before the existing network fallback. Increment the cache version when changing precached launcher or game files.

Updates retain the browser's normal waiting lifecycle. Existing controlled pages and game iframes keep their current worker until all its clients close; there is no forced takeover, automatic reload, or cache deletion during installation. A failed precache rejects the update and leaves the active worker usable.

The optional `node tests/service-worker.integration.cjs` runner requires Playwright and Chromium, using the same module/browser environment variables as the menu runner. `NEXUS_SW_BROWSER_OUTPUT` selects its evidence directory. It checks root and subdirectory scopes, offline byte equality for all four core files, unrelated caches with conflicting responses, saved-data sentinels, modeled v1/v2 installations, failed-update recovery, and waiting/activation across open pages and an iframe.

The canonical cached launch URL is the manifest's `index.html`. A directory URL such as `/` is a separate request and has no offline navigation fallback. External styles/fonts and other uncached assets still require network. These local checks do not establish installed-PWA, physical-device, full offline UI, or production-update acceptance; those remain release checks.

## Bundled runtime maintenance

This distribution has no buildable upstream source project. The JS repair adds a `waitForMobileLaunch` suspension point in `DJt`, allowing the existing button callback to remove the prompt and resume the startup thread. Desktop startup remains on its original path.

PR #3 fixes the outer EPW checksum and restores two modified XZ containers to the decoder's CRC32/32 MiB dictionary profile. The later native-tap repair changes only the browser-host component: exactly two `preventDefault()` calls are removed, and that XZ component is recompressed with the same decoder-compatible profile. All other native/compressed component bytes and customized assets remain intact. The final EPW is **15,067,956 bytes**, with CRC32 **`0x1530803f`** over bytes after its 16-byte header. No validation is bypassed. The integration's warning-script removal changes neither embedded payload.

`python3 scripts/repair-wasm-touch.py` verifies the frozen repaired container. `--apply` reproduces it from the exact reviewed pre-repair payload, and `--file PATH` selects a separate copy. The script checks complete input/output hashes, preserves opaque padding, updates only the required host metadata/offsets/checksum, and refuses an unexpected distribution or compressor result.

When intentionally changing payload contents, regenerate the affected XZ checks, EPW offsets/lengths, and outer CRC32. Independently compare decoded content before updating preservation hashes. Keep the native corruption-rejection check and browser startup checks in place.
