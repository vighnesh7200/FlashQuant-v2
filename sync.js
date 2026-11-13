// FlashQuant cloud sync. The local IndexedDB copy stays the source the app reads from; the cloud is a mirror
// that lets you resume on another device. Rounds are matched by id, so syncing twice never duplicates anything.
// This file has no DOM and does not import the Supabase SDK at load time, so it can be tested with a fake client.

import { sanitizeRecord, sanitizeFacts } from './core.js';

const PAGE = 1000;
const CHUNK = 100;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export const isEmail = (s) => EMAIL.test(String(s || '').trim());

/* ---------- pure helpers ---------- */

export function planSync(localIds, remoteIds) {
  const L = new Set(localIds);
  const R = new Set(remoteIds);
  return { push: localIds.filter((id) => !R.has(id)), pull: remoteIds.filter((id) => !L.has(id)) };
}

// Facts only ever grow, so for each key keep whichever side has seen more tries.
export function mergeBaseFacts(a, b) {
  const out = { ...a };
  Object.keys(b).forEach((k) => {
    if (!out[k] || b[k][0] > out[k][0]) out[k] = b[k];
  });
  return out;
}

const sameFacts = (a, b) => JSON.stringify(Object.keys(a).sort().map((k) => [k, a[k]])) === JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));

export function friendlyError(e) {
  const msg = String((e && (e.message || e.error_description || e.msg)) || e || '');
  const code = String((e && (e.code || e.status)) || '');
  if (/rate limit|too many|over_email_send_rate_limit|429/i.test(msg + code)) return 'Too many emails were requested. Wait a few minutes and try again.';
  if (/PGRST205|42P01|schema cache|does not exist/i.test(msg + code)) return 'The cloud tables are not set up yet. Run the SQL from the setup guide in your Supabase project.';
  if (/JWT|401|403|not authenticated|invalid claim|permission denied|row-level security/i.test(msg + code)) return 'Your sign-in has expired or was refused. Please sign in again.';
  if (/failed to fetch|networkerror|load failed|network request failed|offline/i.test(msg)) return 'You seem to be offline. Your rounds are safe on this device and will sync later.';
  if (/token has expired|invalid|otp/i.test(msg)) return 'That code is wrong or has expired. Request a new one.';
  if (/signups not allowed|disabled/i.test(msg)) return 'Sign-ups are turned off for this project.';
  return msg ? 'Something went wrong: ' + msg.slice(0, 160) : 'Something went wrong.';
}

/* ---------- SDK loading and auth ---------- */

// Returns a Supabase client, or null when sync is not configured or the SDK cannot load (offline, blocked).
export async function connect({ url, key, sdk }) {
  if (!url || !key) return null;
  try {
    const mod = await import(/* @vite-ignore */ sdk);
    const createClient = mod.createClient || (mod.default && mod.default.createClient);
    return createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
  } catch (e) {
    return null;
  }
}

export async function sendCode(client, email, redirect) {
  const { error } = await client.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true, emailRedirectTo: redirect } });
  if (error) throw error;
}

export async function verifyCode(client, email, token) {
  const { data, error } = await client.auth.verifyOtp({ email: email.trim(), token: String(token).replace(/\s/g, ''), type: 'email' });
  if (error) throw error;
  return data;
}

export async function currentUser(client) {
  try {
    const { data } = await client.auth.getSession();
    return data && data.session ? data.session.user : null;
  } catch (e) {
    return null;
  }
}

/* ---------- the syncer ---------- */

