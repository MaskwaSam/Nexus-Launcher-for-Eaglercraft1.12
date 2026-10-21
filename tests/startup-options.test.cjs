const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const file of ['gamefile.html', 'gamefilebetter.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const source = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/i)[1];

    for (const saved of [null, Buffer.from('version:1343\nhasHiddenPhishWarning:false\nhideDefaultUsernameWarning:false\nsound:0.4\n').toString('base64')]) {
        test(`${file} preserves ${saved === null ? 'fresh-profile defaults' : 'saved warning preferences and unrelated settings'}`, () => {
            const storage = new Map(saved === null ? [] : [['_eaglercraft_1.12.g', saved]]);
            const writes = [];
            const window = { localStorage: {
                getItem: (key) => storage.get(key) ?? null,
                setItem: (key, value) => { writes.push(key); storage.set(key, value); }
            } };
            vm.runInNewContext(source, {
                window,
                atob: (value) => Buffer.from(value, 'base64').toString('binary'),
                btoa: (value) => Buffer.from(value, 'binary').toString('base64')
            });
            assert.deepEqual(writes, [], 'startup must leave warning choices to the runtime/user');
            assert.equal(storage.get('_eaglercraft_1.12.g') ?? null, saved);
            assert.equal(window.eaglercraftXOpts.container, 'game_frame');
            assert.equal(window.eaglercraftXOpts.worldsDB, 'worlds');
        });
    }
}
