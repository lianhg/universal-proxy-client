# 万能代理客户端 (Universal Proxy Client)

一个面向 Windows 桌面的多内核代理配置管理工具。Electron + Vue 3 + TypeScript，分两层：**统一配置解析中心**（把各种来源、各种格式的配置转成统一节点模型）与 **内核运行层**（生成可运行配置、启停内核、可逆切换系统代理）。

> 合规提示：本项目只做配置解析与管理，实际使用需遵守所在地网络法规。

## 当前实现状态

### 已落地

| 模块 | 说明 |
|---|---|
| 统一配置解析中心 `src/core/hub/` | 格式自动判定 → 解析 → 字段映射 → 去重 → 自动选核 → 预览报告 |
| 全协议分享链接 | VMess / VLESS / Trojan / Shadowsocks / SSR / SOCKS4 / SOCKS5 / HTTP / HTTPS / Hysteria / Hysteria2 / TUIC / WireGuard / AnyTLS / NaiveProxy / SSH |
| 高级特性 | VLESS Reality、XTLS Vision、WebSocket、gRPC、TCP、HTTP/2、XHTTP、SplitHTTP、HTTPUpgrade、TLS、KCP、QUIC 及各传输层组合 |
| 配置格式 | Clash / Mihomo YAML、sing-box JSON、Xray / V2Ray JSON、WireGuard `.conf`、订阅 Base64 批量、SSD 订阅、多行分享链接 |
| 客户端包装格式 | `v2rayn://`、`sub://`、`clash://install-config`、`ssd://` 等，解包后按真实内容二次判定 |
| 二维码识别中心 | 摄像头实时、屏幕截图、屏幕框选、剪贴板（图片+文本）、PNG/JPG/JPEG/WebP/BMP/GIF、多图批量、一图多码 |
| 多内核能力矩阵 | 协议 × 三内核支持级别与最低版本要求、自动选核、三套 outbound 配置生成 |
| 订阅管理 | 手动拉取走「预览 → 确认」；定时自动更新（默认关闭，1/3/6/12/24 小时可配）；按指纹合并去重、更新记录；节点与订阅本地持久化 |
| **内核运行层** `src/core/runtime/` + `src/main/runtime/` | 完整运行配置生成、二进制探测、进程启停、健康检查、日志流、可逆系统代理、TUN 配置 |
| **内核一键下载** `downloads.ts` + `downloader.ts` | GitHub 官方 Release 直链（支持可选本机代理 CONNECT 隧道、断线自动重试）；Xray 走官方 .dgst SHA-256 校验，sing-box / Mihomo 如实标注「官方无校验文件」并展示本地哈希；.part 临时文件 + 原子安装；压缩包内文件名不符时报出实际清单 |
| **并行热切换（零断网）** | 节点页「⇄ 切换」/ 首页节点行「切换」：① 先用真实内核校验目标配置（Xray `-test -c` / sing-box `check -c` / Mihomo `-t -f`）；② **候选内核在另一组独立空闲端口上完整启动 + 健康检查，这期间旧内核与系统代理全程不动**；③ 验证通过才把系统代理改指向候选端口（此刻两个内核都可用）→ 扶正候选、端口落盘 → **最后才杀旧内核**。① / ② 任一步失败只清理候选，**当前连接、系统代理、运行设置全部原样保留，用户照常上网**；错误原因落盘 `%APPDATA%\universal-proxy-client\logs\runtime.log` 并弹「节点切换失败」toast。四个端口（含 Xray api-in 的 controllerPort）全部独立避让，杜绝端口漂移与残留进程占用；旧内核延迟到达的 exit 事件有 `this.proc !== child` 守卫，不会误判「内核意外退出」而回滚断网。目标节点不支持当前内核时自动换核、peers 按最终内核过滤；TUN 模式因虚拟网卡独占明确拒绝不停机切换。切换入口有**同步重入锁**（连点两次只会起一个候选，第二次直接回「正在切换中」），不会留下孤儿内核；扶正后旧内核登记为 `retiredProc`，断开 / 退出时补刀清理，绝不残留进程占端口 |
| **崩溃自动重启** | 意外退出按 1s/2s/4s 指数退避自动重启（默认开、上限 3 次可配），超限才回滚恢复系统代理 |
| **实时遥测** `telemetry.ts` | clash_api `/connections` 每秒采样 → 真实上下行速率、本次累计流量、活跃连接、规则命中、进程/域名/节点排行；Xray 走原生 gRPC `StatsService.QueryStats`（HTTP/2 + 最小 protobuf 编解码），剔除 api 入站轮询流量 |
| **规则管理 / DNS 分流** `rules.ts` | 11 类规则编辑、Clash 规则文本导入导出、三内核转换、能力矩阵、DNS 服务器下发；无法表达的规则明确阻断启动 |
| **真实 TCP 测速** | 节点页批量探测真实握手延迟（明确标注：连得通 ≠ 代理可用） |
| **网站代理检测 / 节点体检** | 点击后每个站点做「直连 HTTPS GET」+「经节点 CONNECT 隧道 + TLS + GET」两次真实请求；通/不通都写明原因与状态码，并给出「节点可用 / 节点不可用 / 出不了海 / 内核没起」的综合诊断与建议。未检测前显示 `—`，不预填毫秒数 |
| **网络连接监控状态** `describeMonitorStatus()` | 首页卡片固定显示四组状态徽章：**连接 / 采样 / 数据源 / 节点体检**（绿 / 黄 / 红 / 灰，悬停看完整原因）+ 七格状态条（内核、节点、端口、实时速率、累计流量、活跃连接、最近采样）；空表改为结构化原因、建议与操作按钮，不再只丢一句长文案。全部由纯函数归一化，没数据就写「未采样 / 未检测」，不编造 |
| 界面 | 11 个功能项全部有真实内容；首页随机演示数据已全部移除，未连接时显示 0 与具体原因 |
| **窗口拖动** | `frame:false` 无边框窗口：顶部栏空白处、左上角 logo 区、底部状态栏声明 `-webkit-app-region: drag`，按住左键即可拖动；所有按钮 / 菜单 / 输入 / 表格显式 `no-drag`，避免点击被系统当成拖动吞掉；双击顶栏空白处最大化 / 还原。由 `tests/window-drag.test.mjs` 守住，改样式删掉声明会直接测试失败 |
| **仪表盘首页** `DashboardHero.vue` | 按参考图 1:1 复刻：① 顶部一条横带三格「连接状态 / 下载 / 上传」（1.6fr : 1fr : 1fr）· ② 中部三列「200px 大圆连接按钮（火箭 + 运行时长）/ 节点信息四行 / 快捷操作 100px 四宫格」· ③ 节点列表卡「左侧 170px 地区分组栏 + 右侧搜索 / 测速排序 / 刷新 + 52px 节点行」。图标全部为内联线性 SVG，**尺寸按参考图锁死**：状态勾 40、火箭 48、快捷操作 30、信息行 16、分组栏 16、搜索 16、刷新 20、地区标 20、信号柱 18、更多 16、上下行箭头 18（px）；由 `tests/dashboard-layout.test.mjs` 逐项断言，改动任一数值即测试失败。窄屏断点下移到 1000px，避免 1100px 窗口被误判拆行。数据仍全部真实：地区分组按节点名里真实关键词归类、自动选择按真实测速延迟挑最快节点、添加分组为可持久化的关键词分组、信号柱按真实延迟分级；没数据写「— / 未测速 / 等待真实采样」。侧边栏 11 项一次全部可见；顶部主题 / 设置 / 帮助 / 测速入口与真实事件 toast 保留 |