// hooks: getRounds(), putRounds(list), getBase(), setBase(facts), getOwner(), setOwner(id), onStatus(s)
export function createSync({ client, getRounds, putRounds, getBase, setBase, getOwner, setOwner, onStatus = () => {} }) {
  let running = null;
  let again = false;

  const must = (r) => {
    if (r && r.error) throw r.error;
    return r ? r.data : null;
  };

  async function remoteIds() {
    const ids = [];
    for (let from = 0; ; from += PAGE) {
      const rows = must(await client.from('rounds').select('id').order('id').range(from, from + PAGE - 1)) || [];
      rows.forEach((r) => ids.push(r.id));
      if (rows.length < PAGE) break;
    }
    return ids;
  }

  async function push(list) {
    for (let i = 0; i < list.length; i += CHUNK) {
      const rows = list.slice(i, i + CHUNK).map((r) => ({ id: r.id, ts: r.ts, data: r }));
      must(await client.from('rounds').upsert(rows, { onConflict: 'user_id,id', ignoreDuplicates: true }));
    }
  }

  async function pull(ids) {
    const got = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const rows = must(await client.from('rounds').select('id,data').in('id', ids.slice(i, i + CHUNK))) || [];
      rows.forEach((row) => {
        const rec = sanitizeRecord({ ...(row.data || {}), id: row.id });
        if (rec) got.push(rec);
      });
    }
    if (got.length) await putRounds(got);
    return got.length;
  }

  async function syncFacts() {
    const remote = sanitizeFacts((must(await client.from('facts').select('data').maybeSingle()) || {}).data);
    const local = sanitizeFacts(await getBase());
    const merged = mergeBaseFacts(local, remote);
    if (!sameFacts(merged, local)) await setBase(merged);
    if (!sameFacts(merged, remote) && Object.keys(merged).length) must(await client.from('facts').upsert({ data: merged }, { onConflict: 'user_id' }));
  }

  async function runOnce() {
    const user = await currentUser(client);
    if (!user) return { skipped: true };
    const local = await getRounds();
    const owner = await getOwner();
    if (owner && owner !== user.id && local.length) return { conflict: 'owner', localRounds: local.length };
    if (owner !== user.id) await setOwner(user.id);
    const remote = await remoteIds();
    const plan = planSync(local.map((r) => r.id), remote);
    const pulled = await pull(plan.pull);
    const byId = new Map(local.map((r) => [r.id, r]));
    const pushList = plan.push.map((id) => byId.get(id));
    await push(pushList);
    await syncFacts();
    return { pulled, pushed: pushList.length, total: new Set([...local.map((r) => r.id), ...remote]).size };
  }

  // Safe to call from anywhere, any number of times: overlapping calls collapse into one follow-up run.
  async function sync() {
    if (running) {
      again = true;
      return running;
    }
    onStatus({ state: 'syncing' });
    running = (async () => {
      let res;
      try {
        res = await runOnce();
        if (res.conflict) onStatus({ state: 'conflict', ...res });
        else if (res.skipped) onStatus({ state: 'signed-out' });
        else onStatus({ state: 'ok', at: Date.now(), ...res });
      } catch (e) {
        res = { error: friendlyError(e) };
        onStatus({ state: 'error', message: res.error });
      }
      return res;
    })();
    const out = await running;
    running = null;
    if (again) {
      again = false;
      return sync();
    }
    return out;
  }

  // Cheap path after finishing a round: one request. Any failure just leaves it for the next full sync.
  async function pushRound(rec) {
    try {
      const user = await currentUser(client);
      if (!user || (await getOwner()) !== user.id) return false;
      await push([rec]);
      onStatus({ state: 'ok', at: Date.now(), pushed: 1, pulled: 0 });
      return true;
    } catch (e) {
      onStatus({ state: 'error', message: friendlyError(e) });
      return false;
    }
  }

  async function deleteRound(id) {
    try {
      must(await client.from('rounds').delete().eq('id', id));
      return true;
    } catch (e) {
      onStatus({ state: 'error', message: friendlyError(e) });
      return false;
    }
  }

  async function deleteAll() {
    must(await client.from('rounds').delete().gte('ts', 0));
    must(await client.from('facts').delete().neq('user_id', '00000000-0000-0000-0000-000000000000'));
  }

  return { sync, pushRound, deleteRound, deleteAll };
}
