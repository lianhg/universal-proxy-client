/**
 * 内核运行层 —— 纯逻辑回归测试
 * 运行：node tests/runtime.test.mjs
 * 需先执行：npx tsc -p tsconfig.runtime.build.json
 *
 * 覆盖：完整运行配置生成（三内核）、YAML 序列化、TUN/缺字段/不兼容内核的明确阻断、
 *       系统代理快照可逆恢复、默认设置合并、内核启动参数。
 */
import assert from 'node:assert/strict';
import * as H from '../.runtime-build/hub/index.js';
import { parseYaml } from '../.runtime-build/hub/yaml.js';
import * as R from '../.runtime-build/runtime/config-builder.js';
import * as SP from '../.runtime-build/runtime/system-proxy.js';
import * as T from '../.runtime-build/runtime/types.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const settings = () => T.mergeRuntimeSettings();

function node(link) {
  const r = H.importText(link);
  assert.ok(r.nodes.length, '样例链接必须能解析出节点：' + link);
  return r.nodes[0];
}

const vless = node(`vless://${UUID}@hk01.example.net:443?encryption=none&security=reality&pbk=abcKEY&sni=www.microsoft.com&type=ws&path=%2Fws&host=hk.example#VLESS-Reality`);
const vmess = node(`vmess://${Buffer.from(JSON.stringify({ v: '2', ps: '香港-VMess', add: 'hk02.example.net', port: '443', id: UUID, aid: '0', net: 'tcp', tls: 'tls' })).toString('base64')}`);
const ss = node(`ss://${Buffer.from('aes-256-gcm:password').toString('base64')}@jp01.example.net:8388#日本-SS`);

console.log('\n── 完整运行配置生成 ──');

t('Xray 生成 SOCKS + HTTP 入站 + gRPC 统计入站，端口来自设置', () => {
  const r = R.buildRuntimeConfig(vless, 'xray', settings());
  assert.equal(r.config.inbounds.length, 3);
  assert.deepEqual(r.config.inbounds.map(i => i.protocol), ['socks', 'http', 'dokodemo-door']);
  assert.equal(r.config.inbounds[1].port, T.DEFAULT_RUNTIME_SETTINGS.httpPort);
  assert.equal(r.config.inbounds[2].tag, 'api-in');
  assert.equal(r.config.inbounds[2].port, T.DEFAULT_RUNTIME_SETTINGS.controllerPort);
  assert.equal(r.filename, 'runtime-xray.json');
  assert.doesNotThrow(() => JSON.parse(r.text));
});

t('Xray 配置启用 stats/policy/api，api 路由规则排第一（不被兜底规则吃掉）', () => {
  const r = R.buildRuntimeConfig(vless, 'xray', settings());
  assert.deepEqual(r.config.stats, {});
  assert.equal(r.config.statsInboundUplink, undefined, 'stats 开关必须在 policy.system 下，不允许放在顶层残留');
  assert.equal(r.config.policy.system.statsInboundDownlink, true);
  assert.equal(r.config.policy.levels['0'].statsUserUplink, true);
  assert.deepEqual(r.config.api.services, ['StatsService']);
  const first = r.config.routing.rules[0];
  assert.deepEqual(first.inboundTag, ['api-in']);
  assert.equal(first.outboundTag, 'api');
});

t('Xray 默认第一个 outbound 是选中节点', () => {
  const r = R.buildRuntimeConfig(vmess, 'xray', settings(), [vless]);
  assert.equal(r.config.outbounds[0].tag, vmess.name);
  assert.equal(r.config.outbounds.at(-2).protocol, 'freedom');
});

t('Xray DNS 与局域网直连规则', () => {
  const r = R.buildRuntimeConfig(vless, 'xray', settings());
  assert.ok(Array.isArray(r.config.dns.servers));
  assert.ok(r.config.routing.rules.some(x => x.ip?.includes('192.168.0.0/16')));
});

t('关闭 DNS / 局域网直连后对应配置不生成', () => {
  const s = T.mergeRuntimeSettings({ dnsEnabled: false, bypassLan: false });
  const r = R.buildRuntimeConfig(vless, 'xray', s);
  assert.equal(r.config.dns, undefined);
  // api 统计路由规则始终存在；其余规则应为 0
  assert.equal(r.config.routing.rules.length, 1);
});

