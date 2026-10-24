# 架构说明

本文说明各层的职责划分、核心数据结构、关键流程与错误处理约定。功能范围与使用方式见 [README](../README.md)。

## 1. 分层

```
electron/main.cjs ┐
src/main.js      ┴─▶  renderer  ──HTTP/SSE──▶  server  ──▶  app  ──▶  core/*
```

外壳只负责把本地服务跑起来并把界面装进容器，不含业务逻辑。依赖方向严格单向，任一层都不反向依赖上层：

| 层 | 可依赖 | 不可依赖 |
| --- | --- | --- |
| 外壳 | Electron API、`node:http`、`app` 的公开方法 | `core/*` |
| `renderer` | 浏览器 API、HTTP/SSE | 任何 Node API、文件系统 |
| `server` | `app` 的公开方法 | `core/*` |
| `app` | `core/*` | HTTP 的 req/res |
| `core/*` | 同级 core、`shared/constants` | express / http / UI |

把 `server` 换成 Electron IPC 时，`app` 与 `core` 无需改动，这也是浏览器版与便携版能共用同一份内核的原因。

## 2. 关键数据结构

### 2.1 DownloadTask

```js
{
  kind: 'client' | 'library' | 'native' | 'assetIndex' | 'asset' | 'logConfig' | 'java',
  url: string,        // 官方地址，镜像改写在此之上进行
  dest: string,       // 绝对落盘路径，同时是去重键
  sha1: string|null,  // 校验用；资源对象直接用内容哈希作文件名
  size: number,       // 字节数，0 表示未知
  label: string       // 界面展示用短名
}
```

以 `dest` 作去重键，是因为 `libraries` 与 `assets` 跨版本共享。同一份 `gson-2.11.0.jar` 会被多个版本引用，按落盘路径去重即可避免重复下载；`assets/objects` 更是以内容哈希寻址，跨版本自动共享。

### 2.2 Plan

```js
{
  id, resolved,               // resolved 为合并 inheritsFrom 后的完整版本 JSON
  tasks: DownloadTask[],      // 已排序、已去重
  natives: [{ jar, exclude }],// 需要解压的旧版 natives
  assetIndexData,             // 资源索引内容，含 virtual / map_to_resources 标记
  totals: { count, bytes, byKind },
  ctx                         // 规则求值上下文，含 os 与 features
}
```

`install`、`verify`、`repair` 都从 `buildPlan()` 取任务清单，对「该版本应包含哪些文件」的判断来源唯一，因此三者的结论不会出现分歧。

### 2.3 Job

```js
{
  id, type: 'install'|'verify'|'repair', versionId,
  status: 'running'|'paused'|'done'|'error'|'cancelled',
  phase: 'resolve'|'client'|'assets'|'natives'|'finalize',
  progress: { total, completed, skipped, failed, bytesTotal, bytesDone, percent, speed, eta, files[] },
  plan: { totals }, failedTasks: [], result: {},
  controller: AbortController, signal
}
```

每个任务持有独立的 `AbortController`，暂停或取消某个任务不影响其他任务，无需额外协调。

## 3. 时序

### 3.1 安装

```
UI                server            jobs           installer        downloader        Mojang
 │  POST /api/install │                │                │                │               │
 ├───────────────────▶│  create()      │                │                │               │
 │   {jobId}          │───────────────▶│  _run()        │                │               │
 │◀───────────────────┤                ├───────────────▶│  buildPlan()   │               │
 │                    │                │                ├────────────────┼──────────────▶│ 版本 JSON
 │                    │                │                │◀───────────────┼───────────────┤ 资源索引
 │  SSE: phase        │◀───────────────┤◀───────────────┤  plan ready    │               │
 │  SSE: plan         │◀───────────────┤                │                │               │
 │                    │                │                │  coreTasks     │               │
 │                    │                │                ├───────────────▶│ run() 并发下载 │
 │  SSE: progress ×N  │◀───────────────┤◀───────────────┤◀───────────────┤ 节流 160ms    │
 │                    │                │                │  assetTasks    │               │
 │                    │                │                ├───────────────▶│ ...           │
 │                    │                │                │  extractNatives│               │
 │                    │                │                │  写 <id>.json  │               │
 │  SSE: done         │◀───────────────┤◀───────────────┤                │               │
```