### 明确未实现（不会伪装成可用）

- **Xray 按连接列出 / 单条关闭**：Xray 的 StatsService 只有累计计数器，没有连接列表接口，因此用 Xray 时「网络连接监控」的连接表为空且不能逐条关闭连接；需要该能力请改用 sing-box / Mihomo。但**实时上下行速率、累计流量三大内核都已支持**，且卡片会明确显示「采样正常 · Xray 不提供逐条连接列表」，不会误写成节点故障。
- **macOS / Linux 系统代理**：仅 Windows 实现；其他平台明确提示手动配置，不假装成功。
- **非 zip 压缩包的自动解压**：Linux / macOS 的 `.tar.gz` / `.gz` 内核包只下载并校验，解压需手动完成（Windows 用的 zip 全自动）。

## 实时遥测与规则下发

**遥测链路**：内核启动后，`TelemetryCollector` 每秒请求 `127.0.0.1:21811/connections`（sing-box / Mihomo），Xray 则对同一控制端口发 gRPC `StatsService.QueryStats`；再从响应的 `downloadTotal` / `uploadTotal` 累计字节做时间差分算速率（不依赖 WebSocket，也不需要第三方库）。连接列表、进程名、目标域名、出口链路、命中规则全部来自内核返回值。累计量回退（内核重启）会清空历史并把速率归零，绝不输出负数或尖峰；采样失败时速率归零并显示具体错误，不沿用上一帧。`clash_api` 不返回进程 PID，界面因此显示 `—` 而不是编造数字。

**规则下发**：规则按顺序匹配。11 类规则中，Xray 不支持进程名/路径、GEOSITE/GEOIP、SRC-PORT；sing-box 不支持 GEOSITE/GEOIP、SRC-PORT；Mihomo 全部支持。任何一条启用规则无法被当前内核表达，都会列入 `skipped` + `KERNEL_LIMIT` issue 并**阻断启动**——不会出现「悄悄少几条规则还照常连接」。`PROXY` 动作指向选中节点的真实 outbound tag，`REJECT` 指向已有的 `block` 出站，避免生成内核不认的配置。规则修改需断开重连才会生效。

**订阅自动更新**：默认关闭。开启后每分钟检查一次到期订阅，串行执行「拉取 → 解析 → 按指纹去重合并」，每次结果写入更新记录与运行日志；浏览器预览模式（无主进程）会明确拒绝开启。手动「更新」按钮仍保留「预览 → 用户确认」链路。

## 内核运行层设计

启动链路（每一步失败都会回滚，绝不留下被改写的系统设置）：

```
用户点「开始连接」
  → 校验节点必填字段 / 内核兼容性 / TUN 权限
  → 端口自动避让：设定端口被占（v2rayN / Clash 等）就换到冷门空闲端口，并同步给系统代理
  → 探测内核二进制（用户指定 > 应用数据 > 项目 bin > 环境变量 > PATH）
  → 生成完整运行配置（inbounds / dns / routing / log / tun / outbound）
  → 写入 userData/runtime/runtime-{xray|sing-box|mihomo}.{json|yaml}
  → spawn 内核进程，stdout/stderr 实时推到界面日志
  → 健康检查：最多 8 秒等待本地端口监听
  → 读取系统代理原始快照 → 写入新代理 → 刷新 WinINET
  → state=running
```

断开 / 启动失败 / 内核意外退出 / 程序退出：**按快照精确恢复** `ProxyEnable` / `ProxyServer` / `ProxyOverride` / `AutoConfigURL`，再结束进程。快照里原本不存在的键会被删除，而不是写成空值。

系统代理脚本用明文 `.ps1` + `powershell -File` 执行（留在 `userData/runtime/_ps_*.ps1`，可随时审计），不用 base64 `-EncodedCommand`。若你机器上本来就有其他代理客户端在占用系统代理，本程序断开后会还原到它原来的地址与 bypass 列表。

TUN 模式：sing-box / Mihomo 会生成 tun 入站；Xray 无 TUN 能力，请求会被明确阻断。创建虚拟网卡需要管理员权限，权限不足会直接拒绝启动并说明原因。

### 本地端口策略（2026-11-11）

默认端口是 **21808（SOCKS）/ 21809（HTTP）/ 21810（Mixed）/ 21811（控制）**。老版本默认的 7890、10808、10809、9090 分别被 Clash、v2rayN、Clash API 长期占用，默认撞上就会「内核启动后端口未监听」——实测就是 v2rayN 的 xray.exe 占着 10808 导致新内核绑定失败退出。