t('Xray 请求 TUN 必须明确阻断，不静默忽略', () => {
  const s = T.mergeRuntimeSettings({ mode: 'tun' });
  const r = R.buildRuntimeConfig(vless, 'xray', s);
  assert.ok(r.blockers.some(b => b.includes('TUN')));
  assert.ok(r.issues.some(i => i.code === 'KERNEL_LIMIT' && i.field === 'mode'));
  assert.equal(r.config.inbounds.length, 3, '不能悄悄加一个不存在的 TUN 入站');
});

t('sing-box 生成 mixed / socks / http + clash_api', () => {
  const r = R.buildRuntimeConfig(vless, 'sing-box', settings());
  assert.deepEqual(r.config.inbounds.map(i => i.type), ['mixed', 'socks', 'http']);
  assert.equal(r.config.experimental.clash_api.external_controller, `127.0.0.1:${T.DEFAULT_RUNTIME_SETTINGS.controllerPort}`);
  assert.equal(r.filename, 'runtime-sing-box.json');
  assert.doesNotThrow(() => JSON.parse(r.text));
});

t('sing-box TUN 模式生成 tun 入站', () => {
  const s = T.mergeRuntimeSettings({ mode: 'tun' });
  const r = R.buildRuntimeConfig(vless, 'sing-box', s);
  assert.equal(r.config.inbounds[0].type, 'tun');
  assert.equal(r.blockers.length, 0);
  assert.ok(r.notes.some(n => n.includes('管理员权限')));
});

t('Mihomo 生成 YAML 且能被项目 YAML 解析器读回', () => {
  const r = R.buildRuntimeConfig(vmess, 'mihomo', settings());
  assert.equal(r.filename, 'runtime-mihomo.yaml');
  const y = parseYaml(r.text);
  assert.ok(y.value && typeof y.value === 'object');
  assert.equal(y.value['mixed-port'], T.DEFAULT_RUNTIME_SETTINGS.mixedPort);
  assert.ok(Array.isArray(y.value.proxies));
  assert.equal(y.value.proxies[0].name, vmess.name);
});

t('Mihomo YAML 的 proxy-groups / rules 正确', () => {
  const r = R.buildRuntimeConfig(vmess, 'mihomo', settings(), [vless]);
  assert.ok(r.text.includes('proxy-groups:'));
  assert.ok(r.text.includes('MATCH,PROXY'));
  assert.ok(r.text.includes('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve'));
  const y = parseYaml(r.text);
  assert.equal(y.value['proxy-groups'][0].proxies[0], vmess.name);
});

t('Mihomo TUN + DNS fake-ip', () => {
  const s = T.mergeRuntimeSettings({ mode: 'tun' });
  const r = R.buildRuntimeConfig(vmess, 'mihomo', s);
  const y = parseYaml(r.text);
  assert.equal(y.value.tun.enable, true);
  assert.equal(y.value.dns['enhanced-mode'], 'fake-ip');
});

t('toYaml 对象数组缩进正确，不丢字段', () => {
  const s = R.toYaml({ items: [{ name: 'a', port: 1 }, { name: 'b', port: 2 }] });
  assert.ok(s.includes('items:'));
  assert.ok(s.includes('- name: a'));
  const y = parseYaml(s);
  assert.equal(y.value.items.length, 2);
  assert.equal(y.value.items[1].port, 2);
});

t('选中节点排第一，只纳入同内核 peers', () => {
  const r = R.buildRuntimeConfig(ss, 'xray', settings(), [vless, { ...vmess, kernels: ['mihomo'], id: 'excluded' }]);
  const tags = r.config.outbounds.map(o => o.tag);
  assert.equal(tags[0], ss.name);
  assert.ok(!tags.includes('excluded'));
});

t('节点缺少必填字段 → 明确 blocker', () => {
  const broken = { ...vless, uuid: undefined, issues: [{ level: 'error', code: 'MISSING_REQUIRED', message: '缺少 uuid' }] };
  const r = R.buildRuntimeConfig(broken, 'xray', settings());
  assert.ok(r.blockers.some(b => b.includes('缺少必填字段')));
});

