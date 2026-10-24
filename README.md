# Aurora Launcher

Minecraft Java 版启动器。内置游戏本体与版本文件的下载、校验与修复能力，支持离线账户与微软正版账户登录，并能管理 Mojang 官方 Java 运行时。

后端使用 Node.js 标准库实现，没有第三方依赖，不需要 `npm install`；界面是原生 ES Module 写的单页应用，构建步骤为零。

提供两种运行方式：

- **源码运行**：`node src/main.js`，界面在系统浏览器中打开，改完代码刷新即生效。
- **便携版 exe**：执行打包脚本后生成，由 Electron 承载同一个本地服务，免安装、免装 Node，数据跟着文件夹走。

两种方式的渲染层与业务代码完全一致，区别只在外壳。

## 功能

- **版本选择**：拉取官方全部版本列表（正式版、快照、远古版本），支持搜索与分类筛选，选中后先预检文件数与体积再下载。
- **游戏下载**：解析版本 JSON（含 `inheritsFrom` 继承链），生成完整文件清单——client.jar、运行库、资源索引与资源对象、log4j 配置、natives。
- **版本管理**：安装、完整性校验、损坏修复、删除。删除只清理版本目录，共享的 libraries 与 assets 保留。
- **Java 运行时**：探测本机 Java（PATH、`JAVA_HOME`、常见安装路径、已下载运行时）；没有合适版本时从 Mojang 下载官方运行时。
- **账户登录**：离线账户按 `MD5("OfflinePlayer:<name>")` 派生 UUID；微软正版账户走设备码授权，令牌自动续期，头像取自正版皮肤。
- **启动参数**：内存上下限、窗口尺寸与全屏、附加 JVM 参数、Java 路径、游戏目录、`--server/--port` 直连，支持 dry-run 查看完整命令行。
- **进度与状态**：SSE 实时推送阶段、百分比、文件计数、网速、剩余时间与当前文件，失败文件单独列出并可重试。

不包含的部分：Forge / Fabric 等加载器安装器、资源包与光影管理、皮肤上传、联机代理、多实例管理。加载器生成的版本 JSON 放进 `versions/<id>/` 后可以被正常识别和启动，因为继承链解析是通用实现。

## 环境要求

- Windows 10 / 11 64 位（路径处理、`java.exe` 探测与 exe 打包按 Windows 适配；macOS 与 Linux 代码同源，未做发行验证）
- 源码运行需要 Node.js 20.6 或更高（用到 `fetch`、`AbortSignal.any`、`Readable.fromWeb`）
- 便携版不需要额外运行时

## 快速开始

### 源码运行

```bash
node src/main.js                            # 启动并打开浏览器
node src/main.js --no-open                  # 不自动打开浏览器
node src/main.js --port 4600                # 指定端口，被占用时自动顺延
node src/main.js --root "D:/mc/.minecraft"  # 指定数据目录
```

默认数据目录是 `~/.aurora-minecraft`。`--root` 指向已有的官方 `.minecraft` 即可复用现有实例，已存在且校验通过的文件会被跳过。

也可以双击 `start.bat`，它会检查 Node.js 是否安装后启动。

### 便携版

仓库不包含打包产物，先执行一次打包（见下一节），产物在 `dist/Aurora Launcher/`。双击其中的 `Aurora Launcher.exe` 即可运行，不需要安装 Node.js。

整个文件夹可以拷到任意位置，`data/` 跟着走；删除 `data/` 即回到初始状态。首次启动会在 exe 同级创建 `data/`，结构与官方 `.minecraft` 一致，因此也可以把它替换成指向现有实例的目录链接。

## 打包

打包脚本直接组装官方 Electron 运行时与应用代码，不依赖 electron-builder 或 NSIS，组装过程不需要联网。

```bash
node tools/make-icon.mjs    # 生成 build/icon.ico
node tools/build-exe.mjs    # 组装 dist/Aurora Launcher/
```

`build-exe.mjs` 会复制 Electron 运行时、移除 `default_app.asar`、把应用代码放进 `resources/app/`、重命名可执行文件，并在能找到 rcedit 时写入图标与版本信息。

打包前置资源放在仓库同级的 `.build/` 目录（不纳入版本控制）：

```
.build/electron/                          # 解压自 electron-v38.0.0-win32-x64.zip
.build/rcedit/package/bin/rcedit-x64.exe
```

