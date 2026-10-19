# @tonyxiao/javascript-source

Headless source contracts and an Expo adapter. The root export has no platform imports.

```ts
import type { JavaScriptSourceClient } from '@tonyxiao/javascript-source';
import { createExpoUpdatesClient } from '@tonyxiao/javascript-source/expo';
import * as Updates from 'expo-updates';

const client: JavaScriptSourceClient = createExpoUpdatesClient({
  updates: Updates,
  platform: 'ios',
});
const update = await client.checkForUpdate();
if (update) await client.fetchUpdate();
// Flush drafts before restarting.
await client.reload();
```

A client exposes `snapshot`, `select`, `reload`, `resetDevelopmentServer`, `checkForUpdate`, and `fetchUpdate`. Snapshots distinguish the running source from a queued selection and report supported capabilities. Source kinds are `built-in`, `bundle`, and `development-server`.

Expo owns its update cache, runtime-version filtering, and recovery. This adapter does not modify Expo's database. Production Expo Updates does not expose arbitrary saved-bundle import or a manual version picker. Explicit source switching requires an `ExpoSourceController`; `createExpoLauncherController` adapts a native launcher exposing `getSourceInfo`, `loadApp`, and `loadEmbeddedBundle`. Production update APIs may be unavailable in development clients.

`checkDevelopmentServer` validates runtime metadata from `/.well-known/javascript-source.json?platform=ios|android|electron` before remote code runs. The native host supplies the compatibility identifier. Use the Electron package's Vite plugin or serve equivalent metadata from Metro.

For Electron, install `@tonyxiao/electron-updates` alongside this package. Its engine implements the same `JavaScriptSourceClient` interface. UI stays in the application.