启动前会逐个探测内核真正要 bind 的端口（Xray 只绑 SOCKS/HTTP；sing-box、Mihomo 还绑 Mixed 与控制端口，见 `boundPortsOf()`）：

- 设定端口空闲 → 原样使用；
- 被占用 → 依次扫 21808~22007，再兜底 30000~39999，取第一个空闲端口；
- 换过的端口会写回设置文件，日志里明确写出「HTTP 端口 10809 已被 v2rayN.exe（PID xxx）占用，已自动改用 21809」；
- 运行中热切换节点时，旧内核正占着的端口视为可用（本来就要复用）；换内核导致代理端口变化（Xray 用 HTTP 端口、其他内核用 Mixed 端口）时，会同步改写系统代理指向。

仍存在的竞态：探测端口到真正 spawn 之间有几百毫秒窗口，若恰好被别人抢走，`spawnKernel` 的兜底预检会明确报「已被其他程序占用」而不是误报「配置被拒绝」。

### 节点真连测速（2026-11-11）

节点管理页原本的「TCP 握手测速」只测到服务器端口的 TCP 往返，**握手通 ≠ 代理可用**：加密协商、传输层、出站权限任何一环坏了，握手照样成功。所以新增独立的「节点测速」页，做的是**真连下载**：

1. 对每个节点先做最多 3 次 TCP 握手（第一次就通即停），不通直接判「不可用」，不起内核；
2. 起一个**临时内核实例**：独立随机端口（23000~24999）、`mode = 'none'`、DNS 关闭、单节点配置，绝不碰系统代理与路由；
3. 等临时内核监听本地端口后，经它的 HTTP 入站做 `CONNECT` 隧道 → TLS → 原始 HTTP 请求，真实下载；
4. 量三件事：握手延迟、首字节时间（含加密转发链路）、带宽（响应体字节 ÷ 下载耗时，响应头不计入）；
5. 结束无论成功失败都杀进程、删临时配置；用户取消 / 程序退出同样清理。

判定（`gradeSpeed()`）：**≥8 Mbps 优秀 / ≥2 Mbps 可用 / ≥0.5 Mbps 偏慢 / 其余不可用**。目标是 204 或下载不足 20KB 时只给「连通」结论，不给带宽数字——没有实测字节就不编速度。

安全约束：测速目标必须在 `SPEEDTEST_TARGETS` 白名单内（Cloudflare 10MB / CacheFly 5MB / gstatic 204），主进程拒绝任意 URL，preload 也不暴露 fs / 任意进程执行能力。测速会真实消耗流量（默认约 10MB × 节点数），并发默认 3，界面上有提示。

### 网站代理检测 = 节点体检（2026-11-11）

首页这张卡片原先是「直连 / 本地代理各发一次 **HTTP 80 明文 HEAD**」。问题是：现在几乎所有站点都强制 HTTPS，HEAD 还常被 403/405 拒绝，**明明链路通了却显示「不通」**；反过来拿到 301 也算通。四个格子全是「不通 / 1301 ms」，用户根本看不出节点到底行不行。现在改成真刀真枪的**可达性 + 节点体检**：

1. **每个站点两条真实请求**：直连 `https://host:443/` 的 GET；经本地 HTTP 入站 `CONNECT host:443` → TLS → GET。只读响应头，不下载正文、不上传任何用户数据；
2. **通 / 不通怎么判**：拿到任意 HTTP 响应头即算「链路通」（200/301/403/404 都算，但**记下状态码**，403 会标黄并写明「链路已通，目标拒绝」）；只有网络层失败、超时、代理明确拒绝才算不通；
3. **不通要说人话**：`timeout` / `refused` / `dns` / `tls` / `proxy-reject` / `empty-reply` / `not-running` 七类，逐行 hover 能看到具体报错（如 `内核拒绝建立 CONNECT 隧道：HTTP 502`）；
4. **综合诊断**（`core/runtime/telemetry.ts` 的 `diagnoseProbe()` 纯函数）：
   - 境外站经节点可达 → **节点可用**；此时境内站「代 不通」会明确解释成分流规则走直连，**不是节点故障**（这正是亮哥截图里那组数据的结论）；
   - 所有站点经节点都不通但直连正常 → **节点不可用**，按主导失败原因给「换节点 / 重新生成配置 / 查 DNS / 看内核日志」；
   - 境外全不通、境内经节点通 → **节点出不了海**（出口被封 / 订阅过期 / 规则误判直连）；
   - 两条路全不通 → **先查本机网络**，`nodeOk = null`，不把锅甩给节点；
   - 内核没运行 / 内核在跑但 HTTP 入站端口没监听 → 分别给不同提示，**绝不下节点结论**；
5. **没连接也能点**：按钮不再被 `proxyOn` 禁用，未连接时仍测直连（可判断本机是否断网），并明确写「内核未运行，暂时判断不了节点好坏」；「更多 >」直达节点测速页逐个检验节点；
6. 触发前先 `tcpProbe()` 确认本地 HTTP 入站真的在监听；端口取 `settings.httpPort`（三个内核都生成了 HTTP 入站）。四个站点并发，最坏约 5.5 秒。

数据不足时宁可写「判断不了」，也不猜一个结论；诊断结果同时写进运行日志，界面显示检测时刻与「代理可达 x/4 · 直连可达 y/4」。

### Xray 实时网速（2026-11-11）

之前 Xray 内核连上后首页网速恒为 0 B/s——遥测只接了 sing-box / Mihomo 的 clash_api。现在给 Xray 接上它自己的 **gRPC StatsService**，三类内核都能显示真实速率：

