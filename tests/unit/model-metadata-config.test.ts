import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('loads model metadata defaults with existing config and rejects invalid capability updates atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'model-metadata-'));
  const modulePath = fileURLToPath(new URL('../../src/config/manager.ts', import.meta.url));
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ models: { blacklist: ['custom-blocked'] } }));
    const child = Bun.spawn([process.execPath, '-e', `
      import {readFile} from 'node:fs/promises';
      const {loadProxyConfig,updateProxyConfig,getProxyConfig}=await import(${JSON.stringify(modulePath)});
      const config=await loadProxyConfig();
      const before=await readFile('config.json','utf8');
      let rejected=false;
      try{await updateProxyConfig({models:{overrides:{'gemini-4-hydrogen-sonar':{thinkingLevels:['low'],defaultThinkingLevel:'high'}}}});}catch{rejected=true;}
      const unchanged=before===await readFile('config.json','utf8');
      const originalLevels=getProxyConfig().models.overrides['gemini-4-hydrogen-sonar'].thinkingLevels;
      await updateProxyConfig({models:{overrides:{'gemini-future':{name:'Future',thinkingLevels:['low','medium'],defaultThinkingLevel:'medium'}}}});
      console.log(JSON.stringify({blacklist:config.models.blacklist,originalLevels,rejected,unchanged,future:getProxyConfig().models.overrides['gemini-future']}));
    `], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ blacklist: ['custom-blocked'], originalLevels: ['low', 'medium', 'high'], rejected: true, unchanged: true,
      future: { name: 'Future', thinkingLevels: ['low', 'medium'], defaultThinkingLevel: 'medium' } });
    const persisted = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
    expect(persisted.models.overrides['gemini-4-hydrogen-sonar'].thinkingLevels).toEqual(['low', 'medium', 'high']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
