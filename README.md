# 极客百宝箱 (Geek Toolbox) Chrome 扩展

一个 **Manifest V3** 的模块化浏览器助手，把「密码显示、凭证填充、MasterGo 导航」三套工具整合在一起。代码结构清晰、扩展性强，新增功能只需继承基类并在配置中注册。

> 作者：林晨 · 当前版本：v1.0.3

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
│       └── MasterGoNav.js          # MasterGo 悬浮树状导航（仅 mastergo.com）
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
- 支持 tab / list 双视图、一键从页面采集凭证、导入/导出。

### 3. MasterGo 导航（MasterGoNav + 后台 TabPoolManager）
- 悬浮树状侧边栏，支持暗/亮主题、左/右侧、可折叠。
- 默认 **Tab 池模式**：每个菜单项一个标签页、统一收进 tab 组、LRU 淘汰（`TabPool` + `background/managers/TabPoolManager.js`）。
- 另含一套 **iframe 池模式**代码（`IframePool` + `LRUCache`），目前为休眠状态（见下方「已知设计说明」）。

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
