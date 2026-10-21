/* Launcher frame setup and read-only native world backup UI. */
(function () {
    'use strict';
    const frame = document.getElementById('game-frame');
    const preparedDocuments = new WeakSet();
    function focusGameDocument(doc) {
        // Native WASM mouse handlers cancel defaults. A click can otherwise
        // leave keyboard focus on the launcher's Play button. Never activate a
        // background tab or a hidden/replaced game document.
        if (frame?.style.display !== 'block' || frame.contentDocument !== doc || !document.hasFocus()) return;
        if (!doc.hasFocus()) frame.contentWindow.focus();
    }
    function prepareImports() {
        // A cached game may finish loading before these deferred scripts run.
        // Install on the current document as well as every later navigation.
        try {
            const doc = frame?.contentDocument;
            if (!doc?.documentElement) return;
            window.EpkImportGuard.install(frame.contentWindow);
            if (!preparedDocuments.has(doc)) {
                doc.addEventListener('pointerdown', event => {
                    if (event.isTrusted && event.target?.tagName === 'CANVAS') focusGameDocument(doc);
                }, true);
                preparedDocuments.add(doc);
            }
            focusGameDocument(doc);
        } catch (error) { console.error('Could not prepare EPK import validation:', error); }
    }
    const launcherStatus = document.getElementById('launcher-ready-status');
    if (typeof window.EpkImportGuard?.install === 'function') {
        frame?.addEventListener('load', prepareImports);
        prepareImports();
        // Launches wait until both current/future documents are covered, even
        // when an earlier deferred dependency is delayed on the first visit.
        for (const id of ['btn-js', 'btn-wasm']) {
            const button = document.getElementById(id);
            if (button) button.disabled = false;
        }
        if (launcherStatus) launcherStatus.hidden = true;
    } else if (launcherStatus) {
        launcherStatus.textContent = 'The launcher could not load. Reload to try again.';
    }
    const api = window.NexusWorldBackups;
    const open = document.getElementById('btn-world-backups');
    const dialog = document.getElementById('world-backups-dialog');
    if (!api || !open || !dialog) return;
    const select = document.getElementById('world-backups-world');
    const download = document.getElementById('world-backups-download');
    const close = document.getElementById('world-backups-close');
    const status = document.getElementById('world-backups-status');
    let session = 0, busy = false;
    function gameOpen() { return document.getElementById('game-frame')?.style.display === 'block'; }
    function message(text) { status.textContent = text; }
    function ready() {
        select.disabled = busy || select.options.length === 0;
        download.disabled = select.disabled || gameOpen();
    }
    open.disabled = false;
    open.addEventListener('click', async () => {
        const request = ++session;
        busy = true;
        select.replaceChildren();
        ready();
        message('Looking for saved worlds…');
        dialog.showModal();
        if (gameOpen()) {
            busy = false;
            message('Save and Quit to Title, then return to the launcher before making a backup.');
            return;
        }
        try {
            const worlds = await api.listWorlds();
            if (request !== session) return;
            for (const world of worlds) {
                const option = document.createElement('option');
                option.value = world.id;
                option.textContent = world.name;
                select.appendChild(option);
            }
            message(worlds.length ? 'Choose a saved world to download. Your saved world will stay here.' : 'No saved worlds yet. Create one in either edition and Save and Quit to Title.');
        } catch (error) {
            if (request !== session) return;
            message(error.message === 'No saved-world database exists yet'
                ? 'No saved worlds yet. Create one in either edition and Save and Quit to Title.'
                : error.message);
        } finally {
            if (request === session) { busy = false; ready(); }
        }
    });
    download.addEventListener('click', async () => {
        if (busy || !select.value || gameOpen()) return;
        const request = session;
        busy = true;
        ready();
        message('Preparing your world backup…');
        try {
            const snapshot = await api.snapshotWorld(select.value);
            if (request !== session || !dialog.open || gameOpen()) return;
            const backup = api.encodeEpk(snapshot);
            const url = URL.createObjectURL(backup.blob);
            try {
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = backup.filename;
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
            } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
            message('Backup download started. Keep the .epk file in a safe place.');
        } catch (error) {
            if (request === session) message(error.message + ' Your saved world was not changed.');
        } finally {
            if (request === session) { busy = false; ready(); }
        }
    });
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { session++; busy = false; open.focus(); });
}());