t('节点不兼容所选内核 → 明确 blocker 且不假装可用', () => {
  const r = R.buildRuntimeConfig(ss, 'mihomo', settings());
  // ss 在 mihomo 是原生支持的，换成一个只支持 sing-box 的协议
  const hy2 = node('hysteria2://auth@hy.example.net:443?sni=hy.example#HY2');
  const r2 = R.buildRuntimeConfig(hy2, 'xray', settings());
  assert.ok(r2.blockers.some(b => b.includes('不能由 xray 承载')));
  assert.ok(r.blockers.length === 0 || r.blockers.every(b => !b.includes('不能由')));
});

t('内核无法表达的字段进入 unmapped 并写进 notes', () => {
  const withExtra = { ...vless, extras: { customFoo: 'keep-me', another: 42 } };
  const r = R.buildRuntimeConfig(withExtra, 'xray', settings());
  assert.ok(r.unmapped.some(x => x.includes('customFoo')));
  assert.ok(r.notes.some(n => n.includes('原值仍保存在节点 raw / extras')));
});

t('生成结果始终带一条安全说明', () => {
  const r = R.buildRuntimeConfig(vless, 'xray', settings());
  assert.ok(r.issues.some(i => i.code === 'SECURITY' && i.message.includes('快照')));
});

t('未选中节点时返回明确错误而不是抛异常', () => {
  const r = R.buildRuntimeConfig(null, 'xray', settings());
  assert.ok(r.blockers.includes('未选择节点'));
  assert.ok(r.issues.some(i => i.code === 'MISSING_REQUIRED'));
});

console.log('\n── 系统代理可逆性 ──');

t('读取脚本包含注册表路径与 JSON 输出', () => {
  const s = SP.readSystemProxyScript('win32');
  assert.ok(s.script.includes('Internet Settings'));
  assert.ok(s.script.includes('ConvertTo-Json'));
});

t('写入脚本设置端口并刷新 WinINET', () => {
  const s = SP.applySystemProxyScript('win32', '127.0.0.1:7890');
  assert.ok(s.script.includes("'127.0.0.1:7890'"));
  assert.ok(s.script.includes('ProxyEnable'));
  assert.ok(s.script.includes('InternetSetOption'));
});

t('写入脚本必须让本地回环绕过代理，且不整体覆盖用户原有的 ProxyOverride', () => {
  const s = SP.applySystemProxyScript('win32', '127.0.0.1:21809');
  // 访问 127.0.0.1 / localhost 如果走代理会回环，内核自己的控制接口都可能连不上
  assert.ok(s.script.includes('$need = @(\'127.0.0.1\',\'localhost\',\'<local>\')'), '回环地址必须加入绕过列表');
  assert.ok(s.script.includes('$parts -notcontains $n'), '必须合并去重，不能把用户原有的绕过项删掉');
  assert.ok(s.script.includes('$parts -join'), '合并后要写回');
});

t('快照解析：完整值', () => {
  const s = SP.parseWindowsSnapshot('{"proxyEnable":1,"proxyServer":"old:8080","proxyOverride":"<local>","autoConfigURL":"http://x/pac"}');
  assert.equal(s.proxyEnable, 1);
  assert.equal(s.proxyServer, 'old:8080');
  assert.equal(s.autoConfigUrl, 'http://x/pac');
});

t('快照解析：空值保留为 null，恢复时删除而非写空', () => {
  const s = SP.parseWindowsSnapshot('{"proxyEnable":null,"proxyServer":null}');
  assert.equal(s.proxyEnable, null);
  assert.equal(s.proxyServer, null);
  const r = SP.restoreSystemProxyScript('win32', s);
  assert.ok(r.script.includes('Remove-ItemProperty -Path $p -Name ProxyEnable'));
});

t('快照解析：带噪声输出与非法 JSON 不崩溃', () => {
  const s = SP.parseWindowsSnapshot('PS C:\\> {"proxyEnable":0,"proxyServer":"a:1"}');
  assert.equal(s.proxyEnable, 0);
  const bad = SP.parseWindowsSnapshot('not json at all');
  assert.equal(bad.proxyServer, null);
});

