/**
 * 统一配置解析中心 —— 回归测试
 * 运行：node tests/hub.test.mjs （需先 npx tsc -p tsconfig.hub.build.json）
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import * as H from '../.hub-build/index.js';

let pass = 0, fail = 0;
const failures = [];
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; failures.push([name, e]); console.log('  ✗ ' + name + ' → ' + (e?.message ?? e)); }
}
const b64 = s => Buffer.from(s, 'utf8').toString('base64');
const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

/* ------------------------------ 样例数据 ------------------------------ */
const vmessJson = {
  v: '2', ps: '香港-01', add: 'hk01.example.net', port: '443', id: UUID, aid: '0',
  net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ray', tls: 'tls',
  sni: 'cdn.example.com', alpn: 'h2,http/1.1', fp: 'chrome',
};
const vmessLink = 'vmess://' + b64(JSON.stringify(vmessJson));
const vlessReality = `vless://${UUID}@1.2.3.4:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=PUBKEY123&sid=8b&spx=%2F&flow=xtls-rprx-vision&type=raw#Reality-Vision`;
const trojanLink = 'trojan://pass123@tr.example.net:443?security=tls&sni=tr.example.net&type=ws&path=%2Ftrojan&host=tr.example.net#Trojan-WS';
const ssSip002 = 'ss://' + b64('aes-256-gcm:password123') + '@ss.example.net:8388/?plugin=v2ray-plugin%3Bmode%3Dwebsocket#SS-SIP002';
const ssLegacy = 'ss://' + b64('aes-128-gcm:pw@ss2.example.net:8388') + '#SS-LEGACY';
const ssrRaw = `ssr.example.net:8388:origin:aes-256-cfb:plain:${b64('ssr-pass')}/?remarks=${b64('SSR节点')}&protoparam=&obfsparam=`;
const ssrLink = 'ssr://' + b64(ssrRaw).replace(/\+/g, '-').replace(/\//g, '_');
const hy2Link = 'hysteria2://auth99@hy2.example.net:443?sni=hy.example&insecure=1&obfs=salamander&obfs-password=obfspw#HY2-01';
const hy1Link = 'hysteria://h1.example.net:443?peer=h1.example&auth=authpass&protocol=udp&upmbps=100&downmbps=100#HY1-01';
const tuicLink = `tuic://${UUID}:tuicpw@tuic.example.net:443?congestion_control=bbr&alpn=h3&sni=tuic.example#TUIC-01`;
const wgLink = 'wireguard://' + b64('private-key-value') + '@wg.example.net:51820?publickey=PEERPUB&address=10.0.0.2%2F32&mtu=1420#WG-01';
const anytlsLink = 'anytls://anypass@any.example.net:443?sni=any.example#AnyTLS-01';
const naiveLink = 'naive+https://user:naivepw@naive.example.net:443?padding=true#Naive-01';
const sshLink = 'ssh://root:sshpw@ssh.example.net:22?hostKey=HOSTKEY#SSH-01';
const socksLink = 'socks5://user:sockspw@socks.example.net:1080#SOCKS5-01';
const socks4Link = 'socks4://userid@s4.example.net:1080#SOCKS4-01';
const httpProxyLink = 'http://user:httppw@proxy.example.net:8080#HTTP-01';

const clashYaml = `port: 7890
mode: rule
proxies:
  - name: "VLESS-Reality"
    type: vless
    server: 1.2.3.4
    port: 443
    uuid: ${UUID}
    network: tcp
    tls: true
    flow: xtls-rprx-vision
    servername: www.microsoft.com
    client-fingerprint: chrome
    reality-opts:
      public-key: PUBKEY123
      short-id: 8b
    custom-field: keep-me
  - {name: SS-01, type: ss, server: 5.6.7.8, port: 8388, cipher: aes-256-gcm, password: pw}
proxy-groups:
  - name: PROXY
    type: select
    proxies:
      - VLESS-Reality
`;

const singBoxJson = JSON.stringify({
  log: { level: 'info' },
  outbounds: [
    {
      type: 'vless', tag: 'VLESS-XHTTP', server: '1.2.3.4', server_port: 443,
      uuid: UUID, flow: 'xtls-rprx-vision',
      tls: {
        enabled: true, server_name: 'www.microsoft.com',
        utls: { enabled: true, fingerprint: 'chrome' },
        reality: { enabled: true, public_key: 'PUBKEY123', short_id: '8b' },
      },
      transport: { type: 'xhttp', path: '/x', mode: 'auto' },
    },
    { type: 'selector', tag: 'PROXY', outbounds: ['VLESS-XHTTP'] },
    { type: 'direct', tag: 'DIRECT' },
  ],
}, null, 2);

const xrayJson = JSON.stringify({
  log: { loglevel: 'warning' },
  outbounds: [{
    tag: 'XRAY-REALITY', protocol: 'vless',
    settings: { vnext: [{ address: '1.2.3.4', port: 443, users: [{ id: UUID, flow: 'xtls-rprx-vision', encryption: 'none' }] }] },
    streamSettings: {
      network: 'xhttp', security: 'reality',
      tlsSettings: { fingerprint: 'chrome', alpn: ['h2'] },
      realitySettings: { publicKey: 'PUBKEY123', shortId: '8b', serverName: 'www.microsoft.com' },
      xhttpSettings: { path: '/x', mode: 'auto' },
    },
  }],
}, null, 2);

const wgConf = `[Interface]
PrivateKey = wg-private-key
Address = 10.0.0.2/32
DNS = 1.1.1.1
MTU = 1420

[Peer]
PublicKey = wg-peer-public-key
PresharedKey = wg-psk
AllowedIPs = 0.0.0.0/0
Endpoint = wg.example.net:51820
PersistentKeepalive = 25
`;

console.log('\n=== 1. 全协议分享链接 ===');
const protocolCases = [
  ['VMess / WS+TLS', vmessLink, 'vmess'],
  ['VLESS Reality + XTLS Vision', vlessReality, 'vless'],
  ['Trojan / WS+TLS', trojanLink, 'trojan'],
  ['Shadowsocks SIP002', ssSip002, 'ss'],
  ['Shadowsocks 旧式 Base64', ssLegacy, 'ss'],
  ['ShadowsocksR', ssrLink, 'ssr'],
  ['SOCKS5', socksLink, 'socks5'],
  ['SOCKS4', socks4Link, 'socks4'],
  ['HTTP 代理', httpProxyLink, 'http'],
  ['Hysteria v1', hy1Link, 'hysteria'],
  ['Hysteria2', hy2Link, 'hysteria2'],
  ['TUIC v5', tuicLink, 'tuic'],
  ['WireGuard 链接', wgLink, 'wireguard'],
  ['AnyTLS', anytlsLink, 'anytls'],
  ['NaiveProxy', naiveLink, 'naive'],
  ['SSH', sshLink, 'ssh'],
];
for (const [label, link, expected] of protocolCases) {
  t(label, () => {
    const r = H.importText(link);
    assert.equal(r.nodes.length, 1, `应解析出 1 个节点，实际 ${r.nodes.length}；rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
    assert.equal(r.nodes[0].protocol, expected);
    assert.ok(r.nodes[0].server, 'server 不能为空');
    assert.ok(r.nodes[0].port > 0, 'port 必须有效');
    assert.equal(r.previewOnly, true, '必须只是预览');
  });
}

console.log('\n=== 2. 高级特性字段不丢失 ===');
t('VMess 的 WS / TLS / ALPN / fingerprint 完整映射', () => {
  const n = H.importText(vmessLink).nodes[0];
  assert.equal(n.transport, 'ws');
  assert.equal(n.security, 'tls');
  assert.equal(n.transportSettings.path, '/ray');
  assert.equal(n.transportSettings.host, 'cdn.example.com');
  assert.equal(n.tls.sni, 'cdn.example.com');
  assert.equal(n.tls.fingerprint, 'chrome');
  assert.deepEqual(n.tls.alpn, ['h2', 'http/1.1']);
});
t('VMess 的 type=none 是伪装头，不会覆盖 net=ws 传输层', () => {
  const n = H.importText(vmessLink).nodes[0];
  assert.equal(n.transport, 'ws', 'net=ws 必须保留');
});
t('VLESS Reality + XTLS Vision 全参数保留', () => {
  const n = H.importText(vlessReality).nodes[0];
  assert.equal(n.security, 'reality');
  assert.equal(n.reality.publicKey, 'PUBKEY123');
  assert.equal(n.reality.shortId, '8b');
  assert.equal(n.reality.spiderX, '/');
  assert.equal(n.flow, 'xtls-rprx-vision');
  assert.equal(n.tls.fingerprint, 'chrome');
  assert.equal(n.tls.sni, 'www.microsoft.com');
});
t('XHTTP / gRPC / HTTPUpgrade 传输层识别', () => {
  assert.equal(H.importText(`vless://${UUID}@a.example:443?type=xhttp&mode=auto&path=%2Fx#X`).nodes[0].transport, 'xhttp');
  assert.equal(H.importText(`vless://${UUID}@a.example:443?type=grpc&serviceName=svc#G`).nodes[0].transport, 'grpc');
  assert.equal(H.importText(`vless://${UUID}@a.example:443?type=httpupgrade&path=%2Fup#U`).nodes[0].transport, 'httpupgrade');
  assert.equal(H.importText(`vless://${UUID}@a.example:443?type=h2&host=h.example#H`).nodes[0].transport, 'h2');
});
t('未知字段不静默丢失：extras 保留 + lossless=false + 明确提示', () => {
  const custom = { ...vmessJson, customFoo: 42, anotherField: 'abc' };
  const n = H.importText('vmess://' + b64(JSON.stringify(custom))).nodes[0];
  assert.equal(n.extras.customFoo, 42);
  assert.equal(n.extras.anotherField, 'abc');
  assert.equal(n.lossless, false);
  assert.ok(n.issues.some(i => i.code === 'UNKNOWN_FIELD'));
  assert.ok(n.raw.startsWith('vmess://'), '原始输入必须完整保留');
  assert.ok(n.rawDecoded?.includes('customFoo'), '解码后的明文配置也必须留档，便于逐字段复核');
});
t('缺少必填字段明确报错，不伪装成功', () => {
  const r = H.importText(`vless://@1.2.3.4:443?type=ws#NoUUID`);
  const n = r.nodes[0];
  assert.ok(n, '仍生成预览节点以便人工补全');
  assert.ok(n.issues.some(i => i.level === 'error' && i.code === 'MISSING_REQUIRED' && i.field === 'uuid'));
  assert.ok(r.issues.some(i => i.code === 'MISSING_REQUIRED'));
});
t('Reality 缺 publicKey 明确报错', () => {
  const n = H.importText(`vless://${UUID}@1.2.3.4:443?security=reality&sni=x.example#NoPBK`).nodes[0];
  assert.ok(n.issues.some(i => i.code === 'MISSING_REQUIRED' && i.field === 'publicKey'));
});
t('SSR / SSH 等需额外兼容的协议给出明确提示', () => {
  const ssr = H.importText(ssrLink).nodes[0];
  assert.ok(ssr.issues.some(i => i.code === 'PARTIAL_COMPAT' || i.code === 'KERNEL_LIMIT'));
  const ssh = H.importText(sshLink).nodes[0];
  assert.ok(ssh.issues.some(i => i.code === 'PARTIAL_COMPAT'));
});

console.log('\n=== 3. 批量 / 订阅 / 包装格式 ===');
t('多行批量导入 + 逐条失败原因', () => {
  const text = [vmessLink, vlessReality, trojanLink, ssSip002, 'totally-unknown-content'].join('\n');
  const r = H.importText(text);
  assert.equal(r.nodes.length, 4);
  assert.equal(r.rejected.length, 1);
  assert.ok(r.rejected[0].reason.length > 5, '失败项必须说明原因');
  assert.equal(r.stats.byProtocol.vmess, 1);
});
t('Base64 订阅内容（多节点）自动解包', () => {
  const r = H.importText(b64([vmessLink, trojanLink, ssSip002].join('\n')));
  assert.equal(r.nodes.length, 3, `rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
  assert.equal(r.format, 'subscription-content');
});
t('v2rayn:// 包装格式（Base64 分享链接）', () => {
  const r = H.importText('v2rayn://' + b64(vmessLink));
  assert.equal(r.format, 'v2rayn-wrapper');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].protocol, 'vmess');
});
t('v2rayn:// 包装完整 Xray JSON 配置', () => {
  const r = H.importText('v2rayn://' + b64(xrayJson));
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].protocol, 'vless');
});
t('sub:// 订阅地址只登记 requiresFetch，不自动请求', () => {
  const r = H.importText('sub://' + b64('https://sub.example.com/link?token=abc'));
  assert.equal(r.nodes.length, 0);
  assert.ok(r.requiresFetch, '必须返回 requiresFetch');
  assert.equal(r.requiresFetch.url, 'https://sub.example.com/link?token=abc');
  assert.ok(r.issues.some(i => i.code === 'SECURITY'));
});
t('普通订阅 URL 不会被误判为 HTTP 代理节点', () => {
  const r = H.importText('https://sub.example.com/link?token=abc');
  assert.equal(r.format, 'subscription-url');
  assert.equal(r.nodes.length, 0);
  assert.ok(r.requiresFetch);
});
t('clash://install-config?url=... 不自动执行外链配置', () => {
  const r = H.importText('clash://install-config?url=' + encodeURIComponent('https://cdn.example.com/config.yaml'));
  assert.ok(r.requiresFetch);
  assert.equal(r.requiresFetch.kind, 'config-url');
  assert.ok(r.issues.some(i => i.code === 'SECURITY'));
});
t('SSD 订阅解包为多条 SS 节点', () => {
  const ssd = { airport: 'test', port: 8388, method: 'aes-256-gcm', password: 'pw', servers: [{ server: 's1.example', remarks: '节点1' }, { server: 's2.example', remarks: '节点2' }] };
  const r = H.importText('ssd://' + b64(JSON.stringify(ssd)));
  assert.equal(r.nodes.length, 2, `rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
});
t('未知格式明确拒绝，不误报成功', () => {
  for (const bad of ['hello world', '这不是配置也不是链接', 'vmess://%%%bad-base64%%%', b64('just some random text')]) {
    const r = H.importText(bad);
    assert.equal(r.nodes.length, 0, `不应解析出节点: ${bad.slice(0, 30)}`);
    assert.equal(r.ok, false);
    assert.ok(r.rejected.length > 0);
    assert.ok(r.rejected[0].reason.length > 5);
  }
});

console.log('\n=== 4. 完整配置文件 ===');
t('Clash YAML：块式 + 内联混合、嵌套 reality-opts、未知字段保留', () => {
  const r = H.importText(clashYaml);
  assert.equal(r.nodes.length, 2, `rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
  const a = r.nodes[0], b = r.nodes[1];
  assert.equal(a.protocol, 'vless');
  assert.equal(a.reality.publicKey, 'PUBKEY123');
  assert.equal(a.reality.shortId, '8b');
  assert.equal(a.flow, 'xtls-rprx-vision');
  assert.equal(a.tls.fingerprint, 'chrome');
  assert.equal(a.extras['custom-field'], 'keep-me', '未知字段必须保留');
  assert.equal(a.lossless, false);
  assert.equal(b.protocol, 'ss');
  assert.equal(b.method, 'aes-256-gcm');
});
t('sing-box JSON：reality / xhttp / vision，跳过非节点 outbound', () => {
  const r = H.importText(singBoxJson);
  assert.equal(r.nodes.length, 1, `rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
  const n = r.nodes[0];
  assert.equal(n.protocol, 'vless');
  assert.equal(n.security, 'reality');
  assert.equal(n.transport, 'xhttp');
  assert.equal(n.transportSettings.path, '/x');
  assert.equal(n.reality.publicKey, 'PUBKEY123');
  assert.equal(n.flow, 'xtls-rprx-vision');
  assert.ok(r.issues.some(i => /已跳过/.test(i.message)));
});
t('Xray / V2Ray JSON：vnext + realitySettings + xhttpSettings', () => {
  const r = H.importText(xrayJson);
  assert.equal(r.nodes.length, 1, `rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
  const n = r.nodes[0];
  assert.equal(n.protocol, 'vless');
  assert.equal(n.uuid, UUID);
  assert.equal(n.flow, 'xtls-rprx-vision');
  assert.equal(n.security, 'reality');
  assert.equal(n.transport, 'xhttp');
  assert.equal(n.reality.publicKey, 'PUBKEY123');
  assert.equal(n.transportSettings.path, '/x');
});
t('WireGuard .conf：Interface + Peer 全字段', () => {
  const r = H.importText(wgConf);
  assert.equal(r.nodes.length, 1, `rejected=${r.rejected.map(x => x.reason).join(' | ')}`);
  const n = r.nodes[0];
  assert.equal(n.protocol, 'wireguard');
  assert.equal(n.server, 'wg.example.net');
  assert.equal(n.port, 51820);
  assert.equal(n.protocolSettings.privateKey, 'wg-private-key');
  assert.equal(n.protocolSettings.publicKey, 'wg-peer-public-key');
  assert.equal(n.protocolSettings.allowedIPs, '0.0.0.0/0');
});
t('WireGuard 缺 Endpoint 明确说明缺少字段', () => {
  const r = H.importText('[Interface]\nPrivateKey = abc\n[Peer]\nPublicKey = def\n');
  assert.equal(r.nodes.length, 0);
  assert.ok(r.rejected[0].reason.includes('Endpoint'));
});
t('文件导入按内容判定，不迷信扩展名', () => {
  const r = H.importConfigFile('node.txt', vlessReality);
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].protocol, 'vless');
  assert.ok(r.issues.some(i => i.field === 'extension'));
});

console.log('\n=== 5. 去重 / 多内核 / 配置导出 ===');
t('重复节点去重，不静默覆盖', () => {
  const first = H.importText(vmessLink);
  const second = H.importText(vmessLink, { existingFingerprints: [first.nodes[0].fingerprint] });
  assert.equal(second.nodes.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(second.stats.duplicates, 1);
});
t('能力矩阵：SSR 只有 Mihomo，Hysteria2 优先 sing-box，Reality/Vision 优先 Xray', () => {
  assert.deepEqual(H.importText(ssrLink).nodes[0].kernels, ['mihomo']);
  assert.equal(H.importText(hy2Link).nodes[0].kernel, 'sing-box');
  assert.equal(H.importText(vlessReality).nodes[0].kernel, 'xray');
  assert.equal(H.importText(tuicLink).nodes[0].kernel, 'sing-box');
  assert.equal(H.importText(anytlsLink).nodes[0].kernel, 'sing-box');
});
t('老旧 SS 加密算法自动避开 Xray / sing-box', () => {
  const legacy = 'ss://' + b64('rc4-md5:pw@old.example:8388') + '#OLD';
  const n = H.importText(legacy).nodes[0];
  assert.equal(n.method, 'rc4-md5');
  assert.equal(n.kernel, 'mihomo');
  assert.ok(n.issues.some(i => i.code === 'KERNEL_LIMIT' || i.code === 'PARTIAL_COMPAT'));
});
t('协议能力矩阵覆盖 16+ 协议，且标注 versioned / partial', () => {
  const table = H.capabilityTable();
  assert.ok(table.length >= 17);
  const ssr = table.find(x => x.protocol === 'ssr');
  assert.equal(ssr.xray.level, 'unsupported');
  assert.equal(ssr.mihomo.level, 'partial');
});
t('三内核配置导出 + 未映射字段明确提示', () => {
  const n = H.importText('vmess://' + b64(JSON.stringify({ ...vmessJson, customFoo: 42 }))).nodes[0];
  for (const k of ['xray', 'sing-box', 'mihomo']) {
    const r = H.generateKernelConfig([n], k);
    assert.ok(r.config, `${k} 应生成配置`);
    assert.ok(r.issues.some(i => i.code === 'SECURITY'), `${k} 必须标注只生成不执行`);
    if (k === 'xray') assert.ok(r.unmapped.includes('customFoo'), '未映射字段必须列出');
  }
});
t('不支持的节点不会被硬塞进内核配置，但原配置不丢', () => {
  const ssr = H.importText(ssrLink).nodes[0];
  const r = H.generateKernelConfig([ssr], 'xray');
  assert.equal(r.config.outbounds.length, 2, '只应剩 direct/block');
  assert.ok(r.issues.some(i => i.code === 'KERNEL_LIMIT'));
  assert.ok(ssr.raw.includes('ssr://'));
});
t('协议覆盖清单包含 Reality / XTLS Vision / XHTTP 等', () => {
  const c = H.protocolCoverage();
  assert.ok(c.protocols.length >= 16, `实际 ${c.protocols.length} 个协议`);
  for (const x of ['VLESS Reality', 'XTLS Vision', 'XHTTP', 'gRPC']) assert.ok(c.advanced.includes(x));
  assert.ok(c.formats.some(f => f.includes('v2rayn')));
});

console.log('\n=== 6. 二维码内容链路 ===');
t('二维码内容是分享链接 → 二次判定并出预览', () => {
  const r = H.importQrPayload(vmessLink, 'file');
  assert.equal(r.nodes.length, 1);
  assert.equal(r.previewOnly, true);
  assert.ok(r.issues.some(i => /二维码内容判定/.test(i.message)));
});
t('二维码内容是订阅 URL → requiresFetch，不自动请求', () => {
  const r = H.importQrPayload('https://sub.example.com/qr?token=abc', 'camera');
  assert.equal(r.nodes.length, 0);
  assert.ok(r.requiresFetch);
});
t('二维码内容是 Clash YAML → 按配置解析', () => {
  const r = H.importQrPayload(clashYaml, 'file');
  assert.equal(r.nodes.length, 2);
});
t('无法识别的二维码内容不报成功', () => {
  const r = H.importQrPayload('https://www.example.com/normal-page', 'camera');
  assert.equal(r.nodes.length, 0);
  assert.ok(r.requiresFetch || r.rejected.length > 0 || !r.ok);
});

let qrMod = null;
try { qrMod = await import('../.hub-build/qr.js'); } catch (e) { console.log('  ! qr 模块加载跳过：' + e.message); }
if (qrMod) {
  t('一图多码合并：多来源 + 去重 + 来源标注', () => {
    const hits = [
      { text: vmessLink, source: 'file', origin: 'a.png', timestamp: 1 },
      { text: trojanLink, source: 'clipboard', origin: '剪贴板', timestamp: 2 },
      { text: vmessLink, source: 'batch', origin: 'a.png', timestamp: 3 },
      { text: 'not-a-config', source: 'camera', origin: '摄像头', timestamp: 4 },
    ];
    const r = qrMod.previewQrHits(hits);
    assert.equal(r.nodes.length, 2);
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.rejected.length, 1);
    assert.equal(r.previewOnly, true);
  });
  t('批量文件结果保留每张图片的失败说明', () => {
    const r = qrMod.previewFileScans([
      { fileName: 'a.png', hits: [{ text: vmessLink, source: 'batch', origin: 'a.png', timestamp: 1 }] },
      { fileName: 'bad.xyz', hits: [], error: '不支持的图片格式' },
      { fileName: 'empty.png', hits: [] },
    ]);
    assert.equal(r.nodes.length, 1);
    assert.ok(r.issues.some(i => /bad\.xyz/.test(i.message)));
    assert.ok(r.issues.some(i => /未检测到二维码/.test(i.message)));
  });
  t('二维码内容摘要不误判类型', () => {
    assert.equal(qrMod.summarizeQrPayload(vmessLink).kind, '分享链接');
    assert.equal(qrMod.summarizeQrPayload(clashYaml).kind, 'Clash / Mihomo YAML');
    assert.equal(qrMod.summarizeQrPayload(wgConf).kind, 'WireGuard 配置');
    assert.equal(qrMod.summarizeQrPayload([vmessLink, trojanLink].join('\n')).multiNode, true);
  });
  t('支持的图片格式清单覆盖 PNG/JPG/JPEG/WebP/BMP', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'bmp']) {
      assert.equal(qrMod.isSupportedImage({ name: 'qr.' + ext }), true, ext);
    }
    assert.equal(qrMod.isSupportedImage({ name: 'qr.svg', type: 'image/svg+xml' }), false);
  });
  t('空图像数据不会崩溃，返回空结果', () => {
    assert.deepEqual(qrMod.decodeQRData(new Uint8ClampedArray(400 * 400 * 4), 400, 400), []);
  });
}

/* ------------------------------ 缺协议头自动补全 ------------------------------ */

t('丢失 ss:// 协议头的 SIP002 主体自动补全解析（网页复制剥离协议头）', () => {
  const bodyless = b64('aes-256-gcm:password123') + '@203.0.113.72:19999#SS-repair-test';
  const r = H.importText(bodyless);
  assert.equal(r.nodes.length, 1, `应导入成功：${JSON.stringify(r.rejected)}`);
  assert.equal(r.nodes[0].protocol, 'ss');
  assert.equal(r.nodes[0].server, '203.0.113.72');
  assert.equal(r.nodes[0].port, 19999);
  assert.equal(r.nodes[0].password, 'password123');
  assert.equal(r.nodes[0].name.includes('SS-repair-test'), true, '片段名应保留');
});

t('丢失协议头 + 密码 base64 解不出 UTF-8 时仍能按 ASCII 方法名识别', () => {
  // 密码用非 UTF-8 字节（0xFF 0xFE），base64 解码后 TextDecoder 产出 U+FFFD → decodeBase64Utf8 返回 null
  const pwBytes = Buffer.from([0x70, 0x61, 0xff, 0xfe, 0x73, 0x73]);
  const bodyless = Buffer.concat([Buffer.from('aes-256-gcm:'), pwBytes]).toString('base64') + '@1.2.3.4:8388#odd';
  const r = H.importText(bodyless);
  assert.equal(r.nodes.length, 1, `ASCII 方法名兜底应识别成功：${JSON.stringify(r.rejected)}`);
  assert.equal(r.nodes[0].protocol, 'ss');
});

t('无协议头但不像 ss 主体的内容不误补，维持原拒绝行为', () => {
  const r = H.importText('totally-unknown-content');
  assert.equal(r.nodes.length, 0);
  assert.equal(r.rejected.length, 1);
});

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const [name, e] of failures) console.log(`\n[${name}]\n${e?.stack ?? e}`);
  process.exitCode = 1;
}
