import assert from 'node:assert/strict';
import * as DB from './db.js';
import { buildRecord, normalizeConfig } from './core.js';

let passed = 0;
const t = async (name, fn) => {
  await fn();
  passed++;
  console.log('ok  ' + name);
};

const cfg = normalizeConfig({ ops: ['a', 'm'], dur: 30 });
const mkRound = (i) =>
  buildRecord({
    cfg,
    mode: 'n',
    log: Array.from({ length: 10 + i }, (_, j) => ({ op: 'a', bucket: 'No carry', time: 1500, wrong: 0, at: (j + 1) * 2000, x: 1, y: 1 })),
    elapsed: 30,
    completed: true,
    ts: 1700000000000 + i * 60000,
  });

await t('falls back to memory without IndexedDB and says so', async () => {
  await DB.getAllRounds();
  assert.equal(DB.storageState.mode, 'memory');
  assert.ok(DB.storageState.error);
});

await t('store and read rounds, sorted by time', async () => {
  const r = [mkRound(2), mkRound(0), mkRound(1)];
  assert.equal(await DB.putRounds(r), false); // not durable in memory mode
  const all = await DB.getAllRounds();
  assert.deepEqual(all.map((x) => x.ts), all.map((x) => x.ts).slice().sort((a, b) => a - b));
  assert.equal(all.length, 3);
});

await t('backup round trip: merge never duplicates', async () => {
  const text = await DB.backupText();
  const parsed = DB.parseBackup(text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rounds.length, 3);
  const res = await DB.applyBackup(parsed, 'merge');
  assert.equal(res.added, 0);
  assert.equal((await DB.getAllRounds()).length, 3);
});

await t('replace swaps data', async () => {
  const extra = DB.parseBackup(JSON.stringify({ app: 'flashquant', rounds: [mkRound(5)], facts: {} }));
  const res = await DB.applyBackup(extra, 'replace');
  assert.equal(res.added, 1);
  assert.equal((await DB.getAllRounds()).length, 1);
});

await t('rejects junk before touching data', async () => {
  const before = (await DB.getAllRounds()).length;
  for (const bad of ['', '{}', '[]', 'not json', '{"app":"flashquant","rounds":[]}', '{"app":"flashquant","rounds":[{"x":1}]}', 'null']) {
    assert.equal(DB.parseBackup(bad).ok, false, bad);
  }
  assert.equal(DB.parseBackup('x'.repeat(26000000)).ok, false);
  assert.equal((await DB.getAllRounds()).length, before);
});

await t('imported strings cannot carry HTML', async () => {
  const r = mkRound(9);
  r.label = '<img src=x onerror=alert(1)>';
  r.fp = '"><script>alert(1)</script>';
  r.id = '<b>id</b>';
  const p = DB.parseBackup(JSON.stringify({ app: 'flashquant', rounds: [r] }));
  assert.equal(p.ok, true);
  const s = JSON.stringify(p.rounds[0]);
  assert.ok(!/[<>]/.test(s), s);
});

await t('earlier-version (v1) backup is understood', async () => {
  const old = { h: [{ ts: 1700000000000, mode: 'n', dur: 60, score: 30, ops: { a: 1200 }, types: { 'a|Carry': [4, 1200, 1] } }], p: { '7 × 8': [3, 9000, 1, 'm', 7, 8] }, e: {} };
  const p = DB.parseBackup(JSON.stringify(old));
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'earlier version');
  assert.deepEqual(p.facts['7_8'], [3, 9000, 1]);
});

await t('facts sanitised', async () => {
  const f = DB.sanitizeFacts({ '7_8': [1, 2, 3], '<x>': [1, 1, 1], '3_4': ['a', -5, 'z'] });
  assert.deepEqual(Object.keys(f).sort(), ['3_4', '7_8']);
  assert.deepEqual(f['3_4'], [0, 0, 0]);
});

await t('filters and prefs are cleaned', async () => {
  const f = DB.cleanFilters({ range: 'evil', mode: 'k', dur: 99, ops: 'a<b>', fp: '<x>' });
  assert.deepEqual(f, { range: 'all', mode: 'k', dur: 'all', ops: 'all', fp: 'all' });
});

await t('clearAll empties everything', async () => {
  await DB.clearAll();
  assert.equal((await DB.getAllRounds()).length, 0);
  assert.deepEqual(await DB.getFacts(), {});
});

console.log(`\n${passed} storage test groups passed`);
