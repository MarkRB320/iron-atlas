'use strict';
(() => {
  const byId = id => document.getElementById(id);
  const cfg = window.IRON_ATLAS_CONFIG || {};
  const fragment = new URLSearchParams(location.hash.slice(1));
  let recoveryToken = fragment.get('type') === 'recovery' ? fragment.get('access_token') : null;
  let confirmationToken = fragment.get('type') === 'signup' ? fragment.get('access_token') : null;
  const receivedLink = !!(location.hash || location.search);
  // Keep account credentials in memory only and remove the email link from browser history.
  if (receivedLink) history.replaceState(null, '', location.pathname);
  for (const key of ['access_token', 'refresh_token']) fragment.delete(key);
  let deleteSession = null, busy = false;
  function message(text) {
    const status = byId('status');
    status.textContent = text; status.hidden = false; status.focus();
  }
  function buttons(disabled) { document.querySelectorAll('button').forEach(b => { b.disabled = disabled; }); }
  function view(name) {
    for (const id of ['choices', 'recovery', 'deletePanel']) byId(id).hidden = name !== id;
  }
  function onSubmit(id, action) {
    byId(id).addEventListener('submit', async event => {
      event.preventDefault();
      if (busy || !configured) return;
      busy = true; buttons(true);
      try { await action(event.currentTarget); }
      catch (error) { message(error.message || 'Please try again.'); }
      finally { busy = false; buttons(false); }
    });
  }
  let base;
  try {
    const target = new URL(cfg.supabaseUrl);
    if (target.protocol === 'https:' && !target.username && !target.password && !target.search && !target.hash) {
      base = target.href.replace(/\/+$/, '');
    }
  } catch { /* an unpublished configuration */ }
  const configured = !!(base && cfg.supabaseAnonKey);
  async function request(path, options = {}, token) {
    let response;
    const headers = { ...options.headers, apikey: cfg.supabaseAnonKey };
    if (token) headers.Authorization = 'Bearer ' + token;
    try {
      response = await fetch(base + path, { ...options, headers, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    } catch { throw new Error('Could not reach the account service. Check your connection and try again.'); }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.msg || error.error_description || error.message || 'The request could not be completed. Please try again.');
    }
    return response;
  }
  const json = (method, data) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const signOut = token => request('/auth/v1/logout?scope=local', { method: 'POST' }, token).catch(() => {});
  onSubmit('requestReset', async form => {
    const path = IronAtlasAccounts.recoveryPath(cfg.passwordResetUrl);
    await request('/auth/v1/' + path, json('POST', { email: form.elements.email.value.trim() }));
    form.reset();
    message('If this email has an Iron Atlas account, you will receive a password reset link.');
  });
  onSubmit('change', async form => {
    const password = form.elements.password.value;
    if (password !== form.elements.confirm.value) throw new Error('The passwords differ. Enter the same password in both fields.');
    if (!recoveryToken) throw new Error('Please request a new password reset email.');
    await request('/auth/v1/user', json('PUT', { password }), recoveryToken);
    const token = recoveryToken; recoveryToken = null;
    form.reset(); view('choices'); message('Password updated. You can now sign in to Iron Atlas with your new password.');
    await signOut(token);
  });
  onSubmit('signIn', async form => {
    const credentials = { email: form.elements.email.value.trim(), password: form.elements.password.value };
    form.elements.password.value = '';
    const result = await (await request('/auth/v1/token?grant_type=password', json('POST', credentials))).json();
    if (!result.access_token || !result.user || !result.user.id || !result.user.email) throw new Error('Could not verify your account. Please sign in again.');
    deleteSession = { uid: result.user.id, token: result.access_token };
    byId('deleteFor').textContent = result.user.email;
    byId('confirmDelete').reset(); view('deletePanel'); message('Signed in. Review the account below before confirming.');
  });
  byId('cancel').addEventListener('click', async () => {
    const session = deleteSession; deleteSession = null;
    byId('confirmDelete').reset(); view('choices'); message('Account kept. You can close this page.');
    if (session) await signOut(session.token);
  });
  onSubmit('confirmDelete', async form => {
    if (!deleteSession || !form.elements.consent.checked) throw new Error('Sign in and confirm the account you want to delete.');
    const session = deleteSession;
    const result = await IronAtlasAccounts.deleteAccount(session.uid, (path, opts) => request(path, opts, session.token));
    deleteSession = null; form.reset(); byId('signIn').reset(); view('choices');
    message('Your Iron Atlas account and cloud records have been deleted.' + (result.subscription_erasure_queued ? ' Removal of your subscription profile is queued. Manage any active subscription through the store where you purchased it.' : ''));
  });
  async function init() {
    if (!configured) {
      buttons(true); message('The account service is unavailable. Please try again later.'); return;
    }
    if (recoveryToken) {
      view('loading'); buttons(true);
      try {
        const user = await (await request('/auth/v1/user', {}, recoveryToken)).json();
        if (!user.id || !user.email) throw new Error();
        byId('resetFor').textContent = user.email; view('recovery');
      } catch {
        recoveryToken = null; view('choices'); message('This reset link could not be verified. Request a new email below.');
      }
    } else if (confirmationToken) {
      try {
        const user = await (await request('/auth/v1/user', {}, confirmationToken)).json();
        if (!user.id || !user.email_confirmed_at) throw new Error();
        message('Email address confirmed. Open Iron Atlas and sign in to your account.');
      } catch {
        message('Open Iron Atlas and try signing in. Contact support if your email still needs confirmation.');
      } finally { confirmationToken = null; }
    } else if (receivedLink) {
      message('This link cannot be used to change your password. Request a new email below.');
    }
    buttons(false);
  }
  init();
})();