- 配置生成时为 Xray 追加：`stats` + `policy.system` 四个开关 + `dokodemo-door` 统计入站（tag `api-in`，占用控制端口 21811）+ `api` 服务（StatsService），api 路由规则**固定排第一**（不被兜底规则抢先）；
- 采样走 Node 原生 `http2` 直调 `xray.app.stats.command.StatsService/QueryStats`（零第三方依赖，手工实现最小 protobuf 编解码，见 `core/runtime/xray-stats.ts`）；
- 用户视角上下行 = 各入站 `uplink/downlink` 之和，**api-in 的轮询流量被剔除**，否则每秒几百字节的采样流量会污染速率；
- Xray 拿不到连接列表，所以连接监控页对 Xray 显示为空、按连接关闭不可用（明确报错），这两项仍需 sing-box / Mihomo；
- 验收：真 Xray + 本地 2MB 真实下载，gRPC 采样到的 `downlink` 与实际字节数一致；速度卡下方新增错误/原因提示行，不再出现"0 B/s 却不知道为什么"。

### 版本信息（2026-11-11）

版本号**只有一处真源**：`package.json` 的 `version`。打包后 `app.getVersion()` 从 asar 内的 package.json 读取，界面只做展示，不写死任何版本字符串。

- 主进程新增 `app-info` IPC，一次返回：程序版本、Electron / Chromium / Node / V8 版本、平台与架构、系统内核版本、是否已打包、构建时间（取 `app.getAppPath()` 的 mtime）、`userData` 与 exe 路径；
- 渲染层 `api.appInfo()` 做兜底（浏览器预览返回 `—` 占位，不显示假版本），store 里统一 `appInfo / appVersion / loadAppInfo`，侧边栏 logo、底栏、设置页共用同一份；
- 设置中心新增「关于 / 版本信息」卡片：版本号、构建时间、运行环境、系统、三个内核二进制版本、数据目录，带「复制诊断信息」（只含版本与环境，**不含节点、密码、订阅地址**）；
- 安装器脚本由 `build/make_installer.py` 生成时从 package.json 注入版本，写入卸载注册项的 `DisplayVersion`，不再硬编码 1.0.0；
- 发版流程：改 `package.json` 的 `version` → `npm run electron:pack`，产物名（`UniversalProxyClient-<版本>-portable.exe`）由 electron-builder 的 `${version}` 自动带出。**文件名刻意用纯 ASCII**：NSIS stub 处理中文路径时编码会损坏（见下方「NSIS Error」）。

### 界面主题（2026-11-11）

侧边栏左下角的按钮和「设置中心 → 外观 / 主题」卡片共用同一份状态，提供三个选项：**黑夜模式 / 白天模式 / 跟随系统**。选择即时生效、写入 `localStorage`（`upc.theme.v1`），下次启动自动应用；跟随系统模式监听 `prefers-color-scheme` 变化，Windows 切换深浅色时界面自动跟着变。

- 唯一真源是 `src/renderer/theme.ts`：模式解析（`normalizeThemeMode` / `resolveTheme`）、持久化、DOM 应用（`data-theme` + `color-scheme`）、系统监听都在这里；`index.html` 内联一段与 `THEME_BOOTSTRAP_SCRIPT` 逐字一致的首屏脚本，Vue 挂载前就定好主题，**不会闪一下深色**。
- 配色全部走 `style.css` 的 CSS 变量：`:root[data-theme="light"]` 覆盖一整套浅色色板，组件与 `App.vue` 只允许引用语义变量（`--code-bg`、`--speed-down`、`--error-text`、`--nav-active-text` …），不允许硬编码深色值。
- `set-theme-source` IPC 把选择同步给 Electron 原生层（`nativeTheme.themeSource`），右键菜单、系统对话框与浏览器 `prefers-color-scheme` 一起对齐；窗口首帧底色也按 `shouldUseDarkColors` 取色。
- 回归：`tests/theme.test.mjs`（23 条）覆盖模式解析、持久化、DOM 应用、两套变量键不缺项、内联脚本一致性、界面交互与 IPC 链路。

> 渲染层红线（13:01 黑屏事故）：`src/core/**` 会被渲染层通过浏览器预览路径间接打包，**禁止出现任何裸 `Buffer.alloc/from/concat` 或 Node 专有全局**。当时 `xray-stats.ts` 的 `grpcFrame()` 用了 `Buffer.alloc`，模块一加载就抛 `ReferenceError: Buffer is not defined`，整个界面黑屏。现已改为纯 `Uint8Array / DataView / TextDecoder`，`core/hub/util.ts` 的 Base64 也改为经 `globalThis` 可选取 Buffer，并有测试逐文件扫描源码与 `dist/assets/*.js` 防再退化。

## 核心设计原则

1. **任何导入的配置都不能静默丢失参数**。未识别字段进入 `extras`、原始配置完整保留在 `raw`（Base64 类另有 `rawDecoded` 明文），并生成 `UNKNOWN_FIELD` 提示与 `lossless: false`；生成内核配置时无法表达的字段会单独列出。
2. **缺字段明确报错**。必填字段（uuid / password / publicKey / privateKey / server 等）缺失时列出字段名与原因，不返回空串蒙混过关。
3. **未知格式不误报成功**。普通网页 URL 不会被当成 HTTP 代理节点；订阅地址只登记 `requiresFetch`；无法识别的 Base64 / 二维码内容明确拒绝。
4. **先预览、后执行**。所有导入结果 `previewOnly: true`：不联网、不写节点、不启动内核、不改系统代理。用户点「确认导入」才写入；点「开始连接」才启动内核。
5. **二维码只是数据载体**。解出文本后按内容判定是分享链接 / 订阅地址 / 完整配置，再做二次解析。
6. **系统改动必须可逆**。快照 → 改动 → 恢复，任何异常路径都走同一套回滚。

## 快速开始

```bash
pnpm install
pnpm dev                 # 浏览器 http://localhost:5173（运行层明确提示不可用）
pnpm electron:dev        # 桌面端
pnpm build               # 类型检查 + 生产构建
pnpm typecheck           # 仅类型检查
pnpm test                # 全套回归（18 个测试文件，当前 327 项全绿：解析 / 运行配置 / 遥测 / 诊断 / 监控状态 / 主进程 / 并行热切换 / BUG 回归 / 下载器 / 版本 / 主题 / 窗口拖动 / 仪表盘布局与图标尺寸）
node tests/_switch_e2e.mjs  # 可选真机验收：真实 xray.exe + 独立端口 238xx，启动 → 切换 → 拒绝切换不断线（不碰用户连接）
pnpm test:ui             # 10 个界面的浏览器渲染冒烟测试（需 Chrome）
```

