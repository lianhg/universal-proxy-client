/**
 * 路由规则 / DNS 分流 —— 纯逻辑回归测试
 * 运行：node tests/rules.test.mjs
 * 需先执行：npx tsc -p tsconfig.runtime.build.json
 *
 * 覆盖：规则文本解析与拒绝、三内核转换、outbound tag 正确性、不支持规则绝不静默丢失、
 *       运行配置接线（含阻断启动）、DNS 服务器来自自定义配置。
 */
import assert from 'node:assert/strict';
import * as H from '../.runtime-build/hub/index.js';
import * as R from '../.runtime-build/runtime/rules.js';
import * as C from '../.runtime-build/runtime/config-builder.js';
import * as T from '../.runtime-build/runtime/types.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const vless = H.importText(`vless://${UUID}@hk01.example.net:443?encryption=none&security=reality&pbk=abcKEY&sni=www.microsoft.com&type=ws&path=%2Fws#VLESS-Reality`).nodes[0];
const settings = () => T.mergeRuntimeSettings();

console.log('\n── 规则文本解析 ──');
t('Clash 规则文本解析，注释与空行跳过', () => {
  const r = R.parseRuleText('# 注释\nDOMAIN-SUFFIX,google.com,PROXY\n\nGEOSITE,cn,DIRECT,no-resolve\nMATCH,PROXY');
  assert.equal(r.rules.length, 3);
  assert.equal(r.rules[0].kind, 'DOMAIN-SUFFIX');
  assert.equal(r.rules[0].payload, 'google.com');
  assert.equal(r.rules[1].comment, 'no-resolve');
  assert.equal(r.issues.length, 0);
});
t('未知类型 / 未知动作逐行拒绝，不静默丢弃', () => {
  const r = R.parseRuleText('MYSTERY,foo,PROXY\nDOMAIN,bar.com,TELEPORT\nDOMAIN,ok.com,DIRECT');
  assert.equal(r.rules.length, 1);
  assert.equal(r.issues.length, 2);
  assert.match(r.issues[0].message, /无法识别/);
});
t('非法 IP-CIDR 与端口被拒绝', () => {
  assert.ok(R.validateRule(R.createRule({ kind: 'IP-CIDR', payload: 'not-a-cidr' })).length);
  assert.ok(R.validateRule(R.createRule({ kind: 'DST-PORT', payload: 'abc' })).length);
  assert.equal(R.validateRule(R.createRule({ kind: 'MATCH', payload: '' })).length, 0);
});
t('导出文本可被重新解析', () => {
  const cfg = R.cloneRoutingConfig();
  const text = R.serializeRuleText(cfg.rules);
  const back = R.parseRuleText(text);
  assert.equal(back.rules.length, cfg.rules.length);
  assert.equal(back.issues.length, 0);
});

console.log('\n── 三内核转换 ──');
t('默认规则三内核都能完整下发（不会一上来就阻断）', () => {
  for (const k of ['xray', 'sing-box', 'mihomo']) {
    const b = R.buildRoutingForKernel(R.cloneRoutingConfig(), k, vless.name);
    assert.equal(b.skipped.length, 0, `${k} 不应有未下发规则：${JSON.stringify(b.issues)}`);
    assert.ok(b.items.length >= 3);
  }
});
t('Xray DOMAIN-SUFFIX 转成 domain: 前缀', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN-SUFFIX', payload: 'google.com', action: 'PROXY' }), R.createRule({ kind: 'MATCH', action: 'PROXY' })] });
  const b = R.buildRoutingForKernel(cfg, 'xray', vless.name);
  assert.deepEqual(b.items[0].domain, ['domain:google.com']);
});
t('sing-box DOMAIN-SUFFIX 转成 domain_suffix', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN-SUFFIX', payload: 'google.com', action: 'DIRECT' })] });
  const b = R.buildRoutingForKernel(cfg, 'sing-box', vless.name);
  assert.deepEqual(b.items[0].domain_suffix, ['google.com']);
  assert.equal(b.items[0].outbound, 'direct');
});
t('Mihomo 输出 Clash 规则字符串，REJECT 可用', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN', payload: 'ads.example', action: 'REJECT' }), R.createRule({ kind: 'MATCH', action: 'PROXY' })] });
  const b = R.buildRoutingForKernel(cfg, 'mihomo', vless.name);
  assert.equal(b.items[0], 'DOMAIN,ads.example,REJECT');
  assert.equal(b.items[1], 'MATCH,PROXY');
});
t('PROXY 指向真实节点 tag，不指向不存在的 "proxy"', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'MATCH', action: 'PROXY' })] });
  const x = R.buildRoutingForKernel(cfg, 'xray', vless.name);
  const s = R.buildRoutingForKernel(cfg, 'sing-box', vless.name);
  assert.equal(x.items[0].outboundTag, vless.name);
  assert.equal(s.items[0].outbound, vless.name);
});
t('REJECT 指向已有的 block 出站', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'MATCH', action: 'REJECT' })] });
  assert.equal(R.buildRoutingForKernel(cfg, 'xray', vless.name).items[0].outboundTag, 'block');
  assert.equal(R.buildRoutingForKernel(cfg, 'sing-box', vless.name).items[0].outbound, 'block');
});
t('缺少 MATCH 时补兜底规则并说明', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN', payload: 'a.com', action: 'DIRECT' })], defaultAction: 'PROXY' });
  const b = R.buildRoutingForKernel(cfg, 'mihomo', vless.name);
  assert.equal(b.items.at(-1), 'MATCH,PROXY');
  assert.ok(b.issues.some(i => i.code === 'DEGRADED'));
});

