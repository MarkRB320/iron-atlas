'use strict';

// Shared by the phone app and the account website. Requests run under the member's own session.
window.IronAtlasAccounts = (() => {
  const list = '/storage/v1/object/list/progress-photos';
  const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  function emailRedirectPath(action, target) {
    let url;
    try { url = new URL(target); } catch { /* checked below */ }
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Email authentication is unavailable. A secure account page must be configured.');
    }
    return action + '?redirect_to=' + encodeURIComponent(url.href);
  }
  const recoveryPath = target => emailRedirectPath('recover', target);
  const signupPath = target => emailRedirectPath('signup', target);

  async function listPhotos(uid, request) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uid)) throw new Error('Please sign in again.');
    const pageSize = 100, folders = [uid], files = [];
    async function listPage(prefix, offset, limit) {
      const response = await request(list, json('POST', { prefix, limit, offset, sortBy: { column: 'name', order: 'asc' } }));
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('Could not verify your photo list. Please try again.');
      return rows;
    }
    // Read all pages before deleting anything so shrinking pages cannot skip objects.
    for (const folder of folders) {
      const seen = new Set();
      for (let offset = 0; ; offset += pageSize) {
        const rows = await listPage(folder, offset, pageSize);
        for (const row of rows) {
          if (!row || typeof row.name !== 'string' || !row.name || row.name.includes('/') ||
              row.name === '.' || row.name === '..' || seen.has(row.name)) {
            throw new Error('Your photo list changed or could not be read. Please try again.');
          }
          seen.add(row.name);
          const path = folder + '/' + row.name;
          if (row.id === null) folders.push(path);
          else if (typeof row.id === 'string' && row.id) files.push(path);
          else throw new Error('Could not identify a stored photo. Please try again.');
        }
        if (rows.length < pageSize) break;
      }
    }
    return files;
  }
  async function captureGeneration(request) {
    const response = await request('/rest/v1/rpc/cloud_consent_status', json('POST', {}));
    const status = await response.json();
    if (!status || (status.generation !== null && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(status.generation || ''))) {
      throw new Error('Could not verify the cloud copy to remove. Please try again.');
    }
    return status.generation;
  }
  async function removePhotos(uid, request, names, generation, purpose = 'photo') {
    if (names.some(name => typeof name !== 'string' || !name.startsWith(uid + '/'))) throw new Error('Unexpected photo owner.');
    for (let i = 0; i < names.length; i += 100) {
      await request('/functions/v1/cloud-photo-remove', json('POST', { generation, purpose, names: names.slice(i, i + 100) }));
    }
  }
  async function clearPhotos(uid, request, generation, purpose = 'photo') {
    if (generation === undefined) generation = await captureGeneration(request);
    const files = await listPhotos(uid, request);
    await removePhotos(uid, request, files, generation, purpose);
    await request('/functions/v1/cloud-photo-remove', json('POST', { generation, purpose: 'resume', names: [] }));
    if ((await listPhotos(uid, request)).length) throw new Error('Some photos are still stored. Please try again.');
    return generation;
  }

  async function deleteAccount(uid, request, clearDevice) {
    const generation = await captureGeneration(request);
    await clearPhotos(uid, request, generation, 'account');
    if (clearDevice) await clearDevice();
    const response = await request('/rest/v1/rpc/delete_my_account', json('POST', { p_generation: generation }));
    const text = await response.text();
    const result = text ? JSON.parse(text) : null;
    if (result !== null && (result.deleted !== true || typeof result.subscription_erasure_queued !== 'boolean')) {
      throw new Error('Could not verify the account deletion response.');
    }
    return result || { deleted: true, subscription_erasure_queued: false };
  }
  return { recoveryPath, signupPath, captureGeneration, listPhotos, removePhotos, clearPhotos, deleteAccount };
})();
