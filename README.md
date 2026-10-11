This site is a Progressive Web App (PWA) designed to launch and run Eaglercraft 1.12 directly in your browser. The launcher allows you to choose between two runtime versions: the JavaScript (JS) build or the WebAssembly Garbage-Collected (WASM-GC) build, giving users flexibility depending on their browser and device performance.
\n+Runtime regression checks
Run `node --test tests/*.test.cjs` with Node.js 18 or newer. Runtime checks verify the embedded WASM EPW checksum and exercise the bundled JavaScript mobile prompt with its real TeaVM thread suspension/resumption code and mocked DOM/display functions. These are not browser, phone or gameplay tests.

The distribution has no buildable upstream source project. The JS mobile startup repair adds a suspension point in `DJt` (`waitForMobileLaunch`) so its existing launch button can remove the prompt and resume the startup thread. The WASM repair updates only the EPW header checksum; the customized payload and checksum validator are preserved. When intentionally changing the WASM payload, regenerate its CRC32 over bytes after the 16-byte header and update the payload-preservation hash in the runtime test.

Browser validation still needs desktop launches for both editions, a mobile launch-button tap (both direct bundle and launcher iframe), and touch-control recovery. Physical controllers and phones must be tested separately before release.

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
Run `node --test tests/controller.test.cjs` with Node.js 18 or newer. These checks execute the launcher's inline scripts with mocked gamepad and iframe events, without loading either game bundle. They cover shared Back/Start input, key cleanup on disconnect and game exit, reconnect/relaunch, nonzero gamepad slots, handover when another controller remains connected, and the existing input mappings. The launcher uses the first connected controller in the browser's gamepad list, including when earlier slots are empty.

Before releasing, also test a physical controller in both game editions: hold movement or Jump while disconnecting and while leaving fullscreen, then reconnect or relaunch; verify no key stays held and new input works. With two controllers connected, disconnect each in turn and verify the remaining controller works. Check Back and Start individually and together, plus the launcher on a mobile browser. The Node checks do not verify hardware or mobile browser behavior.
