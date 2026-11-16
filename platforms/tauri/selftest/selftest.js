// Bridge self-test for the Tauri shell (Windows / Linux / Android). Calls every non-interactive bridge method,
// checks validation and events, and reports with selftest.done (desktop: printed + exit code; Android: logcat).
// Nothing here prompts the user: hw.createSlot / hw.unwrapSlot are only exercised for their validation errors.
(function () {
  // docs/vault-test-vector.json (recovery slot) and docs/hw-slot-test-vector.json (android-keystore software key)
  const VEC = {
    recoveryBytes: 'EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8=',
    vdk: 'QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=',
    slot: { id: '11111111-1111-4111-8111-111111111111', salt: 'ICEiIyQlJicoKSorLC0uLw==', iv: 'MDEyMzQ1Njc4OTo7', ct: 'yuTURw62iuPY9QMD2ooFBfVNcPsyejAoHEu32Xf9nc6NTFtKKcdHrFXL0L46AkhX' },
    verifier: { iv: 'AQIDBAUGBwgJCgsM', ct: 'yEUhVUdF3BA82pFsMfN3m9FfsVlOd+K6lM73pF6AC/Q7ig==' },
    akKey: 'BQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQ=',
    akSlot: { id: '66666666-6666-4666-8666-666666666666', iv: 'JSYnKCkqKywtLi8w' }
  };
  const lines = []; let passed = 0, failed = 0;
  const out = document.getElementById('out');
  const log = (s) => { lines.push(s); out.textContent = lines.join('\n'); };
  const ok = (c, name, extra) => { if (c) passed++; else failed++; log('  ' + (c ? '✓ ' : '✗ ') + name + (extra ? ' — ' + extra : '')); };
  const skip = (name, why) => log('  ○ ' + name + ' — skipped: ' + why);
  const N = () => window.NotemakerNative;
  const req = (m, p) => N().request(m, p);
  const rejects = async (m, p, name, expect) => {
    try { await req(m, p); ok(false, name, 'did not reject'); } catch (e) { ok(!expect || String(e.message).includes(expect), name, 'rejected: ' + e.message); }
  };
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const te = new TextEncoder();
  const uuid = () => crypto.randomUUID();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextEvent = (type, trigger, ms) => new Promise((res, rej) => {
    const h = (e) => { if (e.detail && e.detail.type === type) { clearTimeout(t); window.removeEventListener('notemaker-native', h); res(e.detail); } };
    const t = setTimeout(() => { window.removeEventListener('notemaker-native', h); rej(new Error('no ' + type + ' event')); }, ms || 5000);
    window.addEventListener('notemaker-native', h);
    trigger();
  });

  async function hkdf(ikm, salt, info) {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, 256));
  }
  async function gcmOpen(keyBytes, iv, ct, aad) {
    const k = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, k, ct));
  }

  async function run() {
    const platform = N() && N().platform;
    const desktop = platform === 'windows' || platform === 'linux';
    log('Environment (' + navigator.userAgent + ')');
    ok(!!N() && N().isDesktop === true && ['windows', 'linux', 'android'].includes(platform), 'NotemakerNative injected', platform + ' ' + (N() && N().shellVersion));
    ok(Object.isFrozen(N()), 'bridge object frozen');
    ok(window.isSecureContext === true, 'isSecureContext', location.origin);
    ok(!!(window.crypto && crypto.subtle), 'crypto.subtle available');
    ok(typeof crypto.randomUUID === 'function', 'crypto.randomUUID available');
    ok(typeof window.__TAURI__ === 'undefined', 'no global __TAURI__ API exposed to the page');

    log('app.capabilities');
    const caps = await req('app.capabilities');
    ok(caps && caps.platform === platform && caps.storage === true && caps.blobs === true, 'capabilities basics', JSON.stringify(caps));
    const expectKey = { windows: 'windows-hello', linux: 'fido2', android: 'android-keystore' }[platform];
    ok(caps.hardwareKey === expectKey, 'hardwareKey = ' + expectKey);
    ok(caps.tray === desktop && caps.notifyWhenClosed === (platform === 'android') && caps.badge === false, 'tray / notifyWhenClosed / badge flags');

    log('WebCrypto vault vectors (recovery slot, android-keystore software key)');
    try {
      const s = VEC.slot;
      const wrap = await hkdf(unb64(VEC.recoveryBytes), unb64(s.salt), 'notemaker/vault/v1/recovery');
      const vdk = await gcmOpen(wrap, unb64(s.iv), unb64(s.ct), 'notemaker/vault/v1/slot/' + s.id);
      ok(b64(vdk) === VEC.vdk, 'HKDF + AES-GCM unwrap → VDK matches vector');
      const ver = await gcmOpen(vdk, unb64(VEC.verifier.iv), unb64(VEC.verifier.ct), 'notemaker/vault/v1/verifier');
      ok(new TextDecoder().decode(ver) === 'notemaker-vault-ok', 'verifier decrypts');
    } catch (e) { ok(false, 'WebCrypto vector', e.message); }

    log('storage.* (temporary data folder)');
    const first = await req('storage.load');
    ok(first && first.json === null, 'storage.load on empty folder → null');
    const doc = JSON.stringify({ app: 'notemaker', version: 2, tasks: [], notes: {}, marker: 'ü✓' });
    ok((await req('storage.save', { json: doc })).ok === true, 'storage.save');
    ok((await req('storage.load')).json === doc, 'storage.load returns saved JSON (UTF-8 intact)');
    const doc2 = JSON.stringify({ app: 'notemaker', version: 2, second: true });
    await req('storage.save', { json: doc2 });
    const files = await req('selftest.trigger', { action: 'storageFiles' });
    ok(files.files.includes('notemaker-data.json') && files.files.includes('notemaker-data.backup.json'), 'second save rotates notemaker-data.backup.json', files.files.join(', '));
    await rejects('storage.save', { json: 'not json' }, 'storage.save rejects invalid JSON');
    await rejects('storage.save', { json: '[1,2]' }, 'storage.save rejects non-object JSON');
    await rejects('storage.save', {}, 'storage.save rejects missing json', 'json must be a string');

    log('blobs.*');
    const id = uuid(), iv = crypto.getRandomValues(new Uint8Array(12)), ct = crypto.getRandomValues(new Uint8Array(1000));
    ok((await req('blobs.put', { id, iv: b64(iv), ct: b64(ct) })).ok === true, 'blobs.put');
    const got = await req('blobs.get', { id });
    ok(got && got.iv === b64(iv) && got.ct === b64(ct), 'blobs.get round trip');
    ok((await req('blobs.delete', { id })).ok === true, 'blobs.delete');
    ok((await req('blobs.get', { id })) === null, 'blobs.get after delete → null');
    await rejects('blobs.put', { id: '../../etc/passwd', iv: b64(iv), ct: b64(ct) }, 'blobs.put rejects non-UUID id', 'UUID');
    await rejects('blobs.put', { id, iv: b64(new Uint8Array(8)), ct: b64(ct) }, 'blobs.put rejects 8-byte iv');
    await rejects('blobs.put', { id, iv: b64(iv), ct: '%%%not base64%%%' }, 'blobs.put rejects bad base64');
    await rejects('blobs.put', { id, iv: b64(iv), ct: b64(new Uint8Array(4)) }, 'blobs.put rejects too-short ct', 'too short');

    log('hw.* (no prompt is triggered)');
    const hw = await req('hw.available');
    ok(hw && hw.kind === expectKey && typeof hw.available === 'boolean' && typeof hw.device === 'string', 'hw.available', JSON.stringify(hw));
    await rejects('hw.createSlot', { slotId: uuid(), label: 'x', vdk: b64(new Uint8Array(16)) }, 'hw.createSlot rejects 16-byte vdk', 'vdk must be 32 bytes');
    await rejects('hw.createSlot', { slotId: 'nope', label: 'x', vdk: VEC.vdk }, 'hw.createSlot rejects bad slotId', 'UUID');
    await rejects('hw.createSlot', { slotId: uuid(), label: 'x', vdk: VEC.vdk, pin: '12' }, 'hw.createSlot rejects 2-char PIN', 'pin');
    await rejects('hw.unwrapSlot', { slot: { id: uuid(), type: 'recovery' } }, 'hw.unwrapSlot rejects a recovery slot', 'slot.type must be');
    await rejects('hw.unwrapSlot', { slot: 'x' }, 'hw.unwrapSlot rejects non-object slot', 'slot must be an object');
    if (platform === 'windows') {
      const sid = uuid();
      await rejects('hw.unwrapSlot', { slot: { id: sid, type: 'windows-hello', keyName: 'someone-else', challenge: b64(new Uint8Array(32)), iv: VEC.akSlot.iv, ct: VEC.vdk } }, 'windows-hello: foreign keyName refused', 'keyName');
      if (!hw.available) skip('windows-hello not-this-device', 'Windows Hello not set up');
      else await rejects('hw.unwrapSlot', { slot: { id: sid, type: 'windows-hello', keyName: 'notemaker-vault-' + sid, challenge: b64(new Uint8Array(32)), iv: VEC.akSlot.iv, ct: VEC.vdk } }, 'windows-hello: unknown key → not-this-device', 'not-this-device');
    }
    if (platform === 'android') {
      const sid = uuid();
      await rejects('hw.unwrapSlot', { slot: { id: sid, type: 'android-keystore', keyAlias: 'other', iv: VEC.akSlot.iv, ct: b64(new Uint8Array(48)) } }, 'android-keystore: foreign keyAlias refused', 'keyAlias');
      await rejects('hw.unwrapSlot', { slot: { id: sid, type: 'android-keystore', keyAlias: 'notemaker-vault-' + sid, iv: VEC.akSlot.iv, ct: b64(new Uint8Array(48)) } }, 'android-keystore: unknown key → not-this-device', 'not-this-device');
    }
    if (platform === 'linux') {
      if (hw.available) skip('fido2 unwrap', 'a security key is plugged in; not touching it');
      else await rejects('hw.unwrapSlot', { slot: { id: uuid(), type: 'fido2-hmac', rpId: 'notemaker.local', credentialId: 'dGVzdA', salt: b64(new Uint8Array(32)), hkdfSalt: b64(new Uint8Array(16)), iv: VEC.akSlot.iv, ct: b64(new Uint8Array(48)) } }, 'fido2-hmac without a key → no-device', 'no-device');
    }
    ok((await req('hw.deleteSlot', { slotId: uuid() })).ok === true, 'hw.deleteSlot of an unknown slot is ok');
    if (/[?&]hw=1/.test(location.search)) {
      // Interactive: create a real hardware slot, unwrap it, delete it (the tester answers the prompts).
      log('hw round trip (interactive)');
      try {
        const sid = uuid(), vdk = crypto.getRandomValues(new Uint8Array(32));
        log('  … answer the prompt (create)');
        const slot = await req('hw.createSlot', { slotId: sid, label: 'Self-test', vdk: b64(vdk) });
        ok(slot.type === caps.hardwareSlotType && slot.id === sid && unb64(slot.iv).length === 12 && unb64(slot.ct).length === 48, 'hw.createSlot returns a ' + slot.type + ' keyslot', JSON.stringify(Object.keys(slot)));
        log('  … answer the prompt (unlock)');
        const r = await req('hw.unwrapSlot', { slot });
        ok(r.vdk === b64(vdk), 'hw.unwrapSlot returns the same VDK');
        ok((await req('hw.deleteSlot', { slotId: sid })).ok === true, 'hw.deleteSlot');
        await rejects('hw.unwrapSlot', { slot }, 'unwrap after delete → not-this-device', 'not-this-device');
      } catch (e) { ok(false, 'hw round trip', e.message); }
    }
    const se = await req('se.available');
    ok(se && se.available === false && typeof se.device === 'string' && se.device.length > 0, 'se.available → false + device name', se && se.device);

    log('notify / app / clipboard (non-interactive)');
    const perm = await req('notify.permission');
    ok(perm && ['granted', 'denied', 'default'].includes(perm.status), 'notify.permission', perm && perm.status);
    await rejects('notify.sync', { items: 'nope' }, 'notify.sync validates items');
    await rejects('notify.sync', { items: [{ id: 'x', title: 't', body: '', at: 'not-a-date', day: '2026-11-16' }] }, 'notify.sync validates at');
    await rejects('notify.sync', { items: [{ id: 'x', title: 't', body: '', at: '2030-01-01T09:00:00.000Z', day: '2026-02-30' }] }, 'notify.sync validates day');
    const future = new Date(Date.now() + 3 * 864e5).toISOString();
    const past = new Date(Date.now() - 60e3).toISOString();
    const sync = await req('notify.sync', { items: [{ id: 'selftest|1', title: 'Self-test reminder', body: '', at: future, day: future.slice(0, 10) }, { id: 'selftest|2', title: 'past', body: '', at: past, day: past.slice(0, 10) }] });
    ok(sync && sync.scheduled === 1, 'notify.sync schedules future items only', JSON.stringify(sync));
    ok((await req('notify.sync', { items: [] })).scheduled === 0, 'notify.sync [] clears');
    ok((await req('app.setBadge', { count: 0 })).ok === true, 'app.setBadge 0 (no-op)');
    await rejects('app.setBadge', { count: -1 }, 'app.setBadge validates count');
    ok((await req('app.setFocusTimer', { label: '24:59', phase: 'focus' })).ok === true, 'app.setFocusTimer show');
    if (desktop) {
      const t = await req('selftest.trigger', { action: 'tray' });
      ok(t.ok === true && t.focusLabel === '24:59', 'tray icon exists and shows the focus timer', JSON.stringify(t));
    }
    ok((await req('app.setFocusTimer', { label: null })).ok === true, 'app.setFocusTimer hide');
    await rejects('app.setFocusTimer', { label: '1', phase: 'nap' }, 'app.setFocusTimer validates phase');
    ok((await req('app.vaultState', { unlocked: true, autoLockMinutes: 7 })).ok === true, 'app.vaultState');
    const vs = await req('selftest.trigger', { action: 'vaultState' });
    ok(vs.unlocked === true && vs.autoLockMinutes === 7, 'app.vaultState stored');
    await req('app.vaultState', { unlocked: false });
    await rejects('app.vaultState', { unlocked: 'yes' }, 'app.vaultState validates unlocked');
    await rejects('app.openExternal', { url: 'file:///etc/passwd' }, 'app.openExternal rejects file://');
    await rejects('app.openExternal', { url: 'javascript:alert(1)' }, 'app.openExternal rejects javascript:');
    await rejects('clipboard.write', { text: 'x', clearAfterSeconds: 0 }, 'clipboard.write validates clearAfterSeconds');
    await rejects('files.save', { suggestedName: 'x.txt', base64: '%%%' }, 'files.save rejects bad base64 before any dialog', 'base64');
    try {
      const secret = 'notemaker-selftest-' + Math.random().toString(36).slice(2);
      await req('clipboard.write', { text: secret, clearAfterSeconds: 1 });
      const c1 = await req('selftest.trigger', { action: 'clipboardRead' });
      ok(c1.text === secret, 'clipboard.write');
      await sleep(platform === 'android' ? 2500 : 1800);
      const c2 = await req('selftest.trigger', { action: 'clipboardRead' });
      ok(c2.text !== secret, 'clipboard cleared after clearAfterSeconds', JSON.stringify(c2.text));
    } catch (e) { ok(false, 'clipboard', e.message); }
    await rejects('no.such.method', {}, 'unknown method rejected', 'unknown method');

    log('events');
    if (desktop) {
      for (const command of ['newTask', 'transfer', 'restore', 'export', 'import', 'today', 'prevDay', 'nextDay', 'lockVault', 'view:vault', 'view:settings', 'search', 'palette', 'review', 'focus.toggle']) {
        try {
          const ev = await nextEvent('menu', () => req('selftest.trigger', { action: 'menu', arg: command }), 3000);
          ok(ev.command === command, 'menu item sends menu “' + command + '”');
        } catch (e) { ok(false, 'menu ' + command, e.message); }
      }
    } else skip('menu', 'no menu on ' + platform);
    try {
      const ev = await nextEvent('lock', () => req('selftest.trigger', { action: 'lock' }));
      ok(ev.reason === 'screen-lock', 'lock event', ev.reason);
    } catch (e) { ok(false, 'lock event', e.message); }
    try {
      const content = JSON.stringify({ format: 'notemaker-transfer', version: 1, note: 'self-test ✓' });
      const ev = await nextEvent('openTransfer', () => req('selftest.trigger', { action: 'openTransfer', arg: content }));
      ok(ev.fileName === 'Selftest transfer.notemaker', 'openTransfer fileName', ev.fileName);
      ok(new TextDecoder().decode(unb64(ev.base64)) === content, 'openTransfer base64 = file bytes');
      const again = await req('shell.takeTransfer');
      ok(again === null, 'transfer bytes are handed out once');
    } catch (e) { ok(false, 'openTransfer', e.message); }
    const undo = await new Promise((res) => {
      const h = (e) => { window.removeEventListener('notemaker-native', h); res(e.detail); };
      window.addEventListener('notemaker-native', h);
      window.__notemakerMenuUndo('undo');
    });
    ok(undo && undo.type === 'menu' && undo.command === 'undo', 'undo outside text field → menu event');
  }

  window.addEventListener('load', () => {
    setTimeout(() => {
      run().catch((e) => ok(false, 'uncaught', e && e.message)).finally(() =>
        N().request('selftest.done', { passed, failed, lines }).catch(() => {}));
    }, 300);
  });
})();
