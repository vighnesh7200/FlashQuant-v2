// FlashQuant account UI: header button, sign-in dialog, and the triggers that keep the cloud copy in step.
// All text that comes from outside (email address, server messages) is escaped or set with textContent.

import { esc } from './core.js';
import { SUPABASE_URL, SUPABASE_KEY, SUPABASE_SDK } from './config.js';
import { connect, createSync, currentUser, friendlyError, isEmail, sendCode, verifyCode } from './sync.js';

const $ = (id) => document.getElementById(id);

// Read before the SDK gets a chance to clear the address bar: a link that failed or expired comes back as #error_description=...
function linkProblem() {
  const h = location.hash || '';
  if (!/error_description=|error_code=/.test(h)) return '';
  const p = new URLSearchParams(h.replace(/^#/, ''));
  return /expired|invalid/i.test(p.get('error_description') || p.get('error_code') || '')
    ? 'That sign-in link has expired or was already used. Request a new code below.'
    : 'The sign-in link did not work. Request a new code below.';
}

export function createAccount({ DB, hooks }) {
  const enabled = Boolean(SUPABASE_URL && SUPABASE_KEY);
  const S = { client: null, sync: null, user: null, status: { state: 'idle' }, step: 'email', email: '', msg: '', busy: false, loading: enabled, lastOk: 0 };
  const dlg = () => $('acct-dlg');

  /* ---------- rendering ---------- */

  function ago(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    return s < 10 ? 'just now' : s < 60 ? s + ' seconds ago' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago';
  }

  function statusLine() {
    const st = S.status;
    if (st.state === 'syncing') return 'Syncing…';
    if (st.state === 'error') return '<span class="bad">' + esc(st.message) + '</span>';
    if (st.state === 'ok') {
      const bits = [];
      if (st.pushed) bits.push(st.pushed + ' uploaded');
      if (st.pulled) bits.push(st.pulled + ' downloaded');
      return '<span class="good">Synced ' + ago(st.at) + '</span>' + (bits.length ? ' · ' + bits.join(', ') : '');
    }
    return 'Not synced yet.';
  }

  function renderButton() {
    const b = $('acct-btn');
    if (!enabled) return b.classList.add('hide');
    b.classList.remove('hide');
    const dot = S.status.state === 'syncing' ? 'busy' : S.status.state === 'error' || S.status.state === 'conflict' ? 'err' : S.user ? 'ok' : 'off';
    const name = S.user ? (S.user.email || 'account').split('@')[0].slice(0, 14) : 'Sign in';
    b.innerHTML = `<i class="dot ${dot}" aria-hidden="true"></i>${esc(name)}`;
    b.setAttribute('aria-label', S.user ? `Account: ${S.user.email}. ${S.status.state === 'ok' ? 'Synced.' : ''}` : 'Sign in to sync your stats');
  }

  function renderDialog() {
    const body = $('acct-body');
    const local = hooks.localCount();
    const note = S.msg ? `<p class="acct-msg" role="alert">${S.msg}</p>` : '';
    let h = '<h2 id="acct-title">Account</h2>';
    if (S.loading && !S.client) {
      h += '<p class="muted">Connecting…</p>';
    } else if (!S.client) {
      h += '<p class="bad">Cloud sync could not load. Check your connection and reload the page. You can keep playing; everything is saved on this device.</p>';
    } else if (S.status.state === 'conflict') {
      h += `<p><b>This browser holds ${S.status.localRounds} round${S.status.localRounds === 1 ? '' : 's'} from a different account.</b></p>
        <p>To protect both accounts, nothing was merged. Choose what to do:</p>
        <div class="actions"><button type="button" class="btn primary" data-a="take-over">Replace this device's data with my account's</button>
        <button type="button" class="btn" data-a="signout">Sign out</button></div>
        <p class="muted small">The other account's data stays safe in its own cloud copy.</p>`;
    } else if (S.user) {
      h += `<p>Signed in as <b>${esc(S.user.email || '')}</b></p><p id="acct-status" role="status">${statusLine()}</p>${note}
        <div class="actions"><button type="button" class="btn primary" data-a="sync"${S.status.state === 'syncing' ? ' disabled' : ''}>Sync now</button>
        <button type="button" class="btn" data-a="signout">Sign out</button></div>
        <p class="muted small">Your rounds are saved on this device first and copied to your account after each round, so FlashQuant keeps working offline. Signing out keeps this device's copy.</p>`;
    } else if (S.step === 'code') {
      h += `<p>We sent an email to <b>${esc(S.email)}</b>. Enter the code from it, or open the link in the email on this device.</p>${note}
        <form data-a="verify"><label for="acct-code" class="sr">Code from the email</label>
        <input id="acct-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code" aria-describedby="acct-help">
        <button type="submit" class="btn primary"${S.busy ? ' disabled' : ''}>Verify and sign in</button></form>
        <p id="acct-help" class="muted small">Nothing arrived? Check spam, or <button type="button" class="link" data-a="back">use a different email</button>.</p>`;
    } else {
      h += `<p>Sign in to keep your stats in the cloud and pick up where you left off on any device. No password: we email you a one-time code.</p>
        ${local ? `<p class="muted small">The ${local} round${local === 1 ? '' : 's'} already on this device will be added to your account.</p>` : ''}${note}
        <form data-a="send"><label for="acct-email" class="sr">Email address</label>
        <input id="acct-email" type="email" autocomplete="email" inputmode="email" placeholder="you@example.com" value="${esc(S.email)}" required>
        <button type="submit" class="btn primary"${S.busy ? ' disabled' : ''}>${S.busy ? 'Sending…' : 'Email me a code'}</button></form>
        <p class="muted small">Playing without an account always works. Signing in only adds sync.</p>`;
    }
    h += '<div class="actions"><button type="button" class="btn small" data-a="close">Close</button></div>';
    body.innerHTML = h;
  }

  function render() {
    renderButton();
    if (dlg() && dlg().open) renderDialog();
  }

  function open() {
    if (!enabled) return;
    renderDialog();
    if (!dlg().open) dlg().showModal();
    const f = $('acct-email') || $('acct-code');
    if (f) f.focus();
  }

  /* ---------- sync plumbing ---------- */

  function setStatus(st) {
    S.status = st;
    if (st.state === 'ok') {
      S.lastOk = st.at;
      if (st.pulled) hooks.refresh();
    }
    render();
  }

  function makeSync() {
    S.sync = createSync({
      client: S.client,
      getRounds: hooks.getRounds,
      putRounds: DB.putRounds,
      getBase: DB.getFacts,
      setBase: (f) => DB.setMeta('facts', f),
      getOwner: () => DB.getMeta('owner', null),
      setOwner: (id) => DB.setMeta('owner', id),
      onStatus: setStatus,
    });
  }

  async function syncNow() {
    if (!S.sync || !S.user) return null;
    const r = await S.sync.sync();
    if (r && r.pulled) await hooks.refresh();
    return r;
  }

  function onAuth(event, session) {
    // Never call SDK methods directly inside this callback; hand off to the next tick.
    setTimeout(() => {
      const had = S.user;
      S.user = session ? session.user : null;
      if (S.user) {
        S.msg = '';
        if (!had || had.id !== S.user.id) syncNow();
        if (event === 'SIGNED_IN' && dlg().open && !had) renderDialog();
      } else {
        S.status = { state: 'idle' };
      }
      render();
    }, 0);
  }

  /* ---------- actions ---------- */

  async function onSubmitSend(form) {
    const email = form.querySelector('input').value.trim();
    S.email = email;
    if (!isEmail(email)) { S.msg = 'Enter a valid email address.'; return renderDialog(); }
    S.busy = true; S.msg = ''; renderDialog();
    try {
      await sendCode(S.client, email, location.origin + '/');
      S.step = 'code';
    } catch (e) {
      S.msg = esc(friendlyError(e));
    }
    S.busy = false;
    renderDialog();
    const c = $('acct-code') || $('acct-email');
    if (c) c.focus();
  }

  async function onSubmitVerify(form) {
    const token = form.querySelector('input').value.replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(token)) { S.msg = 'The code is made of digits only, and it is in the email.'; return renderDialog(); }
    S.busy = true; S.msg = ''; renderDialog();
    try {
      await verifyCode(S.client, S.email, token);
      S.step = 'email';
    } catch (e) {
      S.msg = esc(friendlyError(e));
    }
    S.busy = false;
    renderDialog();
  }

  async function onClick(e) {
    const t = e.target.closest('[data-a]');
    if (!t || t.tagName === 'FORM') return;
    const a = t.dataset.a;
    if (a === 'close') return dlg().close();
    if (a === 'back') { S.step = 'email'; S.msg = ''; return renderDialog(); }
    if (a === 'sync') return syncNow();
    if (a === 'signout') {
      try { await S.client.auth.signOut(); } catch (err) { /* local session is cleared anyway */ }
      S.user = null; S.status = { state: 'idle' }; S.msg = ''; S.step = 'email';
      return render();
    }
    if (a === 'take-over') {
      await DB.clearData();
      await DB.setMeta('owner', S.user.id);
      await hooks.refresh();
      return syncNow();
    }
  }

  /* ---------- public ---------- */

  async function init() {
    $('acct-btn').addEventListener('click', open);
    dlg().addEventListener('click', onClick);
    dlg().addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target.closest('form[data-a]');
      if (!f) return;
      if (f.dataset.a === 'send') onSubmitSend(f);
      else if (f.dataset.a === 'verify') onSubmitVerify(f);
    });
    // Clicking the dark backdrop closes the dialog.
    dlg().addEventListener('mousedown', (e) => { if (e.target === dlg()) dlg().close(); });
    renderButton();
    if (!enabled) return;
    const problem = linkProblem();
    S.client = await connect({ url: SUPABASE_URL, key: SUPABASE_KEY, sdk: SUPABASE_SDK });
    S.loading = false;
    if (!S.client) { render(); return; }
    makeSync();
    S.client.auth.onAuthStateChange(onAuth);
    S.user = await currentUser(S.client);
    if (problem) { S.msg = esc(problem); open(); }
    render();
    if (S.user) syncNow();
    window.addEventListener('online', () => syncNow());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && S.user && Date.now() - S.lastOk > 60000) syncNow();
    });
  }

  return {
    init,
    enabled,
    isSignedIn: () => Boolean(S.user),
    syncNow,
    afterRound: async (rec) => { if (S.user && S.sync) { if (!(await S.sync.pushRound(rec))) syncNow(); } },
    deleteRound: async (id) => (S.user && S.sync ? S.sync.deleteRound(id) : true),
    deleteCloud: async () => {
      if (!S.user || !S.sync) return { ok: true };
      try { await S.sync.deleteAll(); return { ok: true }; } catch (e) { return { ok: false, message: friendlyError(e) }; }
    },
  };
}
