import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import {
  BUNDLE_MANIFEST_FILE, assertCompatible, checkDevelopmentServer, isSafeAssetPath,
  normalizeDevelopmentServerUrl, parseManifest, parseSource,
  type BundleManifest, type JavaScriptSource, type JavaScriptSourceClient, type SourceSnapshot,
} from './core.js';

interface BundleRecord { manifest: BundleManifest; status: 'ready' | 'failed' }
interface StoreState {
  version: 1;
  selected: JavaScriptSource;
  lastSuccessful: JavaScriptSource;
  pending: { token: string; source: JavaScriptSource } | null;
  bundles: BundleRecord[];
  recoveryReason: string | null;
}
export interface ElectronUpdatesOptions {
  /** Must be outside the signed app, normally under app.getPath('userData'). */
  directory: string;
  builtInDirectory: string;
  runtimeVersion: string;
  defaultDevelopmentServerUrl?: string;
  initialSource?: JavaScriptSource;
  reload: () => Promise<void>;
  /** A protocol-compatible feed returns { manifest, url, sha256 }. No hosted service is required. */
  updateUrl?: string;
  request?: typeof fetch;
  /** Optional authenticity policy; called before importing any remote or local bundle. */
  verifyManifest?: (manifest: BundleManifest) => Promise<void>;
}
export interface UpdateDescriptor { manifest: BundleManifest; url: string; sha256: string }
export interface LaunchTarget {
  source: JavaScriptSource;
  token: string | null;
  assetDirectory: string | null;
  serverUrl: string | null;
}
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sameSource = (a: JavaScriptSource, b: JavaScriptSource) => JSON.stringify(a) === JSON.stringify(b);

/** One instance per native main process. All mutations are serialized and state writes are atomic. */
export class ElectronUpdates implements JavaScriptSourceClient {
  private state!: StoreState;
  private queue: Promise<unknown> = Promise.resolve();
  private current: JavaScriptSource = { kind: 'built-in' };
  private initialized = false;
  private update: UpdateDescriptor | null = null;
  private readonly options: ElectronUpdatesOptions;
  readonly runtime: { platform: 'electron'; runtimeVersion: string };