finalize 是唯一的提交动作。此前任何一步失败，磁盘上最多留下孤立的 `.part` 与已下好的共享文件，而 `versions/<id>/<id>.json` 不存在，`listInstalled()` 不会将其视为已安装版本。

### 3.2 启动

```
UI                app                    launcher            javaRuntime        child process
 │ POST /api/launch │                       │                     │                   │
 ├─────────────────▶│ resolve(fromLocal)    │                     │                   │
 │                  ├──────────────────────▶│ requiredJavaMajor   │                   │
 │                  │                       ├────────────────────▶│ 探测或下载运行时   │
 │                  │                       │◀────────────────────┤                   │
 │                  │                       │ buildLaunchCommand  │                   │
 │                  │                       │  · classpath 过滤    │                   │
 │                  │                       │  · 规则求值          │                   │
 │                  │                       │  · 占位符替换        │                   │
 │                  │                       │  · 内存参数去重      │                   │
 │                  │                       ├─────────────────────┼──────────────────▶│ spawn
 │                  │                       │                     │                   │
 │ SSE: game-log ×N │◀──────────────────────┤ stdout / stderr     │                   │
 │ SSE: game-exit   │◀──────────────────────┤ on close            │                   │
```

### 3.3 校验与修复

以本地 `<id>.json` 构建计划（`fromLocal: true`），断网也能执行。逐文件检查存在性、大小、（严格模式）SHA1，收集 `broken[]`。`repair` 模式只把 `broken[]` 交给下载器补下载，不重跑全量。

## 4. 下载引擎

### 4.1 并发模型

固定大小 worker pool 配共享游标，不预分配任务：

```js
while (true) {
  const i = cursor++;              // 单线程自增，无锁
  if (i >= tasks.length) return;
  await process(tasks[i]);
}
```

慢任务不会占住槽位，负载自然均衡；每个任务内部独立，失败只影响自身。

### 4.2 单任务流程

```
_runTask(task)
  ├─ 快速通道：文件存在？
  │    ├─ 大小匹配 → （严格模式）SHA1 匹配 → 'skipped'（计入已处理，不计入网速）
  │    └─ 不匹配 → 删除，继续
  └─ _downloadWithRetry(最多 N 次)
       └─ _downloadOnce(attempt)
            ├─ 有 .part 且小于目标 → Range: bytes=<n>-
            ├─ HTTP 416            → 删 .part，报可重试错误
            ├─ 非 2xx              → 分类可重试性（403/404/408/429/5xx）
            ├─ 期望 206 收到 200   → 服务器不支持 Range，从头覆盖写
            ├─ 流式写入 .part（Transform 计数并节流推进度）
            ├─ content-length 不符 → 判定传输截断，可重试
            ├─ rename .part → dest（原子）
            └─ SHA1 校验失败       → 删文件，可重试
```

### 4.3 进度统计

| 错误做法 | 后果 |
| --- | --- |
| 流式累加 `bytesDone`，完成时再加一次 `task.size` | 字节双倍计数，进度提前到 100% 但文件只下了一半 |
| 用包含跳过字节的差值计算速度 | 续传首次刷新就显示数百 MB/s |
| 只在文件完成时推进度 | 下载单个 23 MB 的 client.jar 期间界面无反馈 |
| 切换阶段时沿用上一批的 progress | 阶段显示「游戏资源」，数字却是上一批的 |

修正方式：把已完成字节、真实流量、在途字节拆成 `bytesBase` / `speedBase` / 每任务 `state.received`，在 `_emit` 中合成；传输过程中逐块推进（内部节流 160ms）；每批开始时强制推一帧。

### 4.4 网络策略

