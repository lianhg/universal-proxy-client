/**
 * 内核运行层 —— 由统一节点生成「内核可直接运行」的完整配置
 *
 * 与 hub/kernel.ts 的 generateKernelConfig 的区别：
 * - 后者只生成 outbound 骨架（预览用）
 * - 这里补齐 inbounds / dns / routing / log / tun / controller，并序列化成落盘文本
 *
 * 继承同一条原则：任何无法表达的字段、被排除的节点、被忽略的 TUN 请求，
 * 都必须作为 issue / blocker 返回，绝不静默降级。
 */

import type { KernelType, ParseIssue, UnifiedNode } from '../hub/model.js';
import { KERNEL_MATRIX, generateKernelConfig } from '../hub/kernel.js';
import { issue } from '../hub/util.js';
import type { RuntimeSettings } from './types.js';
import { buildRoutingForKernel, cloneRoutingConfig, validateRouting, type RoutingConfig } from './rules.js';
import { XRAY_API_INBOUND_TAG, XRAY_API_OUTBOUND_TAG } from './xray-stats.js';

/** 把通用 DNS 地址写成 sing-box 1.14 新版 server 对象（旧 {address} 格式 1.14 起被移除） */
function singBoxDnsServer(addr: string, index: number, detour?: string): Record<string, unknown> {
  const ob: Record<string, unknown> = { tag: `dns-${index}` };
  if (detour) ob.detour = detour;
  const m = /^(tls|https|quic|h3):\/\/([^/]+?)(\/[^\s]*)?$/.exec(addr);
  if (m) {
    ob.type = m[1] === 'tls' ? 'tls' : m[1] === 'quic' ? 'quic' : 'https';
    ob.server = m[2];
    if (m[3] && m[3] !== '/') ob.path = m[3];
    if (m[1] === 'h3') ob.type = 'https';
  } else if (addr.startsWith('udp://')) {
    ob.type = 'udp';
    ob.server = addr.slice(6);
  } else if (addr.startsWith('tcp://')) {
    ob.type = 'tcp';
    ob.server = addr.slice(6);
  } else if (/^[a-zA-Z]+:\/\//.test(addr)) {
    // 无法识别的 scheme：保底原样交给内核，由内核报出明确错误
    ob.type = 'udp';
    ob.server = addr;
  } else {
    ob.type = 'udp';
    ob.server = addr;
    ob.server_port = 53;
  }
  return ob;
}

export interface RuntimeConfigResult {
  kernel: KernelType;
  config: Record<string, unknown>;
  text: string;
  filename: string;
  listenPort: number;
  issues: ParseIssue[];
  unmapped: string[];
  /** 硬阻断：出现这些就不该启动进程 */
  blockers: string[];
  notes: string[];
}

const PRIVATE_NETS = [
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
  '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10',
];

function levelForXray(l: RuntimeSettings['logLevel']): string {
  return l === 'debug' ? 'debug' : l === 'info' ? 'info' : l === 'error' ? 'error' : 'warning';
}
function levelForSingBox(l: RuntimeSettings['logLevel']): string {
  return l === 'warn' ? 'warn' : l;
}
function levelForMihomo(l: RuntimeSettings['logLevel']): string {
  return l === 'warn' ? 'warning' : l === 'error' ? 'silent' : l;
}

/**
 * 按【当前能力矩阵】判定某节点能否由该内核承载。
 *
 * 不信任节点上存的 kernels 数组：那是导入时刻的判定快照，
 * 矩阵升级（例如判定 Xray 不再承载 wireguard）后，localStorage 里的旧数据
 * 仍带着过期结论，会把无效 outbound 写进配置、连累整个内核拒绝启动。
 */
export function kernelSupports(node: UnifiedNode, kernel: KernelType): boolean {
  const cap = KERNEL_MATRIX[node.protocol]?.[kernel];
  return !!cap && cap.level !== 'unsupported';
}

