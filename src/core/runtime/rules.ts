/**
 * 路由规则 / DNS 分流 —— 纯逻辑层
 *
 * 红线（延续「任何配置都不能静默丢失参数」）：
 * 某个内核无法表达的规则，必须作为 issue + skipped 明确返回，并让运行层阻断启动。
 * 绝不允许「忽略几条规则后照常连接」——那会悄悄改变分流行为，属于安全问题。
 */

import type { KernelType, ParseIssue } from '../hub/model.js';
import { issue } from '../hub/util.js';

export type RuleKind =
  | 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD'
  | 'GEOSITE' | 'IP-CIDR' | 'GEOIP'
  | 'PROCESS-NAME' | 'PROCESS-PATH'
  | 'DST-PORT' | 'SRC-PORT' | 'MATCH';

export type RuleAction = 'PROXY' | 'DIRECT' | 'REJECT';

export interface RoutingRule {
  id: string;
  enabled: boolean;
  kind: RuleKind;
  payload: string;
  action: RuleAction;
  comment: string;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  defaultAction: RuleAction;
  bypassLan: boolean;
  dnsEnabled: boolean;
  dnsServers: string[];
}

export const RULE_KINDS: RuleKind[] = [
  'DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'GEOSITE', 'IP-CIDR', 'GEOIP',
  'PROCESS-NAME', 'PROCESS-PATH', 'DST-PORT', 'SRC-PORT', 'MATCH',
];
export const RULE_ACTIONS: RuleAction[] = ['PROXY', 'DIRECT', 'REJECT'];

let seq = 0;
export function createRule(partial: Partial<RoutingRule> = {}): RoutingRule {
  seq += 1;
  return {
    id: partial.id || `rule-${Date.now().toString(36)}-${seq}`,
    enabled: partial.enabled !== false,
    kind: partial.kind ?? 'DOMAIN-SUFFIX',
    payload: partial.payload ?? '',
    action: partial.action ?? 'PROXY',
    comment: partial.comment ?? '',
  };
}

/** 默认只放三个内核都能表达的规则，避免用户一选 Xray 就被规则能力差异挡住 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  rules: [
    createRule({ kind: 'DOMAIN-SUFFIX', payload: 'localhost', action: 'DIRECT', comment: '本机地址直连' }),
    createRule({ kind: 'DOMAIN-SUFFIX', payload: 'local', action: 'DIRECT', comment: '本地域名直连' }),
    createRule({ kind: 'MATCH', payload: '', action: 'PROXY', comment: '其余流量走代理' }),
  ],
  defaultAction: 'PROXY',
  bypassLan: true,
  dnsEnabled: true,
  dnsServers: ['223.5.5.5', '119.29.29.29', '8.8.8.8'],
};

export function cloneRoutingConfig(input?: Partial<RoutingConfig>): RoutingConfig {
  const base = DEFAULT_ROUTING_CONFIG;
  return {
    rules: (input?.rules ?? base.rules).map(r => ({ ...r })),
    defaultAction: input?.defaultAction ?? base.defaultAction,
    bypassLan: input?.bypassLan ?? base.bypassLan,
    dnsEnabled: input?.dnsEnabled ?? base.dnsEnabled,
    dnsServers: [...(input?.dnsServers?.length ? input.dnsServers : base.dnsServers)],
  };
}

/** 单条规则校验；返回具体问题列表，空数组表示可用 */
export function validateRule(rule: RoutingRule): string[] {
  const errs: string[] = [];
  if (!RULE_KINDS.includes(rule.kind)) errs.push(`未知规则类型「${rule.kind}」`);
  if (!RULE_ACTIONS.includes(rule.action)) errs.push(`未知动作「${rule.action}」`);
  const p = rule.payload.trim();
  if (rule.kind !== 'MATCH' && !p) errs.push('规则内容不能为空');
  if (rule.kind === 'IP-CIDR' && p && !/^[0-9a-fA-F:.]+\/\d{1,3}$/.test(p)) {
    errs.push(`IP-CIDR 格式不合法：${p}（示例 192.168.0.0/16）`);
  }
  if (/^(DST|SRC)-PORT$/.test(rule.kind) && p && !/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(p)) {
    errs.push(`端口格式不合法：${p}（示例 80,443 或 8000-9000）`);
  }
  if (/^DOMAIN/.test(rule.kind) && p && /[\s,:]/.test(p)) {
    errs.push(`域名不能包含空格 / 逗号 / 冒号：${p}`);
  }
  return errs;
}

export function validateRouting(cfg: RoutingConfig): ParseIssue[] {
  const out: ParseIssue[] = [];
  cfg.rules.filter(r => r.enabled).forEach((r, i) => {
    for (const m of validateRule(r)) {
      out.push(issue('error', 'INVALID_VALUE', `第 ${i + 1} 条规则（${r.kind} ${r.payload}）：${m}`, { field: 'rules', value: r.id }));
    }
  });
  if (cfg.dnsEnabled && !cfg.dnsServers.length) {
    out.push(issue('error', 'INVALID_VALUE', '已开启 DNS 分流但没有填写 DNS 服务器', { field: 'dnsServers' }));
  }
  return out;
}