构建产物：`dist/index.html`、`dist/electron-main/main.js`、`dist/electron-preload/index.js`。

## 版本号与发布流程

版本号只有一个真源：`package.json` 的 `version`。界面、窗口标题、安装器 `DisplayVersion`、打包产物名全部从它派生，任何地方都不允许再手写版本号。

**规矩：每次改动都要升版本号，升完立刻在 `CHANGELOG.md` 记一条。** 不允许「改了但版本号没动」。

| 改动类型 | 升哪一位 | 命令示例 |
| --- | --- | --- |
| 修复、文案、样式微调 | patch | `npm run bump -- patch "修复二维码订阅按钮点不动"` |
| 新功能、新页面、新模块 | minor | `npm run bump -- minor "新增规则分流编辑器"` |
| 不兼容调整（数据结构、配置格式） | major | `npm run bump -- major "重写配置文件格式"` |

`npm run bump` 一次做完三件事：改写 `package.json`、用 `build/make_installer.py` 重新生成 `install.ps1`（安装器显示版本跟着走）、在 `CHANGELOG.md` 顶部插入条目。脚本会先校验再落盘，中途失败不会留下「版本号改了但日志没写」的半成品。

发布顺序：`npm run bump -- patch "说明"` → `npm test` → `npm run electron:pack` → 覆盖安装目录的 `app.asar` → 重新打绿色版 zip（文件名带版本号）。`tests/version.test.mjs` 会检查「`CHANGELOG.md` 顶部版本 == `package.json` 版本」「`install.ps1` 与包版本一致」，忘记升版或忘记记账都会直接测试失败。

## 打包 EXE 与安装

**最简单：双击 `打包.bat`**，菜单里选一项即可（自动 `vite build`，用项目内的 electron-builder 25.1.8，不走 npx 以免拉成别的版本）。

```
[1] Install    安装到本机（推荐）—— 桌面 + 开始菜单 + 卸载项
[2] Green zip  绿色版目录 + 绿色版 zip（推荐分发）
[3] Green dir  仅绿色版目录
[4] NSIS       NSIS 安装包
[5] Portable   便携版单文件（不推荐，见下方 NSIS Error 说明）
[6] All safe   安装到本机 + 绿色版 zip
```

命令行等价写法：

```bash
npx vite build
./node_modules/.bin/electron-builder --win dir portable   # 绿色版 + 单文件便携版
./node_modules/.bin/electron-builder --win nsis           # NSIS 安装包
powershell -ExecutionPolicy Bypass -File install.ps1       # 本地安装器
```

| 产物 / 方式 | 路径 | 说明 |
| --- | --- | --- |
| **本地安装（推荐）** | `安装.bat` / `install.ps1` | 复制到 `%LOCALAPPDATA%\Programs\万能代理客户端`，建桌面 + 开始菜单快捷方式，写 HKCU 卸载项，出现在"设置 → 应用"里。**不需要 NSIS、不需要管理员、不碰 TEMP**，杀软几乎不拦 |
| 卸载 | `卸载.bat` / 设置里的卸载项 | 停进程 → 删快捷方式 → 删注册项 → 删程序目录（`%APPDATA%` 下的配置和日志保留） |
| **免 NSIS 绿色 zip（推荐分发）** | `release\UPC-green-<版本>.zip`（打包.bat 菜单 [2]，版本号自动取 `package.json`）/ 手工产物 `万能代理客户端-<版本>-绿色版.zip` | 由 `win-unpacked` 直接 `7z a -tzip` 打成，110MB 左右，解压后双击根目录的 `万能代理客户端.exe` 即可，**完全不经过 NSIS / 不写 TEMP**。文件名始终带版本号，旧包在打包时自动清掉，不会混着发出去 |
| 便携版（**不推荐**，11-16 起菜单降为 [5]） | `release\UniversalProxyClient-<版本>-portable.exe` | 单文件 72MB，本质是 NSIS 自解压，运行时展开到 `%TEMP%\UniversalProxyClient`——**国产杀软/Defender 常拦这个行为，报 `NSIS Error` 就是它**；文件名已改纯 ASCII 规避中文路径乱码 |
| 绿色版 | `release\win-unpacked\万能代理客户端.exe` | 284MB 目录，拷走必须带整个 `win-unpacked`，单个 exe 拷出去跑不起来 |
| NSIS 安装包 | `release\UniversalProxyClient-setup-<版本>.exe`（已停用） | 两遍编译，第二遍要运行 setup exe 回写卸载器；被打断会留下 **250KB 左右的空壳 exe，双击没任何反应** |

**为什么用本地安装器而不是 NSIS**：NSIS 在这台机器上第二遍编译不稳定，中断时只留下 253KB 的空壳 setup（没有 7z 载荷），双击自然无反应。`install.ps1` 是纯文件安装，逻辑全部可读可查，失败时有明确中文报错，且卸载走 Windows 标准入口。

### 切换节点失败导致断网（2026-11-12 10:21 真实事故 → 并行切换）

`logs/runtime.log` 记下的完整链条：

```
切换失败 SS-09 → US VLESS-12 / xray：内核启动后 21813 端口未监听（8 秒内）
切换失败且原节点恢复失败：本地端口 21812、21813 已被 xray.exe（PID 31012）占用
```

旧链路「先杀旧 → 起新 → 失败 rollback」有三个致命点：① 切换时 `resolveFreePorts` 拿 `runtime-settings.json` 里的端口去复用，而该设置会与实际运行配置脱节，端口漂到 21812/21813；② 新内核起不来后残留进程仍占端口，回退也失败；③ 回退失败就 `rollback()` 直接恢复系统代理 → 用户断网。Xray 的 `controllerPort`（api-in）还不参与避让，同一端口被两个内核争用。

