import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { ElectronUpdates } from '../dist/electron.js';
import { checkDevelopmentServer } from '../dist/core.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function archive(id = 'a', runtimeVersion = 'native-v1', content = '<html>A</html>') {
  const manifest = { formatVersion: 1, id, version: id, platform: 'electron', runtimeVersion, launchAsset: 'index.html', assets: { 'index.html': hash(content) } };
  return { manifest, bytes: zipSync({ 'source-update.json': strToU8(JSON.stringify(manifest)), 'index.html': strToU8(content) }) };
}
async function fixture(t: { after: (f: () => Promise<void>) => void }, defaultDevelopmentServerUrl?: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'source-updates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const builtInDirectory = path.join(root, 'signed-app');
  await mkdir(builtInDirectory);
  await writeFile(path.join(builtInDirectory, 'index.html'), 'original-signed-file');
  const options = { directory: path.join(root, 'data'), builtInDirectory, runtimeVersion: 'native-v1', reload: async () => {},
    ...(defaultDevelopmentServerUrl ? { defaultDevelopmentServerUrl } : {}) };
  const store = new ElectronUpdates(options);
  await store.initialize();
  return { root, store, options };
}

test('imports multiple bundles, loads offline, and never changes the built-in files', async t => {
  const { store, options } = await fixture(t);
  await store.importArchive(archive('a').bytes);
  await store.importArchive(archive('b', 'native-v1', '<html>B</html>').bytes);
  await store.select({ kind: 'bundle', bundleId: 'b' });
  const launch = await store.prepareLaunch();
  assert.equal(await readFile(path.join(launch.assetDirectory!, 'index.html'), 'utf8'), '<html>B</html>');
  assert.equal(await readFile(path.join(options.builtInDirectory, 'index.html'), 'utf8'), 'original-signed-file');
  assert.equal((await store.snapshot()).bundles.length, 2);
  await store.notifyAppReady(launch.token!);
  const reopened = new ElectronUpdates(options);
  await reopened.initialize();
  assert.deepEqual((await reopened.prepareLaunch()).source, { kind: 'bundle', bundleId: 'b' });
});

test('unacknowledged new bundle rolls back to the last confirmed bundle on next launch', async t => {
  const { store, options } = await fixture(t);
  for (const id of ['a', 'b']) await store.importArchive(archive(id).bytes);
  await store.select({ kind: 'bundle', bundleId: 'a' });
  await store.notifyAppReady((await store.prepareLaunch()).token!);
  await store.select({ kind: 'bundle', bundleId: 'b' });
  await store.prepareLaunch();
  const reopened = new ElectronUpdates(options);
  await reopened.initialize();
  assert.deepEqual((await reopened.prepareLaunch()).source, { kind: 'bundle', bundleId: 'a' });
  assert.equal((await reopened.snapshot()).bundles.find(b => b.id === 'b')?.status, 'failed');
});

test('failed relaunch of last successful source falls back to Built-in instead of looping', async t => {
  const { store, options } = await fixture(t);
  await store.importArchive(archive().bytes);
  await store.select({ kind: 'bundle', bundleId: 'a' });
  await store.notifyAppReady((await store.prepareLaunch()).token!);
  await store.prepareLaunch();
  const reopened = new ElectronUpdates(options);
  await reopened.initialize();
  assert.deepEqual((await reopened.prepareLaunch()).source, { kind: 'built-in' });
});

test('timeout recovery ignores stale ready acknowledgements and stale failure callbacks', async t => {
  const { store } = await fixture(t);
  await store.importArchive(archive().bytes);
  await store.select({ kind: 'bundle', bundleId: 'a' });
  const launch = await store.prepareLaunch();
  assert.equal(await store.failLaunch('stale'), false);
  assert.equal(await store.failLaunch(launch.token!), true);
  await store.notifyAppReady(launch.token!);
  assert.deepEqual((await store.snapshot()).selected, { kind: 'built-in' });
});

test('native update retains bundles but rejects incompatible selection and launches Built-in', async t => {
  const { store, options } = await fixture(t);
  await store.importArchive(archive().bytes);
  await store.select({ kind: 'bundle', bundleId: 'a' });
  await store.notifyAppReady((await store.prepareLaunch()).token!);
  const upgraded = new ElectronUpdates({ ...options, runtimeVersion: 'native-v2' });
  await upgraded.initialize();
  assert.equal((await upgraded.snapshot()).bundles[0]?.compatible, false);
  await assert.rejects(upgraded.select({ kind: 'bundle', bundleId: 'a' }), /Incompatible/);
  assert.deepEqual((await upgraded.prepareLaunch()).source, { kind: 'built-in' });
});

