/** Platform-neutral types. This entry point has no Node, Electron, React, or Expo imports. */
export type JavaScriptSource =
  | { readonly kind: 'built-in' }
  | { readonly kind: 'bundle'; readonly bundleId: string }
  | { readonly kind: 'development-server'; readonly url: string };

export type UpdatePlatform = 'electron' | 'ios' | 'android';
export const DEVELOPMENT_MANIFEST_PATH = '/.well-known/javascript-source.json';
export const BUNDLE_MANIFEST_FILE = 'source-update.json';

export interface RuntimeIdentity {
  readonly platform: UpdatePlatform;
  readonly runtimeVersion: string;
}

export interface BundleManifest extends RuntimeIdentity {
  readonly formatVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly launchAsset: string;
  /** SHA-256 of every file, relative to the bundle root. */
  readonly assets: Readonly<Record<string, string>>;
}

export interface SavedBundle {
  readonly id: string;
  readonly version: string;
  readonly runtimeVersion: string;
  readonly compatible: boolean;
  readonly status: 'ready' | 'failed';
}

export interface SourceCapabilities {
  readonly importBundle: boolean;
  readonly manageBundles: boolean;
  readonly developmentServer: boolean;
  readonly automaticUpdates: boolean;
}

export interface SourceSnapshot {
  /** The source actually running, not a queued selection. */
  readonly current: JavaScriptSource;
  readonly selected: JavaScriptSource;
  readonly runtime: RuntimeIdentity;
  readonly defaultDevelopmentServerUrl: string | null;
  readonly bundles: readonly SavedBundle[];
  readonly capabilities: SourceCapabilities;
  readonly recoveryReason: string | null;
}

/** Host UI decides when to flush drafts and restart. Selection only persists the next source. */
export interface AvailableUpdate extends RuntimeIdentity {
  readonly id: string;
  readonly version: string;
}

export interface JavaScriptSourceClient {
  snapshot(): Promise<SourceSnapshot>;
  select(source: JavaScriptSource): Promise<void>;
  reload(): Promise<void>;
  resetDevelopmentServer(): Promise<void>;
  checkForUpdate(): Promise<AvailableUpdate | null>;
  fetchUpdate(): Promise<void>;
}

export function assertCompatible(expected: RuntimeIdentity, actual: RuntimeIdentity): void {
  if (actual.platform !== expected.platform || actual.runtimeVersion !== expected.runtimeVersion) {
    throw new Error(`Incompatible JavaScript: requires ${actual.platform}/${actual.runtimeVersion}; installed runtime is ${expected.platform}/${expected.runtimeVersion}.`);
  }
}

export function normalizeDevelopmentServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Development server must be an HTTP(S) origin without credentials, path, query, or fragment.');
  }
  return url.href;
}

export function isSafeAssetPath(value: string): boolean {
  return value.length > 0 && !value.includes('\\') && !value.includes('\0') &&
    !value.includes(':') && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function parseManifest(value: unknown): BundleManifest {
  if (!value || typeof value !== 'object') throw new Error('Invalid bundle manifest.');
  const m = value as Record<string, unknown>;
  if (m.formatVersion !== 1 || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(m.id) ||
      typeof m.version !== 'string' || !m.version || typeof m.runtimeVersion !== 'string' || !m.runtimeVersion ||
      !['electron', 'ios', 'android'].includes(String(m.platform)) ||
      typeof m.launchAsset !== 'string' || !isSafeAssetPath(m.launchAsset) ||
      !m.assets || typeof m.assets !== 'object' || Array.isArray(m.assets)) throw new Error('Invalid bundle manifest.');
  const assets = m.assets as Record<string, unknown>;
  if (!Object.hasOwn(assets, m.launchAsset) || Object.keys(assets).length > 10000 ||
      Object.entries(assets).some(([name, hash]) => !isSafeAssetPath(name) || name === BUNDLE_MANIFEST_FILE ||
        typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid bundle assets.');
  return m as unknown as BundleManifest;
}

export function parseSource(value: unknown): JavaScriptSource {
  if (!value || typeof value !== 'object') throw new Error('Invalid JavaScript source.');
  const source = value as Record<string, unknown>;
  if (source.kind === 'built-in') return { kind: 'built-in' };
  if (source.kind === 'bundle' && typeof source.bundleId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(source.bundleId)) {
    return { kind: 'bundle', bundleId: source.bundleId };
  }
  if (source.kind === 'development-server' && typeof source.url === 'string') {
    return { kind: 'development-server', url: normalizeDevelopmentServerUrl(source.url) };
  }
  throw new Error('Invalid JavaScript source.');
}

/** The same preflight can be used by Metro and Vite adapters, before executing remote JS. */
export async function checkDevelopmentServer(url: string, runtime: RuntimeIdentity, request: typeof fetch = fetch): Promise<void> {
  const metadataUrl = new URL(DEVELOPMENT_MANIFEST_PATH, normalizeDevelopmentServerUrl(url));
  metadataUrl.searchParams.set('platform', runtime.platform);
  const response = await request(metadataUrl, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Development server compatibility check failed (${response.status}).`);
  const metadata = await response.json() as Partial<RuntimeIdentity>;
  if (typeof metadata.runtimeVersion !== 'string' || typeof metadata.platform !== 'string') {
    throw new Error('Development server does not advertise its native runtime.');
  }
  assertCompatible(runtime, metadata as RuntimeIdentity);
}
