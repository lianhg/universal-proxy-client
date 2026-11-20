/**
 * 统一配置解析中心 —— 数据模型
 *
 * 设计原则（对应需求规格）：
 * 1. 任何导入的配置都不能静默丢失参数。未知字段一律进入 `extras`，并生成 issue 明确提示。
 * 2. 原始配置文本完整保留在 `raw`，随时可回溯 / 重新解析 / 导出。
 * 3. 解析结果只是"预览数据"，绝不在解析阶段执行任何配置（安全边界）。
 */

export type KernelType = 'xray' | 'sing-box' | 'mihomo';

/** 支持的协议。unknown 只用于"识别出是配置、但协议无法判定"的场景，绝不冒充成功。 */
export type Protocol =
  | 'vmess' | 'vless' | 'trojan'
  | 'ss' | 'ssr'
  | 'socks4' | 'socks5' | 'http' | 'https'
  | 'hysteria' | 'hysteria2' | 'tuic'
  | 'wireguard' | 'anytls' | 'naive' | 'ssh'
  | 'unknown';

/** 传输层 */
export type Transport =
  | 'tcp' | 'ws' | 'grpc' | 'h2' | 'http' | 'httpupgrade'
  | 'xhttp' | 'splithttp' | 'kcp' | 'quic' | 'none';

/** 底层安全层 */
export type Security = 'none' | 'tls' | 'reality' | 'xtls';

/** 输入内容的格式判定 */
export type DetectedFormat =
  | 'share-link'            // 单条标准分享链接
  | 'share-link-batch'      // 多行分享链接 / 多节点批量
  | 'v2rayn-wrapper'        // v2rayn:// 及同类客户端包装格式
  | 'subscription-url'      // 纯订阅地址（需联网拉取，解析中心不自动请求）
  | 'subscription-content'  // 订阅返回体（Base64 批量 / Clash YAML / sing-box JSON）
  | 'clash-yaml'            // Clash / Mihomo YAML
  | 'sing-box-json'         // sing-box 配置
  | 'xray-json'             // Xray / V2Ray JSON
  | 'wireguard-conf'        // WireGuard .conf
  | 'qr-payload'            // 二维码解出的裸内容（走二次判定）
  | 'unknown';              // 明确不支持 / 无法识别

export type IssueCode =
  | 'MISSING_REQUIRED'      // 缺必填字段
  | 'UNKNOWN_FIELD'         // 有字段没被映射到统一模型（原始值已保留）
  | 'UNSUPPORTED_FIELD'     // 字段在当前内核无法表达
  | 'UNSUPPORTED_PROTOCOL'  // 协议不在支持列表
  | 'PARTIAL_COMPAT'        // 只能部分兼容 / 需额外处理
  | 'DEGRADED'              // 降级处理（如自动补默认值）
  | 'INVALID_VALUE'         // 字段值非法
  | 'PARSE_ERROR'           // 解析失败
  | 'KERNEL_LIMIT'          // 内核能力限制
  | 'DUPLICATE'             // 与已有节点重复
  | 'RENAMED'               // 重名节点写入配置时 tag 重命名（内核要求唯一）
  | 'SECURITY'              // 安全提示（含外链、未自动执行等）
  | 'ENHANCED';             // 自动增强配置（如按内核能力追加国内直连规则）

export interface ParseIssue {
  level: 'error' | 'warning' | 'info';
  code: IssueCode;
  /** 给用户看的中文说明，必须说清缺什么、为什么 */
  message: string;
  /** 涉及的字段名 */
  field?: string;
  /** 原始值，绝不丢 */
  value?: unknown;
  kernel?: KernelType;
  /** 对应第几行 / 第几个节点 */
  location?: string;
}

export interface TLSOptions {
  sni?: string;
  serverName?: string;
  alpn?: string[];
  fingerprint?: string;
  allowInsecure?: boolean;
  certificate?: string;
  /** TLS 之外未映射的字段 */
  [key: string]: unknown;
}

export interface RealityOptions {
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
  serverName?: string;
  fingerprint?: string;
  mldsa65Verify?: string;
  [key: string]: unknown;
}