## 微软正版登录

微软 OAuth 要求每个分发方使用自己注册的应用。程序里不内置应用 ID，需要花三分钟自己注册一个，免费，不需要密钥或信用卡。

1. 打开 [Azure 应用注册](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)，新建注册，「受支持的账户类型」选「仅个人 Microsoft 账户」，重定向 URI 留空。
2. 在概览页复制「应用程序(客户端) ID」。
3. 左侧「身份验证」→ 页面底部「高级设置」→「允许公共客户端流」选「是」→ 保存。

回到启动器，右上角账户头像 → 微软正版，粘贴 ID 后点「验证并保存」。保存前会实际向微软申请一次设备码，所以校验通过即代表这个 ID 可用。

配置完成后点「使用微软账户登录」，界面会给出一个验证码，在 `microsoft.com/link` 输入即可完成授权。授权轮询运行在服务端，中途关闭弹窗不会中断流程，重新打开能接上进度。

采用设备码流程而非授权码加本地回调，是为了避免登记回调地址和占用本机端口，也让浏览器版与便携版的行为保持一致。

令牌有效期方面，Minecraft 访问令牌约 24 小时，刷新令牌约 90 天。打开界面和启动游戏前都会静默续期。

## 数据目录

```
<root>/
├── versions/<id>/
│   ├── <id>.json          # 合并 inheritsFrom 后的版本清单，安装完成的标志
│   ├── <id>.jar           # client.jar
│   ├── natives/           # 旧版本需要的 natives 解压目录
│   └── aurora.json        # 安装时间、继承链、体积统计
├── libraries/             # Maven 结构，多版本共享
├── assets/
│   ├── indexes/<id>.json
│   ├── objects/ab/<hash>  # 内容哈希寻址，跨版本自动去重
│   ├── virtual/           # 1.6 及更早版本的虚拟资源目录
│   └── log_configs/
├── runtime/<component>/<platform>/
├── meta/                  # 远程元数据缓存，断网时作为兜底
├── logs/
├── compat.json            # 渲染兼容级别，删除即复位
└── aurora.config.json     # 配置与当前账户
```

## 目录结构

```
src/
├── main.js              源码版入口：起服务、开浏览器
├── app.js               应用门面，串联各模块
├── server/index.js      REST 与 SSE 路由
├── core/                下载、版本解析、启动、账户、Java 探测等
├── renderer/            界面：index.html / style.css / app.js
└── shared/constants.js  共享常量与错误类型
electron/main.cjs        便携版外壳
tools/                   图标生成与打包
docs/ARCHITECTURE.md     设计说明
test/                    单元测试
```

## 实现概要

依赖方向是单向的：外壳 → server → app → core。外壳只负责把本地服务跑起来并把界面装进容器，`server` 只做协议转换，业务集中在 `app` 与 `core`。因此把 `server` 换成 Electron IPC 时，下层的代码不需要改动。

`install`、`verify`、`repair` 三者共用同一份安装计划，对「这个版本应该包含哪些文件」的判断来源唯一，不会出现校验与安装口径不一致的情况。计划构建时按落盘路径去重，`libraries` 与 `assets` 天然跨版本共享。

写入采用 `.part` 加校验通过后重命名的方式，中途失败不会在最终路径留下残缺文件。进度统计区分「已完成字节」与「在途字节」，网速只统计真实网络流量，跳过与校验命中的文件不计入。

具体的数据结构、状态机与错误处理矩阵见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 测试

```bash
npm test
```

测试覆盖微软登录的错误码翻译、账户构建、会话状态推进与令牌过期判断，全部使用模拟响应，不访问网络。

## 已知限制

- 完整资源体积较大（1.19.4 约 500 MB、3600 个对象）。安装时可以取消「下载完整游戏资源」先进入游戏，之后用「校验并修复」补齐。
- 严格校验 5000 多个文件需要数十秒，可在设置中切到「快速（仅大小）」。
- 未配置应用 ID 时，微软登录入口为禁用状态。
- 便携版体积约 300 MB，其中绝大部分是 Electron 运行时。未做代码签名，Windows SmartScreen 首次运行会提示未知发布者。
- 微软令牌以明文保存在 `data/aurora.config.json`，与多数第三方启动器一致。介意的话请把 `data/` 放在个人目录下，不要整个文件夹分享出去。

## 许可

[MIT](LICENSE)