console.log('\n── 不支持规则绝不静默丢失 ──');
t('Xray 的 PROCESS-NAME / GEOSITE 进 skipped 并附具体原因', () => {
  const cfg = R.cloneRoutingConfig({ rules: [
    R.createRule({ kind: 'PROCESS-NAME', payload: 'chrome.exe', action: 'DIRECT' }),
    R.createRule({ kind: 'GEOSITE', payload: 'cn', action: 'DIRECT' }),
    R.createRule({ kind: 'MATCH', action: 'PROXY' }),
  ] });
  const b = R.buildRoutingForKernel(cfg, 'xray', vless.name);
  assert.equal(b.skipped.length, 2);
  assert.equal(b.issues.filter(i => i.code === 'KERNEL_LIMIT').length, 2);
  assert.match(b.issues[0].message, /geosite.dat|进程名/);
});
t('sing-box 的 SRC-PORT 被明确拒绝', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'SRC-PORT', payload: '1234', action: 'DIRECT' })] });
  const b = R.buildRoutingForKernel(cfg, 'sing-box', vless.name);
  assert.equal(b.skipped.length, 1);
  assert.match(b.issues[0].message, /source_port/);
});
t('能力矩阵列出每个内核的支持与不支持类型', () => {
  const cov = R.routingCoverage();
  assert.equal(cov.length, 3);
  assert.equal(cov.find(c => c.kernel === 'mihomo').unsupported.length, 0);
  assert.ok(cov.find(c => c.kernel === 'xray').unsupported.length > 0);
});

console.log('\n── 运行配置接线 ──');
t('不带 routing 时行为与旧版一致', () => {
  const r = C.buildRuntimeConfig(vless, 'xray', settings());
  assert.equal(r.blockers.length, 0);
  assert.ok(Array.isArray(r.config.routing.rules));
});
t('带自定义规则：Xray routing.rules 含 domain 规则', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN-SUFFIX', payload: 'example.com', action: 'PROXY' }), R.createRule({ kind: 'MATCH', action: 'PROXY' })] });
  const r = C.buildRuntimeConfig(vless, 'xray', settings(), [], cfg);
  assert.equal(r.blockers.length, 0);
  assert.ok(r.config.routing.rules.some(x => JSON.stringify(x.domain ?? []).includes('example.com')));
});
t('带自定义规则：Mihomo rules 含用户规则且保留兜底', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN', payload: 'ads.example', action: 'REJECT' }), R.createRule({ kind: 'MATCH', action: 'PROXY' })] });
  const r = C.buildRuntimeConfig(vless, 'mihomo', settings(), [], cfg);
  assert.ok(r.config.rules.includes('DOMAIN,ads.example,REJECT'));
  assert.equal(r.config.rules.at(-1), 'MATCH,PROXY');
  assert.doesNotThrow(() => r.text);
});
t('不支持的规则会阻断启动并列入 unmapped', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'PROCESS-NAME', payload: 'chrome.exe', action: 'DIRECT' }), R.createRule({ kind: 'MATCH', action: 'PROXY' })] });
  const r = C.buildRuntimeConfig(vless, 'xray', settings(), [], cfg);
  assert.ok(r.blockers.length >= 1);
  assert.ok(r.unmapped.some(u => u.includes('PROCESS-NAME')));
  assert.ok(r.issues.some(i => i.code === 'KERNEL_LIMIT'));
});
t('DNS 服务器来自自定义规则配置', () => {
  const cfg = R.cloneRoutingConfig({ dnsServers: ['1.1.1.1', '9.9.9.9'] });
  const r = C.buildRuntimeConfig(vless, 'xray', settings(), [], cfg);
  assert.deepEqual(r.config.dns.servers, ['1.1.1.1', '9.9.9.9']);
});
t('非法规则（空 payload）也会阻断并报字段名', () => {
  const cfg = R.cloneRoutingConfig({ rules: [R.createRule({ kind: 'DOMAIN-SUFFIX', payload: '', action: 'PROXY' })] });
  const r = C.buildRuntimeConfig(vless, 'mihomo', settings(), [], cfg);
  assert.ok(r.blockers.some(b => b.includes('校验失败')));
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (fail) { for (const [n, e] of failures) console.error('  ✗ ' + n, e); process.exit(1); }
