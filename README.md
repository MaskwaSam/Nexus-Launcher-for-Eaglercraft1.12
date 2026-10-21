This site is a Progressive Web App (PWA) designed to launch and run Eaglercraft 1.12 directly in your browser. The launcher allows you to choose between two runtime versions: the JavaScript (JS) build or the WebAssembly Garbage-Collected (WASM-GC) build, giving users flexibility depending on their browser and device performance.

Scoped review fixes (2026-10-20)
- Controller camera movement now targets the iframe canvas, matching both bundled editions. Existing keyboard mappings and focus/disconnect cleanup are retained.
- Both first launch-option scripts match upstream main `958d9128d653db1b08e78be4c2ec6d07c6b798a0`; the added code that forced phishing/default-username warnings off has been removed. No saved options or worlds are rewritten. Existing user preferences, including previously saved warning dismissals, remain in storage.
- The JavaScript mobile suspension fix and the entire repaired WASM EPW are retained byte for byte after the first script. Main and PR3 decoded WASM executable/glue are identical; no compiled warning-default changes needed reversal. Customized assets and CRC validation remain intact.
- The service-worker cache is `nexus-launcher-v2`, precaches the real `index.html`, and expires only older Nexus launcher caches. World databases and other cache namespaces are untouched.
- About now recommends copy-first, version-preserving export checks. EPK extraction is not asserted to produce a compatible 1.12.2 Java world; end-to-end conversion has not been tested. Sources: [Eagler Binary Tools](https://github.com/lax1dude/eagler-binary-tools), [Mineways quick start](https://www.realtimerendering.com/erich/minecraft/public/mineways/downloads.html), and [Mineways documentation](https://www.realtimerendering.com/erich/minecraft/public/mineways/mineways.html).

Validation: `node --test tests/*.test.cjs` passes 41 checks (25 controller, 13 runtime, 2 warning/storage guards, 1 service-worker cache guard). `node checks/controller-runtime-browser.cjs` uses Playwright/Chrome to execute the actual JS camera accumulator and decoded WASM canvas callback with a simulated gamepad. It checks delivery, iframe/root focus suppression and recovery, and a temporarily absent canvas. Install/provide Playwright via `PLAYWRIGHT_MODULE` and optionally set `CHROME_PATH`. This is handler-level browser evidence, not a physical controller, phone, world conversion, gameplay, deployment, or release acceptance test.

`node checks/controller-runtime-live.cjs` also boots the full JS bundle in a local iframe, waits for its actual canvas listener registration, and verifies a live camera-accumulator delta of `[10, 5]` from the launcher. It exposes the accumulator and models pointer lock through test instrumentation; this does not establish rendered gameplay or real pointer-lock/controller behavior. The full WASM runtime has not been launched by this scoped check.

Runtime regression checks
Run `node --test tests/*.test.cjs` with Node.js 18 or newer. Runtime checks execute the bundled native WASM EPW decoder with mocked host imports (including a JSPI-capable host), verify integrity and component preservation, and exercise the bundled JavaScript mobile prompt with its real TeaVM thread suspension/resumption code and mocked DOM/display functions. These are not browser, phone or gameplay tests.

The distribution has no buildable upstream source project. The JS mobile startup repair adds a suspension point in `DJt` (`waitForMobileLaunch`) so its existing launch button can remove the prompt and resume the startup thread. The WASM repair fixes the EPW checksum and restores the modified XZ containers to the bundled decoder's CRC32/32 MiB dictionary profile. Compressed LZMA2 bitstreams and uncompressed component bytes are preserved, including customized assets; no loader validation is bypassed. When intentionally changing the WASM payload, regenerate XZ checks, EPW offsets/lengths and the EPW CRC32 over bytes after the 16-byte header, and update the component-preservation hashes in the runtime test.

Browser validation still needs desktop launches for both editions, a mobile launch-button tap (both direct bundle and launcher iframe), and touch-control recovery. Physical controllers and phones must be tested separately before release.
The WASM-GC edition also requires browser JSPI support (`WebAssembly.Suspending`); Chrome 137 may require enabling JavaScript Promise Integration in its browser flags before restarting. Enabling a browser capability is not a checksum or decompression workaround.

What the Launcher Does
The PWA acts as a lightweight launcher for Eaglercraft 1.12. Instead of installing a traditional game client, the site loads the game directly in your browser and manages the runtime environment. With a single interface, you can:
Launch Eaglercraft 1.12 instantly
Switch between JS and WASM-GC engine builds
Connect to multiplayer servers
Run the game fullscreen like a native app
What a PWA Is
A Progressive Web App (PWA) is a website that behaves like a native application. When installed, it can run independently from the browser in its own window and provides features similar to desktop or mobile apps.
Key characteristics include:
Installable – Add it to your desktop or home screen without downloading a traditional program
Offline caching – Game assets and launcher files can be stored locally for faster startup
App-like interface – Runs without browser UI for a more immersive experience
Automatic updates – The launcher updates itself when new versions are available
How the PWA Optimizes Gameplay
Using PWA technology improves the Eaglercraft experience in several ways:
1. Faster Loading
Service workers cache essential game files locally, reducing loading times after the first launch.
2. Reduced Network Overhead
Assets such as textures, scripts, and UI components can be stored offline, meaning the launcher doesn't need to download everything each time.
3. Native-like Performance
Running as a standalone app eliminates browser UI overhead and allows the game to operate closer to a desktop application environment.
4. Engine Choice for Performance
JS Version: Maximum compatibility with older browsers and devices.
WASM-GC Version: Uses WebAssembly with garbage collection for improved performance and more efficient memory management on modern browsers.
5. Seamless Updates
The PWA automatically updates cached files when new builds of Eaglercraft or the launcher become available, keeping gameplay smooth without manual downloads.
Summary
The Eaglercraft 1.12 PWA Launcher provides a fast, installable, browser-based game client that combines the convenience of a website with the performance of a native application. By leveraging modern web technologies like service workers, caching, and WebAssembly, it delivers a smoother and more reliable way to play Eaglercraft directly from your browser.

Controller regression checks
Run `node --test tests/controller.test.cjs` with Node.js 18 or newer. These checks execute the launcher's inline scripts with mocked gamepad and iframe events, without loading either game bundle. They cover shared Back/Start input, key cleanup on disconnect, game exit, window/iframe focus loss and page hiding, reconnect/relaunch/refocus, nonzero gamepad slots, handover when another controller remains connected, and the existing input mappings. The launcher uses the first connected controller in the browser's gamepad list, including when earlier slots are empty. Controller input is suspended while the page is hidden or unfocused and resumes with fresh key transitions when focus returns.

Before releasing, also test a physical controller in both game editions: hold movement or Jump while disconnecting and while leaving fullscreen, then reconnect or relaunch; verify no key stays held and new input works. With two controllers connected, disconnect each in turn and verify the remaining controller works. Check Back and Start individually and together, plus the launcher on a mobile browser. The Node checks do not verify hardware or mobile browser behavior.
