'use strict';

window.IronAtlasBackup = (() => {
  const version = '2026-11-02';
  const sharingVersion = '2026-11-02';
  const privacyUrl = 'https://ironatlas.insomnia-it.co.uk/privacy/';
  const privacyReady = value => value === privacyUrl;
  const copy = value => JSON.parse(JSON.stringify(value));
  function create({ key, storage, rpc, readState, listFiles, retainFile, missingKnown, eraseFiles, resumeRemovals, current = () => true }) {
    let remote = null, record = {}, queue = Promise.resolve(), stopping = false;
    const check = () => { if (!current()) throw new Error('Account changed. Sign in again.'); };
    const call = async (name, args) => { check(); const result = await rpc(name, args); check(); return result; };
    async function transition(name, args, generation) {
      for (let attempt = 0; attempt < 3; attempt++) {
        check(); await resumeRemovals(generation); check();
        try { return await call(name, args); }
        catch (error) { if (attempt === 2 || !error.message.startsWith('Photo removal is in progress.')) throw error; }
      }
    }
    const serial = fn => { const work = queue.catch(() => {}).then(fn); queue = work; return work; };
    function status(value) {
      if (!value || typeof value.enabled !== 'boolean' || typeof value.cleanup_pending !== 'boolean' || value.version !== version) {
        throw new Error('Cloud backup status could not be verified. Your device copy is kept.');
      }
      if ((value.enabled || value.cleanup_pending) && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.generation || '')) throw new Error('Cloud backup generation could not be verified.');
      remote = value; return value;
    }
    async function read() { check(); record = await storage.read(key) || {}; check(); }
    async function save() { check(); await storage.write(key, copy(record)); check(); }
    async function refresh() {
      check(); status(await call('cloud_consent_status', {})); await read();
      stopping = stopping || !!(record.withdrawal && record.withdrawal.phase !== 'done');
      return remote;
    }
    const api = {
      get state() { return remote; },
      get withdrawal() { return record.withdrawal || null; },
      get removalPending() { return stopping || !!remote?.cleanup_pending; },
      get enabled() { return !!(remote?.enabled && !remote.cleanup_pending && !stopping); },
      get ready() { return api.enabled && record.adoptedGeneration === remote.generation; },
      pause() { stopping = true; },
      refresh: () => serial(refresh),
      grant: policy => serial(async () => {
        if (!privacyReady(policy)) throw new Error('Cloud backup is unavailable until the official privacy policy is configured.');
        await refresh();
        if (stopping || remote.cleanup_pending) throw new Error('Finish removing the previous cloud copy before enabling backup.');
        status(await call('grant_cloud_consent', { p_version: version, p_expected_generation: remote.generation }));
        record.adoptedGeneration = null;
        await save(); return remote;
      }),
      adopt: generation => serial(async () => {
        if (!api.enabled || generation !== remote.generation) throw new Error('Cloud backup changed. Please retry.');
        record.adoptedGeneration = generation; await save();
      }),
      withdraw: (snapshot, allowMissing = false) => {
        stopping = true; // Stop new writes before the first asynchronous operation.
        const local = copy(snapshot);
        return serial(async () => {
          await read();
          status(await call('cloud_consent_status', {}));
          if (!record.withdrawal || record.withdrawal.phase === 'done') {
            if (record.withdrawal) (record.archives ||= []).push(record.withdrawal);
            record.withdrawal = { generation: remote.generation, phase: 'prepared', local, files: [], missing: [] };
          }
          const task = record.withdrawal;
          if (task.generation === null && task.phase === 'prepared' && !remote.enabled && remote.cleanup_pending) task.generation = remote.generation;
          if (task.generation !== remote.generation) throw new Error('Cloud backup was changed on another device. Review its current status before removing it.');
          await save();
          status(await transition('begin_cloud_withdrawal', { p_expected_generation: task.generation }, task.generation));
          task.generation = remote.generation; task.phase = 'revoked'; record.adoptedGeneration = null;
          await save();
          if (!task.cloud) { task.cloud = await readState(); await save(); }
          const paths = await listFiles(); check();
          task.missing = [];
          for (const path of paths) {
            check(); const retained = await retainFile(path); check();
            task.files = task.files.filter(file => file.path !== path);
            task.files.push({ path, ...retained });
            if (retained.missing) task.missing.push(path);
            await save();
          }
          task.missing.push(...await missingKnown(task.local, task.cloud));
          task.missing = [...new Set(task.missing)];
          if (allowMissing) task.acknowledgedMissing = [...task.missing];
          task.phase = task.missing.some(path => !task.acknowledgedMissing?.includes(path)) ? 'missing' : 'preserved';
          await save();
          if (task.phase === 'missing') return { pending: true, missing: task.missing };
          const latest = await listFiles(); check();
          if (latest.some(path => !task.files.some(file => file.path === path && (!file.missing || task.acknowledgedMissing?.includes(path))))) {
            throw new Error('The cloud file list changed. Retry removal to preserve the additional files.');
          }
          task.phase = 'erasing'; await save();
          check(); await eraseFiles(latest, task.generation); check();
          status(await transition('finish_cloud_withdrawal', { p_generation: task.generation }, task.generation));
          task.phase = 'done'; stopping = false; await save();
          return { pending: false, missing: task.missing };
        });
      },
      dismissStaleWithdrawal: () => serial(async () => {
        await refresh();
        if (!record.withdrawal || record.withdrawal.generation === remote.generation) throw new Error('The current removal must be completed or retried.');
        record.withdrawal.phase = 'done'; record.withdrawal.superseded = true;
        record.adoptedGeneration = null; stopping = false; await save();
      }),
      export: () => serial(async () => { await read(); return copy({ ...(record.withdrawal || {}), previous: record.archives || [] }); }),
      clear: () => serial(async () => { check(); await storage.remove(key); record = {}; remote = null; stopping = false; }),
    };
    return api;
  }
  return { version, sharingVersion, privacyUrl, privacyReady, create };
})();
