import { createHash } from 'node:crypto';
import { BUNDLE_MANIFEST_FILE, DEVELOPMENT_MANIFEST_PATH, type BundleManifest } from '@tonyxiao/javascript-source';

export interface ElectronUpdatesPluginOptions {
  runtimeVersion: string;
  version: string;
  /** Supply a release ID in CI; otherwise the content hash provides a stable immutable ID. */
  id?: string;
}

/** Vite/Rollup-compatible plugin without a dependency on either bundler's runtime. */
export function electronUpdates(options: ElectronUpdatesPluginOptions) {
  return {
    name: 'electron-updates',
    enforce: 'post' as const,
    configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: { setHeader: (key: string, value: string) => void; end: (body: string) => void }, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== DEVELOPMENT_MANIFEST_PATH) return next();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ platform: 'electron', runtimeVersion: options.runtimeVersion }));
      });
    },
    generateBundle(this: { emitFile: (file: { type: 'asset'; fileName: string; source: string }) => void }, _output: unknown, bundle: Record<string, { type: string; code?: string; source?: string | Uint8Array }>) {
      const assets: Record<string, string> = {};
      for (const [name, item] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        if (name === BUNDLE_MANIFEST_FILE) continue;
        const content = item.type === 'chunk' ? item.code : item.source;
        if (content !== undefined) assets[name] = createHash('sha256').update(content).digest('hex');
      }
      const contentId = createHash('sha256').update(JSON.stringify({ runtimeVersion: options.runtimeVersion, version: options.version, assets })).digest('hex');
      const manifest: BundleManifest = {
        formatVersion: 1, platform: 'electron', runtimeVersion: options.runtimeVersion,
        id: options.id ?? contentId, version: options.version, launchAsset: 'index.html', assets,
      };
      this.emitFile({ type: 'asset', fileName: BUNDLE_MANIFEST_FILE, source: JSON.stringify(manifest, null, 2) });
    },
  };
}
