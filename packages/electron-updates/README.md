# @tonyxiao/electron-updates

Headless JavaScript bundle updates for Electron, modeled after Expo Updates. Install alongside the peer package `@tonyxiao/javascript-source`.

```ts
import { ElectronUpdates } from '@tonyxiao/electron-updates';
import type { JavaScriptSourceClient } from '@tonyxiao/javascript-source';

const updates = new ElectronUpdates({
  directory: path.join(app.getPath('userData'), 'javascript-source-updates'),
  builtInDirectory: path.join(app.getAppPath(), 'web'),
  runtimeVersion: 'my-native-bridge-v1',
  reload: async () => { app.relaunch(); app.quit(); },
});
await updates.initialize();
const client: JavaScriptSourceClient = updates;
const launch = await updates.prepareLaunch();
// Serve assetDirectory or proxy serverUrl through the host's existing origin/preload.
// Once the client mounts, acknowledge the non-null token through host IPC.
if (launch.token) await updates.notifyAppReady(launch.token);
```

`select` persists the next source without restarting. `snapshot` distinguishes running and selected sources. An explicit selection overrides the dev runner default; `resetDevelopmentServer` restores it. Unavailable or incompatible servers fall back to the last working source or Built-in.

An unacknowledged launch rolls back on the next startup. Hosts can enforce a ready timeout with `failLaunch(token)` and restart when it returns true. Built-in remains the offline recovery target. This handles startup failures, not every later application error.

## Bundles and compatibility

`packBundle(directory, { runtimeVersion, version })` returns a ZIP containing `source-update.json` and every asset with SHA-256 hashes. `importBundle(path)` imports from disk; IDs are immutable. Checksums, path traversal, and archive sizes are validated. Storage must remain outside the installed app. Native updates retain saved bundles but incompatible bundles cannot launch. The host changes its runtime identifier when required native capabilities change.

```ts
import { electronUpdates } from '@tonyxiao/electron-updates/vite';
// Add to Vite plugins:
electronUpdates({ runtimeVersion: 'my-native-bridge-v1', version: '1.2.3' });
```

The plugin advertises development compatibility metadata and emits a build manifest. Packing recomputes the manifest to include copied public assets.

## Remote updates

An optional `updateUrl` serves `{ manifest, url, sha256 }`. `checkForUpdate` validates compatibility; `fetchUpdate` downloads and imports without activation. The host owns polling, feeds/channels, selection, and restart policy. Downloaded bundles work offline. Checksums detect corruption; use `verifyManifest` for a host-specific authenticity policy. Trust the feed as executable-code distribution.

This package updates JavaScript, not the native Electron application. Native distribution and signing remain the host's responsibility.
