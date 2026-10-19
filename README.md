# JavaScript Source

Headless JavaScript source selection and updates for Electron and Expo. Applications own the UI and decide when to flush state and restart.

This monorepo contains two packages:

- [`@tonyxiao/javascript-source`](packages/javascript-source): platform-neutral contracts, compatibility preflight, and an adapter over Expo Updates and an optional native launcher.
- [`@tonyxiao/electron-updates`](packages/electron-updates): Electron bundle storage, ZIP import/download, startup recovery, and Vite integration. Implements the shared `JavaScriptSourceClient` interface.

**Built-in** is the original JavaScript shipped with the app. **Saved bundles** are compatible versions stored in application data. **Development server** loads live JavaScript after checking native compatibility. These operations never rewrite the signed app. Native upgrades retain saved bundles; incompatible versions cannot launch.

## Install

On the tailnet, configure the `@tonyxiao` scope to use `https://npm.meteor-ruffe.ts.net/`, then:

```sh
# Electron
npm install @tonyxiao/javascript-source @tonyxiao/electron-updates
# Expo (use the expo-updates version matching the application's Expo SDK)
npm install @tonyxiao/javascript-source
npx expo install expo-updates
```

`electron-updates` uses `javascript-source` as a peer dependency so the host chooses one shared protocol version. The common package has no Node, Electron, React, or Expo runtime dependency; the Expo adapter accepts the installed SDK module.

Public builders without Tailscale can install the built release artifacts together:

```sh
npm install \
  https://github.com/tonyxiao/javascript-source/releases/download/v0.2.0/tonyxiao-javascript-source-0.2.0.tgz \
  https://github.com/tonyxiao/javascript-source/releases/download/v0.2.0/tonyxiao-electron-updates-0.2.0.tgz
```

Mobile needs only the first artifact. Release artifacts contain compiled JavaScript and types; installation needs no Git checkout or build step.

## Development

`npm ci`, `npm test`, `npm run typecheck`. Build order is contracts first, Electron second. Tests cover both engines and install the packed packages into an independent consumer to exercise exports and offline recovery.
