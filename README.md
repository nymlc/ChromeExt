# 极客百宝箱 (Geek Toolbox) Chrome 扩展

一个 **Manifest V3** 的模块化浏览器助手，把「密码显示、凭证填充、MasterGo 导航、时间戳格式化」四套工具整合在一起。代码结构清晰、扩展性强，新增功能只需继承基类并在配置中注册。

> 作者：林晨 · 当前版本：v1.0.9

## 项目结构

```
ChromeExt/
├── background.js                     # Service Worker 主入口
│   └── background/managers/
│       ├── PasswordManager.js        # 快捷键（Ctrl/Cmd+Shift+P 切换密码）管理
│       └── TabPoolManager.js         # MasterGo 标签页池的后台协调
├── content/                          # Content Scripts（注入网页）
│   ├── content.js                    # Content 主入口：ContentManager 统筹模块生命周期
│   └── modules/
│       ├── BaseModule.js            # Content 模块基类（三层开关 / 启用检查）
│       ├── PasswordHelper.js        # 密码显示模块
│       ├── CredentialFiller.js      # 凭证填充模块（最复杂）
│       ├── ImagePreview.js          # 复制/粘贴图片地址预览
│       └── MasterGoNav.js           # MasterGo 悬浮树状导航（仅 mastergo.com）
├── popup/                            # 扩展管理面板（Popup）
│   ├── popup.js                      # Popup 主入口：PopupManager
│   ├── popup.html / popup.css        # 面板 UI
│   └── modules/
│       ├── BaseModule.js           # Popup 模块基类
│       ├── PasswordToggle.js       # 密码模块开关 UI
│       ├── CredentialManager.js    # 凭证管理 UI（增删改 / 采集）
│       └── MasterGoManager.js      # MasterGo 导航配置 UI
├── shared/                           # 多端共用的工具类
│   ├── storageState.js             # 全局存储缓存单例（集中监听 + 订阅）
│   ├── Toast.js                    # 轻提示
│   ├── SideTooltip.js              # 侧边浮层（凭证选择列表）
│   ├── TabPool.js                 # MasterGo 标签页池（content 客户端）
│   ├── IframePool.js              # MasterGo iframe 池（休眠，见下）
│   └── LRUCache.js                # LRU 淘汰（休眠，配合 IframePool）
├── icons/                           # 图标资源
├── scripts/
│   └── build.js                     # 打包脚本（同步 manifest/package 版本号）
├── manifest.json                    # 扩展配置
└── package.json                     # 版本号由 build 脚本与 manifest 同步
```

## 三大功能模块

### 1. 密码显示（PasswordHelper / PasswordToggle）
- 为所有 `<input type="password">` 添加眼睛图标，点击或双击切换明文/密文。
- 通过 `MutationObserver` 支持框架动态插入的密码框。
- 显示状态按 `tabId` 存于 `sessionStorage`，**刷新即重置**（设计如此）。
- 快捷键：`Ctrl/Cmd + Shift + P`（由 `background/managers/PasswordManager.js` 转发）。

### 2. 凭证填充（CredentialFiller / CredentialManager）
- 按页面 `title` 模糊匹配项目（或 `titleProjectBindings` 手动绑定），聚焦登录框时弹出 `SideTooltip` 选择凭证。
- 支持**跨 iframe**：iframe 内通过 `postMessage` 委托父页面渲染浮层，避免被 iframe 边界裁剪。
- 字段识别综合 `placeholder / name / id / autocomplete / aria-label` 等线索 + 语义兜底；填充用原生 `value` setter 触发框架事件。
- 支持标签 / 列表双视图、一键从页面采集凭证、导入/导出；`note` 是兼容字段名，实际存储多值标签数组，用于分组和环境/角色区分。

### 3. MasterGo 导航（MasterGoNav + 后台 TabPoolManager）
- 悬浮树状侧边栏，支持暗/亮主题、左/右侧、可折叠。
- 默认 **Tab 池模式**：每个菜单项一个标签页、统一收进 tab 组、LRU 淘汰（`TabPool` + `background/managers/TabPoolManager.js`）。
- 另含一套 **iframe 池模式**代码（`IframePool` + `LRUCache`），目前为休眠状态（见下方「已知设计说明」）。