/**
 * 解析 Clash / Mihomo 规则文本。
 * 无法识别的类型逐行作为 issue 返回，不静默丢弃；`no-resolve` 等选项会保留到 comment。
 */
export function parseRuleText(text: string): { rules: RoutingRule[]; issues: ParseIssue[] } {
  const rules: RoutingRule[] = [];
  const issues: ParseIssue[] = [];
  String(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const parts = line.split(',').map(s => s.trim());
    const kind = parts[0].toUpperCase() as RuleKind;
    let payload = parts[1] ?? '';
    let action = (parts[2] ?? '').toUpperCase() as RuleAction;
    let extra = parts.slice(3);
    // Clash 常见的两字段写法 `MATCH,PROXY`（MATCH 没有 payload）
    if (kind === 'MATCH' && parts.length === 2 && RULE_ACTIONS.includes(payload.toUpperCase() as RuleAction)) {
      action = payload.toUpperCase() as RuleAction;
      payload = '';
      extra = [];
    }
    if (!RULE_KINDS.includes(kind)) {
      issues.push(issue('error', 'PARSE_ERROR', `第 ${i + 1} 行规则类型「${parts[0]}」无法识别，已拒绝导入：${line.slice(0, 120)}`, { value: line.slice(0, 200) }));
      return;
    }
    if (!RULE_ACTIONS.includes(action)) {
      issues.push(issue('error', 'PARSE_ERROR', `第 ${i + 1} 行动作「${parts[2] ?? '空'}」无法识别，已拒绝导入：${line.slice(0, 120)}`, { value: line.slice(0, 200) }));
      return;
    }
    const rule = createRule({ kind, payload, action, comment: extra.join(',') });
    const errs = validateRule(rule);
    if (errs.length) {
      issues.push(issue('error', 'INVALID_VALUE', `第 ${i + 1} 行：${errs.join('；')}`, { value: line.slice(0, 200) }));
      return;
    }
    rules.push(rule);
  });
  return { rules, issues };
}

export function serializeRuleText(rules: RoutingRule[]): string {
  return rules.map(r => {
    // MATCH 无 payload，但保留空位，保证「导出 → 再导入」字段不会错位
    const cells = r.kind === 'MATCH'
      ? ['MATCH', '', r.action, ...(r.comment ? [r.comment] : [])]
      : [r.kind, r.payload, r.action, ...(r.comment ? [r.comment] : [])];
    return cells.join(',').replace(/,\s*$/, '');
  }).join('\n');
}

/* ───────────────────── 各内核能力矩阵 ───────────────────── */

const UNSUPPORTED: Record<KernelType, Partial<Record<RuleKind, string>>> = {
  xray: {
    'PROCESS-NAME': 'Xray routing 不支持按进程名匹配（无进程信息来源）',
    'PROCESS-PATH': 'Xray routing 不支持按进程路径匹配',
    GEOSITE: 'Xray 的 geosite 需要 geosite.dat 规则文件，当前未随程序分发；请改用 DOMAIN-SUFFIX 或切换 Mihomo',
    GEOIP: 'Xray 的 geoip 需要 geoip.dat 规则文件，当前未随程序分发；请改用 IP-CIDR 或切换 Mihomo',
    'SRC-PORT': 'Xray 支持 sourcePort，但转换需要逐条拆分端口段，当前未实现以避免静默丢失',
  },
  'sing-box': {
    GEOSITE: 'sing-box 的 geosite 需要 rule_set / geosite 资源，当前未随程序分发；请改用 DOMAIN-SUFFIX 或切换 Mihomo',
    GEOIP: 'sing-box 的 geoip 需要 rule_set / geoip 资源，当前未随程序分发；请改用 IP-CIDR 或切换 Mihomo',
    'SRC-PORT': 'sing-box 路由规则无 source_port 字段，无法表达',
  },
  mihomo: {},
};

export function unsupportedKinds(kernel: KernelType): Partial<Record<RuleKind, string>> {
  return UNSUPPORTED[kernel] ?? {};
}

/**
 * Xray / sing-box 的 outbound tag 是节点名，另有内置的 direct 与 block；
 * 不存在名为 "proxy" 的出站，指向它会导致内核启动失败。
 */
function actionOutbound(action: RuleAction, kernel: KernelType, proxyTag: string): string {
  if (action === 'DIRECT') return 'direct';
  if (action === 'REJECT') return 'block';
  return kernel === 'mihomo' ? 'PROXY' : proxyTag;
}

