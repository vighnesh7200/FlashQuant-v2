import assert from 'node:assert/strict';
import { planSync, mergeBaseFacts, friendlyError, isEmail, createSync } from './sync.js';
import { buildRecord, normalizeConfig, factsOf } from './core.js';

let passed = 0;
const t = async (name, fn) => { await fn(); passed++; console.log('ok  ' + name); };

// In-memory stand-in for the Supabase client. Data is scoped to the signed-in user, like row-level security.
function fakeServer() {
  const db = { rounds: new Map(), facts: new Map() }; // key: userId|id
  const calls = [];
  const clientFor = (getUser, opts = {}) => ({
    auth: { getSession: async () => ({ data: { session: getUser() ? { user: getUser() } : null } }) },
    from(table) {
      const q = { table, op: 'select', filters: [], rows: null, o: null, range: null, single: false };
      const run = () => {
        calls.push(table + ':' + q.op);
        if (opts.fail) return { data: null, error: new Error(opts.fail) };
        const u = getUser();
        if (!u) return { data: null, error: { code: '401', message: 'JWT expired' } };
        const store = db[table];
        const mine = [...store.entries()].filter(([k]) => k.startsWith(u.id + '|')).map(([, v]) => v);
        if (q.op === 'select') {
          let rows = mine.slice();
          q.filters.forEach(([kind, col, val]) => {
            if (kind === 'in') rows = rows.filter((r) => val.includes(r[col]));
          });
          if (q.o) rows.sort((a, b) => (a[q.o] < b[q.o] ? -1 : 1));
          if (q.range) rows = rows.slice(q.range[0], q.range[1] + 1);
          if (q.cols && q.cols !== '*') rows = rows.map((r) => Object.fromEntries(q.cols.split(',').map((c) => [c, r[c]])));
          return { data: q.single ? rows[0] || null : rows, error: null };
        }
        if (q.op === 'upsert') {
          q.rows.forEach((r) => {
            const key = u.id + '|' + (table === 'rounds' ? r.id : 'facts');
            if (store.has(key) && q.opts.ignoreDuplicates) return;
            store.set(key, { ...r, user_id: u.id });
          });
          return { data: null, error: null };
        }
        if (q.op === 'delete') {
          if (!q.filters.length) return { data: null, error: { message: 'DELETE requires a WHERE clause' } };
          [...store.keys()].filter((k) => k.startsWith(u.id + '|')).forEach((k) => {
            const row = store.get(k);
            const hit = q.filters.every(([kind, col, val]) => (kind === 'eq' ? row[col] === val : kind === 'gte' ? row[col] >= val : kind === 'neq' ? row[col] !== val : true));
            if (hit) store.delete(k);
          });
          return { data: null, error: null };
        }
        return { data: null, error: new Error('unsupported') };
      };
      const b = {
        select(cols) { q.cols = cols; return b; },
        order(c) { q.o = c; return b; },
        range(a, z) { q.range = [a, z]; return b; },
        in(c, v) { q.filters.push(['in', c, v]); return b; },
        eq(c, v) { q.filters.push(['eq', c, v]); return b; },
        gte(c, v) { q.filters.push(['gte', c, v]); return b; },
        neq(c, v) { q.filters.push(['neq', c, v]); return b; },
        upsert(rows, o) { q.op = 'upsert'; q.rows = Array.isArray(rows) ? rows : [rows]; q.opts = o || {}; return b; },
        delete() { q.op = 'delete'; return b; },
        maybeSingle() { q.single = true; return b; },
        then(res, rej) { return Promise.resolve(run()).then(res, rej); },
      };
      return b;
    },
  });
  return { db, calls, clientFor };
}

function device(server, user, opts = {}) {
  const st = { rounds: new Map(), base: {}, owner: null, status: [] };
  const sync = createSync({
    client: server.clientFor(() => user.v, opts),
    getRounds: async () => [...st.rounds.values()],
    putRounds: async (l) => l.forEach((r) => st.rounds.set(r.id, r)),
    getBase: async () => st.base,
    setBase: async (f) => { st.base = f; },
    getOwner: async () => st.owner,
    setOwner: async (id) => { st.owner = id; },
    onStatus: (s) => st.status.push(s),
  });
  return { st, sync };
}

