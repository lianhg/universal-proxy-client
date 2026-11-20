/**
 * WireGuard 跨内核承载回归测试
 * 运行：node tests/wireguard.test.mjs （需先 npx tsc -p tsconfig.runtime.build.json）
 *
 * 背景：曾出现「Xray 配置里混入 wireguard outbound（TCP 代理格式）导致内核整体拒绝启动」。
 * 修复：① 能力矩阵判定 Xray 不承载 wireguard；② config-builder 按当前矩阵重新判定节点，
 * 不信任 localStorage 里的 kernels 快照；③ sing-box / mihomo 走 WireGuard 专属 schema。
 */
import assert from 'node:assert/strict';
import { makeNode } from '../.runtime-build/hub/util.js';
import { KERNEL_MATRIX, buildSingBoxOutbound, buildMihomoProxy, resolveKernelForNode } from '../.runtime-build/hub/kernel.js';
import { buildRuntimeConfig } from '../.runtime-build/runtime/config-builder.js';
import * as R from '../.runtime-build/runtime/rules.js';
import { mergeRuntimeSettings } from '../.runtime-build/runtime/types.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' :: ' + e.message); }
}

const settings = mergeRuntimeSettings();

function wgNode(overrides = {}) {
  return makeNode({
    protocol: 'wireguard', server: '203.0.113.10', port: 51820,
    name: '203.0.113.10:51820', raw: 'wireguard://203.0.113.10:51820', transport: 'none', security: 'none',
    protocolSettings: {
      privateKey: 'PRIVATEKEYBASE64=', publicKey: 'PEERPUBLICKEY=', address: '172.16.0.2/32',
      allowedIPs: '0.0.0.0/0', reserved: '1,2,3', mtu: 1420, ...(overrides.protocolSettings ?? {}),
    },
    ...overrides,
  });
}

function vlessNode(name = 'cdn-1') {
  return makeNode({
    protocol: 'vless', server: 'example.com', port: 443, name,
    uuid: 'f63ee17c-d94f-436c-8132-de63780dbe77', raw: `vless://x@example.com:443?path=/ws`,
    transport: 'ws', security: 'tls',
    transportSettings: { path: '/ws', host: 'example.com' },
  });
}

/* ─────────────── 能力矩阵 ─────────────── */

t('能力矩阵：Xray 不承载 wireguard（核心修复）', () => {
  assert.equal(KERNEL_MATRIX.wireguard.xray.level, 'unsupported');
  assert.ok(KERNEL_MATRIX.wireguard.xray.note.length > 10, '必须写明原因');
});

t('能力矩阵：sing-box / mihomo 原生承载 wireguard', () => {
  assert.equal(KERNEL_MATRIX.wireguard['sing-box'].level, 'native');
  assert.equal(KERNEL_MATRIX.wireguard.mihomo.level, 'native');
});

/* ─────────────── Xray 配置纯净性 ─────────────── */

t('内核裁决：用户手动选择优先，节点不支持才回落体检推荐', () => {
  const ssNode = { kernels: ['xray', 'sing-box', 'mihomo'], kernel: 'xray' };
  assert.equal(resolveKernelForNode(ssNode, 'mihomo'), 'mihomo', '用户选 mihomo 且节点兼容 → mihomo');
  assert.equal(resolveKernelForNode(ssNode, 'xray'), 'xray', '用户选 xray → xray');
  const hysteria2Node = { kernels: ['sing-box'], kernel: 'sing-box' };
  assert.equal(resolveKernelForNode(hysteria2Node, 'xray'), 'sing-box', '节点不支持 xray → 回落体检推荐');
  const noRec = { kernels: [], kernel: null };
  assert.equal(resolveKernelForNode(noRec, 'mihomo'), 'mihomo', '无推荐内核时保留用户选择');
});

t('选中 vless + peers 含 wireguard：Xray outbounds 不得出现 wireguard', () => {
  const v = vlessNode();
  const wg = wgNode();
  const r = buildRuntimeConfig(v, 'xray', settings, [wg]);
  assert.deepEqual(r.blockers, [], '不应有阻断');
  const protos = r.config.outbounds.map(o => o.protocol);
  assert.ok(!protos.includes('wireguard'), `wireguard 混进了 Xray 配置: ${protos}`);
  assert.ok(protos.includes('vless'));
});

t('peers 里的 wireguard 被排除时必须留痕（issue + note），不静默丢弃', () => {
  const v = vlessNode();
  const wg = wgNode();
  const r = buildRuntimeConfig(v, 'xray', settings, [wg]);
  const hit = r.issues.find(i => i.code === 'KERNEL_LIMIT' && /wireguard/i.test(i.message));
  assert.ok(hit, '缺少 KERNEL_LIMIT 说明');
  assert.ok(r.notes.some(n => /未写入配置/.test(n)), 'notes 未说明排除');
});