/**
 * 统一节点。字段分三层：
 * - 结构化字段：客户端逻辑直接消费（server / port / protocol / transport ...）
 * - transportSettings / extras：所有没能结构化的原参数，完整保留
 * - raw：导入时的原始文本或原始对象序列化结果
 */
export interface UnifiedNode {
  id: string;
  name: string;
  protocol: Protocol;
  /** 协议别名，例如协议字段写作 ss / shadowsocks / hysteria2 时的原始写法 */
  protocolAlias?: string;
  server: string;
  port: number;

  // 凭据
  uuid?: string;
  password?: string;
  method?: string;
  alterId?: number;

  // 传输与安全
  transport: Transport;
  security: Security;
  tls?: TLSOptions;
  reality?: RealityOptions;
  /** XTLS Vision / xtls-rprx-vision 等流控 */
  flow?: string;
  /** WS path / host、gRPC serviceName、XHTTP mode、KCP header 等 */
  transportSettings: Record<string, unknown>;

  // 协议专属结构（WireGuard peers、SSR obfs、SSH host key 等）
  protocolSettings: Record<string, unknown>;

  /** 所有未被映射的原始字段：保证不静默丢失 */
  extras: Record<string, unknown>;

  /** 原始配置（完整保留，便于复核与重新解析） */
  raw: string;
  /** 解码后的明文配置（Base64 类分享链接 / 包装格式解包结果），便于逐字段复核 */
  rawDecoded?: string;
  rawFormat: DetectedFormat;
  /** 来源：paste / qr:camera / file:xxx.png / subscription:https://... */
  source: string;

  issues: ParseIssue[];
  /** true = 所有字段都已映射到结构化模型；false = extras 里有待确认字段 */
  lossless: boolean;

  /** 可承载该节点的内核（按推荐顺序），空数组 = 无内核可用 */
  kernels: KernelType[];
  kernel: KernelType | null;
  /** 内核无法完整表达时，这里说明会降级什么 */
  kernelReason?: string;

  /** 去重指纹 */
  fingerprint: string;
  addedAt: number;
}

/** 解析失败项：必须说明原因并保留原文，不允许"跳过不吭声" */
export interface RejectedItem {
  raw: string;
  reason: string;
  issues: ParseIssue[];
  location?: string;
}

export interface ImportStats {
  total: number;
  parsed: number;
  failed: number;
  duplicates: number;
  warnings: number;
  byProtocol: Record<string, number>;
  byFormat: Record<string, number>;
}

/**
 * 导入报告。预览用 —— 调用方必须让用户确认后才写入节点列表 / 启动内核。
 */
export interface ImportReport {
  ok: boolean;
  format: DetectedFormat;
  /** 格式判定的中文说明 */
  formatLabel: string;
  nodes: UnifiedNode[];
  rejected: RejectedItem[];
  duplicates: UnifiedNode[];
  issues: ParseIssue[];
  stats: ImportStats;
  /** 安全承诺：本报告只是预览，未做任何网络请求 / 内核启动 / 文件写入 */
  previewOnly: true;
  /** 若为订阅地址，需要调用方显式发起拉取 */
  requiresFetch?: { url: string; kind: 'subscription' | 'config-url' };
}

export interface ImportOptions {
  /** 来源标识，用于审计与 UI 展示 */
  source?: string;
  /** 已有节点指纹集合，用于去重 */
  existingFingerprints?: string[];
  /** 允许递归解包的最大层数（v2rayn:// 套娃 / Base64 嵌套） */
  maxDepth?: number;
  /** 是否跳过自动选核（单测或纯格式校验时可用） */
  skipKernel?: boolean;
  /** 内部递归深度，调用方不用传 */
  _depth?: number;
}

export const PROTOCOL_LABELS: Record<Protocol, string> = {
  vmess: 'VMess', vless: 'VLESS', trojan: 'Trojan',
  ss: 'Shadowsocks', ssr: 'ShadowsocksR',
  socks4: 'SOCKS4', socks5: 'SOCKS5', http: 'HTTP', https: 'HTTPS',
  hysteria: 'Hysteria', hysteria2: 'Hysteria2', tuic: 'TUIC',
  wireguard: 'WireGuard', anytls: 'AnyTLS', naive: 'NaiveProxy', ssh: 'SSH',
  unknown: '未知协议',
};