**现在**：候选内核先在四个独立空闲端口上完整启动并健康检查，旧内核与系统代理全程不动；验证通过才改系统代理指向、扶正候选、最后杀旧内核。任何前置失败只清理候选，`runtime.log` 与界面 toast 给出确切原因。另修了 `spawnKernel` 的 exit 监听：旧内核延迟退出时若 `this.proc !== child` 就只记日志，不再误触发「内核意外退出」回滚。真机验收见 `tests/_switch_e2e.mjs`（第 ④ 步专门验证「候选失败后端口仍监听、PID 未变」）。

### 双击便携版报 `NSIS Error: Error writing temporary file`（2026-11-12）

排查结论：**TEMP 本身没问题**（`%LOCALAPPDATA%\Temp` 存在、可写、C 盘剩余 58GB），是 NSIS stub 的问题：

- `%TEMP%\nsis2.log` 里 makensis 的 `Output:` 路径，中文文件名已经变成乱码问号 —— NSIS 处理中文 `$EXEPATH` 时编码损坏，自解压阶段写临时文件失败，弹窗就报「temp folder is invalid」，属于**误导性报错**。
- 同目录十几个 `ns*.tmp` 是 11-11 打包失败留下的残留，不是原因，可留可删。
- 处理顺序：① **直接双击桌面「万能代理客户端」快捷方式**（已安装版，不走 NSIS）；② 要用便携分发就解压 `万能代理客户端-<版本>-绿色版.zip`；③ 别再双击 `release` 里那几个中文名旧 exe。
- 根治：`electron-builder.yml` 里 portable / nsis 的 `artifactName` 全部改成纯 ASCII，打包时不再生成中文名 NSIS 产物。

### 11-16 复现与最终结论：编码不是主因，杀软拦「未签名新文件写 %TEMP% 再执行」才是

纯 ASCII 文件名的 `UniversalProxyClient-1.1.0-portable.exe` 仍然复现同一个弹窗。完整取证：

- 便携包载荷与 `win-unpacked` **逐字节一致**（7za 解包 + SHA-256 比对通过）→ 不是打包损坏；
- `%TEMP%` 存在、可写、45GB 空闲、609 个文件（远低于 GetTempFileName 的 65535 上限）→ 不是 TEMP 目录问题；
- Smart App Control=关、无 ASR 规则、无 AppLocker/WDAC 策略、Defender 近 7 天对新包**零检出记录** → 不是病毒库命中；
- 手动把 188MB 的 `万能代理客户端.exe` 拷进 `%TEMP%` 瞬间完成，但 NSIS stub 自己写临时文件立即失败（换 `TEMP=E:\tmp` 也一样，退出码 2）→ 拦截发生在 **NSIS 进程的行为层**（Defender 实时保护对「未签名 + 无云端信誉 + 自解压到临时目录再执行」这一模式的启发式阻断，弹窗文案是 stub 对写失败的二转描述，具有误导性）；
- 本机已安装版（`%LOCALAPPDATA%\Programs\万能代理客户端`）启动日志正常，`win-unpacked` 直接双击也正常 → **只有 portable 这一条路被堵**。

**决定**：`打包.bat` 菜单重排——[1] 安装到本机、[2] 绿色版 zip（推荐分发）、[5] Portable 降为「不推荐」并写明症状与替代；README 与菜单一致。根治只能二选一：① 买代码签名证书（EV 即时信誉，SmartScreen/杀软从此不拦）；② 向 https://www.microsoft.com/wdsi/filesubmission 提交便携 exe 报误报（只解云端，不保证所有杀软）。自用机可在管理员 PowerShell 加 `Add-MpPreference -ExclusionPath <release 目录>` 放行。