| 场景 | 策略 |
| --- | --- |
| 超时 | 单请求 45s，元数据 30s，使用 `AbortSignal.timeout` |
| 取消 | 用户信号与超时信号以 `AbortSignal.any` 组合 |
| 退避 | `min(800ms × 2^(n-1), 8s) × (0.7~1.3 随机)`，避免并发任务同时重试 |
| 换源 | `mirror=auto` 时第 2 次起改写为 BMCLAPI；`official` / `bmclapi` 为强制模式 |
| 熔断 | 单批次连续 12 次失败且 0 成功时提前中止 |

### 4.5 镜像映射

`mirrorUrl()` 只做 host 级改写：

| 官方 | 镜像 |
| --- | --- |
| `launchermeta/piston-meta/piston-data.mojang.com` | `bmclapi2.bangbang93.com`（路径原样） |
| `libraries.minecraft.net/<path>` | `bmclapi2.bangbang93.com/maven/<path>` |
| `resources.download.minecraft.net/<xx>/<hash>` | `bmclapi2.bangbang93.com/assets/<xx>/<hash>` |

新增下载源只需加一条规则，元数据、本体、运行库、资源全链路生效。

## 5. 规则求值

`rules` 决定某个库或某条参数在当前平台是否生效，语义为最后命中者生效：

```js
function evaluateRules(rules, ctx) {
  if (!rules?.length) return true;      // 无 rules 视为允许
  let allowed = false;
  for (const rule of rules) {
    if (matchOs(rule.os, ctx.os) && matchFeatures(rule.features, ctx.features)) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}
```

平台映射 `win32→windows`、`darwin→osx`、`linux→linux`；架构映射 `x64→x86_64`、`ia32→x86`、`arm64→arm64`。

同一套求值用于两处：libraries 过滤决定下载哪些库、哪些进 classpath；arguments 过滤决定 `--demo`、`--width/--height`、`-XstartOnFirstThread` 等条件参数是否出现。`features` 由启动选项构造，例如用户填写分辨率时 `has_custom_resolution` 为 true。

## 6. classpath 与启动参数

### 6.1 组装顺序

```
[用户内存参数] [-Dlog4j.configurationFile=...] [版本自带 jvm args（规则过滤 + 替换）]
  [mainClass] [game args（规则过滤 + 替换）]
```

版本自带的 `-Xmx` / `-Xms` 会被剔除，保证用户设置优先且不重复；`${classpath}`、`${natives_directory}` 等占位符统一替换，缺失变量替换为空串。旧版 `minecraftArguments` 字符串与新版 `arguments.game` 数组走同一套后续流程。

### 6.2 natives 的两种形态

| 版本 | 形态 | 处理 |
| --- | --- | --- |
| 1.18 及更早（多数） | `libraries[].natives` + `classifiers` 映射 | 下载对应 classifier，解压到 `versions/<id>/natives`，不进 classpath |
| 1.19 起 | 独立 Maven 构件 `org.lwjgl:lwjgl:x:natives-windows` | 作为普通 artifact 进 classpath，由 LWJGL 运行时自行抽取 |

判定依据是 `lib.natives` 字段是否存在。1.8.9 的计划里有 4 个 native 任务，1.21.4 为 0 个。

### 6.3 Java 选择

```
显式配置路径 → 本机精确匹配 requiredMajor → 本机兼容版本 → 已下载运行时 → 自动下载
```

兼容性判定：`required ≤ 8` 时只接受 Java 8，因为 1.16 及更早版本只稳定支持 8；否则接受 `required < major ≤ required+6`。均未命中时按 `jre-legacy` / `alpha` / `gamma` / `epsilon` 的映射下载官方运行时。