t('选中 wireguard + xray：必须硬阻断而不是生成必死配置', () => {
  const r = buildRuntimeConfig(wgNode(), 'xray', settings, []);
  assert.ok(r.blockers.length > 0, '应当阻断');
  assert.ok(/不能由 xray 承载|sing-box|Mihomo/i.test(r.blockers.join('；')));
});

t('旧快照数据（kernels 含过期 xray）也会被当前矩阵拦下', () => {
  const wg = wgNode();
  wg.kernels = ['xray', 'sing-box', 'mihomo']; // 模拟修复前导入的快照
  const r = buildRuntimeConfig(wg, 'xray', settings, []);
  assert.ok(r.blockers.length > 0, '旧快照不应放行');
});

/* ─────────────── sing-box wireguard schema ─────────────── */

t('sing-box wireguard：专属字段 private_key / peer_public_key / local_address', () => {
  const { outbound } = buildSingBoxOutbound(wgNode());
  assert.equal(outbound.type, 'wireguard');
  assert.equal(outbound.private_key, 'PRIVATEKEYBASE64=');
  assert.equal(outbound.peer_public_key, 'PEERPUBLICKEY=');
  assert.deepEqual(outbound.local_address, ['172.16.0.2/32']);
  assert.deepEqual(outbound.reserved, [1, 2, 3]);
  assert.equal(outbound.mtu, 1420);
  assert.equal(outbound.server, '203.0.113.10');
  assert.equal(outbound.server_port, 51820);
  assert.ok(!('settings' in outbound), '不应带 TCP 代理格式的 settings');
});

t('sing-box wireguard：缺密钥时在 unmapped 明确登记', () => {
  const { outbound, unmapped } = buildSingBoxOutbound(wgNode({ protocolSettings: { privateKey: '', publicKey: '' } }));
  assert.equal(outbound.private_key, undefined);
  assert.ok(unmapped.some(u => /privateKey/.test(u)));
  assert.ok(unmapped.some(u => /publicKey/.test(u)));
});

/* ─────────────── mihomo wireguard schema ─────────────── */

t('mihomo wireguard：专属字段 private-key / public-key / ip / allowed-ips', () => {
  const { proxy } = buildMihomoProxy(wgNode());
  assert.equal(proxy.type, 'wireguard');
  assert.equal(proxy['private-key'], 'PRIVATEKEYBASE64=');
  assert.equal(proxy['public-key'], 'PEERPUBLICKEY=');
  assert.equal(proxy.ip, '172.16.0.2/32');
  assert.deepEqual(proxy['allowed-ips'], ['0.0.0.0/0']);
  assert.deepEqual(proxy.reserved, [1, 2, 3]);
  assert.ok(!('uuid' in proxy), '不应混入通用字段');
});

t('sing-box 选中 wireguard：完整配置能生成且 outbound 结构正确', () => {
  const r = buildRuntimeConfig(wgNode(), 'sing-box', settings, [vlessNode()]);
  assert.deepEqual(r.blockers, []);
  const wg = r.config.outbounds.find(o => o.type === 'wireguard');
  assert.ok(wg, 'wireguard outbound 缺失');
  assert.ok(wg.private_key, 'private_key 缺失');
  assert.ok(!('streamSettings' in wg), '不应带 Xray 的 streamSettings');
});

/* ─────────────── MATCH 兜底规则（曾导致 Xray "no effective fields" 拒启） ─────────────── */

t('Xray MATCH 规则必须带 network 字段（Xray 拒绝只有 outboundTag 的规则）', () => {
  const cfg = { rules: [R.createRule({ kind: 'MATCH', action: 'PROXY' })], defaultAction: 'PROXY' };
  const b = R.buildRoutingForKernel(cfg, 'xray', 'n1');
  assert.equal(b.items[0].network, 'tcp,udp');
  assert.ok(b.items[0].outboundTag, 'outboundTag 仍要指向节点');
});

t('sing-box MATCH 规则必须带 network（sing-box 校验 missing conditions）', () => {
  const cfg = { rules: [R.createRule({ kind: 'MATCH', action: 'PROXY' })], defaultAction: 'PROXY' };
  const b = R.buildRoutingForKernel(cfg, 'sing-box', 'n1');
  assert.deepEqual(b.items[0].network, ['tcp', 'udp']);
});

t('Xray 无 MATCH 时补的兜底也要带 network', () => {
  const cfg = { rules: [R.createRule({ kind: 'DOMAIN', payload: 'a.com', action: 'DIRECT' })], defaultAction: 'PROXY' };
  const b = R.buildRoutingForKernel(cfg, 'xray', 'n1');
  const last = b.items.at(-1);
  assert.equal(last.network, 'tcp,udp');
  assert.ok(last.outboundTag, '兜底出站存在');
});

console.log('');
if (fail) {
  console.log(`\n❌ 失败 ${fail} / 共 ${pass + fail}`);
  for (const [name, e] of failures) console.log(`\n[${name}]\n${e?.stack ?? e}`);
  process.exit(1);
}
console.log(`✅ wireguard 承载测试全部通过（${pass} 项）`);
