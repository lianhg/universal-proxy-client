/**
 * 全能代理客户端 —— 统一配置解析中心（Unified Config Hub）
 *
 * 对外只暴露少量入口：
 *   importText(text, opts)          任意文本 / 文件内容 / 二维码解出的内容
 *   detectFormat(text)             只看格式，不解析
 *   importQrPayload(text, source)  二维码专用入口（带来源标注）
 *   protocolCoverage()             能力清单（供 UI 展示）
 *
 * 安全边界：本模块是纯函数层，不联网、不读文件、不启动内核、不写系统代理。
 * 返回的 ImportReport.previewOnly 恒为 true，必须由调用方让用户确认后再落盘。
 */

import type {
  DetectedFormat, ImportOptions, ImportReport, ParseIssue, RejectedItem, UnifiedNode,
} from './model.js';
import { PROTOCOL_LABELS } from './model.js';
import { buildReport, issue } from './util.js';
import { isShareLink, parseShareLink, parseShareLinks, SHARE_SCHEMES } from './share-links.js';
import {
  detectFormat as detect, parseClashYaml, parseSingBoxJson, parseSubscriptionContent,
  parseSubscriptionUrl, parseWireGuardConf, parseWrapper, parseXrayJson,
  type DetectResult, type FormatContext, type FormatOutcome, type RecurseFn, WRAPPER_SCHEMES,
} from './formats.js';
import { capabilityTable, generateKernelConfig, KERNEL_LABELS, KERNEL_MATRIX, selectKernels } from './kernel.js';

export { detect };
export type { DetectResult };
export * from './model.js';
export { parseShareLink, parseShareLinks, isShareLink, SHARE_SCHEMES } from './share-links.js';
export {
  parseClashYaml, parseSingBoxJson, parseXrayJson, parseWireGuardConf,
  parseSubscriptionContent, parseWrapper, parseSubscriptionUrl, WRAPPER_SCHEMES,
} from './formats.js';
export {
  KERNEL_MATRIX, KERNEL_LABELS, capabilityTable, selectKernels, generateKernelConfig,
  buildXrayOutbound, buildSingBoxOutbound, buildMihomoProxy,
} from './kernel.js';
export { parseYaml, extractListBlocks } from './yaml.js';
/** 剥离 Vue/Pinia 响应式 Proxy —— 跨 IPC 传参前必须调用（否则 structuredClone 报 runtime-5） */
export { toPlain } from './util.js';

/** 支持的协议 / 传输 / 安全层 / 配置格式清单，供界面展示与自检 */
export function protocolCoverage() {
  return {
    protocols: Object.entries(PROTOCOL_LABELS).filter(([k]) => k !== 'unknown').map(([key, label]) => ({ key, label })),
    shareSchemes: [...SHARE_SCHEMES],
    wrapperSchemes: [...WRAPPER_SCHEMES],
    transports: ['tcp', 'ws', 'grpc', 'h2', 'http', 'httpupgrade', 'xhttp', 'splithttp', 'kcp', 'quic'],
    security: ['tls', 'reality', 'xtls', 'none'],
    advanced: ['VLESS Reality', 'XTLS Vision', 'WebSocket', 'gRPC', 'HTTP/2', 'XHTTP', 'TLS', 'UDP over TCP'],
    formats: ['Clash / Mihomo YAML', 'sing-box JSON', 'Xray / V2Ray JSON', 'WireGuard .conf', '订阅 Base64 批量', 'SSD 订阅', 'v2rayn:// 包装', '多行分享链接'],
    kernels: Object.entries(KERNEL_LABELS).map(([key, label]) => ({ key, label })),
  };
}

function emptyOutcome(): FormatOutcome {
  return { nodes: [], rejected: [], issues: [] };
}

/**
 * 统一导入入口。任意来源（粘贴、文件、二维码、订阅返回体）都走这里。
 */