## 7. HTTP 与 SSE 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bootstrap` | 全量状态：配置、账户、已安装版本、Java 列表、任务、运行中进程 |
| GET | `/api/versions/remote?force=1` | 远程版本清单，含 `stale` 标记 |
| POST | `/api/versions/preview` | 预检 `{versionId, includeAssets}`，返回文件数、体积、分类、安装路径 |
| POST | `/api/install` | 创建安装任务 |
| POST | `/api/verify` | `{versionId, repair}` 校验或校验并修复 |
| DELETE | `/api/versions/:id` | 删除版本目录，不动共享资源 |
| POST | `/api/reveal` | 在文件管理器中打开版本目录 |
| POST | `/api/jobs/:id/{pause,resume,cancel}` | 任务控制 |
| POST | `/api/launch` | 启动游戏，`dryRun:true` 时只返回命令行 |
| POST | `/api/process/:id/kill` | 结束游戏进程 |
| POST | `/api/auth/offline` | `{name}` 创建离线账户，UUID 由服务端派生 |
| POST | `/api/auth/microsoft/start` | 发起微软登录，返回 `{id, state, userCode, verificationUri, expiresAt}` |
| GET | `/api/auth/microsoft/status` | 查询登录会话，前端 1s 轮询 |
| POST | `/api/auth/microsoft/cancel` | 取消登录 |
| POST | `/api/auth/microsoft/verify-client` | 仅验证应用 ID 是否可用 |
| POST | `/api/auth/microsoft/client-id` | 校验通过后保存应用 ID |
| POST | `/api/auth/refresh` | 强制刷新令牌 |
| POST | `/api/auth/logout` | 退出正版账户，切回离线账户并保留名字 |
| GET | `/api/auth/skin` | 返回皮肤 `{dataUrl, w, h}`，离线返回 `{dataUrl: null}` |
| GET/POST | `/api/config` | 读写配置；改 `rootDir` 会重建 paths 层。`account` 一律返回脱敏快照 |
| GET | `/api/storage` | 磁盘占用：版本、运行库、资源、运行时 |
| GET | `/api/stream` | SSE：`progress` `phase` `plan` `file` `done` `error` `paused` `cancelled` `verified` `game-log` `game-exit` `auth` `account` `auth-warning` |

进度是服务端单向推送，SSE 自带断线重连、握手开销小、纯 HTTP 可穿透，比 WebSocket 少一套心跳逻辑。每 20s 发送一个注释帧，防止中间层主动断开。

## 8. 一致性保证

| 风险 | 保证方式 |
| --- | --- |
| 半截文件被当成有效文件 | 写 `.part`，校验通过后 `rename` 到最终路径 |
| 下到一半的版本被当成已安装 | `listInstalled()` 只认存在 `<id>/<id>.json` 的目录，该文件仅在 finalize 阶段写入 |
| 配置文件写到一半损坏 | `atomicWrite`：临时文件加 rename |
| 安装与校验结论不一致 | 两者共用 `buildPlan()` |
| 重复下载已存在的库 | 按 `dest` 去重，快速通道跳过 |
| 单个请求异常导致服务退出 | `sendJson` 检查 `headersSent`；进程级 `uncaughtException` / `unhandledRejection` 兜底记录 |
| 局域网内被调用启动游戏 | 仅监听 `127.0.0.1`，逐请求校验回环地址 |

## 9. 桌面外壳与打包

### 9.1 打包方式

构建链只有 `node tools/build-exe.mjs` 一步，把官方 Electron 运行时目录与应用代码目录拼装在一起：

```
Aurora Launcher.exe          ← electron.exe 改名
resources/app/
  package.json  main.cjs  icon.ico
  src/          ← 后端与界面，含声明 type=module 的 src/package.json
resources/{*.pak, *.dll, locales/, icudtl.dat, ...}
```

代价是需要自行准备 `.build/electron/`，收益是离线可复现：不依赖 npm 构建依赖，也不受 registry 与 GitHub Release 可达性影响。图标与版本信息通过 rcedit 写入 PE 资源，找不到 rcedit 时跳过。

`resources/app/src/package.json` 必须声明 `type: module`，否则该目录下的 ESM 后端会被当作 CJS 解析。主进程保持 `.cjs` 并用动态 `import()` 加载后端，以兼容旧版 Electron 对 ESM main 的限制。

### 9.2 端口与单实例