### 4. 时间戳格式化（TimestampFormatter）
- **网页内复制即显示**：在网页中复制数字时间戳或日期文本，浮层紧跟光标即时弹出（无需权限、不弹框）。
- **任意处复制（终端/编辑器/聊天等）即显示**：在别处复制时间戳后，在任意页面 / 输入框**粘贴**该内容，浮层即自动弹出（置中央）。粘贴事件直接携带文本，无需读取系统剪贴板、不弹权限框、也**不在页面注入任何图标**。
  > 技术说明：Chrome 不允许后台无感轮询剪贴板——Service Worker 无 `navigator.clipboard`、Offscreen 文档无法聚焦导致 `readText` 必失败、内容脚本轮询又会逐页弹「查看复制到剪贴板的文字和图片」权限框。因此「任意处复制」采用「粘贴即识别」——粘贴是用户手势且内容随事件直送，是最稳且不打扰的方式（零图标、无需 `clipboard-read` 权限）。
- **其它应用复制 → 网页粘贴即识别**：在终端/编辑器/聊天等任意处复制的时间戳，回到网页或输入框 `粘贴` 即可自动弹出格式化浮层（零图标、无需 `clipboard-read` 权限）。
- 支持识别：
  - 整数时间戳：10 位（秒）、13 位（毫秒）、16 位（微秒）、19 位（纳秒）。
  - 日期/时间字符串：`2026-08-06T09:45:03Z`、`2026-08-06 09:45:03`、`2026/08/06 09:45:03` 等常见格式。
- 浮层展示**本地时间、星期、UTC 时间、相对时间**；点击任意一行即复制。
- 交互细节：网页内复制浮层定位取光标坐标（鼠标 / 右键菜单均覆盖），纯键盘复制回退到选区尾端；浮层 **8 秒后自动消失**，也可按 `Esc` 或点击空白处立即关闭。跨应用复制请直接粘贴触发，无需任何页面图标。
- 为防止误触普通数字，整数模式只接受上述四种规范长度（如 11 位手机号不会触发）。

### 5. 图片地址预览（ImagePreview）
- 在网页中复制图片地址或 `data:image/...` 内容（包括 base64、URI 编码 SVG）时，会先用浏览器原生图片加载验证；验证成功后在鼠标或选区附近显示预览。
- 从终端、编辑器、聊天工具等其它应用复制图片地址后，回到网页或输入框粘贴时也会验证并居中预览；不会读取系统剪贴板，也不会阻止原始粘贴。
- 同源 `blob:` 地址会尽力预览，但受创建页面、存储分区和 `URL.revokeObjectURL()` 生命周期限制，失败时静默忽略。
- 裸 base64、非图片 `data:`、不安全协议、加载失败的地址、超过 2 MiB 的 data URL 或超过 16 MP 的图片均会静默忽略；不新增 `clipboard-read`、主机权限或后台抓取。
- 受三层开关控制：模块总开关 `imagePreviewModuleEnabled`、网站级禁用 `disabledImagePreviewSites`，并可设置最大预览尺寸。

### 6. 二维码工具（QrCodeTool）
- **Popup 工具面板**：扩展图标弹出页内置「二维码工具」模块。
  - **生成**：输入文本 / 网址，实时预览二维码，可下载 PNG。
  - **解码**：上传本地图片或直接在面板内粘贴图片，使用 jsQR 解析，结果可一键复制。
- **网页内右键触发**（无需打开面板）：
  - 在网页中**选中文本**右键 →「为选中文本生成二维码」→ 页面浮层展示二维码并支持下载。
  - 在网页任意位置右键 →「解码二维码」：若右键的是 `<img>` 二维码，直接抓取该图解码；若右键的是**背景图 / Canvas 渲染的二维码**（登录码、支付码常见），则自动整页扫描所有图片与 canvas 找出二维码并解码。图片均由后台 Service Worker 抓取（扩展具备 host 权限，绕过页面 CORS 限制），因此跨域图片也能正常解码。