t('恢复脚本按快照精确还原每个字段', () => {
  const snap = { capturedAt: 1, platform: 'win32', proxyEnable: 0, proxyServer: 'old:8080', proxyOverride: '<local>', autoConfigUrl: null };
  const r = SP.restoreSystemProxyScript('win32', snap);
  assert.ok(r.script.includes("'old:8080'"));
  assert.ok(r.script.includes("'<local>'"));
  assert.ok(r.script.includes('Remove-ItemProperty -Path $p -Name AutoConfigURL'));
});

t('非 Windows 平台明确返回不支持，不假装成功', () => {
  assert.equal(SP.readSystemProxyScript('darwin'), null);
  assert.equal(SP.applySystemProxyScript('linux', '127.0.0.1:7890'), null);
  assert.equal(SP.systemProxySupported('darwin'), false);
  assert.ok(SP.manualProxyHint('darwin', '127.0.0.1:7890').includes('手动'));
});

console.log('\n── 设置与启动参数 ──');

t('mergeRuntimeSettings 深合并 tun / 数组 / 内核路径', () => {
  const s = T.mergeRuntimeSettings({ tun: { mtu: 1400 }, dnsServers: ['1.1.1.1'], binaryPaths: { xray: 'C:/x.exe' } });
  assert.equal(s.tun.mtu, 1400);
  assert.equal(s.tun.stack, 'system');
  assert.deepEqual(s.dnsServers, ['1.1.1.1']);
  assert.equal(s.binaryPaths.xray, 'C:/x.exe');
  assert.equal(T.DEFAULT_RUNTIME_SETTINGS.tun.mtu, 9000, '不能污染默认值');
});

t('默认端口落在冷门段，避开 v2rayN / Clash 常占端口', () => {
  const d = T.DEFAULT_RUNTIME_SETTINGS;
  const contested = new Set([7890, 7891, 1080, 10808, 10809, 9090, 8080, 8888]);
  for (const p of [d.socksPort, d.httpPort, d.mixedPort, d.controllerPort]) {
    assert.ok(!contested.has(p), `默认端口 ${p} 属于大众端口，容易和 v2rayN / Clash 撞车`);
    assert.ok(p >= 21808 && p < 22008, `默认端口 ${p} 应落在冷门池 21808~22007`);
  }
  assert.equal(new Set([d.socksPort, d.httpPort, d.mixedPort, d.controllerPort]).size, 4, '四个默认端口不能重复');
});

t('boundPortsOf：Xray 只绑 SOCKS/HTTP，其它内核多绑 mixed + 控制端口', () => {
  const s = T.mergeRuntimeSettings();
  assert.deepEqual(T.boundPortsOf('xray', s), [s.socksPort, s.httpPort]);
  assert.deepEqual(T.boundPortsOf('sing-box', s), [s.mixedPort, s.socksPort, s.httpPort, s.controllerPort]);
  assert.deepEqual(T.boundPortsOf('mihomo', s), [s.mixedPort, s.socksPort, s.httpPort, s.controllerPort]);
});

t('emptyStatus 标记浏览器预览不可用', () => {
  const s = T.emptyStatus(settings(), true);
  assert.equal(s.unavailable, true);
  assert.equal(s.state, 'stopped');
  assert.equal(s.systemProxy.applied, false);
});

t('三内核启动参数正确', () => {
  assert.deepEqual(T.KERNEL_BIN_NAMES.xray.runArgs('c.json', 'd'), ['run', '-c', 'c.json']);
  assert.deepEqual(T.KERNEL_BIN_NAMES['sing-box'].versionArgs, ['version']);
  assert.deepEqual(T.KERNEL_BIN_NAMES.mihomo.runArgs('c.yaml', 'd'), ['-f', 'c.yaml', '-d', 'd']);
});

console.log(`\n运行层测试：${pass} 通过 / ${fail} 失败`);
if (fail) {
  for (const [name, e] of failures) console.error(`  ✗ ${name}: ${e.stack ?? e}`);
  process.exit(1);
}