便携版用 `listenEphemeral()` 由系统分配空闲端口，不使用固定端口，避免多实例或端口被占时启动失败。端口写入 `aurora-boot.log`，`BrowserWindow` 加载 `http://127.0.0.1:<port>`。

单实例通过 `app.requestSingleInstanceLock()` 实现，第二次双击时聚焦已有窗口，不会新起一个下载引擎去争抢同一批 `.part` 文件。

### 9.3 渲染降级链

在受限环境（无独显、老驱动、远程桌面、受限 Job 对象、精简系统）下，Chromium 可能以两种方式失败：

| 现象 | 根因 |
| --- | --- |
| GPU 进程反复 `0xC0000005`，随后 `GPU process isn't usable` 并退出 | GPU 进程无法启动 |
| 渲染进程 `0x80000003` | Chromium 沙箱被宿主限制 |

两者对外表现都是窗口一闪而过，且 GUI 子系统没有控制台，不会留下 stdout。因此 `electron/main.cjs` 做了三件事：

1. 每个阶段用 `fs.appendFileSync` 写 `aurora-boot.log`，不依赖 `console`。
2. `data/compat.json` 决定本次使用硬件加速、软件渲染还是关闭沙箱，相关调用必须发生在 `app.whenReady()` 之前。
3. 监听 `child-process-gone` 与 `render-process-gone`，达到阈值后写下一级 stage，释放单实例锁，再 `relaunch()`。渲染进程在加载完成前崩溃时直接跳到关闭沙箱，省去一次重启。

顺序上必须先释放单实例锁再重启，否则新进程会被旧进程持有的锁拦下并直接退出。

### 9.4 退出时的进程清理

`before-quit` 中先关闭 HTTP 服务，再结束所有游戏子进程，最后退出。否则会留下「启动器已关闭、游戏仍在运行」的孤儿进程，下次启动还可能因单实例锁而拿不到窗口。

## 10. 账户与鉴权

### 10.1 统一账户结构

离线账户与微软账户产出同一形状的对象，启动参数组装、界面渲染与配置持久化都不需要分支：

```js
{
  mode: 'offline' | 'microsoft',
  name, uuid, accessToken, userType: 'legacy' | 'msa',
  xuid, refreshToken, clientId,
  expiresAt,      // 微软账户为 Minecraft 令牌到期时间戳，离线账户为 0
  skinUrl         // 微软账户为皮肤贴图地址，离线账户为空
}
```

差别只在来源：离线账户 `accessToken = '0'`，UUID 由名字派生；微软账户的令牌来自真实链路。

### 10.2 登录链路

```
用户点击登录
   │
   ▼  POST /devicecode  ─────────►  user_code（如 K7QP-2XHD）
   │                                服务端按 interval 轮询
   ▼  用户在 microsoft.com/link 输入验证码并授权
   │
   ▼  POST /token (device_code)  ──►  MSA access_token + refresh_token
   │
   ▼  user.auth.xboxlive.com      ──►  XBL Token        (RpsTicket = d=<MSA token>)
   │
   ▼  xsts.auth.xboxlive.com      ──►  XSTS Token + uhs + xid
   │
   ▼  login_with_xbox             ──►  Minecraft access_token (24h)
   │
   ▼  entitlements/mcstore        ──►  是否拥有 product_minecraft / game_minecraft
   │
   ▼  minecraft/profile           ──►  name / uuid / skins
```

设备码流程不需要在 Azure 登记重定向 URI，不需要在本机监听回调端口，因此不受防火墙与端口占用影响，两种交付形态的行为也一致。代价是用户需手动输入一次验证码。

登录状态机 `MsaLoginSession` 运行在服务端，页面只轮询 `GET /api/auth/microsoft/status`。关闭弹窗、切换标签或刷新页面都不会中断授权，重新打开时自动接上进度。会话 20 分钟后过期。

### 10.3 令牌生命周期

