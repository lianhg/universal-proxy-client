// 代理协议类型定义
export type ProxyProtocol =
  | 'vmess' | 'ss' | 'trojan' | 'vless'
  | 'hysteria2' | 'tuic' | 'socks5' | 'http'
  | 'hy2' // alias for hysteria2
  | 'clash-meta' // Mihomo/Clash config
  | 'sing-box'
  | 'xray';

export interface BaseProxy {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  addedAt: number;
  updatedAt?: number;
}

export interface ShadowsocksConfig extends BaseProxy {
  protocol: 'ss';
  server: string;      // host:port
  method: string;
  password: string;
  plugin?: string;
  pluginOpts?: string;
  comment?: string;
}

export interface VMessConfig extends BaseProxy {
  protocol: 'vmess';
  server: string;
  port: number;
  uuid: string;
  aid: number;        // alterId (legacy)
  net: string;        // tcp/kcp/quic/gRPC
  type: string;       // none/Random/protocol (obfuscation)
  tls: string;        // none/tls
  sni?: string;       // Server Name Indication
  alpn?: string[];    // http/1.1,h2
  host?: string;      // Host header
  path?: string;      // WS path / GRPC path
  fp?: string;        // fingerprint: chrome/firefox/safari/ios/none/custom
  pbk?: string;       // publicKey (Reality)
  sid?: string;       // shortId (Reality)
  spx?: string;       // SpiderX (Reality)
  flow?: string;      // xtls-rprx-vision etc
  security?: string;  // auto/aes-128-gcm/chacha20-poly1305/none
}

export interface TrojanConfig extends BaseProxy {
  protocol: 'trojan';
  server: string;
  port: number;
  password: string;
  net?: string;       // tcp/kcp/quic/gRPC
  type?: string;
  sni?: string;
  alpn?: string[];
  host?: string;
  path?: string;
  fp?: string;
  tls?: string;       // none/tls
}

export interface VLESSConfig extends BaseProxy {
  protocol: 'vless';
  server: string;
  port: number;
  uuid: string;
  net: string;        // tcp/kcp/quic/gRPC
  type: string;
  tls: string;        // none/tls/reality
  sni?: string;
  alpn?: string[];
  host?: string;
  path?: string;
  fp?: string;
  pbk?: string;
  sid?: string;
  spx?: string;
  flow?: string;
  security?: string;
}

export interface Hysteria2Config extends BaseProxy {
  protocol: 'hysteria2';
  server: string;
  port: number;
  auth: string;       // password/token
  sni?: string;
  alpn?: string[];
  insecure?: boolean; // skip cert verification
}

export interface TUICConfig extends BaseProxy {
  protocol: 'tuic';
  server: string;
  port: number;
  uuid: string;
  password?: string;
  sni?: string;
  alpn?: string[];
  congestion?: string; // cubic/new_reno/illinois
  zero_rtt?: boolean;
}

export interface SOCKS5Config extends BaseProxy {
  protocol: 'socks5';
  server: string;
  port: number;
  username?: string;
  password?: string;
}

export interface HTTPConfig extends BaseProxy {
  protocol: 'http';
  server: string;
  port: number;
  username?: string;
  password?: string;
  tls?: boolean;
  sni?: string;
}

export type ProxyItem =
  | ShadowsocksConfig
  | VMessConfig
  | TrojanConfig
  | VLESSConfig
  | Hysteria2Config
  | TUICConfig
  | SOCKS5Config
  | HTTPConfig;

// 共享链接原始文本
export interface ParsedLink {
  original: string;
  item: ProxyItem;
  protocol: ProxyProtocol;
}

// QR 识别结果
export interface QRResult {
  id: string;
  text: string;
  imageSource: 'camera' | 'file' | 'clipboard' | 'screen';
  parsed: ParsedLink | null;
  timestamp: number;
  thumbnail?: string; // base64 data URL
}

// 内核选择
export type KernelType = 'xray' | 'sing-box' | 'mihomo';

// 单个内核实例配置
export interface KernelInstance {
  id: string;
  name: string;
  type: KernelType;
  path: string;           // 可执行文件路径
  workingDir: string;     // 工作目录
  configPath: string;     // 配置文件路径
  listeningAddress: string;
  listeningPort: number;
  apiPort: number;
  running: boolean;
}

// 订阅源
export interface Subscription {
  id: string;
  name: string;
  url: string;
  updatedAt?: number;
  proxies: ProxyItem[];
  tags?: string[];
}

// 应用状态
export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  kernelAutoStart: boolean;
  systemProxyEnabled: boolean;
  tunMode: boolean;
  defaultKernel: KernelType;
  subscriptions: Subscription[];
  proxies: ProxyItem[];
  activeTag?: string;
}
