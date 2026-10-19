import {
  assertCompatible, checkDevelopmentServer, parseSource,
  type AvailableUpdate, type JavaScriptSource, type JavaScriptSourceClient,
  type RuntimeIdentity, type SavedBundle, type SourceSnapshot,
} from './core.js';

/** Structural interface keeps this package independent of an Expo SDK version. Pass expo-updates. */
export interface ExpoUpdatesEngine {
  readonly isEnabled: boolean;
  readonly isEmbeddedLaunch: boolean;
  readonly runtimeVersion: string | null;
  readonly updateId: string | null;
  checkForUpdateAsync(): Promise<{ isAvailable: boolean; isRollBackToEmbedded?: boolean; manifest?: unknown }>;
  fetchUpdateAsync(): Promise<unknown>;
  reloadAsync(): Promise<void>;
}

/** Native launcher integration is explicitly separate from expo-updates' production update engine. */
export interface ExpoSourceController {
  snapshot(): Promise<{
    current: JavaScriptSource;
    selected: JavaScriptSource;
    bundles: readonly SavedBundle[];
    recoveryReason: string | null;
  }>;
  select(source: JavaScriptSource): Promise<void>;
  reload(): Promise<void>;
}

export interface ExpoUpdatesOptions {
  updates: ExpoUpdatesEngine;
  platform: 'ios' | 'android';
  /** Required in dev clients, where expo-updates often reports null. Must come from the native build. */
  runtimeVersion?: string;
  sourceController?: ExpoSourceController;
  defaultDevelopmentServerUrl?: string;
  request?: typeof fetch;
}

export function createExpoUpdatesClient(options: ExpoUpdatesOptions): JavaScriptSourceClient {
  const engine = options.updates;
  const runtime: RuntimeIdentity = { platform: options.platform, runtimeVersion: options.runtimeVersion ?? engine.runtimeVersion ?? '' };
  let pending: JavaScriptSource | null = null;
  const requireRuntime = () => { if (!runtime.runtimeVersion) throw new Error('The native build does not expose a runtime version.'); };
  const currentSource = (): JavaScriptSource => engine.isEmbeddedLaunch || !engine.updateId
    ? { kind: 'built-in' } : { kind: 'bundle', bundleId: engine.updateId };
  return {
    async snapshot(): Promise<SourceSnapshot> {
      const controlled = await options.sourceController?.snapshot();
      const current = controlled?.current ?? currentSource();
      return {
        current, selected: controlled?.selected ?? pending ?? current, runtime,
        bundles: controlled?.bundles ?? [], recoveryReason: controlled?.recoveryReason ?? null,
        defaultDevelopmentServerUrl: options.defaultDevelopmentServerUrl ?? null,
        capabilities: {
          importBundle: false,
          manageBundles: !!options.sourceController,
          developmentServer: !!options.sourceController,
          automaticUpdates: engine.isEnabled,
        },
      };
    },
    async select(input) {
      const source = parseSource(input);
      requireRuntime();
      if (!options.sourceController) throw new Error('Explicit source selection requires the native source controller; expo-updates does not expose a saved-bundle picker.');
      if (source.kind === 'development-server') await checkDevelopmentServer(source.url, runtime, options.request);
      await options.sourceController.select(source);
    },
    async reload() {
      if (options.sourceController) await options.sourceController.reload();
      else await engine.reloadAsync();
    },
    async resetDevelopmentServer() {
      if (!options.defaultDevelopmentServerUrl) throw new Error('No default development server was provided.');
      await this.select({ kind: 'development-server', url: options.defaultDevelopmentServerUrl });
    },
    async checkForUpdate(): Promise<AvailableUpdate | null> {
      requireRuntime();
      if (!engine.isEnabled) throw new Error('Published updates are unavailable while using this development client.');
      const result = await engine.checkForUpdateAsync();
      if (!result.isAvailable || result.isRollBackToEmbedded) return null;
      const manifest = result.manifest as { id?: string; runtimeVersion?: string; extra?: { version?: string } } | undefined;
      if (!manifest?.id || !manifest.runtimeVersion) throw new Error('Update has no runtime metadata.');
      const update = { id: manifest.id, version: manifest.extra?.version ?? manifest.id, platform: options.platform, runtimeVersion: manifest.runtimeVersion };
      assertCompatible(runtime, update);
      return update;
    },
    async fetchUpdate() {
      if (!engine.isEnabled) throw new Error('Published updates are unavailable while using this development client.');
      const result = await engine.fetchUpdateAsync() as { isNew?: boolean; manifest?: { id?: string }; isRollBackToEmbedded?: boolean };
      if (result.isRollBackToEmbedded) pending = { kind: 'built-in' };
      else if (result.manifest?.id) pending = { kind: 'bundle', bundleId: result.manifest.id };
    },
  };
}