| 令牌 | 有效期 | 失效后果 | 处理 |
| --- | --- | --- | --- |
| MSA access_token | 约 1 小时 | 无法换取 XBL 令牌 | 不在本地持久使用，只在链路中即时消费 |
| MSA refresh_token | 约 90 天 | 需要重新登录 | 存入配置，用于换取新的 access_token |
| Minecraft access_token | 24 小时 | 联机鉴权失败 | 存入配置，到 `expiresAt` 时静默续期 |

续期为全链重跑：refresh_token 换新 MSA 令牌，再经 XBL、XSTS 取得新的 Minecraft 令牌与档案。首登与续期共用 `buildAccount()`，产出的账户结构一致。

触发点有两个：`bootstrap()` 时后台执行，不阻塞渲染，失败仅记日志；`launch()` 前阻塞执行，因为令牌不正确会导致进服被拒，但失败不阻止启动，单人游戏仍可运行。`expiresAt` 提前 5 分钟视为过期。

### 10.4 错误码映射

| 来源 | 码 | 提示 |
| --- | --- | --- |
| AAD | 700016 | 应用 ID 不存在，确认复制的是应用程序(客户端) ID |
| AAD | 7000218 | 未开启「允许公共客户端流」 |
| AAD | invalid_grant | 登录已失效，请重新登录 |
| XSTS | 2148916233 | 没有 Xbox 档案，通常意味着未购买，需先登录 xbox.com |
| XSTS | 2148916238 | 未成年账户，需加入 Microsoft 家庭组 |
| XSTS | 2148916235/36/37 | 地区不支持、需年龄验证、屏幕时间超限 |
| MC | 401 | 账户拒绝登录，确认拥有 Java 版 |
| MC | 404（profile） | 尚未创建角色名，需先在官方启动器创建 |
| mcstore | items 为空 | 该账户没有 Java 版购买记录 |

### 10.5 应用 ID 校验

配置面板的「验证并保存」会实际调用 `POST /devicecode`，不是格式检查。校验通过代表该 ID 确实可用（存在、是公共客户端、允许设备码流），不会出现保存成功但登录失败的情况；校验失败时返回翻译后的原因。只有校验通过才写入配置，避免存下一个不可用的 ID 让用户误以为已配置完成。

### 10.6 皮肤头像

服务端从 `textures.minecraft.net` 取皮肤 PNG 并转为 data URL，前端用 CSS 裁出正面 8×8 区域，不依赖第三方头像服务：

```js
const k = box / 8;                                   // 一个皮肤像素对应的设备像素
img.style.backgroundSize = `${64 * k}px ${h * k}px`; // 兼容 64×64 与旧版 64×32
img.style.backgroundPosition = `${-8 * k}px ${-8 * k}px`;
```

`h` 从 PNG 的 IHDR 读取，因此旧版 64×32 皮肤不会被拉伸错位。

### 10.7 安全边界

- 令牌不下发到前端。`bootstrap` 与 `/api/config` 返回 `accountView()` 脱敏快照，只含名字、UUID 与到期状态。
- 令牌以明文保存在 `aurora.config.json`。本地单机程序没有可靠的系统密钥库可依赖，与多数第三方启动器一致，README 中已说明。
- 仅申请 `XboxLive.signin offline_access` 两项权限，不涉及邮箱、通讯录与订阅。
- 账户自愈：微软账户缺少 `uuid` 或 `accessToken` 时，启动阶段自动退回离线账户，避免启动瞬间抛出一连串鉴权错误。

## 11. 后续演进

1. 加载器安装器：新增 `core/loaders/*`，产出带 `inheritsFrom` 的版本 JSON，现有下载、校验、启动链路无需改动。
2. 限速与代理：给 `Downloader` 加令牌桶，给 `rawFetch` 注入 ProxyAgent。
3. 多实例：`config.profiles[]` 配合 `createPaths(root)`，后者已是纯函数。
4. 校验提速：把 SHA1 放进 worker_threads 池，或用大小与 mtime 缓存做增量校验。
5. 崩溃诊断：`game-exit` 退出码非 0 时读取 `crash-reports/latest.log`，定位内存不足、Java 版本不符、显卡驱动等常见原因。