/** 把选中的节点排到第一位（Xray 默认走第一个 outbound，Mihomo 默认选中 select 第一项） */
function orderNodes(selected: UnifiedNode, peers: UnifiedNode[], kernel: KernelType): { list: UnifiedNode[]; excluded: UnifiedNode[] } {
  const seen = new Set<string>([selected.id]);
  const list: UnifiedNode[] = [selected];
  const excluded: UnifiedNode[] = [];
  for (const n of peers) {
    if (n.id === selected.id || seen.has(n.id)) continue;
    seen.add(n.id);
    if (kernelSupports(n, kernel)) list.push(n);
    else excluded.push(n);
  }
  return { list, excluded };
}

export function buildRuntimeConfig(
  selected: UnifiedNode,
  kernel: KernelType,
  settings: RuntimeSettings,
  peers: UnifiedNode[] = [],
  routing?: RoutingConfig,
): RuntimeConfigResult {
  const issues: ParseIssue[] = [];
  const blockers: string[] = [];
  const notes: string[] = [];

  if (!selected) return {
    kernel, config: {}, text: '', filename: '', listenPort: settings.mixedPort,
    issues: [issue('error', 'MISSING_REQUIRED', '没有选中任何节点，无法生成运行配置', { field: 'node' })],
    unmapped: [], blockers: ['未选择节点'], notes: [],
  };

  // 节点没选核时（例如从旧数据恢复）给一次补救，否则 generateKernelConfig 会把它整个排除
  const node: UnifiedNode = { ...selected };
  if (!node.kernels?.length) {
    node.kernels = node.kernel ? [node.kernel] : [kernel];
    issues.push(issue('warning', 'DEGRADED',
      `节点「${node.name}」缺少内核能力判定，已按当前内核 ${kernel} 补齐；建议重新导入该节点以完成完整校验`,
      { kernel, field: 'kernels' }));
  }
  // 用当前矩阵重新判定，不依赖快照（旧数据可能带着已过期的能力结论）
  if (!kernelSupports(node, kernel)) {
    blockers.push(`节点「${node.name}」(${node.protocol.toUpperCase()}) 不能由 ${kernel} 承载：${node.kernelReason ?? '能力矩阵不支持'}`);
  }
  if (node.issues?.some(i => i.level === 'error' && i.code === 'MISSING_REQUIRED')) {
    blockers.push(`节点「${node.name}」缺少必填字段，启动几乎必然失败：${node.issues.filter(i => i.level === 'error').map(i => i.message).join('；')}`);
  }

  const { list: ordered, excluded } = orderNodes(node, peers, kernel);
  for (const ex of excluded) {
    issues.push(issue('warning', 'KERNEL_LIMIT',
      `备选节点「${ex.name}」(${ex.protocol.toUpperCase()}) 不能由 ${kernel} 承载，本次未写入配置；原文保留在节点数据中，如需使用请切换到支持它的内核`,
      { kernel, field: ex.protocol }));
  }
  if (excluded.length) notes.push(`${excluded.length} 个备选节点因内核不支持该协议而未写入配置（未静默丢弃，见上方日志）`);

  /* 重名节点：三个内核都要求出站 tag / proxy 名唯一（Xray "existing tag found"、
     sing-box 重复 tag、Clash 重复 proxy 名都是直接拒载）。订阅源里重名很常见。
     处理：改写为「名称 #2」写入配置并留痕，节点内容不动、不丢弃。
     选中节点排在第一位、永远保留原名，因此路由规则对它的引用不受影响。 */
  const tagSeen = new Set<string>();
  let renamed = 0;
  const unique = ordered.map(n => {
    if (!tagSeen.has(n.name)) { tagSeen.add(n.name); return n; }
    let i = 2;
    let cand = `${n.name} #${i}`;
    while (tagSeen.has(cand)) cand = `${n.name} #${++i}`;
    tagSeen.add(cand);
    renamed++;
    issues.push(issue('warning', 'RENAMED',
      `节点「${n.name}」与其他节点重名，已以 tag「${cand}」写入配置（内核要求 tag 唯一；节点内容未修改）`,
      { kernel, field: 'name' }));
    return { ...n, name: cand };
  });
  if (renamed) notes.push(`${renamed} 个重名节点已重命名 tag 后写入配置（未丢弃、内容未变）`);

  const base = generateKernelConfig(unique, kernel);
  // 预览层的 SECURITY 提示在真正落盘的场景下已不成立，替换成运行层的说明
  issues.push(...base.issues.filter(i => i.code !== 'SECURITY'));
  const unmapped = [...base.unmapped];
  const config = JSON.parse(JSON.stringify(base.config)) as Record<string, unknown>;

  /* 用户自定义路由规则：任何无法下发的规则都阻断启动，绝不「忽略几条照常连」 */
  const routingCfg = routing ? cloneRoutingConfig(routing) : null;
  const routingBuild = routingCfg ? buildRoutingForKernel(routingCfg, kernel, node.name) : null;
  if (routingCfg && routingBuild) {
    issues.push(...routingBuild.issues);
    const invalid = validateRouting(routingCfg);
    issues.push(...invalid);
    for (const r of routingBuild.skipped) {
      unmapped.push(`未下发规则 ${r.kind},${r.payload},${r.action}`);
      blockers.push(`路由规则「${r.kind},${r.payload},${r.action}」无法由 ${kernel} 表达；请在「规则管理」禁用该规则或改用支持的写法，避免带着残缺分流策略连接`);
    }
    for (const i of invalid) blockers.push(`路由规则校验失败：${i.message}`);
    notes.push(`已下发 ${routingBuild.applied} 条自定义规则；未下发 ${routingBuild.skipped.length} 条${routingBuild.skipped.length ? '（已阻断启动）' : ''}`);
  }

  const dnsEnabled = routingCfg ? routingCfg.dnsEnabled : settings.dnsEnabled;
  const dnsServers = routingCfg?.dnsServers?.length ? routingCfg.dnsServers : settings.dnsServers;
  const bypassLan = routingCfg ? routingCfg.bypassLan : settings.bypassLan;
  const listen = settings.listenAddress || '127.0.0.1';

  if (kernel === 'xray') {
    config.log = { loglevel: levelForXray(settings.logLevel), access: '', error: '' };
    // Xray 没有 mixed 入站，HTTP 与 SOCKS 必须分开；系统代理指向 http-in
    config.inbounds = [
      { tag: 'socks-in', port: settings.socksPort, listen, protocol: 'socks', settings: { udp: true, auth: 'noauth' } },
      { tag: 'http-in', port: settings.httpPort, listen, protocol: 'http', settings: { allowTransparent: false } },
    ];
    if (dnsEnabled) {
      config.dns = { servers: [...dnsServers], tag: 'dns-in' };
      notes.push(`DNS 交由 Xray 处理：${dnsServers.join(' / ')}`);
    }
    const rules: Record<string, unknown>[] = [];
    if (dnsEnabled) rules.push({ type: 'field', inboundTag: ['dns-in'], outboundTag: 'direct' });
    if (bypassLan) rules.push({ type: 'field', ip: PRIVATE_NETS, outboundTag: 'direct' });
    if (routingBuild) rules.push(...(routingBuild.items as Record<string, unknown>[]));
    // gRPC 统计：运行层每秒打一次 QueryStats 拿真实上下行字节（实时网速的数据源）
    config.stats = {};
    config.policy = {
      levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
      system: {
        statsInboundUplink: true, statsInboundDownlink: true,
        statsOutboundUplink: true, statsOutboundDownlink: true,
      },
    };
    (config.inbounds as Record<string, unknown>[]).push({
      tag: XRAY_API_INBOUND_TAG, listen, port: settings.controllerPort,
      protocol: 'dokodemo-door', settings: { address: '127.0.0.1' },
    });
    config.api = { tag: XRAY_API_OUTBOUND_TAG, services: ['StatsService'] };
    // api 路由规则必须排第一，否则会被 MATCH 之类的兜底规则抢先吃掉
    rules.unshift({ type: 'field', inboundTag: [XRAY_API_INBOUND_TAG], outboundTag: XRAY_API_OUTBOUND_TAG });
    notes.push(`已开启 gRPC 统计接口（${listen}:${settings.controllerPort}）：实时网速由此采样，代理行为不受影响`);
    config.routing = { domainStrategy: 'IPIfNonMatch', rules };
    if (settings.mode === 'tun') {
      blockers.push('Xray-core 不提供 TUN 入站；TUN 模式请改用 sing-box 或 Mihomo 内核');
      issues.push(issue('error', 'KERNEL_LIMIT', 'Xray 无 TUN 入站能力，本次未生成任何 TUN 配置（未静默忽略该请求）', { kernel, field: 'mode' }));
    }
    notes.push(`入站：SOCKS ${settings.socksPort} / HTTP ${settings.httpPort}；系统代理指向 HTTP 端口；默认路由指向第一个 outbound（当前节点）`);
  } else if (kernel === 'sing-box') {
    config.log = { level: levelForSingBox(settings.logLevel), timestamp: true, disabled: false };
    const inbounds: Record<string, unknown>[] = [
      { type: 'mixed', tag: 'mixed-in', listen, listen_port: settings.mixedPort },
      { type: 'socks', tag: 'socks-in', listen, listen_port: settings.socksPort },
      { type: 'http', tag: 'http-in', listen, listen_port: settings.httpPort },
    ];
    if (settings.mode === 'tun') {
      inbounds.unshift({
        type: 'tun', tag: 'tun-in', interface_name: settings.tun.interfaceName,
        mtu: settings.tun.mtu, auto_route: settings.tun.autoRoute,
        strict_route: settings.tun.strictRoute, stack: settings.tun.stack,
        address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
      });
      notes.push('TUN 入站已写入；创建虚拟网卡需要管理员权限，无权限时内核会明确报错');
    }
    config.inbounds = inbounds;
    config.experimental = {
      clash_api: { external_controller: `${listen}:${settings.controllerPort}` },
      // sing-box 1.8+ 废弃 clash_api.store_selected，改为独立的 cache_file
      cache_file: { enabled: true, store_fakeip: true },
    };
    if (dnsEnabled) {
      // sing-box 1.12 起弃用、1.14 起移除旧版 { address } DNS 格式，必须用新 server 对象
      config.dns = {
        servers: dnsServers.map((addr, i) => singBoxDnsServer(addr, i, i === 0 ? 'direct' : undefined)),
        strategy: 'prefer_ipv4',
      };
      notes.push(`DNS 由 sing-box 接管，首选 ${dnsServers[0]} 直连查询`);
    }
    const routeRules: Record<string, unknown>[] = [];
    if (bypassLan) routeRules.push({ ip_cidr: PRIVATE_NETS, outbound: 'direct' });
    if (routingBuild) routeRules.push(...(routingBuild.items as Record<string, unknown>[]));
    // sing-box 1.12+ 要求出站域名解析显式指向 DNS 服务器 tag，否则报 deprecated / 拒载
    config.route = { ...(config.route as object ?? {}), rules: routeRules, auto_detect_interface: settings.mode === 'tun', default_domain_resolver: 'dns-0' };
    notes.push('已开启 clash_api：实时流量 / 连接统计由运行层每秒采样');
  } else {
    (config as any)['mixed-port'] = settings.mixedPort;
    (config as any)['socks-port'] = settings.socksPort;
    (config as any).port = settings.httpPort;
    (config as any)['allow-lan'] = listen !== '127.0.0.1';
    (config as any)['bind-address'] = listen;
    (config as any)['log-level'] = levelForMihomo(settings.logLevel);
    (config as any)['external-controller'] = `${listen}:${settings.controllerPort}`;
    // geo 数据源改走 jsdelivr 镜像：默认 GitHub release 直连国内经常失败，
    // 而首次用 GEOSITE/GEOIP 规则启动时代理还没建立（鸡生蛋），必须保证直连可达。
    (config as any)['geox-url'] = {
      geoip: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat',
      geosite: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat',
      mmdb: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb',
      asn: 'https://fastly.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/GeoLite2-ASN.mmdb',
    };
    const proxies = (config as any).proxies as Record<string, unknown>[];
    const names = proxies.map((p: any) => String(p.name));
    (config as any)['proxy-groups'] = [
      { name: 'PROXY', type: 'select', proxies: names.length ? names : ['DIRECT'] },
      { name: 'FALLBACK', type: 'fallback', proxies: names.length ? names : ['DIRECT'], url: 'http://www.gstatic.com/generate_204', interval: 300 },
    ];
    const rules: string[] = [];
    if (bypassLan) PRIVATE_NETS.forEach(n => rules.push(`IP-CIDR,${n},DIRECT,no-resolve`));
    if (routingBuild) rules.push(...(routingBuild.items as string[]));
    else rules.push('MATCH,PROXY');
    (config as any).rules = rules;
    if (dnsEnabled) {
      (config as any).dns = {
        enable: true, 'enhanced-mode': 'fake-ip', 'fake-ip-range': '198.18.0.1/16',
        nameserver: [...dnsServers], 'default-nameserver': [dnsServers[0]],
      };
      notes.push('DNS 已开启 fake-ip 模式，配合 TUN 可避免 DNS 泄漏');
    }
    if (settings.mode === 'tun') {
      (config as any).tun = {
        enable: true, stack: settings.tun.stack, mtu: settings.tun.mtu,
        'auto-route': settings.tun.autoRoute, 'strict-route': settings.tun.strictRoute,
        'auto-detect-interface': true, 'device-name': settings.tun.interfaceName,
        'dns-hijack': ['any:53'],
      };
      notes.push('TUN 已开启；Mihomo 创建虚拟网卡需要管理员权限');
    }
    notes.push(`代理组 PROXY 默认选中「${node.name}」`);
  }

  if (unmapped.length) notes.push(`${unmapped.length} 类字段内核无法表达，原值仍保存在节点 raw / extras：${unmapped.slice(0, 8).join('、')}${unmapped.length > 8 ? '…' : ''}`);
  if (peers.length) notes.push(`同内核备选节点 ${peers.length} 个一并写入，方便运行时切换`);
  issues.push(issue('info', 'SECURITY',
    '本配置由用户在界面确认后生成；系统代理改动前会保存原始快照，断开或退出时按快照恢复。',
    { kernel }));

  const text = kernel === 'mihomo' ? toYaml(config) : JSON.stringify(config, null, 2);
  const filename = kernel === 'mihomo' ? 'runtime-mihomo.yaml'
    : kernel === 'sing-box' ? 'runtime-sing-box.json' : 'runtime-xray.json';

  return { kernel, config, text, filename, listenPort: settings.mixedPort, issues, unmapped, blockers, notes };
}

/** 只针对本模块生成的结构做 YAML 序列化（不依赖第三方 yaml 库） */
export function toYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    if (/^[\w./:@-]+$/.test(value) && !/^(true|false|null|yes|no|on|off|\d+)$/i.test(value)) return value;
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value.map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        // 对象数组：首行接在 "- " 后面，其余行统一缩进 indent+2
        const lines = toYaml(item, indent + 2).split('\n');
        const first = lines[0].slice(indent + 2);
        return [`${pad}- ${first}`, ...lines.slice(1)].join('\n');
      }
      return `${pad}- ${toYaml(item, 0)}`;
    }).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    if (!entries.length) return '{}';
    return entries.map(([k, v]) => {
      const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : `'${k}'`;
      if (v && typeof v === 'object') {
        const child = toYaml(v, indent + 2);
        if (child === '[]' || child === '{}') return `${pad}${key}: ${child}`;
        return `${pad}${key}:\n${child}`;
      }
      return `${pad}${key}: ${toYaml(v, 0)}`;
    }).join('\n');
  }
  return 'null';
}
