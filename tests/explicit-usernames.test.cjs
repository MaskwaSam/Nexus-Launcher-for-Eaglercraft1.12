'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const html = fs.readFileSync(path.join(__dirname, '..', 'gamefile.html'), 'utf8');
const java = s => ({ iJ: { data: Array.from(s, c => c.charCodeAt(0)) } });
const text = s => String.fromCharCode(...s.iJ.data);
function extract(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  return html.slice(start, html.indexOf('\nfunction ', start + 1));
}
function context() {
  const c = {
    Bg: s => s.iJ.data.length, Bn: (s, i) => s.iJ.data[i], $rt_str: java,
    FZ: () => false, B: () => false, Is() {}, HGS: { h: 0 },
    HGF: 0, HGG: -1, HGE: java(''), writes: 0, saves: 0, navigations: 0,
    F3Q(s) { c.HGE = s; c.writes++; }, DU3() { c.saves++; },
    GGM() { c.navigations++; }, FV() { throw Error('Unexpected state'); },
  };
  vm.createContext(c);
  for (const name of ['nexusExplicitNameValid', 'nexusProfileDoneState', 'DZW', 'E_$']) {
    vm.runInContext(extract(name), c);
  }
  return c;
}

test('explicit ASCII names accept underscores and reject invalid lengths/characters', () => {
  const c = context();
  for (const s of ['Sam', 'AB_CD', '_12', 'ABCDEFGHIJKLMNOP']) assert.equal(c.nexusExplicitNameValid(java(s)), 1, s);
  for (const s of ['', 'ab', 'ABCDEFGHIJKLMNOPQ', '!!!', ' A_', 'AB-CD', 'AB.CD', 'éab', '😀abc']) {
    assert.equal(c.nexusExplicitNameValid(java(s)), 0, s);
  }
  assert.equal(c.nexusExplicitNameValid(null), 0);
});

test('actual initializer creates a blank name and retains the random skin choice', () => {
  const c = context();
  Object.assign(c, {
    J() {}, Bb: function () {}, Fh: function () {}, C: n => n, Gqp() {},
    Rt() { c.HGX = {}; }, E2: () => ({ h: 0 }), EZo() {},
    Nj() { c.HGW = { data: [{ ND: { zW: null } }] }; }, randomCalls: 0,
    H(_random, bound) { c.randomCalls++; assert.equal(bound, 1); return 0; },
    GKh() { throw Error('Random username formatting must never run'); },
  });
  vm.runInContext(extract('Etv'), c);
  c.Etv();
  assert.equal(text(c.HGE), '');
  assert.equal(c.randomCalls, 1);
  assert.equal(c.HGF, 0);
  assert.equal(c.HGG, -1);
});

test('actual safeProfile preserves existing names for invalid text while saving skin selection', () => {
  const c = context();
  for (const existing of ['', 'Saved_Name', 'x', 'legacy-name']) {
    c.HGE = java(existing);
    c.writes = 0;
    c.HGS = { h: 2 };
    c.DZW({ kp: 1, X$: { cA: java('!!!') } });
    assert.equal(text(c.HGE), existing);
    assert.equal(c.writes, 0);
    assert.equal(c.HGF, -1);
    assert.equal(c.HGG, 1);
  }
  c.DZW({ kp: 3, X$: { cA: java('AB_CD') } });
  assert.equal(text(c.HGE), 'AB_CD');
  assert.equal(c.HGF, 1);
  assert.equal(c.HGG, -1);
  assert.equal(c.writes, 1);
});

test('actual profile init/keyTyped keep Done disabled for raw invalid text and guard saves/navigation', () => {
  const c = context();
  Object.assign(c, {
    C: n => n, D: {}, Ge: function () {}, B3: function () {},
    G: (_type, length) => ({ data: new Array(length) }), GWv: label => label,
    F0n() {}, D8z(field, focused) { field.focused = focused; },
    EFd: () => c.HGE, Dww(field, value) { field.cA = value; },
    Ks(field, max) { field.max = max; },
    B4S(button, id) { button.bF = id; button.bT = 1; },
    Bra(button, id) { button.bF = id; button.bT = 1; },
    Y(list, button) { list.qP.data.push(button); list.h++; }, Er2() {},
    Gtq(field, char, key) {
      const next = key === 14 ? text(field.cA).slice(0, -1) : (text(field.cA) + char).slice(0, field.max);
      field.cA = java(next);
    },
  });
  vm.runInContext(extract('E_C'), c);
  vm.runInContext(extract('FFd'), c);
  const a = { r: 640, L: 480, J: {}, be: { h: 0, qP: { data: [] } }, rw: 0,
    j: { F: { bRa: 1 } }, caE: {}, kp: 0, sG: { data: [] } };
  c.E_C(a);
  assert.equal(text(a.X$.cA), '');
  assert.equal(a.X$.focused, 1);
  assert.equal(a.X$.max, 16);
  assert.equal(a.be.qP.data[0].bT, 0);
  for (const char of '!!!') c.FFd(a, char, 0);
  assert.equal(text(a.X$.cA), '!!!');
  assert.equal(a.be.qP.data[0].bT, 0);
  c.E_$(a, a.be.qP.data[0]);
  assert.equal(c.saves, 0); assert.equal(c.navigations, 0); assert.equal(c.writes, 0);
  for (let i = 0; i < 3; i++) c.FFd(a, '', 14);
  for (const char of 'AB_CD') c.FFd(a, char, 0);
  assert.equal(text(a.X$.cA), 'AB_CD');
  assert.equal(a.be.qP.data[0].bT, 1);
  c.E_$(a, a.be.qP.data[0]);
  assert.equal(text(c.HGE), 'AB_CD');
  assert.equal(c.saves, 1); assert.equal(c.navigations, 1);
});

test('native edit and debug deltas reverse/replay exactly and validate', { timeout: 180000 }, () => {
  execFileSync(process.env.NEXUS_PYTHON_EXECUTABLE || 'python3', [
    '-B', path.join(__dirname, 'explicit-usernames-proof.py'),
  ], { cwd: path.join(__dirname, '..'), stdio: 'pipe', timeout: 170000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', NEXUS_NODE_EXECUTABLE: process.execPath },
  });
});