- 第三方库：`qrcode`（生成）、`jsQR`（解码），均以 UMD 单文件形式置于 `lib/` 由打包脚本收录。
- 受三层开关控制：模块总开关 `qrCodeToolModuleEnabled`、网站级禁用 `disabledQrCodeToolSites`。

## 三层控制系统

所有 Content 模块共用 `BaseContentModule.checkModuleEnabled()`，依次判断：

| 层级 | 含义 | 存储键 |
|------|------|--------|
| 全局禁用 | 整个扩展在某网站是否启用 | `globalDisabledSites` |
| 模块全局开关 | 某功能是否全局启用 | `{module}ModuleEnabled` |
| 网站级开关 | 某功能在特定网站是否启用 | `disabled{Module}Sites` |

开关切换通过统一的 `StorageState` 缓存广播，立即生效、无需刷新页面。

## 技术架构

```
background.js (Service Worker)
  └─ managers/  PasswordManager / TabPoolManager
        ▲ 消息路由(canHandle + handle)
content scripts (注入网页)
  ├─ <all_urls> (除 mastergo.com): PasswordHelper + CredentialFiller，由 ContentManager 统筹
  └─ mastergo.com: MasterGoNav（自启动 IIFE）
shared/StorageState  ── 单一 chrome.storage.onChanged 监听 + 订阅广播
popup (管理面板)
  └─ PopupManager + PasswordToggle / CredentialManager / MasterGoManager
```

**共享存储缓存层（StorageState）**
各模块原本各自 `chrome.storage.onChanged` 监听并重复 `get`；现统一收敛到 `shared/storageState.js`：
- 首次 `init()` 拉取全量 `chrome.storage.local` 并注册**唯一** `onChanged` 监听。
- 暴露 `get / set / subscribe / refresh`，变更时同步缓存并广播给订阅者。
- Content 脚本需在 `manifest.json` 的 content_scripts 中先于其它模块加载。

## 存储键约定

| 功能 | 存储键 | 类型 |
|------|--------|------|
| 全局禁用网站 | `globalDisabledSites` | `Array<string>` |
| 密码模块全局启用 | `passwordModuleEnabled` | `Boolean` |
| 密码模块网站禁用 | `disabledPasswordSites` | `Array<string>` |
| 凭证模块全局启用 | `credentialModuleEnabled` | `Boolean` |
| 凭证模块网站禁用 | `disabledCredentialSites` | `Array<string>` |
| 凭证项目库 | `credentialProjects` | `Array<Project>` |
| 标题→项目绑定 | `titleProjectBindings` | `Object<title, projectId>` |
| 凭证视图模式 | `credentialViewMode` | `'tab' \| 'list'` |
| MasterGo 节点 | `mastergoNavNodes` | `Array` |
| MasterGo 折叠/侧/容量/主题 | `mastergoNavCollapsed` / `mastergoNavSide` / `mastergoNavPoolCapacity` / `mastergoNavTheme` | `Boolean` / `'left'\|'right'` / `Number` / `'dark'\|'light'` |
| MasterGo 模块启用 | `masterGoNavModuleEnabled` | `Boolean` |
| 时间戳模块全局启用 | `timestampFormatterModuleEnabled` | `Boolean` |
| 时间戳模块网站禁用 | `disabledTimestampFormatterSites` | `Array<string>` |
| 时间戳显示 UTC | `timestampFormatterShowUTC` | `Boolean` |
| 时间戳显示相对时间 | `timestampFormatterShowRelative` | `Boolean` |
| 图片地址预览模块启用 | `imagePreviewModuleEnabled` | `Boolean` |
| 图片地址预览网站禁用 | `disabledImagePreviewSites` | `Array<string>` |
| 图片最大预览尺寸 | `imagePreviewMaxSize` | `Number`（px） |
| Popup 模块顺序 | `moduleOrder` | `Array<string>` |

