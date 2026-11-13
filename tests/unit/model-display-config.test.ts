import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { validateModelDisplayConfig } from '../../src/config/model-display';

const defaults = await Bun.file(new URL('../../src/config/model-display-defaults.json', import.meta.url)).json();
const modulePath = fileURLToPath(new URL('../../src/config/manager.ts', import.meta.url));
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('configurable model display policy', () => {
  test('validates default and partial policies and rejects malformed rules', () => {
    expect(() => validateModelDisplayConfig(defaults)).not.toThrow();
    expect(() => validateModelDisplayConfig({ groups: [] })).not.toThrow();
    for (const display of [null, [], { groups: {} }, { groups: [{ name: 'Preview', patterns: ['('] }] }, { groups: [{ name: '', patterns: ['preview'] }] }, { groups: [{ name: 'Preview', patterns: ['preview'], separateWhen: 'sometimes' }] }, { poolRules: [{ patterns: ['preview'], pools: [] }] }, { visibility: { hidePatterns: [42] } }]) {
      expect(() => validateModelDisplayConfig(display)).toThrow();
    }
  });

  test('merges partial policy settings, replaces rule arrays, and rejects invalid updates without writing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'display-config-'));
    directories.push(dir);
    await writeFile(join(dir, 'config.json'), JSON.stringify({ display: { groups: [] } }));
    const child = Bun.spawn([process.execPath, '-e', `
      import {readFile} from 'node:fs/promises';
      const {loadProxyConfig, updateProxyConfig, getProxyConfig} = await import(${JSON.stringify(modulePath)});
      const config = await loadProxyConfig();
      const before = await readFile('config.json', 'utf8');
      let rejected = false;
      try { await updateProxyConfig({display:{groups:[{name:'Invalid',patterns:['(']}]}}); } catch { rejected = true; }
      console.log(JSON.stringify({groups:config.display.groups,poolRuleCount:config.display.poolRules.length,rejected,unchanged:before===await readFile('config.json','utf8'),activeGroups:getProxyConfig().display.groups}));
    `], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({ groups: [], poolRuleCount: defaults.poolRules.length, rejected: true, unchanged: true, activeGroups: [] });
    expect(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))).toEqual({ display: { groups: [] } });
  });
});