export function importText(text: string, opts: ImportOptions = {}): ImportReport {
  const depth = opts._depth ?? 0;
  const maxDepth = opts.maxDepth ?? 3;
  const detected = detect(text);
  const ctx: FormatContext = {
    source: opts.source ?? 'paste',
    rawFormat: detected.format,
    maxDepth,
    _depth: depth,
  };
  const issues: ParseIssue[] = [];
  const rejected: RejectedItem[] = [];
  let outcome: FormatOutcome = emptyOutcome();

  if (depth > maxDepth) {
    return buildReport('unknown', '嵌套层数超限',
      [], [{ raw: String(text).slice(0, 200), reason: `配置嵌套解包超过 ${maxDepth} 层，已停止以防递归炸弹；原始内容保留`, issues: [issue('error', 'SECURITY', '嵌套层数超限，已中止解析')] }],
      [issue('error', 'SECURITY', `配置嵌套解包超过 ${maxDepth} 层，已停止解析`)]);
  }

  const recurse: RecurseFn = (payload, nextCtx) => importText(payload, {
    ...opts,
    source: nextCtx.source ?? ctx.source,
    _depth: (nextCtx._depth ?? depth) + 1,
    existingFingerprints: [],
  });

  switch (detected.format) {
    case 'share-link': {
      const r = parseShareLink(text.trim(), { source: ctx.source, rawFormat: 'share-link' });
      if ('node' in r) outcome.nodes.push(r.node);
      else outcome.rejected.push(r.rejected);
      break;
    }
    case 'share-link-batch': {
      const r = parseShareLinks(text, { source: ctx.source, rawFormat: 'share-link-batch' });
      outcome.nodes.push(...r.nodes);
      outcome.rejected.push(...r.rejected);
      break;
    }
    case 'v2rayn-wrapper':
      outcome = parseWrapper(text, ctx, recurse);
      break;
    case 'subscription-url':
      outcome = parseSubscriptionUrl(text.trim(), ctx);
      break;
    case 'subscription-content':
      outcome = parseSubscriptionContent(text, ctx, recurse);
      break;
    case 'clash-yaml':
      outcome = parseClashYaml(text, ctx);
      break;
    case 'sing-box-json':
      outcome = parseSingBoxJson(text, ctx);
      break;
    case 'xray-json':
      outcome = parseXrayJson(text, ctx);
      break;
    case 'wireguard-conf':
      outcome = parseWireGuardConf(text, ctx);
      break;
    case 'qr-payload':
      outcome = { ...emptyOutcome(), ...(() => {
        const inner = detect(text);
        if (inner.format === 'unknown') {
          return { rejected: [{ raw: text, reason: `二维码内容无法识别：${inner.detail}`, issues: [issue('error', 'UNSUPPORTED_PROTOCOL', inner.detail)] }] };
        }
        const r = importText(text, { ...opts, _depth: depth + 1, source: ctx.source });
        return { nodes: r.nodes, rejected: r.rejected, issues: r.issues, requiresFetch: r.requiresFetch };
      })() };
      break;
    default:
      outcome.rejected.push({
        raw: String(text).slice(0, 300),
        reason: `${detected.label}：${detected.detail}。解析中心不会把无法识别的内容伪装成导入成功。`,
        issues: [issue('error', 'UNSUPPORTED_PROTOCOL',
          `${detected.label}：${detected.detail}`, { value: String(text).slice(0, 120) })],
      });
      break;
  }

  // 汇总各解析层产生的提示
  issues.push(...outcome.issues);
  rejected.push(...outcome.rejected);

  // ---- 去重（与已有节点 + 本次导入内部） ----
  const seen = new Set(opts.existingFingerprints ?? []);
  const nodes: UnifiedNode[] = [];
  const duplicates: UnifiedNode[] = [];
  for (const n of outcome.nodes) {
    if (seen.has(n.fingerprint)) {
      duplicates.push(n);
      n.issues.push(issue('info', 'DUPLICATE', `节点「${n.name}」与已有节点重复（指纹 ${n.fingerprint}），已列入重复列表，不自动覆盖`, { field: 'fingerprint', value: n.fingerprint }));
    } else {
      seen.add(n.fingerprint);
      nodes.push(n);
    }
  }
  if (duplicates.length) {
    issues.push(issue('info', 'DUPLICATE', `本次有 ${duplicates.length} 个重复节点，未自动写入；可在导入预览中手动选择覆盖`, { value: duplicates.length }));
  }

  // ---- 自动选核 ----
  if (!opts.skipKernel) {
    for (const n of nodes) selectKernels(n);
    const noKernel = nodes.filter(n => !n.kernel);
    if (noKernel.length) {
      issues.push(issue('warning', 'KERNEL_LIMIT',
        `${noKernel.length} 个节点当前没有可用内核（${noKernel.slice(0, 5).map(n => n.protocol.toUpperCase()).join('、')}）；配置已完整保留，需额外兼容处理`,
        { value: noKernel.length }));
    }
  }

  // ---- 阻断性问题汇总到报告级别，避免用户漏看 ----
  const blocking = nodes.filter(n => n.issues.some(i => i.level === 'error'));
  if (blocking.length) {
    issues.push(issue('error', 'MISSING_REQUIRED',
      `有 ${blocking.length} 个节点存在必填字段缺失或字段非法：${blocking.slice(0, 5).map(n => `「${n.name}」`).join('、')}${blocking.length > 5 ? '…' : ''}。这些节点已在预览中标红，未阻止生成预览，但不应直接连接。`,
      { value: blocking.length }));
  }
  const lossy = nodes.filter(n => !n.lossless);
  if (lossy.length) {
    issues.push(issue('warning', 'UNKNOWN_FIELD',
      `有 ${lossy.length} 个节点含未映射字段，原始配置已完整保存在 raw / extras，未静默丢弃；请在导入预览中逐条确认。`,
      { value: lossy.length }));
  }

  // 安全承诺
  issues.push(issue('info', 'SECURITY',
    '本次结果仅为预览：未发起网络请求、未写入节点列表、未启动内核、未修改系统代理 / TUN。确认后才可执行导入。',
    {}));

  return buildReport(detected.format, detected.label, nodes, rejected, issues, duplicates, outcome.requiresFetch);
}