  constructor(options: ElectronUpdatesOptions) {
    if (path.resolve(options.directory) === path.resolve(options.builtInDirectory) ||
        path.resolve(options.directory).startsWith(path.resolve(options.builtInDirectory) + path.sep)) {
      throw new Error('Bundle storage must be outside the built-in frontend.');
    }
    this.options = options;
    this.runtime = { platform: 'electron', runtimeVersion: options.runtimeVersion };
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private async persist(): Promise<void> {
    const temp = path.join(this.options.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, path.join(this.options.directory, 'state.json'));
  }
  private bundleDirectory(id: string): string { return path.join(this.options.directory, 'bundles', id); }
  private initialState(): StoreState {
    const selected: JavaScriptSource = this.options.initialSource ?? (this.options.defaultDevelopmentServerUrl
      ? { kind: 'development-server', url: normalizeDevelopmentServerUrl(this.options.defaultDevelopmentServerUrl) }
      : { kind: 'built-in' });
    return { version: 1, selected, lastSuccessful: { kind: 'built-in' }, pending: null, bundles: [], recoveryReason: null };
  }
  async initialize(): Promise<void> {
    return this.mutate(async () => {
      if (this.initialized) return;
      await mkdir(path.join(this.options.directory, 'bundles'), { recursive: true });
      try {
        const stored = JSON.parse(await readFile(path.join(this.options.directory, 'state.json'), 'utf8')) as StoreState;
        if (stored.version !== 1 || !Array.isArray(stored.bundles)) throw new Error('Invalid update state.');
        this.state = { ...stored, selected: parseSource(stored.selected), lastSuccessful: parseSource(stored.lastSuccessful),
          bundles: stored.bundles.map(record => ({ manifest: parseManifest(record.manifest), status: record.status === 'failed' ? 'failed' : 'ready' })) };
        if (stored.pending) {
          const failed = parseSource(stored.pending.source);
          if (failed.kind === 'bundle') {
            const record = this.state.bundles.find(b => b.manifest.id === failed.bundleId);
            if (record) record.status = 'failed';
          }
          // A user selection made after this failed launch must still win.
          if (sameSource(this.state.selected, failed)) this.state.selected = sameSource(this.state.lastSuccessful, failed) ? { kind: 'built-in' } : this.state.lastSuccessful;
          this.state.pending = null;
          this.state.recoveryReason = 'The previous JavaScript source did not confirm startup; restored the last working source.';
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          // Preserve corrupt state for diagnosis while guaranteeing an offline escape hatch.
          await rename(path.join(this.options.directory, 'state.json'), path.join(this.options.directory, `state-invalid-${randomUUID()}.json`)).catch(() => {});
          this.state = { ...this.initialState(), selected: { kind: 'built-in' }, recoveryReason: 'Invalid update state; restored Built-in.' };
        } else this.state = this.initialState();
      }
      this.initialized = true;
      await this.persist();
    });
  }
  private assertInitialized(): void { if (!this.initialized) throw new Error('Call initialize() first.'); }
  async snapshot(): Promise<SourceSnapshot> {
    await this.queue;
    this.assertInitialized();
    return {
      current: this.current, selected: this.state.selected, runtime: this.runtime,
      defaultDevelopmentServerUrl: this.options.defaultDevelopmentServerUrl ?? null,
      bundles: this.state.bundles.map(({ manifest, status }) => ({ id: manifest.id, version: manifest.version,
        runtimeVersion: manifest.runtimeVersion, compatible: manifest.runtimeVersion === this.runtime.runtimeVersion && manifest.platform === 'electron', status })),
      capabilities: { importBundle: true, manageBundles: true, developmentServer: true, automaticUpdates: !!this.options.updateUrl },
      recoveryReason: this.state.recoveryReason,
    };
  }
  async select(input: JavaScriptSource): Promise<void> {
    return this.mutate(async () => {
      this.assertInitialized();
      const source = parseSource(input);
      await this.validateSource(source);
      this.state.selected = source;
      // Intentional selection is independent of any unacknowledged old renderer.
      this.state.pending = null;
      await this.persist();
    });
  }
  private async validateSource(source: JavaScriptSource): Promise<void> {
    if (source.kind === 'bundle') {
      const record = this.state.bundles.find(b => b.manifest.id === source.bundleId);
      if (!record) throw new Error('Saved bundle not found.');
      assertCompatible(this.runtime, record.manifest);
      if (record.status === 'failed') throw new Error('This bundle previously failed to start. Import a corrected bundle with a new ID.');
      await this.verifyFiles(record.manifest);
    } else if (source.kind === 'development-server') {
      await checkDevelopmentServer(source.url, this.runtime, this.options.request);
    }
  }
  private async verifyFiles(manifest: BundleManifest): Promise<void> {
    for (const [name, hash] of Object.entries(manifest.assets)) {
      const file = path.join(this.bundleDirectory(manifest.id), name);
      if (!(await lstat(file)).isFile() || sha256(await readFile(file)) !== hash) throw new Error(`Bundle asset is missing or modified: ${name}`);
    }
  }
  /** Called before creating the renderer. Startup failure falls back without executing incompatible JS. */
  async prepareLaunch(): Promise<LaunchTarget> {
    return this.mutate(async () => {
      this.assertInitialized();
      let source = this.state.selected;
      try { await this.validateSource(source); }
      catch (error) {
        source = this.state.lastSuccessful;
        try { await this.validateSource(source); } catch { source = { kind: 'built-in' }; }
        this.state.recoveryReason = error instanceof Error ? error.message : String(error);
        this.state.selected = source;
      }
      this.current = source;
      const token = source.kind === 'built-in' ? null : randomUUID();
      this.state.pending = token ? { token, source } : null;
      if (!token) this.state.lastSuccessful = source;
      await this.persist();
      return {
        source, token,
        assetDirectory: source.kind === 'development-server' ? null : source.kind === 'built-in' ? this.options.builtInDirectory : this.bundleDirectory(source.bundleId),
        serverUrl: source.kind === 'development-server' ? source.url : null,
      };
    });
  }
  async notifyAppReady(token: string): Promise<void> {
    return this.mutate(async () => {
      this.assertInitialized();
      if (!this.state.pending || this.state.pending.token !== token) return;
      this.state.lastSuccessful = this.state.pending.source;
      this.state.pending = null;
      this.state.recoveryReason = null;
      await this.persist();
    });
  }
  /** Host may call on renderer crash/ready timeout, then restart. Stale callbacks cannot undo a newer launch. */
  async failLaunch(token: string): Promise<boolean> {
    return this.mutate(async () => {
      if (this.state.pending?.token !== token) return false;
      const failed = this.state.pending.source;
      if (failed.kind === 'bundle') {
        const record = this.state.bundles.find(b => b.manifest.id === failed.bundleId);
        if (record) record.status = 'failed';
      }
      this.state.selected = sameSource(this.state.lastSuccessful, failed) ? { kind: 'built-in' } : this.state.lastSuccessful;
      this.state.pending = null;
      this.state.recoveryReason = 'JavaScript startup failed; restored the last working source.';
      await this.persist();
      return true;
    });
  }
  async resetDevelopmentServer(): Promise<void> {
    if (!this.options.defaultDevelopmentServerUrl) throw new Error('This app was not started with a default development server.');
    await this.select({ kind: 'development-server', url: this.options.defaultDevelopmentServerUrl });
  }
  async reload(): Promise<void> { await this.options.reload(); }
  async importBundle(file: string): Promise<BundleManifest> {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.size > MAX_BUNDLE_BYTES) throw new Error('Select a bundle ZIP smaller than 256 MB.');
    return this.importArchive(new Uint8Array(await readFile(file)));
  }
  async importArchive(archive: Uint8Array): Promise<BundleManifest> {
    return this.mutate(async () => {
      this.assertInitialized();
      if (archive.byteLength > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds size limit.');
      let total = 0;
      const files = unzipSync(archive, { filter: entry => {
        total += entry.originalSize;
        if (total > MAX_BUNDLE_BYTES || !isSafeAssetPath(entry.name.replace(/\/$/, ''))) throw new Error('Unsafe or oversized bundle archive.');
        return !entry.name.endsWith('/');
      } });
      const metadata = files[BUNDLE_MANIFEST_FILE];
      if (!metadata) throw new Error(`Bundle ZIP must contain ${BUNDLE_MANIFEST_FILE}.`);
      const manifest = parseManifest(JSON.parse(new TextDecoder().decode(metadata)));
      assertCompatible(this.runtime, manifest);
      if (manifest.platform === 'electron' && manifest.launchAsset !== 'index.html') throw new Error('Electron bundles must launch index.html.');
      await this.options.verifyManifest?.(manifest);
      const existing = this.state.bundles.find(b => b.manifest.id === manifest.id);
      if (existing) {
        if (JSON.stringify(existing.manifest) !== JSON.stringify(manifest)) throw new Error('Bundle IDs are immutable. Use a new ID for different contents.');
        return manifest;
      }
      if (Object.keys(files).some(name => name !== BUNDLE_MANIFEST_FILE && !Object.hasOwn(manifest.assets, name))) throw new Error('Archive contains unlisted files.');
      for (const [name, hash] of Object.entries(manifest.assets)) {
        if (!files[name] || sha256(files[name]) !== hash) throw new Error(`Bundle checksum mismatch: ${name}`);
      }
      const staging = path.join(this.options.directory, `import-${randomUUID()}`);
      try {
        await mkdir(staging);
        for (const [name, bytes] of Object.entries(files)) {
          const destination = path.join(staging, name);
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, bytes);
        }
        // An orphan from a failed state write is never active; recover it on re-import.
        await rm(this.bundleDirectory(manifest.id), { recursive: true, force: true });
        await rename(staging, this.bundleDirectory(manifest.id));
        this.state.bundles.push({ manifest, status: 'ready' });
        await this.persist();
      } finally { await rm(staging, { recursive: true, force: true }); }
      return manifest;
    });
  }
  async deleteBundle(id: string): Promise<void> {
    return this.mutate(async () => {
      if (!this.state.bundles.some(b => b.manifest.id === id)) throw new Error('Saved bundle not found.');
      if ([this.current, this.state.selected, this.state.lastSuccessful].some(s => s.kind === 'bundle' && s.bundleId === id)) {
        throw new Error('Cannot delete the running, selected, or recovery bundle. Switch to Built-in and confirm a launch first.');
      }
      this.state.bundles = this.state.bundles.filter(b => b.manifest.id !== id);
      await this.persist();
      await rm(this.bundleDirectory(id), { recursive: true, force: true });
    });
  }
  async checkForUpdate(): Promise<BundleManifest | null> {
    if (!this.options.updateUrl) return null;
    const request = this.options.request ?? fetch;
    const response = await request(this.options.updateUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Update check failed (${response.status}).`);
    const descriptor = await response.json() as UpdateDescriptor;
    const manifest = parseManifest(descriptor.manifest);
    assertCompatible(this.runtime, manifest);
    if (typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
        typeof descriptor.url !== 'string' || new URL(descriptor.url).protocol !== 'https:') throw new Error('Invalid update descriptor.');
    this.update = { ...descriptor, manifest };
    const snapshot = await this.snapshot();
    return snapshot.bundles.some(b => b.id === manifest.id) ? null : manifest;
  }
  async fetchUpdate(): Promise<void> {
    const update = this.update;
    if (!update) throw new Error('Check for an update first.');
    const response = await (this.options.request ?? fetch)(update.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body) throw new Error('Bundle download failed.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds size limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (sha256(bytes) !== update.sha256) throw new Error('Bundle download checksum mismatch.');
    // Descriptor and archive must agree, even when the feed returns misleading metadata.
    const manifest = await this.importArchive(bytes);
    if (JSON.stringify(manifest) !== JSON.stringify(update.manifest)) throw new Error('Downloaded manifest does not match the update descriptor.');
  }
}

/** Packs a renderer directory without following symlinks or touching the installed app. */
export async function packBundle(directory: string, options: { runtimeVersion: string; version: string; id?: string }): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  let total = 0;
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeAssetPath(name)) throw new Error('Unsafe asset path.');
      if (entry.isSymbolicLink()) throw new Error('Bundle directories cannot contain symlinks.');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile() && name !== BUNDLE_MANIFEST_FILE) {
        const stat = await lstat(path.join(directory, name));
        total += stat.size;
        if (total > MAX_BUNDLE_BYTES) throw new Error('Bundle exceeds size limit.');
        files[name] = new Uint8Array(await readFile(path.join(directory, name)));
      }
    }
  }
  await walk('');
  const assets = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)]));
  const id = options.id ?? sha256(new TextEncoder().encode(JSON.stringify({ runtimeVersion: options.runtimeVersion, assets })));
  const manifest = parseManifest({ formatVersion: 1, platform: 'electron', runtimeVersion: options.runtimeVersion,
    id, version: options.version, launchAsset: 'index.html', assets });
  files[BUNDLE_MANIFEST_FILE] = new TextEncoder().encode(JSON.stringify(manifest));
  return zipSync(files);
}