function portList(p: string): number[] {
  const out: number[] = [];
  for (const seg of p.split(',')) {
    const m = seg.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let v = a; v <= b && out.length < 64; v++) out.push(v);
  }
  return out;
}

export interface RoutingBuildResult {
  kernel: KernelType;
  /** 可直接写进内核配置的对象 / 字符串 */
  items: unknown[];
  /** 未能下发的规则（原样返回，供 UI 列出） */
  skipped: RoutingRule[];
  issues: ParseIssue[];
  applied: number;
}

/** 按内核生成规则；任何无法表达的规则都进 skipped + issues */
export function buildRoutingForKernel(cfg: RoutingConfig, kernel: KernelType, proxyTag = 'PROXY'): RoutingBuildResult {
  const issues: ParseIssue[] = [];
  const skipped: RoutingRule[] = [];
  const items: unknown[] = [];
  const active = cfg.rules.filter(r => r.enabled);
  const bad = unsupportedKinds(kernel);

  for (const r of active) {
    if (bad[r.kind]) {
      skipped.push(r);
      issues.push(issue('error', 'KERNEL_LIMIT',
        `内核 ${kernel} 无法下发规则「${r.kind},${r.payload},${r.action}」：${bad[r.kind]}。请禁用该规则、改用支持的写法或切换内核。`,
        { kernel, field: 'rules', value: serializeRuleText([r]) }));
      continue;
    }
    const out = actionOutbound(r.action, kernel, proxyTag);
    if (kernel === 'xray') {
      const rule: Record<string, unknown> = { type: 'field', outboundTag: out };
      if (r.kind === 'DOMAIN') rule.domain = [r.payload];
      else if (r.kind === 'DOMAIN-SUFFIX') rule.domain = [`domain:${r.payload}`];
      else if (r.kind === 'DOMAIN-KEYWORD') rule.domain = [`keyword:${r.payload}`];
      else if (r.kind === 'IP-CIDR') rule.ip = [r.payload];
      else if (r.kind === 'DST-PORT') rule.port = r.payload;
      else if (r.kind === 'PROCESS-NAME' || r.kind === 'PROCESS-PATH') { /* 已在上方拦截 */ }
      else if (r.kind === 'MATCH') rule.network = 'tcp,udp'; // Xray 拒绝只有 outboundTag 的规则（"no effective fields"），tcp+udp 即全匹配
      items.push(rule);
    } else if (kernel === 'sing-box') {
      const rule: Record<string, unknown> = { outbound: out };
      if (r.kind === 'DOMAIN') rule.domain = [r.payload];
      else if (r.kind === 'DOMAIN-SUFFIX') rule.domain_suffix = [r.payload];
      else if (r.kind === 'DOMAIN-KEYWORD') rule.domain_keyword = [r.payload];
      else if (r.kind === 'IP-CIDR') rule.ip_cidr = [r.payload];
      else if (r.kind === 'PROCESS-NAME') rule.process_name = [r.payload];
      else if (r.kind === 'PROCESS-PATH') rule.process_path = [r.payload];
      else if (r.kind === 'DST-PORT') rule.port = portList(r.payload);
      else if (r.kind === 'MATCH') rule.network = ['tcp', 'udp']; // sing-box 校验"missing conditions"，tcp+udp 即全匹配
      items.push(rule);
    } else {
      const text = r.kind === 'MATCH'
        ? `MATCH,${r.action}`
        : `${r.kind},${r.payload},${r.action}${r.comment ? ',' + r.comment : ''}`;
      items.push(text);
    }
  }

  // 收尾：保证任何内核都有一个兜底规则，否则内核的默认行为可能与用户预期不同
  const hasCatchAll = active.some(r => r.kind === 'MATCH' && !bad[r.kind]);
  if (!hasCatchAll) {
    if (kernel === 'xray') items.push({ type: 'field', outboundTag: actionOutbound(cfg.defaultAction, kernel, proxyTag), network: 'tcp,udp' });
    else if (kernel === 'sing-box') items.push({ outbound: actionOutbound(cfg.defaultAction, kernel, proxyTag), network: ['tcp', 'udp'] });
    else items.push(`MATCH,${cfg.defaultAction}`);
    issues.push(issue('info', 'DEGRADED',
      `规则列表没有 MATCH 兜底，已按默认动作 ${cfg.defaultAction} 补一条（不会静默改变分流方向）`, { kernel }));
  }
  return { kernel, items, skipped, issues, applied: items.length - (hasCatchAll ? 0 : 1) };
}

/** 供 UI 展示的能力矩阵 */
export function routingCoverage() {
  return (['xray', 'sing-box', 'mihomo'] as KernelType[]).map(kernel => ({
    kernel,
    supported: RULE_KINDS.filter(k => !unsupportedKinds(kernel)[k]),
    unsupported: Object.entries(unsupportedKinds(kernel)).map(([kind, reason]) => ({ kind, reason: String(reason) })),
  }));
}
