/**
 * 内核配置端到端回归测试 —— 用真实内核验收过的结构写死断言
 * 运行：node tests/kernel-e2e.test.mjs （需先 npx tsc -p tsconfig.runtime.build.json）
 *
 * 背景：Xray 26.x 拒绝只有 outboundTag 的 MATCH 规则（"no effective fields"）、
 * VLESS 缺 encryption:"none" 被拒载；sing-box 1.14 移除旧 DNS 格式、
 * ws transport 不认顶层 host、要求 default_domain_resolver、store_selected 移入 cache_file。
 * 上述每一条都用本机真实内核 `xray -test` / `sing-box check` / `mihomo -t` 验证过。
 */
import assert from 'node:assert/strict';
import { makeNode } from '../.runtime-build/hub/util.js';
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

function vlessNode(name = 'cdn-1') {
  return makeNode({
    protocol: 'vless', server: 'example.com', port: 443, name,
    uuid: 'f63ee17c-d94f-436c-8132-de63780dbe77', raw: 'vless://x@example.com:443?path=/ws',
    transport: 'ws', security: 'tls',
    transportSettings: { path: '/ws', host: 'example.com' },
    securitySettings: { serverName: 'example.com', fingerprint: 'chrome' },
  });
}

function gen(kernel) {
  return buildRuntimeConfig(vlessNode(), kernel, settings, [vlessNode('cdn-2')]);
}

/* ─────────────── MATCH 兜底规则 ─────────────── */

t('Xray MATCH 带 network=tcp,udp（"no effective fields" 修复）', () => {
  const cfg = { rules: [R.createRule({ kind: 'MATCH', action: 'PROXY' })], defaultAction: 'PROXY' };
  const b = R.buildRoutingForKernel(cfg, 'xray', 'n1');
  assert.equal(b.items[0].network, 'tcp,udp');
  assert.equal(b.items[0].outboundTag, 'n1');
});

t('sing-box MATCH 带 network=["tcp","udp"]（"missing conditions" 修复）', () => {
  const cfg = { rules: [R.createRule({ kind: 'MATCH', action: 'PROXY' })], defaultAction: 'PROXY' };
  const b = R.buildRoutingForKernel(cfg, 'sing-box', 'n1');
  assert.deepEqual(b.items[0].network, ['tcp', 'udp']);
  assert.equal(b.items[0].outbound, 'n1');
});

/* ─────────────── VLESS encryption ─────────────── */

t('VLESS 缺 encryption 时主动补 "none"（Xray 26.x 缺字段拒载）', () => {
  const { config } = gen('xray');
  const users = config.outbounds.find(o => o.protocol === 'vless').settings.vnext[0].users;
  assert.equal(users[0].encryption, 'none');
});

/* ─────────────── sing-box transport / DNS / route ─────────────── */

t('sing-box ws transport：host 放进 headers.Host，不出顶层 host', () => {
  const { config } = gen('sing-box');
  const tr = config.outbounds.find(o => o.type === 'vless').transport;
  assert.equal(tr.type, 'ws');
  assert.equal(tr.path, '/ws');
  assert.equal(tr.headers.Host, 'example.com');
  assert.equal(tr.host, undefined);
});

t('sing-box DNS：新版 server 对象（1.14 移除 {address} 旧格式）', () => {
  const { config } = gen('sing-box');
  const servers = config.dns.servers;
  assert.ok(servers.length >= 1);
  for (const s of servers) {
    assert.ok(s.type, '必须有 type 字段');
    assert.ok(s.server, '必须有 server 字段');
    assert.equal(s.address, undefined, '不允许残留旧版 address');
  }
  assert.equal(servers[0].detour, 'direct', '首选 DNS 直连');
});

t('sing-box route：必须带 default_domain_resolver', () => {
  const { config } = gen('sing-box');
  assert.equal(config.route.default_domain_resolver, 'dns-0');
});

t('sing-box experimental：store_selected 移入 cache_file', () => {
  const { config } = gen('sing-box');
  assert.equal(config.experimental.clash_api.store_selected, undefined, '旧字段不允许残留');
  assert.equal(config.experimental.cache_file.enabled, true);
});