const cfg = normalizeConfig({ ops: ['m'], m: [2, 12, 2, 12], dur: 30 });
const round = (i, x = 7, y = 8) => buildRecord({ cfg, mode: 'n', elapsed: 30, completed: true, ts: 1700000000000 + i * 60000, log: [{ op: 'm', bucket: 'Product under 100', time: 2000, wrong: 0, at: 1000, x, y, errs: [] }] });
const A = { id: 'user-a', email: 'a@x.com' };
const B = { id: 'user-b', email: 'b@x.com' };

await t('planSync finds what to push and pull', () => {
  const p = planSync(['a', 'b', 'c'], ['b', 'c', 'd']);
  assert.deepEqual(p, { push: ['a'], pull: ['d'] });
});

await t('first sign-in uploads everything already on this device', async () => {
  const s = fakeServer(); const me = { v: A };
  const d = device(s, me);
  for (let i = 0; i < 5; i++) d.st.rounds.set(round(i).id, round(i));
  d.st.base = { '7_8': [4, 9000, 1] };
  const r = await d.sync.sync();
  assert.equal(r.pushed, 5);
  assert.equal(r.pulled, 0);
  assert.equal(s.db.rounds.size, 5);
  assert.equal(d.st.owner, 'user-a');
  assert.deepEqual([...s.db.facts.values()][0].data, { '7_8': [4, 9000, 1] });
});

await t('a second device resumes with all stats, including heatmap facts', async () => {
  const s = fakeServer(); const me = { v: A };
  const d1 = device(s, me);
  const made = [round(0), round(1, 6, 9), round(2)];
  made.forEach((r) => d1.st.rounds.set(r.id, r));
  await d1.sync.sync();
  const d2 = device(s, me);
  const r = await d2.sync.sync();
  assert.equal(r.pulled, 3);
  assert.equal(d2.st.rounds.size, 3);
  assert.deepEqual(factsOf([...d2.st.rounds.values()]), factsOf(made));
  assert.equal(d2.st.rounds.get(made[1].id).label, made[1].label);
});

await t('syncing again changes nothing and never duplicates', async () => {
  const s = fakeServer(); const me = { v: A };
  const d1 = device(s, me); const d2 = device(s, me);
  d1.st.rounds.set(round(0).id, round(0));
  await d1.sync.sync(); await d2.sync.sync();
  const r1 = await d1.sync.sync(); const r2 = await d2.sync.sync();
  assert.equal(r1.pushed + r1.pulled + r2.pushed + r2.pulled, 0);
  assert.equal(s.db.rounds.size, 1);
});

await t('both devices played offline: sync merges both histories', async () => {
  const s = fakeServer(); const me = { v: A };
  const d1 = device(s, me); const d2 = device(s, me);
  await d1.sync.sync(); await d2.sync.sync();
  d1.st.rounds.set(round(1).id, round(1));
  d2.st.rounds.set(round(2).id, round(2));
  await d1.sync.sync(); await d2.sync.sync(); await d1.sync.sync();
  assert.equal(d1.st.rounds.size, 2);
  assert.equal(d2.st.rounds.size, 2);
  assert.equal(s.db.rounds.size, 2);
});

await t('users can never see each other\'s rounds (row-level security model)', async () => {
  const s = fakeServer(); const me = { v: A };
  const a = device(s, me);
  a.st.rounds.set(round(0).id, round(0));
  await a.sync.sync();
  me.v = B;
  const b = device(s, me);
  const r = await b.sync.sync();
  assert.equal(r.pulled, 0);
  assert.equal(b.st.rounds.size, 0);
});

await t('a different account on the same browser is stopped, not merged', async () => {
  const s = fakeServer(); const me = { v: A };
  const d = device(s, me);
  d.st.rounds.set(round(0).id, round(0));
  await d.sync.sync();
  me.v = B; // user A signed out, user B signs in on the same browser
  const r = await d.sync.sync();
  assert.equal(r.conflict, 'owner');
  assert.equal([...s.db.rounds.keys()].filter((k) => k.startsWith('user-b|')).length, 0);
  assert.equal(d.st.status.at(-1).state, 'conflict');
});

