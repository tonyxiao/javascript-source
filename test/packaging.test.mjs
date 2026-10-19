import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
test('built packages install together and recover offline in an independent consumer', async t => {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const directory = await mkdtemp(path.join(root, 'tmp/package-consumer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--workspaces', '--json', '--pack-destination', directory], { cwd: root, encoding: 'utf8' }));
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...packed.map(p => path.join(directory, p.filename))], { cwd: directory, stdio: 'pipe' });
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, readFile } from 'node:fs/promises';
    import { registerHooks } from 'node:module';
    // Mobile entry points must load without resolving any Node or Electron modules.
    const hook = registerHooks({ resolve(specifier, context, next) {
      if (specifier.startsWith('node:') || specifier === 'electron' || specifier === 'fflate') throw new Error('Platform dependency in mobile entry: ' + specifier);
      return next(specifier, context);
    }});
    await import('@tonyxiao/javascript-source');
    await import('@tonyxiao/javascript-source/expo');
    hook.deregister();
    const { ElectronUpdates, packBundle } = await import('@tonyxiao/electron-updates');
    const { electronUpdates } = await import('@tonyxiao/electron-updates/vite');
    assert.equal(electronUpdates({runtimeVersion:'native-v1',version:'1'}).name, 'electron-updates');
    await mkdir('built-in'); await writeFile('built-in/index.html','original');
    await mkdir('renderer'); await writeFile('renderer/index.html','saved');
    const options = { directory:'data',builtInDirectory:'built-in',runtimeVersion:'native-v1',reload:async()=>{} };
    const engine = new ElectronUpdates(options); await engine.initialize();
    const archive = await packBundle('renderer',{runtimeVersion:'native-v1',version:'1',id:'saved'});
    await engine.importArchive(archive);
    await engine.select({kind:'bundle',bundleId:'saved'});
    const launch = await engine.prepareLaunch();
    assert.equal(await readFile(launch.assetDirectory+'/index.html','utf8'),'saved');
    // Simulate startup crash: no ready acknowledgement, then reopen storage.
    const recovered = new ElectronUpdates(options); await recovered.initialize();
    assert.deepEqual((await recovered.prepareLaunch()).source,{kind:'built-in'});
    assert.equal(await readFile('built-in/index.html','utf8'),'original');
    assert.equal((await recovered.snapshot()).bundles[0].status,'failed');
  `;
  await writeFile(path.join(directory, 'consumer.mjs'), script);
  assert.doesNotThrow(() => execFileSync(process.execPath, ['consumer.mjs'], { cwd: directory, stdio: 'pipe' }));
});