> 凭证（用户名/密码）以**明文**存于 `chrome.storage.local`，依赖 Chrome 存储沙箱保护。对高安全场景建议后续增加加密层（本版本未做）。

## 扩展新功能

1. **Content 模块**：在 `content/modules/` 新建类继承 `BaseContentModule`，实现 `init()/destroy()`，并在 `manifest.json` 的 content_scripts 与 `content.js` 的 `ContentManager.modules` 中注册。
2. **Popup 模块**：在 `popup/modules/` 新建类继承 `BaseModule`，在 `popup.html` 添加 UI、在 `popup.js` 初始化。
3. 模块开关自动获得三层控制能力（命名遵循 `{module}ModuleEnabled` / `disabled{Module}Sites`）。

## 构建与发布

```bash
npm run build        # 递增版本号（manifest + package.json 同步）→ 生成 dist/GeekToolbox_vX.Y.Z.zip
npm run build:keep   # 不递增版本号，仅重新打包
```

- 版本号**单一来源**：`build.js` 以 `manifest.json` 为准，打包时同步写入 `package.json`，消除两者不一致。
- `scripts/build.js` 的 `EXCLUDES` 已排除 `package.json`、`scripts/` 等，不进入产物。

## 已知设计说明

- **IframePool / LRUCache 为休眠代码**：当前 `MasterGoNav.js` 中 `POOL_MODE = 'tab'` 写死，manifest 也只加载 `TabPool`。若切换到 `iframe` 模式，需手动把 `POOL_MODE` 改为 `'iframe'`，并在 manifest 中将 `TabPool.js` 换成 `LRUCache.js + IframePool.js`、把 `run_at` 改为 `document_start`。后续可改为由 storage 配置驱动，避免隐蔽切换成本。
- **无自动化测试 / lint**：目前为纯手写 JS，CSS 多内联于 `cssText`，可维护性一般，建议后续补 `eslint` 与单元测试。

## 卸载数据抢救

Chrome 卸载扩展时会连同 `chrome.storage.local` 一起清掉，且卸载前没有任何钩子可以执行代码——唯一的出口是 `chrome.runtime.setUninstallURL`（卸载后自动打开的网址，限长 1023 字符）。本扩展用「双保险」保住凭证数据：

1. **全量备份（首选）**：扩展安装期间，每次凭证数据变化（防抖 1.5s），`BackupRescueManager` 会**后台静默打开恢复页**（不激活、不抢焦点），由注入该页的 `shared/restorePageSync.js` 把全量数据写入**抢救页所在域名的 localStorage**（网页存储不属于扩展，卸载不影响），写入完成立即关闭标签。无需手动访问。
2. **URL 兜底（降级）**：`BackupRescueManager` 每次数据变化后重建卸载链接：把数据打包成导出格式 → `lz-string` 压缩 → 拼进抢救页的 `#d=` 哈希。塞不下 1023 字符时按「去 customFields → 丢绑定 → 逐条丢最旧凭证」逐级截断，并在页面标注 `⚠️ 兜底备份`。绑定先于凭证丢弃——绑定只是自动填充的辅助匹配，若放到最后丢，超容量的绑定会把全部凭证连坐挤掉。没有任何凭证时链接只指向抢救页，不嵌入空载荷。

卸载后浏览器打开抢救页（`restore/index.html`），优先读 localStorage 全量备份，读不到再解析链接里的兜底数据，提供**下载 .json / 复制**；拿到的文件即标准导出格式，重装扩展后在弹窗「导入」即可恢复。

- 涉及文件：`shared/backupConfig.js`（配置，含抢救页地址）、`background/managers/BackupRescueManager.js`、`shared/restorePageSync.js`、`restore/`、`lib/lz-string.min.js`。
- **部署**：把 `restore/` 目录发布为静态页（如 GitHub Pages），并把地址写入 `backupConfig.js` 的 `restorePageUrl`；地址的 origin 必须与同步目标一致，否则 localStorage 全量备份不会生效。
- 局限：全量备份依赖用户在扩展安装期间手动访问过一次抢救页；兜底链接受 1023 字符限制，数据量大时只保留部分凭证。