/** 二维码解出的裸内容入口：带来源标注 + 二次格式判定 */
export function importQrPayload(text: string, source: 'camera' | 'file' | 'clipboard' | 'screen' | 'region' | 'batch' = 'camera', opts: ImportOptions = {}): ImportReport {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) {
    return buildReport('unknown', '空二维码内容', [], [{ raw: '', reason: '二维码内容为空', issues: [issue('error', 'PARSE_ERROR', '二维码内容为空')] }], []);
  }
  const detected = detect(trimmed);
  const report = importText(trimmed, { ...opts, source: `qr:${source}` });
  // 二维码只是数据载体：明确告知解出的到底是什么
  report.issues.unshift(issue('info', 'PARTIAL_COMPAT',
    `二维码内容判定为「${detected.label}」（${detected.detail}）；二维码本身只是数据载体，已按内容类型二次处理`,
    { field: 'format', value: detected.format }));
  return report;
}

/** 文件导入入口：按扩展名做提示，但内容判定仍以 detectFormat 为准（不信扩展名） */
export function importConfigFile(fileName: string, content: string, opts: ImportOptions = {}): ImportReport {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const report = importText(content, { ...opts, source: `file:${fileName}` });
  const extMap: Record<string, string> = {
    yaml: 'Clash / Mihomo YAML', yml: 'Clash / Mihomo YAML',
    json: 'sing-box / Xray JSON', conf: 'WireGuard .conf',
    txt: '订阅内容 / 分享链接', sub: '订阅内容',
  };
  if (extMap[ext]) {
    report.issues.unshift(issue('info', 'PARTIAL_COMPAT',
      `文件 ${fileName} 扩展名暗示「${extMap[ext]}」，实际格式以内容判定为准：${report.formatLabel}`,
      { field: 'extension', value: ext }));
  }
  report.nodes.forEach(n => { n.source = `file:${fileName}`; });
  return report;
}