await t('signed-out sync does nothing', async () => {
  const s = fakeServer(); const me = { v: null };
  const d = device(s, me);
  d.st.rounds.set(round(0).id, round(0));
  const r = await d.sync.sync();
  assert.equal(r.skipped, true);
  assert.equal(s.db.rounds.size, 0);
});

await t('large histories are paged and chunked', async () => {
  const s = fakeServer(); const me = { v: A };
  const d1 = device(s, me);
  for (let i = 0; i < 1250; i++) d1.st.rounds.set('id' + String(i).padStart(5, '0'), { ...round(i), id: 'id' + String(i).padStart(5, '0') });
  await d1.sync.sync();
  assert.equal(s.db.rounds.size, 1250);
  const d2 = device(s, me);
  const r = await d2.sync.sync();
  assert.equal(r.pulled, 1250);
});

await t('failures are reported in plain words and keep local data', async () => {
  const s = fakeServer(); const me = { v: A };
  const d = device(s, me, { fail: 'Failed to fetch' });
  d.st.rounds.set(round(0).id, round(0));
  const r = await d.sync.sync();
  assert.match(r.error, /offline/);
  assert.equal(d.st.rounds.size, 1);
  assert.equal(d.st.status.at(-1).state, 'error');
  const d2 = device(s, me, { fail: 'Could not find the table \'public.rounds\' in the schema cache' });
  assert.match((await d2.sync.sync()).error, /not set up/);
});

await t('overlapping sync calls collapse into one follow-up', async () => {
  const s = fakeServer(); const me = { v: A };
  const d = device(s, me);
  d.st.rounds.set(round(0).id, round(0));
  const [x, y, z] = await Promise.all([d.sync.sync(), d.sync.sync(), d.sync.sync()]);
  assert.ok(x && y && z);
  assert.equal(s.db.rounds.size, 1);
  assert.ok(s.calls.filter((c) => c === 'rounds:upsert').length <= 2);
});

await t('pushRound is one request and only for the owning account', async () => {
  const s = fakeServer(); const me = { v: A };
  const d = device(s, me);
  await d.sync.sync();
  const before = s.calls.length;
  assert.equal(await d.sync.pushRound(round(9)), true);
  assert.equal(s.calls.length - before, 1);
  const stranger = device(s, me); // never synced, so no owner
  assert.equal(await stranger.sync.pushRound(round(10)), false);
});

await t('deleting a round or everything removes the cloud copy', async () => {
  const s = fakeServer(); const me = { v: A };
  const d = device(s, me);
  const r0 = round(0); const r1 = round(1);
  d.st.rounds.set(r0.id, r0); d.st.rounds.set(r1.id, r1);
  d.st.base = { '2_3': [1, 1, 0] };
  await d.sync.sync();
  assert.equal(await d.sync.deleteRound(r0.id), true);
  assert.equal(s.db.rounds.size, 1);
  await d.sync.deleteAll();
  assert.equal(s.db.rounds.size, 0);
  assert.equal(s.db.facts.size, 0);
});

await t('older facts total merges by keeping the larger sample', () => {
  const m = mergeBaseFacts({ '7_8': [3, 1, 0], '2_3': [5, 1, 0] }, { '7_8': [9, 1, 0], '4_5': [1, 1, 0] });
  assert.deepEqual(m, { '7_8': [9, 1, 0], '2_3': [5, 1, 0], '4_5': [1, 1, 0] });
});

await t('friendly errors and email check', () => {
  assert.match(friendlyError(new Error('email rate limit exceeded')), /Too many emails/);
  assert.match(friendlyError({ message: 'Token has expired or is invalid' }), /wrong or has expired/);
  assert.match(friendlyError({ code: 'PGRST205', message: 'x' }), /not set up/);
  assert.equal(isEmail('a@b.co'), true);
  assert.equal(isEmail('nope'), false);
  assert.equal(isEmail('a b@c.com'), false);
});

console.log(`\n${passed} sync test groups passed`);
