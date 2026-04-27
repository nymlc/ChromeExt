# 密码查看助手 Chrome 扩展

一个帮助用户查看和管理网页密码框的 Chrome 扩展程序。

## 项目结构

```
ChromeExt/
├── content/                    # Content Scripts
│   ├── modules/
│   │   ├── BaseModule.js      # Content 模块基类
│   │   └── PasswordHelper.js  # 密码功能模块
│   └── content.js             # Content 主入口
├── popup/                      # Popup 界面
│   ├── modules/
│   │   ├── BaseModule.js      # Popup 模块基类
│   │   └── PasswordToggle.js  # 密码切换模块
│   ├── utils/
│   │   └── Toast.js           # Toast 提示工具
│   ├── popup.html             # Popup HTML
│   ├── popup.css              # Popup 样式
│   └── popup.js               # Popup 主入口
├── icons/                      # 图标资源
├── background.js               # 后台脚本(快捷键)
└── manifest.json               # 扩展配置文件
```

## 核心功能

### 1. 密码显示功能
- 为所有密码框添加眼睛图标
- 点击图标或双击密码框切换显示/隐藏
- 支持动态添加的密码框

### 2. 三层控制系统

#### 全局扩展开关
- 控制整个扩展在某个网站是否启用
- 存储键: `globalDisabledSites`

#### 模块全局开关
- 控制某个功能模块是否全局启用
- 存储键: `{moduleName}ModuleEnabled` (如 `passwordModuleEnabled`)

#### 网站级开关
- 控制某个功能在特定网站是否启用
- 存储键: `disabled{ModuleName}Sites` (如 `disabledPasswordSites`)

### 3. 实时启用/禁用
- 所有开关切换立即生效,无需刷新页面
- 通过 `chrome.storage.onChanged` 监听实现

## 技术特点

### 模块化架构
- 每个功能独立成模块
- 基类提供通用功能(启用/禁用、存储管理)
- 子类只需关注业务逻辑

### Content Script 架构
```javascript
ContentManager (content.js)
  ├── 监听存储变化
  ├── 管理模块生命周期
  └── 模块实例
      └── PasswordHelper (继承 BaseContentModule)
          ├── checkModuleEnabled() - 三层检查
          ├── init() - 初始化
          └── destroy() - 清理
```

### Popup 架构
```javascript
PopupManager (popup.js)
  ├── 全局设置管理
  └── 模块实例
      └── PasswordToggle (继承 BaseModule)
          ├── initModuleStatus() - 读取状态
          ├── toggleModuleEnabled() - 模块开关
          └── toggleSiteEnabled() - 网站开关
```

## 扩展新功能

### 1. 创建 Content 模块
```javascript
// content/modules/AutoFill.js
class AutoFill extends BaseContentModule {
  constructor() {
    super('autoFill'); // 模块名
  }
  
  async init() {
    const enabled = await this.checkModuleEnabled();
    if (!enabled) return;
    // 业务逻辑...
  }
  
  destroy() {
    // 清理逻辑...
  }
}
```

### 2. 创建 Popup 模块
```javascript
// popup/modules/AutoFillToggle.js
class AutoFillToggle extends BaseModule {
  constructor() {
    super('autoFill');
  }
  
  async init() {
    await this.initModuleStatus();
    // UI 绑定...
  }
}
```

### 3. 更新配置文件
- 在 `manifest.json` 中添加脚本引用
- 在 `popup.html` 中添加 UI 模块
- 在 `content.js` 和 `popup.js` 中初始化模块

## 存储键约定

| 功能 | 存储键 | 类型 | 说明 |
|------|--------|------|------|
| 全局禁用网站 | `globalDisabledSites` | Array | 禁用所有功能的网站列表 |
| 模块全局启用 | `{module}ModuleEnabled` | Boolean | 模块是否全局启用 |
| 模块网站禁用 | `disabled{Module}Sites` | Array | 禁用该模块的网站列表 |
| 密码显示状态 | `passwordVisible` | Boolean | 密码是否显示 |

## 开发指南

### 命名规范
- 模块名: 小驼峰 (如 `password`, `autoFill`)
- 类名: 大驼峰 (如 `PasswordHelper`, `AutoFillToggle`)
- 存储键: 遵循约定格式

### 代码规范
- 使用 ES6 类语法
- 继承基类复用通用功能
- 注释清晰,说明功能用途

## 版本
v1.0.0
