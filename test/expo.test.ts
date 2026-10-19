import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExpoUpdatesClient, type ExpoUpdatesEngine } from '../dist/expo.js';
function engine(overrides: Partial<ExpoUpdatesEngine> = {}): ExpoUpdatesEngine {
  return { isEnabled: true, isEmbeddedLaunch: true, runtimeVersion: 'native-v1', updateId: null,
    checkForUpdateAsync: async () => ({ isAvailable: true, manifest: { id: 'update-a', runtimeVersion: 'native-v1' } }),
    fetchUpdateAsync: async () => ({ isNew: true, manifest: { id: 'update-a' } }), reloadAsync: async () => {}, ...overrides };
}
test('Expo delegates updates and distinguishes running Built-in from downloaded next source', async () => {
  const client = createExpoUpdatesClient({ updates: engine(), platform: 'ios' });
  assert.equal((await client.checkForUpdate())?.id, 'update-a');
  await client.fetchUpdate();
  const snapshot = await client.snapshot();
  assert.deepEqual(snapshot.current, { kind: 'built-in' });
  assert.deepEqual(snapshot.selected, { kind: 'bundle', bundleId: 'update-a' });
  assert.equal(snapshot.capabilities.importBundle, false);
  await assert.rejects(client.select({ kind: 'built-in' }), /requires the native/);
});
test('Expo development mode exposes unsupported capabilities rather than invoking production APIs', async () => {
  const client = createExpoUpdatesClient({ updates: engine({ isEnabled: false }), platform: 'android' });
  assert.equal((await client.snapshot()).capabilities.automaticUpdates, false);
  await assert.rejects(client.checkForUpdate(), /development client/);
});
test('Expo rejects incompatible manifests and checks Metro before asking native controller to select', async () => {
  const client = createExpoUpdatesClient({ updates: engine({ checkForUpdateAsync: async () => ({ isAvailable: true, manifest: { id: 'bad', runtimeVersion: 'other' } }) }), platform: 'ios' });
  await assert.rejects(client.checkForUpdate(), /Incompatible/);
  let selected = false;
  const native = createExpoUpdatesClient({ updates: engine(), platform: 'ios',
    request: async () => Response.json({ platform: 'ios', runtimeVersion: 'other' }),
    sourceController: { snapshot: async () => ({ current: { kind: 'built-in' }, selected: { kind: 'built-in' }, bundles: [], recoveryReason: null }), select: async () => { selected = true; }, reload: async () => {} } });
  await assert.rejects(native.select({ kind: 'development-server', url: 'http://100.100.100.100:8081' }), /Incompatible/);
  assert.equal(selected, false);
});