test('rejects corruption, incompatible archives, and path traversal before activation', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.importArchive(archive('a', 'other').bytes), /Incompatible/);
  const good = archive();
  await assert.rejects(store.importArchive(zipSync({ 'source-update.json': strToU8(JSON.stringify(good.manifest)), 'index.html': strToU8('modified') })), /checksum/);
  await assert.rejects(store.importArchive(zipSync({ '../outside': strToU8('bad') })), /Unsafe/);
  assert.equal((await store.snapshot()).bundles.length, 0);
});

test('explicit dev URL overrides runner default, reset restores default, Built-in remains selected across restarts', async t => {
  const { store, options } = await fixture(t, 'http://127.0.0.1:5000/');
  const request: typeof fetch = async () => Response.json({ platform: 'electron', runtimeVersion: 'native-v1' });
  const configured = new ElectronUpdates({ ...options, request });
  await configured.initialize();
  await configured.select({ kind: 'development-server', url: 'http://100.100.100.100:6000' });
  assert.equal((await configured.prepareLaunch()).serverUrl, 'http://100.100.100.100:6000/');
  await configured.resetDevelopmentServer();
  assert.equal((await configured.prepareLaunch()).serverUrl, 'http://127.0.0.1:5000/');
  await configured.select({ kind: 'built-in' });
  const reopened = new ElectronUpdates({ ...options, request });
  await reopened.initialize();
  assert.deepEqual((await reopened.prepareLaunch()).source, { kind: 'built-in' });
});

test('dev server preflight refuses mismatched native runtime', async () => {
  await assert.rejects(checkDevelopmentServer('http://100.100.100.100:8081', { platform: 'electron', runtimeVersion: 'v1' },
    async () => Response.json({ platform: 'electron', runtimeVersion: 'v2' })), /Incompatible/);
});

test('corrupt saved state preserves diagnosis and recovers offline', async t => {
  const { options } = await fixture(t);
  await writeFile(path.join(options.directory, 'state.json'), 'incomplete');
  const store = new ElectronUpdates(options);
  await store.initialize();
  assert.deepEqual((await store.prepareLaunch()).source, { kind: 'built-in' });
});

test('cannot delete active or recovery bundles; deleting an unused bundle is persistent', async t => {
  const { store } = await fixture(t);
  await store.importArchive(archive('a').bytes);
  await store.importArchive(archive('b').bytes);
  await store.select({ kind: 'bundle', bundleId: 'a' });
  await assert.rejects(store.deleteBundle('a'), /Cannot delete/);
  await store.deleteBundle('b');
  assert.deepEqual((await store.snapshot()).bundles.map(b => b.id), ['a']);
});

test('packing includes copied public assets and produces an importable bundle', async t => {
  const { packBundle } = await import('../dist/electron.js');
  const { store, root } = await fixture(t);
  const source = path.join(root, 'renderer-build');
  await mkdir(source);
  await writeFile(path.join(source, 'index.html'), '<html>App</html>');
  await writeFile(path.join(source, 'public-image.svg'), '<svg/>');
  const bytes = await packBundle(source, { runtimeVersion: 'native-v1', version: '1.0' });
  const manifest = await store.importArchive(bytes);
  assert.ok(manifest.assets['public-image.svg']);
  await store.select({ kind: 'bundle', bundleId: manifest.id });
  assert.equal((await store.prepareLaunch()).source.kind, 'bundle');
});

test('remote download imports to local storage without selecting or replacing Built-in', async t => {
  const { options } = await fixture(t);
  const update = archive();
  const request: typeof fetch = async input => String(input).includes('feed')
    ? Response.json({ manifest: update.manifest, url: 'https://updates.example/bundle.zip', sha256: createHash('sha256').update(update.bytes).digest('hex') })
    : new Response(update.bytes);
  const store = new ElectronUpdates({ ...options, updateUrl: 'https://updates.example/feed', request });
  await store.initialize();
  assert.equal((await store.checkForUpdate())?.id, 'a');
  await store.fetchUpdate();
  const snapshot = await store.snapshot();
  assert.deepEqual(snapshot.selected, { kind: 'built-in' });
  assert.equal(snapshot.bundles.length, 1);
});
