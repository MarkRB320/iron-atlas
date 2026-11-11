'use strict';

window.IronAtlasModeration = (() => {
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
  const reasons = ['abuse', 'hate', 'sexual', 'violence', 'spam', 'other'];
  const copy = value => JSON.parse(JSON.stringify(value));
  function allowed(value) {
    const replacements = { '@': 'a', '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '$': 's' };
    let text;
    try { text = JSON.stringify(value); } catch { return false; }
    if (typeof text !== 'string') return false;
    text = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, '').replace(/[@013457$]/g, character => replacements[character]).toLowerCase().replace(/[^a-z]+/g, ' ');
    return !/(^| )(fuck[a-z]*|motherfuck[a-z]*|shit|shitty|shithead[a-z]*|bullshit|cunt[a-z]*|nigger[a-z]*|faggot[a-z]*|porn|pornography|kill yourself|i will kill you|rape you|child porn)( |$)/.test(text);
  }
  function reference(kind, value) {
    return kind === 'assigned_plan' ? typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
      : ['shared_plan', 'peer'].includes(kind) && uuid(value);
  }
  function source(value) {
    if (!value || !['shared_plan', 'assigned_plan'].includes(value.kind) || !reference(value.kind, value.reference) || !uuid(value.author)) return null;
    return { kind: value.kind, reference: value.kind === 'shared_plan' ? value.reference.toLowerCase() : value.reference, author: value.author.toLowerCase() };
  }
  function validOperation(operation) {
    if (!operation || !operation.args || typeof operation.args !== 'object' || Array.isArray(operation.args)) return false;
    if (['block_peer', 'unblock_peer'].includes(operation.rpc)) return uuid(operation.args.p_peer);
    return operation.rpc === 'report_content' && reference(operation.args.p_kind, operation.args.p_reference) && reasons.includes(operation.args.p_reason);
  }
  function normalizeOperation(operation) {
    if (!validOperation(operation)) return null;
    const args = operation.args;
    return operation.rpc === 'report_content'
      ? { rpc: operation.rpc, args: { p_kind: args.p_kind, p_reference: args.p_kind === 'assigned_plan' ? args.p_reference : args.p_reference.toLowerCase(), p_reason: args.p_reason } }
      : { rpc: operation.rpc, args: { p_peer: args.p_peer.toLowerCase() } };
  }
  function create({ key, storage, request, current = () => true }) {
    let record = { blocked: [], pending: [], verified: false }, loaded = false, error = '', queue = Promise.resolve(), closed = false;
    const check = () => { if (closed || !current()) throw new Error('Account changed. Sign in again to manage shared content.'); };
    const serial = work => { const result = queue.catch(() => {}).then(work); queue = result; return result; };
    async function load() {
      check(); if (loaded) return;
      const saved = await storage.read(key); check();
      if (saved && (!Array.isArray(saved.blocked) || !saved.blocked.every(uuid) || !Array.isArray(saved.pending) || saved.pending.length > 1000 || !saved.pending.every(validOperation))) {
        throw new Error('Saved moderation choices could not be read. Your training records are kept.');
      }
      record = saved ? { blocked: [...new Set(saved.blocked.map(id => id.toLowerCase()))], pending: saved.pending.map(normalizeOperation), verified: saved.verified === true } : record;
      loaded = true;
    }
    async function save(next) {
      check(); await storage.write(key, copy(next)); check(); record = next;
    }
    async function call(name, args) {
      check(); const result = await request(name, args); check(); return result;
    }
    async function flush() {
      await load(); error = '';
      const operations = record.pending.filter(item => item.rpc !== 'report_content').concat(record.pending.filter(item => item.rpc === 'report_content'));
      for (const operation of operations) {
        try {
          const result = await call(operation.rpc, operation.args);
          const next = copy(record);
          if (operation.rpc === 'report_content') {
            if (!uuid(result?.id) || result.status !== 'open') throw new Error('The report could not be confirmed. Retry from Account.');
          } else {
            const blocked = operation.rpc === 'block_peer';
            if (result?.blocked !== blocked) throw new Error('The account choice could not be confirmed. Retry from Account.');
            next.blocked = next.blocked.filter(id => id !== operation.args.p_peer);
            if (blocked) next.blocked.push(operation.args.p_peer);
          }
          const key = JSON.stringify(operation);
          next.pending = next.pending.filter(item => JSON.stringify(item) !== key);
          await save(next);
        } catch (failure) { check(); if (!error) error = failure.message; }
      }
      return { pending: record.pending.length > 0, error };
    }
    async function enqueue(operation) {
      await load();
      operation = normalizeOperation(operation);
      if (!operation) throw new Error('This moderation choice is invalid.');
      if (!record.pending.some(item => JSON.stringify(item) === JSON.stringify(operation))) {
        if (record.pending.length >= 1000 || (operation.rpc === 'report_content' && record.pending.filter(item => item.rpc === 'report_content').length >= 50)) throw new Error('Retry your pending moderation choices before adding more.');
        const next = copy(record);
        if (operation.rpc !== 'report_content') next.pending = next.pending.filter(item => item.rpc === 'report_content' || item.args.p_peer !== operation.args.p_peer);
        next.pending.push(operation); await save(next);
      }
      return flush();
    }
    const api = {
      get loaded() { return loaded; },
      get verified() { return loaded && record.verified === true; },
      get error() { return error; },
      get pending() { return record.pending.length; },
      get blocked() { return [...new Set(record.blocked.concat(record.pending.filter(item => item.rpc !== 'report_content').map(item => item.args.p_peer)))]; },
      load: () => serial(load),
      refresh: () => serial(async () => {
        await load();
        try {
          const peers = await call('blocked_peers', {});
          if (!Array.isArray(peers) || !peers.every(peer => uuid(peer?.id))) throw new Error('Blocked accounts could not be verified.');
          const next = copy(record); next.blocked = [...new Set(peers.map(peer => peer.id.toLowerCase()))]; next.verified = true; await save(next);
        } catch (failure) { check(); error = failure.message; return { pending: record.pending.length > 0, error }; }
        return flush();
      }),
      retry: () => serial(flush),
      close: () => { closed = true; return queue.catch(() => {}); },
      block: peer => serial(() => enqueue({ rpc: 'block_peer', args: { p_peer: peer } })),
      unblock: peer => serial(() => enqueue({ rpc: 'unblock_peer', args: { p_peer: peer } })),
      report: (kind, ref, reason) => serial(() => enqueue({ rpc: 'report_content', args: { p_kind: kind, p_reference: ref, p_reason: reason } })),
    };
    return api;
  }
  return { uuid, reference, source, reasons, allowed, create };
})();
