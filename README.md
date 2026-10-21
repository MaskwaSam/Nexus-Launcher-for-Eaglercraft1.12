# Patterson Classroom Launcher for Eaglercraft 1.12

A browser launcher with local JavaScript and WebAssembly Garbage-Collected (WASM-GC) editions, fullscreen play, optional downloadable HTML bundles, controller mappings, and classroom world-export guidance. The About page retains the existing classroom instructions. World export, multiplayer, and gameplay have not been verified for this integration candidate.

## Integration candidate

This isolated candidate combines three open draft PRs. PRs #2 and #3 are sibling changes based on PR #1, so both must be integrated to obtain both repairs.

| Source | Pinned head | Target |
| --- | --- | --- |
| [PR #1: classroom baseline](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/1) | `c98ff7962068ceaa17b86c824a4ae585e8a756c7` | `main` at `958d9128d653db1b08e78be4c2ec6d07c6b798a0` |
| [PR #2: controller focus recovery](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/2) | `52afc7b23d87b4bc2a738904328c1c596e4eef80` | PR #1 |
| [PR #3: bundled runtime repair](https://github.com/MaskwaSam/Nexus-Launcher-for-Eaglercraft1.12/pull/3) | `aa204954f2b829a1c53f3802d92ee19378663e12` | PR #1 |

The functional changes are separate: PR #2 changes `index.html` and controller checks; PR #3 changes the two game bundles and runtime checks. This README reconciles their overlapping documentation. Integration also routes right-stick movement to the runtime canvas and sends each keyboard transition once through document bubbling to the game's window listeners.

**Warning decision, approved October 20, 2026:** stop forcing the phishing and default-username warnings hidden. Startup no longer writes either preference. New profiles use the runtime's normal warning behavior; existing saved preferences, including prior dismissals, remain intact. No preference migration is performed. PR #1's bundled attribution text is preserved.

This is a review candidate, not a production release or hardware acceptance result. No source PR is merged by creating this branch. Authentication, server routes, the service worker, and existing saves are outside the integration changes.

## Automated regression checks

Run with Node.js 18 or newer; this candidate was exercised with Node.js **26.5.1**:

```sh
node --test tests/*.test.cjs
```

The combined suite contains **43 checks**:

- **26 controller checks:** actual launcher scripts in a VM, with modeled gamepads, iframe reloads, and Window/Document/Canvas event propagation. They cover mappings and deadzones, shared Back/Start, disconnect and handover, sparse gamepad slots, exit/relaunch, focus/visibility cleanup, fresh refocus transitions, stable WindowProxy reloads, and canvas delivery. The first connected gamepad in the browser's list is used, including when earlier slots are empty.
- **13 runtime checks:** the actual bundled native WASM container decoder with mocked host imports, valid decoding and corruption rejection, preserved component hashes, and the real TeaVM mobile suspension/resumption lifecycle with mocked DOM/display functions. The decoder tests model a JSPI-capable host; they do not establish browser JSPI support.
- **4 startup-option checks:** fresh profiles and saved warning preferences in both editions; startup performs no forced preference writes and retains the existing container and world-database options.

These checks do not establish physical-controller, phone, gameplay, or multiplayer compatibility. The VM model omits browser capture/cancellation details, so loaded-runtime browser checks are also needed for input delivery.

The optional `node tests/browser.integration.cjs` runner requires Playwright and a Chromium browser. Set `NEXUS_BROWSER_EXECUTABLE` to use an installed browser; `NEXUS_PLAYWRIGHT_MODULE` can select an existing Playwright module. It serves this checkout on a temporary loopback port, uses fresh browser profiles, and prints the directory containing its screenshots and JSON results. `NEXUS_BROWSER_OUTPUT` can select that directory. It records unavailable native tab-focus transitions separately; mobile canvas startup checks still require visual review of the touch-menu screenshots.

## Browser and device acceptance

Desktop and Android-emulated startup/menu evidence is recorded separately from the Node checks in the integration validation record. Browser automation uses simulated gamepads; trusted emulated touch is not a physical-phone test. The WASM edition requires browser support for JavaScript Promise Integration, including `WebAssembly.Suspending`; the runtime's capability, checksum, and decompression checks remain enabled.

The known WASM touch-menu failure from PR #3 remains a release acceptance concern. Reaching Edit Profile after the mobile launch prompt does not establish working touch menus or gameplay. Do not treat mouse success in a mobile context as touch success.

Before release, exercise both editions with physical controllers and phones. Hold movement/Jump while disconnecting, leaving fullscreen, switching windows, and hiding the tab; then reconnect, relaunch, and refocus. Confirm no held key survives and new input works. With two controllers connected, disconnect each in turn and confirm handover. Check Back and Start individually and together, inventory, right-stick camera movement, keyboard/mouse play, touch menus, and in-world controls. Verify saved worlds and the classroom world-export workflow independently.

## Existing PWA cache limitation

The unchanged `sw.js` precaches `./launcher.html`, but this distribution contains `index.html` instead. A fresh install therefore requests a missing file and cannot finish its precache. This is inherited from `main`, not introduced by combining these PRs. Offline installation/update behavior is not accepted for this candidate. Any later deployment must also verify that installed clients receive compatible launcher and runtime versions rather than stale cached files.

## Bundled runtime maintenance

This distribution has no buildable upstream source project. The JS repair adds a `waitForMobileLaunch` suspension point in `DJt`, allowing the existing button callback to remove the prompt and resume the startup thread. Desktop startup remains on its original path.

The WASM repair fixes the outer EPW checksum and restores two modified XZ containers to the bundled decoder's CRC32/32 MiB dictionary profile. Compressed LZMA2 bitstreams and decoded component bytes are preserved, including customized assets. The final EPW is **15,067,956 bytes**, with CRC32 **`0x8ed16493`** over bytes after its 16-byte header. No validation is bypassed. The integration's warning-script removal changes neither embedded payload.

When intentionally changing payload contents, regenerate the affected XZ checks, EPW offsets/lengths, and outer CRC32. Independently compare decoded content before updating preservation hashes. Keep the native corruption-rejection check and browser startup checks in place.
