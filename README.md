# Patterson Classroom Launcher for Eaglercraft 1.12

A browser launcher with local JavaScript and WebAssembly Garbage-Collected (WASM-GC) editions, fullscreen play, optional downloadable HTML bundles, controller mappings, and native saved-world backups. The About page retains the classroom instructions and separates native Eaglercraft backups from the unverified Java/Mineways conversion workflow.

## Integration candidate

This draft retains the compatible classroom, controller and runtime repairs originally reviewed in PRs #1–#3, plus the integration fixes below. Those source PRs were merged separately into `main` at `1b8ce0f6dafd156e88e7834f6cc9bbdd2740e751` during this follow-up. PR #4 is reconciled with that revision and remains a draft; this work does not merge into production or deploy.

| Original source | Reviewed head | Original target |
| --- | --- | --- |
| [PR #1: classroom baseline](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/1) | `c98ff7962068ceaa17b86c824a4ae585e8a756c7` | `main` at `958d9128d653db1b08e78be4c2ec6d07c6b798a0` |
| [PR #2: controller focus recovery](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/2) | `52afc7b23d87b4bc2a738904328c1c596e4eef80` | PR #1 |
| [PR #3: bundled runtime repair](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/3) | `aa204954f2b829a1c53f3802d92ee19378663e12` | PR #1 |

The original functional changes were separate: PR #2 changed `index.html` and controller checks; PR #3 changed the two game bundles and runtime checks. Integration routes right-stick movement to the runtime canvas and sends each keyboard transition once through document bubbling to the game's window listeners. Both instrumented controller checks are retained. The launcher restores child keyboard focus when a game loads or receives a trusted canvas click/tap, fixing WASM mouse cancellation leaving focus on the parent Play button. It also provides the native world-backup action missing from these bundled clients; Java/Mineways conversion remains unverified.

**Warning decision, approved October 20, 2026:** stop forcing the phishing and default-username warnings hidden. Startup no longer writes either preference. New profiles use the runtime's normal warning behavior; existing saved preferences, including prior dismissals, remain intact. No preference migration is performed. PR #1's bundled attribution text is preserved.

This is a review candidate, not a production release or hardware acceptance result. Authentication and server routes are unchanged. The backup panel reads existing saves without modifying them; native game imports create a separate restored copy.

## Automated regression checks

Use Python 3 and a Node.js release supporting the bundled WASM-GC module; the complete candidate suite passed with Node.js **24.19.0**:

```sh
node --test tests/*.test.cjs
```

The combined suite contains **120 checks**:

- **26 controller checks:** actual launcher scripts in a VM, with modeled gamepads, iframe reloads, and Window/Document/Canvas event propagation. They cover mappings and deadzones, shared Back/Start, disconnect and handover, sparse gamepad slots, exit/relaunch, focus/visibility cleanup, fresh refocus transitions, stable WindowProxy reloads, and canvas delivery. The first connected gamepad in the browser's list is used, including when earlier slots are empty.
- **20 runtime checks:** the actual bundled native WASM container decoder with mocked host imports, valid decoding and corruption rejection, preserved component hashes, the real TeaVM mobile suspension/resumption lifecycle, the actual WASM host's canvas handlers, and main's two stricter startup guards against saved-setting access and warning-suppression code. The touch checks cover native-tap defaults, retained touch records, movement/cancellation, desktop mouse/wheel mappings, pointer lock, and exact restoration of the original host by reversing its two call removals. The decoder tests model a JSPI-capable host; they do not establish browser JSPI support.
- **4 startup-option checks:** fresh profiles and saved warning preferences in both editions; startup performs no forced preference writes and retains the existing container and world-database options.
- **4 download checks:** controlled links fetch the exact worker response and save its unchanged Blob under the original filename; object-URL cleanup is delayed; uncontrolled/modified clicks stay native; failures use the original link; repeated pending clicks are coalesced and later retries work.
- **7 service-worker checks:** the distribution and its complete local UI dependency graph are precached; installation paths have distinct cache names; activation preserves legacy, foreign-scope and unrelated caches; fetches stay within the current cache; only same-origin GET launcher navigations share the canonical shell; other requests retain exact lookup and network fallback; a missing required asset rejects installation.
- **8 native backup checks:** exact world-prefix selection in a single read-only transaction, copied bytes, every dimension and opaque sidecar, safe representable filenames, no partial result on errors, missing-database abort, blocked-open cleanup, native padding, and independent EPK/NBT verification.
- **25 EPK picker-guard checks:** complete raw/gzip/zlib validation, paths and Java-trim aliases, duplicate files, late corrupt records, limits, selected-filename defaults after the native 32-unit truncation, and actual extracted JS/WASM desktop/mobile file-chooser callbacks. The native read stays blocked until the entire archive validates; unsafe defaults are rejected before any file read. Reselection, pending Done, cancellation/replacement and other picker types are covered. Pending validation cannot replay a callback after its iframe Document is replaced or becomes inaccessible.
- **7 frame lifecycle checks:** delayed deferred scripts install into an already loaded game, the current blank document and later reloads are covered, and a rootless loading document waits for its load, and launches stay disabled until the guard dependency is ready. Native child focus is restored on active game load or a trusted canvas pointer, without focusing background tabs, hidden games, file inputs or replaced documents.
- **17 independent archive-inspection checks:** valid native EPK/vanilla ZIP fixtures, exact member SHA-256 hashes including padding/opaque bytes, big-endian NBT and signed long seeds, block queries, Anvil regions, corrupt/truncated data, unsafe paths and bounded nested decompression. These are format tests; vanilla ZIP support in the inspector does not establish runtime conversion support.
- **2 native import-repair checks:** actual generated-JS suspension/resumption before data-fixer allocation, exact reversal/reapplication of the WASM call and debug correction, frozen component hashes, and native `WebAssembly.validate`. When the recorded Git baseline is available, full EPW replay also reproduces the reviewed output.

These checks do not establish physical-controller, phone, or multiplayer compatibility. Native gameplay acceptance uses the separate browser runner below. The VM model omits browser capture/cancellation details, so loaded-runtime browser checks are also needed for input delivery.

The optional `node tests/browser.integration.cjs` runner requires Playwright, a Chromium browser, and Tesseract for rendered-menu assertions. Set `NEXUS_BROWSER_EXECUTABLE` to use an installed browser; `NEXUS_PLAYWRIGHT_MODULE` can select an existing Playwright module, and `NEXUS_TESSERACT_EXECUTABLE` can select the OCR executable. It serves this checkout on a temporary loopback port, uses fresh browser profiles, and prints the directory containing screenshots, OCR text and JSON results. `NEXUS_BROWSER_OUTPUT` selects that directory. `NEXUS_BROWSER_SCENARIOS` can select comma-separated scenario names, such as `android-wasm-iframe`; `NEXUS_BROWSER_ROOT` can serve a separate distribution for before/after checks. Native tab-focus transitions that headless Chrome cannot produce remain explicitly unavailable.

The retained `checks/controller-runtime-browser.cjs` and `checks/controller-runtime-live.cjs` use `PLAYWRIGHT_MODULE` and `CHROME_PATH`. They exercise extracted native camera consumers and an instrumented JS runtime with simulated controllers and modeled focus/pointer lock. Their results are separate from native-focus browser checks and physical-controller acceptance.

## Browser and device acceptance

Desktop and Android-emulated startup/menu evidence is recorded separately from the Node checks in the integration validation record. Browser automation uses simulated gamepads; trusted emulated touch is not a physical-phone test. The WASM edition requires browser support for JavaScript Promise Integration, including `WebAssembly.Suspending`; the runtime's capability, checksum, and decompression checks remain enabled.

The WASM touch-menu blocker is repaired at the bundled browser-host boundary. That host cancelled canvas touch-start/end while queuing touch events that the compiled game discards. Removing those two cancellations restores the browser's native compatibility mouse path, matching the JS edition. It fabricates no DOM mouse events and retains touch-move cancellation, native touch records and keyboard-zone handling. The separate import-initialization repair below changes one compiled call.

Mobile checks exercise direct and launcher-iframe paths in Android emulation. They require one trusted native mouse down/up/click sequence per tap and assert rendered profile-to-title, Options and Controls transitions with Touchscreen Mode OFF and ON. They also check cancelled touches, drags, multitouch, repeated taps and restoration of the mode setting. These menu checks do not establish touch gameplay or physical-phone compatibility.

Before release, exercise both editions with physical controllers and phones. Hold movement/Jump while disconnecting, leaving fullscreen, switching windows, and hiding the tab; then reconnect, relaunch, and refocus. Confirm no held key survives and new input works. With two controllers connected, disconnect each in turn and confirm handover. Check Back and Start individually and together, inventory, right-stick camera movement, keyboard/mouse play, touch menus, and in-world controls. Verify native backup downloads and restores on those devices too. Java/Mineways conversion and the complete classroom printing workflow remain separate acceptance checks.

## Service-worker precache and updates

The worker precaches sixteen local files: `index.html`, the unchanged manifest, both bundled game files, local utility/font stylesheets and WOFF2 fonts, the backup/EPK-guard scripts and backup stylesheet, the launcher image, and the existing icons. This repairs the inherited missing-`launcher.html` install failure and removes the launcher's Tailwind/Google Fonts network dependency. The captured utility stylesheet keeps the original cascade order and responsive behavior; asset provenance and licenses are in [assets/README.md](assets/README.md).

Cache generation 5 includes the encoded registration path: for example, `nexus-launcher:%2F:v5` and `nexus-launcher:%2Fclassroom%2F:v5`. Root and subdirectory installations can coexist. Activation removes only obsolete numeric generations owned by the current scope. Legacy global v1/v2/v3 caches are deliberately retained because another active installation may still use them; unrelated caches are retained too. Fetches read only the current scope's cache. Increment the generation when changing any precached file.

Same-origin GET navigations to the scope directory or `index.html`, including launch queries, use the canonical cached launcher. Unknown paths, queried runtime URLs, non-navigation requests, other origins and non-GET requests keep exact lookup and the existing network fallback. There is no broad application-shell fallback. The manifest identity, start URL and scope remain unchanged.

Updates retain the browser's normal waiting lifecycle. Existing controlled pages and game iframes keep their current worker until all its clients close; there is no forced takeover, automatic reload, or cache deletion during installation. A failed precache rejects the update and leaves the active worker usable.

The optional `node tests/service-worker.integration.cjs` runner requires Playwright and Chromium, using the same module/browser environment variables as the menu runner. `NEXUS_SW_BROWSER_OUTPUT` selects its evidence directory. It checks all sixteen cached response hashes, root and subdirectory coexistence, offline root/query navigation, exact misses, saved-data sentinels, modeled global v1/v2/v3 and scoped v4 installations, failed-update recovery, and waiting/activation across open pages and an iframe.

Chrome's native download-link requests can bypass the worker. For a controlled launcher, the download buttons fetch the exact runtime URL through the current worker and save its Blob under the existing filename. Uncontrolled pages and modified clicks retain native links; failed fetches fall back to the original download link. Pending repeated clicks are coalesced, and temporary object URLs are released after 60 seconds. Downloaded bytes match the current cached game bundles.

The separate `node tests/pwa.integration.cjs` runner requires Chrome with the CDP PWA domain, Playwright, Sharp and Tesseract. `NEXUS_PWA_OUTPUT` selects its evidence directory. It uses a temporary persistent profile and loopback app identities, installs real root/subdirectory apps through Chrome, then blocks network through a process-wide proxy before a full browser restart. It checks standalone display, local UI assets/fonts, navigation aliases, saved-data sentinels, offline backup empty states, downloads and rendered JS/WASM menus, then uninstalls its test apps. It does not emulate standalone display mode or use the user's browser profile.

These automated checks do not establish the manual install dialog or OS shortcut experience, Safari/iOS or Android installed-app behavior, physical-controller or phone input, multiplayer, Java/Mineways conversion, or a production update. Native desktop gameplay and backup/restore are checked separately below. Those remain separate release checks.

## Saved-world backups and gameplay acceptance

These bundles have native EPK import controls but no working world-export action. Use **Saved Worlds → Back up a world** in the launcher:

1. In the game, choose **Save and Quit to Title**. Exit fullscreen or reopen the launcher, and close other game tabs so they cannot continue saving.
2. Choose the saved world and **Download world (.epk)**. Worlds are listed by their saved folder name, which can differ from a later in-game rename. Keep the downloaded original unchanged.
3. To restore a copy in either edition, choose **Singleplayer → Create New World → Load EPK File**, select the backup, enter a name and continue. Native import chooses a separate folder if the original exists. Keep the original world until the restored copy has been checked.

The launcher reads the shared native IndexedDB filesystem in one read-only transaction. It copies every file under the selected world's exact prefix, including player data, all dimensions, maps, statistics, custom files and compression padding. It excludes global settings and other worlds. Missing/incomplete worlds, unsafe or unrepresentable paths, and size limits produce an error rather than a partial backup. Limits are 8,191 files, 64 MiB per file and 128 MiB of world data. The panel applies to worlds saved at this launcher's browser origin; moving to another site, browser profile or downloaded standalone HTML does not transfer that storage.

The launcher also validates native EPK pickers before the game's importer reads the selected archive. It checks every path and file CRC, complete framing, duplicates and bounded decompression, for raw, gzip and zlib EPKs. It also rejects selected filenames whose native default import name would be blank, padded or unsafe after the game's 32-unit truncation. Invalid archives return no file to the game. Other pickers and valid non-world EPK types keep their native behavior. This blocks archive-controlled traversal and unsafe initial import names at the launcher boundary. Enter a plain restored-world name using letters, numbers and spaces. Later manual edits to the private canvas name field remain governed by the inherited engine validation; separator-only names are a known remaining limitation. Downloaded standalone bundles include the native initialization repair but do not include the launcher's picker guard.

Run `node tests/gameplay.integration.cjs` for the optional desktop acceptance suite. It requires Playwright, Chrome, Sharp, Tesseract and Python 3, using `NEXUS_PLAYWRIGHT_MODULE`, `NEXUS_SHARP_MODULE`, `NEXUS_BROWSER_EXECUTABLE`, `NEXUS_TESSERACT_EXECUTABLE` and `NEXUS_PYTHON_EXECUTABLE` as needed. `NEXUS_GAMEPLAY_OUTPUT` selects evidence; `NEXUS_GAMEPLAY_SCENARIOS=js,wasm` selects editions. Each scenario uses a disposable persistent profile and a local server. It creates a Creative Superflat world, uses trusted native keyboard/mouse input, saves and quits, restarts Chrome cold with network denied and ordinary HTTP cache cleared, and downloads a real backup. It then reopens and restores a separate copy in the opposite edition.

`python3 scripts/inspect-world-export.py FILE.epk` independently checks EPK framing/CRCs and compressed NBT data without extracting or modifying the source. The browser runner uses it to verify the seed, placed/broken blocks, player inventory, movement, camera rotation and jump state. It compares every exported member against the database's original SHA-256 and every native database record before and after backup, and all original-world hashes before and after restoring/playing the copy. Screenshots/OCR establish visible native menus and gameplay; archive inspection establishes durable saved state.

This is bounded automated desktop Creative-world coverage. Survival progression, long sessions, large/modded worlds, every gameplay action, multiplayer, physical controllers/phones, mobile installed-app downloads, and Java/Mineways conversion still require separate verification. Native EPK validity does not establish Java-world or 3D-print compatibility.

## Bundled runtime maintenance

This distribution has no buildable upstream source project. The JS repair adds a `waitForMobileLaunch` suspension point in `DJt`, allowing the existing button callback to remove the prompt and resume the startup thread. Desktop startup remains on its original path.

PR #3 fixes the outer EPW checksum and restores two modified XZ containers to the decoder's CRC32/32 MiB dictionary profile. The later native-tap repair changes only the browser-host component: exactly two `preventDefault()` calls are removed, and that XZ component is recompressed with the same decoder-compatible profile.

Fresh-worker world import previously created data fixers before registering blocks/items, crashing with `Accessed Items before Bootstrap`. Both editions now call the existing idempotent bootstrap before creating data fixers. The JS edit adds a resumable state before the original allocation. The WASM edit inserts one three-byte call before that allocation; only its body/code size fields and one TeaVM debug-address delta change. Reversing these edits recovers the original decompressed code and metadata exactly. All other compiled functions, data segments, customized assets and container padding are preserved. Data fixers still run normally.

The final EPW is **15,060,892 bytes**, with CRC32 **`0x3c545a94`** over bytes after its 16-byte header and SHA-256 `856faef3c5a11fbcf05cfb87fcaf5c92f0776b7200925dd062277621f543d11d`. No validation is bypassed. The integration's warning-script removal changes neither embedded payload.

`python3 scripts/repair-wasm-touch.py` verifies the frozen repaired host in either the historical touch-only payload or the current import-repaired payload. `--apply` reproduces the historical touch repair from its exact reviewed input; `--file PATH` selects a separate copy.

`python3 scripts/repair-native-import.py` verifies the current native import repair. `--apply --root PATH` reproduces it from the exact touch-repaired baseline `68d6706`. It checks the generated JS state, WASM types/functions and every original debug event, and pins the complete output hash. It rejects optimized Python execution and writes files by atomic replacement. The current compressor reproduces the reviewed new payload; restoring the original compressed XZ bytes requires the retained Git baseline. Both scripts preserve opaque padding, recompute required offsets/lengths/checksums, and refuse unexpected distributions or compressor results. Never run either against an active deployment.

When intentionally changing payload contents, regenerate the affected XZ checks, EPW offsets/lengths, and outer CRC32. Independently compare decoded content before updating preservation hashes. Keep the native corruption-rejection check and browser startup checks in place.