- 应用图标：`build/icon.ico`（深蓝底 + 蓝青渐变闪电，`build/make_icon.py` 生成，改配色后重跑即可）；安装器脚本由 `build/make_installer.py` 生成。
- **bat 里不要写中文**：cmd 按 ANSI(936) 解析批处理，GBK 中文的尾字节可能落在 `\` `|` `&` 上导致行被截断（表现为 `'exe' 不是内部或外部命令`）。中文提示统一放在 `.ps1`（UTF-8 with BOM）里。
- **主进程/preload 必须打成 CommonJS**：`vite-plugin-electron` 按 `package.json` 的 `"type"` 决定输出格式，`type: "module"` 会产出 ESM —— Electron 从 `app.asar` 加载 ESM 主入口不稳定，且 sandbox 下 preload 必须 CJS（否则 preload 加载失败、`window.api` 全空、界面白屏）。所以 package.json **刻意不写 `"type": "module"`**，测试用的 `tsconfig.*.build.json` 也统一 `module: CommonJS`。
- 启动日志：`%APPDATA%\万能代理客户端\logs\startup.log`，记录启动阶段、`did-fail-load`、渲染进程崩溃与未捕获异常——双击闪退时先看它。
- **跨 IPC 传参必须脱壳**：Pinia 的 state / computed 取出来的都是 Proxy，而 Electron 的 `contextBridge` 与 `structuredClone` 都不接受 Proxy，直接 `ipcRenderer.invoke(ch, store.nodes)` 会抛 `An object could not be cloned.`（Vue 错误参考 runtime-5）。所有跨进程参数在 `src/renderer/api.ts` 里统一过 `toPlain()`（`src/core/hub/util.ts`，全深度递归，只脱普通对象、保留 Date/Map/Set 原型）。新增 IPC 调用时别忘了套。测试见 `tests/plain.test.mjs`。
- **WireGuard 节点只能由 sing-box / Mihomo 承载**：Xray 虽有 wireguard 出站，但需要本机私钥等完整接口参数，按 TCP 代理通用 schema 生成会被内核整体拒绝（`[Warning] common/errors`，所有端口不监听）。`config-builder` 用 `kernelSupports()` 按**当前**能力矩阵重新判定每个节点（不信任 localStorage 里的 kernels 快照），不支持的备选节点排除并留痕，选中的不支持则硬阻断。测试见 `tests/wireguard.test.mjs`。
- **不要在项目根目录用 `asar extract-file` 提取 `package.json`**：它会释放到当前目录并覆盖项目同名文件（曾因此误删，靠 `/tmp/pkg_backup*.json` 备份恢复）。要查包内元数据请 `cd` 到临时目录再提取。
- 注意：WorkBuddy / IDE 沙箱里跑 `--win nsis` 会在第二遍（运行 setup exe 回写卸载器）退出码 2，因为沙箱禁止启动 GUI 程序；沙箱里连官方最小 Electron 应用都是 rc=3 无法初始化，属于环境限制。请在**普通 PowerShell** 里执行。
- 已知缓存坑：Windows 无符号链接权限时 electron-builder 解压 `winCodeSign` 会无限重试。解法：用 `7za x winCodeSign-2.6.0.7z -snl-` 手动解压到 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0\`（`-snl-` 把符号链接落成普通文件副本），app-builder 检测到目录存在即跳过下载。

桌面端首次启动前，把 `xray.exe` / `sing-box.exe` / `mihomo.exe` 放到设置中心显示的 bin 目录（或指定完整路径）。在「设置中心 → 内核运行层」可以看到三个内核的探测结果、运行状态、配置预览和实时内核日志。

> 环境提示：在 WorkBuddy / 某些 IDE 的集成终端里直接启动 Electron 可能报 `node-language-shim.cjs` 找不到，那是终端注入的 `NODE_OPTIONS` 与 `ELECTRON_RUN_AS_NODE=1` 导致的，与项目代码无关。请在普通 PowerShell / CMD 终端里运行 `pnpm electron:dev`。当前 Agent 沙箱没有交互式桌面会话，无法在此实测 GUI 窗口（Chromium 报 `crashpad not connected`），但主进程运行层已在 Node 侧完整回归验证。

## 目录结构

```
src/
├── main.ts                     # Electron 主进程（解析 / 订阅 / 配置生成 / 运行层 IPC）
├── preload/index.ts            # contextBridge 最小 API 面 + 运行事件订阅
├── core/hub/                   # 统一配置解析中心（纯 TS，零重依赖，可独立测试）
│   ├── model.ts                # 统一节点模型 / 报告 / issue
│   ├── util.ts                 # Base64 / URL / 字段映射（不丢字段的关键）
│   ├── share-links.ts          # 16 类协议分享链接解析
│   ├── yaml.ts                 # 轻量 YAML 子集解析（Clash 配置）
│   ├── formats.ts              # 配置格式解析 + 自动判定
│   ├── kernel.ts               # 内核能力矩阵 / 选核 / outbound 生成
│   ├── qr.ts                   # 多来源二维码识别中心
│   └── index.ts                # 统一入口 importText / importQrPayload / importConfigFile
├── core/runtime/               # 运行层纯逻辑（可独立测试，不 import electron）
│   ├── types.ts                # 状态 / 设置 / 二进制 / 快照 模型
│   ├── config-builder.ts       # 三内核完整运行配置 + 自定义规则接线 + YAML 序列化
│   ├── telemetry.ts            # 遥测模型 / Clash API 归一化 / 速率差分 / 排行
│   ├── rules.ts                # 规则模型 / 文本解析 / 三内核转换 / 能力矩阵
│   └── system-proxy.ts         # 系统代理读 / 写 / 恢复脚本与快照解析
├── main/runtime/               # 运行层主进程侧（有 IO）
│   ├── binaries.ts             # 二进制发现与版本探测
│   ├── telemetry.ts            # clash_api 每秒采样、Xray gRPC 统计、站点 HTTPS 可达性探测
│   └── manager.ts              # 进程管理、健康检查、可逆系统代理、日志流、TCP 测速
├── renderer/
│   ├── App.vue                 # 10 个 tab 的外壳 + 首页真实连接
│   ├── api.ts                  # Electron IPC / 浏览器本地逻辑适配
│   ├── store.ts                # Pinia：节点 / 订阅 / 报告 / 遥测 / 规则 / 自动更新 / 日志
│   └── components/             # RuntimePanel、RulesPanel、MonitorPanel、StatsPanel 等
├── types.ts                    # 旧版类型（兼容保留）
tests/
├── hub.test.mjs                # 全协议 / 全格式 / 无损字段 / 选核 / 二维码（55）
├── runtime.test.mjs            # 运行配置生成 / YAML / 系统代理可逆（27）
├── telemetry.test.mjs          # 遥测归一化 / 速率差分 / 排行（16）
├── rules.test.mjs              # 规则解析 / 三内核下发 / 阻断路径（20）
├── manager.test.mjs            # 主进程拒绝路径 / 设置持久化 / TCP 测速（12）
├── telemetry-collector.test.mjs # 本地假 clash_api 端到端：采样 / 速率 / 降级 / Xray 不轮询（10）
├── window-drag.test.mjs        # 无边框窗口拖拽区 / 按钮 no-drag / 双击最大化 / 构建产物 CSS 保留（8）
├── dashboard-layout.test.mjs   # 参考图 11 个图标尺寸 / 三格比例 / 三列布局 / 控件尺寸 / 断点 / 不编造数据（10）
├── switch-node.test.mjs        # 并行热切换零断网：候选失败 / 代理改指失败 / 旧内核最后杀 / 独立端口 / TUN 拒绝 / 并发重入锁 / 孤儿内核回收 / 旧链路移除红线 / 真实 Xray -test（16）
├── bug-regressions.test.mjs    # 本轮 BUG 回归：端口清洗 / 遥测空 ctx / 日志轮转 / 订阅锁 / 错误提示链路（10）
├── _switch_e2e.mjs             # 可选真机验收：真实内核跑完整切换链路（默认不进 test 链）
├── _validate_kernels.mjs       # 可选真机验收：三内核配置预检命令可用性（默认不进 test 链）
└── ui_smoke.py                 # 构建产物的逐页渲染校验（10 页）
design/                         # 10 张界面设计稿与可编辑 HTML 源码
```

## 协议 × 内核能力矩阵（摘要）

| 协议 | Xray | sing-box | Mihomo | 备注 |
|---|---|---|---|---|
| VMess / VLESS / Trojan / SS | 原生 | 原生 | 原生 | SS 废弃算法仅 Mihomo 兼容较好 |
| VLESS Reality / XTLS Vision | 参考实现 | 需较新版本 | 需 ≥1.18 / ≥1.19 | 按版本门槛提示 |
| Hysteria2 / TUIC / WireGuard / AnyTLS | 不支持 | 原生 / 需版本 | 原生 / 需版本 | 自动避开 Xray |
| SSR | 不支持 | 不支持 | 部分 | auth_chain 等组合已不维护，需实测 |
| NaiveProxy / SSH | 不支持 | 不支持 | 部分 / 需外部客户端 | 参数完整保留，明确提示 |

完整矩阵见 `src/core/hub/kernel.ts`，界面「设置中心」可查看。

- **内核配置必须用真实内核验收**（2026-11-11 全部通过）：`xray run -c <cfg> -test` / `sing-box check -c <cfg>` / `mihomo -t -f <cfg>`。踩过的版本差异坑，生成器已按此适配：
  1. **Xray 26.x 拒绝只有 `outboundTag` 的路由规则**（"this rule has no effective fields"），MATCH 兜底必须带 `network: "tcp,udp"`；sing-box 同理要求 `network: ["tcp","udp"]`（"missing conditions"）。
  2. **Xray 26.x 拒载缺 `encryption` 字段的 VLESS 用户**，生成器对 vless 缺省补 `"encryption": "none"`。
  3. **sing-box 1.14 移除旧版 DNS 格式** `{ address }`，必须用新版对象 `{ type, tag, server, server_port }`；且 route 需要 `default_domain_resolver` 指向 DNS tag，`clash_api.store_selected` 已废弃须移入 `experimental.cache_file`。
  4. **sing-box ws transport 不认顶层 `host`**，必须写进 `headers: { Host: ... }`（grpc 的 `serviceName` 同理映射为 `service_name`）。

## 测试

- `npm test`：分 `test:hub` / `test:runtime` / `test:manager` / `test:version` / `test:theme` / `test:window` / `test:layout` 七段跑完全部回归，覆盖 16 类协议、Reality/Vision/XHTTP、Clash YAML / sing-box / Xray / WireGuard、v2rayn:// 包装、订阅、去重、选核、二维码判定、未知格式拒绝、字段不静默丢失；三内核运行配置与 TUN/阻断；系统代理快照可逆；遥测归一化与速率差分；11 类路由规则的三内核下发与阻断；主进程拒绝路径 / 自动重启设置 / 热切换守卫；下载计划 URL、.dgst 新旧两种格式解析、注入式下载全流程（校验失败拒装 / 缺文件报清单 / 404 / 断线重试）；**渲染包裸 `Buffer` 扫描**（13:01 黑屏事故回归，构建前后都查）。
- `pnpm test:ui`：用 Chrome headless 打开构建产物的 10 个界面，检查关键内容与运行时错误，输出截图到 `tests/ui-smoke/`；首页额外校验仪表盘五处关键内容与**侧栏 11/11 个菜单项全部存在**，另有 `dashboard-home.png`（1440×900）与 `dashboard-home-1280x720.png` 两张布局截图确认无裁切。
- BUG 回归（2026-11-12 第二轮排查）：端口设置被清空 / 填 0 或 70000 / 与别的端口撞车时，先清洗再落盘（不再写出 `"mixedPort": ""` 这种把内核坑死的配置）；遥测采集器 `ctx` 被 `stop()` 清空后采样失败不再读 null 抛 `unhandledRejection`；`runtime.log` 超 1MB 自动轮转到 400KB；订阅自动更新加锁，定时器不会与上一轮叠加并发拉同一个订阅；渲染层连接 / 断开 / 切换全部补上 `catch` 与 toast，主进程运行层 IPC 加 `guarded` 兜底 —— **异常再也不会变成「点了没反应」**；系统代理绕过列表改为合并去重，本地回环永不走代理。
- 采集器端到端测试会在 `127.0.0.1` 临时端口起一个假 clash_api，真实验证采样、速率差分、DELETE 关闭连接、404 / 非 JSON 降级，以及 Xray 不发任何统计请求。
- 测速相关：`tests/speedtest.test.mjs` 13 条纯逻辑（目标解析 / CONNECT 请求与响应 / Content-Length / 速度换算与分级 / 白名单）；`tests/speedtest-download.test.mjs` 5 条用本机假代理 + 2MB 源站真跑下载链路（字节数、maxBytes 收工、204 不给带宽、502 如实报错、取消立即失败）。另外做过一次真机端到端：临时内核启动、隧道失败如实上报、结束后残留配置为 0。
- 监控状态：`tests/monitor-status.test.mjs` 18 条纯逻辑（连接 / 采样 / 数据源 / 节点体检四态、Xray「有速率无连接列表」的准确空态、采样异常、连接失败、采样时刻相对时间、以及「没数据不写成通」红线）。
- 节点体检：`tests/probe-diagnosis.test.mjs` 23 条纯逻辑（站点分组、七类失败归类、逐行判定、以及「节点可用 / 节点不可用 / 出不了海 / 部分可用 / 数据不足不下结论」各种组合，含亮哥截图那一组数据的回归）；`tests/probe-reachability.test.mjs` 14 条用本机假目标站 + 假 CONNECT 代理真发请求，验证 200/403 算通、超时、端口拒绝、502 代理拒绝、目标不存在、内核未运行不发假请求。
- **下载器做过真机端到端验证**（2026-11-10，经本机代理）：Xray v26.11.9（官方 .dgst SHA-256 校验通过）、Mihomo v1.19.33（zip 内文件改名安装）、sing-box v1.14.4，三者安装后均可执行并自报正确版本。URL 模板 / 校验 / 解压 / 改名链路以当日官方 Release 实测为准。
- 主进程测试**不会**启动内核、**不会**写系统代理、**不会**读写注册表；所有测试都不访问外网。
