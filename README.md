# JavaScript Updates

Headless JavaScript source selection for Electron and Expo. The client owns its UI and decides when to flush state and restart. Switching or importing JavaScript never rewrites the signed application.

- **Built-in**: the original bundle in the installed application.
- **Saved bundles**: immutable compatible bundles in application data.
- **Development server**: a live origin with a runtime compatibility preflight.

## Install

On the tailnet:

```sh
npm install @tonyxiao/javascript-updates --registry=https://npm.meteor-ruffe.ts.net/
```

Public CI and cloud builders can install the same built package without Tailscale:

```sh
npm install https://github.com/tonyxiao/javascript-updates/releases/download/v0.1.0/tonyxiao-javascript-updates-0.1.0.tgz
```

The source repository is public. The registry is optional; no Git dependency or install-time build is needed when using the release tarball.

## Entry points

- `@tonyxiao/javascript-updates`: shared source, snapshot, capability, and manifest contracts. No platform imports.
- `/electron`: filesystem-backed bundle storage, ZIP import/download, source selection, checksums, startup acknowledgements and rollback.
- `/expo`: an adapter around `expo-updates`. Pass the installed SDK module instead of adding another Expo dependency. Explicit source selection requires a native `ExpoSourceController`; production Expo Updates alone does not expose an arbitrary saved-bundle picker or disk import.
- `/vite`: development metadata and build-manifest plugin.

## Electron

```ts
const updates = new ElectronUpdates({
  directory: path.join(app.getPath('userData'), 'javascript-source-updates'),
  builtInDirectory: path.join(app.getAppPath(), 'web'),
  runtimeVersion: 'my-native-bridge-v1',
  defaultDevelopmentServerUrl: process.env.VITE_DEV_SERVER_URL,
  reload: async () => { app.relaunch(); app.quit(); },
});
await updates.initialize();
const launch = await updates.prepareLaunch();
// Serve launch.assetDirectory through the application's existing custom protocol,
// or proxy launch.serverUrl. Keep the same origin and preload bridge.
// After the client actually mounts, acknowledge the token through host IPC:
await updates.notifyAppReady(launch.token);
```

Only call `notifyAppReady` when there is a non-null token. On a startup crash or ready timeout, call `failLaunch(token)` and restart if it returns true. If the process exits before acknowledgement, the next initialize rolls back automatically. Built-in is the final offline recovery target. This is startup recovery, not a guarantee of recovery from every later application error.

`select` persists a next source; it does not restart or discard drafts. `snapshot` distinguishes the currently running source from the selected source. An explicit selection overrides the dev runner default. `resetDevelopmentServer` restores that default. An unavailable or incompatible server falls back to the last working source or Built-in.

## Bundle format

A ZIP contains `source-update.json` and every listed file. The manifest contains:

```json
{
  "formatVersion": 1,
  "id": "release-123",
  "version": "1.2.3",
  "platform": "electron",
  "runtimeVersion": "my-native-bridge-v1",
  "launchAsset": "index.html",
  "assets": { "index.html": "<64-character SHA-256>" }
}
```

IDs are immutable. Archives must contain all assets with matching hashes; traversal and oversized archives are rejected. Bundle storage is separate from the installed application. Native upgrades retain saved bundles but incompatible bundles cannot launch. The host defines its native runtime compatibility identifier and changes it when the bridge or required native capabilities change. A hash is useful only if the inputs represent the actual native build contract.

Use `packBundle(directory, { runtimeVersion, version })` from `/electron` to create an archive from a built renderer, including copied public assets. The `/vite` plugin advertises `/.well-known/javascript-source.json` and emits a manifest for generated assets; packing recomputes the full manifest. Serve equivalent metadata from Metro before enabling strict preflight there.

## Remote updates

Set `updateUrl` to a feed returning `{ manifest, url, sha256 }`. `checkForUpdate` validates runtime compatibility; `fetchUpdate` downloads and imports without activating. The host chooses polling, channel/feed URL, and whether to select/restart automatically. No scheduler or hosted service is required. Downloaded bundles launch offline. Checksums detect corruption; use `verifyManifest` for an application-specific authenticity policy. A feed is executable-code distribution and must be trusted by the host.

## Expo

```ts
import * as Updates from 'expo-updates';
const client = createExpoUpdatesClient({ updates: Updates, platform: 'ios' });
const available = await client.checkForUpdate();
if (available) await client.fetchUpdate();
// After flushing drafts, when the client permits a restart:
await client.reload();
```

Expo owns its cache, runtime-version filtering, and recovery. The adapter does not modify Expo's database or claim that its cache is a user-managed bundle library. Capabilities explicitly report the missing operations. In a development client, production update methods may be unavailable; use the native source-controller extension for Metro and manual Built-in recovery. The same runtime preflight helper is available to both platforms.

## Development

`npm ci`, `npm test`, `npm run typecheck`. Git installs build through `prepare`; releases should publish the built package. No React, Electron runtime, or Expo dependency is loaded by the core entry point.
