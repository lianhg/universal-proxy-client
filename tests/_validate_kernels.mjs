/** 一次性验证：三内核的「配置预检」命令是否可用（好配置必须退出 0） */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildRuntimeConfig } from '../.main-build/core/runtime/config-builder.js';
import { mergeRuntimeSettings } from '../.main-build/core/runtime/types.js';
import * as H from '../.main-build/core/hub/index.js';

const execFileAsync = promisify(execFile);
const BIN_DIR = path.join(os.homedir(), 'AppData/Roaming/universal-proxy-client/bin');
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const node = H.importText(`vless://${UUID}@check.example.net:443?encryption=none&security=tls&sni=check.example#CHECK`).nodes[0];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upc-validate-'));

const cases = [
  { kernel: 'xray', bin: 'xray.exe', args: f => ['-test', '-c', f] },
  { kernel: 'sing-box', bin: 'sing-box.exe', args: f => ['check', '-c', f] },
  { kernel: 'mihomo', bin: 'mihomo.exe', args: f => ['-t', '-f', f, '-d', dir] },
];

for (const c of cases) {
  const bin = path.join(BIN_DIR, c.bin);
  if (!fs.existsSync(bin)) { console.log(c.kernel, '跳过：二进制不存在'); continue; }
  const r = buildRuntimeConfig(node, c.kernel, mergeRuntimeSettings(), [], undefined);
  if (r.blockers.length) { console.log(c.kernel, '生成配置被阻断:', r.blockers[0]); continue; }
  const f = path.join(dir, c.kernel + '.json');
  fs.writeFileSync(f, r.text, 'utf8');
  try {
    const { stdout, stderr } = await execFileAsync(bin, c.args(f), { timeout: 8000, windowsHide: true, cwd: dir, maxBuffer: 1024 * 1024 });
    const out = `${stderr || ''}${stdout || ''}`.trim().split(/\r?\n/).slice(-2).join(' | ');
    console.log(c.kernel, '退出 0 ✓', out.slice(0, 160));
  } catch (e) {
    const out = `${e.stderr || ''}${e.stdout || ''}`.trim().split(/\r?\n/).slice(-3).join(' | ');
    console.log(c.kernel, '退出非 0 ✗ code=', e.code, out.slice(0, 300) || e.message);
  }
}
fs.rmSync(dir, { recursive: true, force: true });