/* ─────────────── SS 协议名映射（曾导致 Xray "unknown config id: ss" 拒启） ─────────────── */

function ssNode() {
  return makeNode({
    protocol: 'ss', server: '13.55.34.55', port: 19999, name: 'wo SS-14 | free-nodes',
    password: 'MyPass19999', method: 'aes-256-gcm', raw: 'ss://test',
    transport: 'none', security: 'none',
  });
}

t('Xray SS 出站协议名必须写 shadowsocks（Xray 不认 "ss"）', () => {
  const r = buildRuntimeConfig(ssNode(), 'xray', settings, []);
  assert.deepEqual(r.blockers, []);
  const ob = r.config.outbounds.find(o => o.tag === 'wo SS-14 | free-nodes');
  assert.equal(ob.protocol, 'shadowsocks');
  assert.equal(ob.settings.servers[0].method, 'aes-256-gcm');
  assert.equal(ob.settings.servers[0].password, 'MyPass19999');
});

t('sing-box SS 出站协议名为 shadowsocks', () => {
  const r = buildRuntimeConfig(ssNode(), 'sing-box', settings, []);
  const ob = r.config.outbounds.find(o => o.tag === 'wo SS-14 | free-nodes');
  assert.equal(ob.type, 'shadowsocks');
  assert.equal(ob.method, 'aes-256-gcm');
});

t('mihomo SS 出站协议名保持 ss（Clash 系叫法）', () => {
  const r = buildRuntimeConfig(ssNode(), 'mihomo', settings, []);
  const p = r.config.proxies.find(o => o.name === 'wo SS-14 | free-nodes');
  assert.equal(p.type, 'ss');
  assert.equal(p.cipher, 'aes-256-gcm');
});

/* ─────────────── 重名节点 tag 去重（曾导致 Xray "existing tag found" 拒启） ─────────────── */

function ssNamed(name) {
  const n = makeNode({
    protocol: 'ss', server: '13.55.34.55', port: 19999, name,
    password: 'p', method: 'aes-256-gcm', raw: 'ss://x',
    transport: 'none', security: 'none',
  });
  n.kernels = ['xray', 'sing-box', 'mihomo'];
  return n;
}

t('重名节点写入配置时 tag 自动加序号，内核不再拒载', () => {
  const r = buildRuntimeConfig(ssNamed('sel'), 'xray', settings, [
    ssNamed('dup'), ssNamed('dup'), ssNamed('dup'),
  ]);
  assert.deepEqual(r.blockers, []);
  const tags = r.config.outbounds.map(o => o.tag);
  assert.equal(tags.length, new Set(tags).size, 'tag 必须全部唯一');
  assert.ok(tags.includes('dup'));
  assert.ok(tags.includes('dup #2'));
  assert.ok(tags.includes('dup #3'));
});

t('重名去重必须留痕（RENAMED issue），不静默改名', () => {
  const r = buildRuntimeConfig(ssNamed('sel'), 'xray', settings, [ssNamed('dup'), ssNamed('dup')]);
  const hits = r.issues.filter(i => i.code === 'RENAMED');
  assert.equal(hits.length, 1);
  assert.ok(/重名/.test(hits[0].message));
  assert.ok(r.notes.some(n => /重命名/.test(n)));
});

t('选中节点永远保留原名（路由规则引用不受去重影响）', () => {
  const r = buildRuntimeConfig(ssNamed('sel'), 'xray', settings, [ssNamed('sel'), ssNamed('sel')]);
  // 即使 peers 里还有两个同名节点，选中节点排第一、名字不动
  assert.equal(r.config.outbounds[0].tag, 'sel');
  const tags = r.config.outbounds.map(o => o.tag);
  assert.equal(tags.length, new Set(tags).size);
});

console.log('');
if (fail) {
  console.log(`\n❌ 失败 ${fail} / 共 ${pass + fail}`);
  for (const [name, e] of failures) console.log(`\n[${name}]\n${e?.stack ?? e}`);
  process.exit(1);
}
console.log(`✅ 内核配置端到端测试全部通过（${pass} 项）`);
