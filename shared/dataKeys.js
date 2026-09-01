/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-09-01
 * @FilePath: /ChromeExt/shared/dataKeys.js
 * @Description: 数据键位单一来源
 *   导出 / 导入 / 卸载抢救三处共用同一份「模块 → storage key」映射，
 *   避免新增模块设置后某一处漏登记（历史上抢救只备份了凭证，丢了模块隐藏与全部模块设置）。
 *   新增设置项时：在这里对应模块的 keys 里加一行即可，三处同步生效。
 */

(function (global) {
  // 模块 → 展示名 + 该模块用到的全部 storage key
  var GEEK_DATA_KEYS = {
    credential: {
      name: '凭证管理',
      keys: [
        'credentialProjects',
        'titleProjectBindings',
        'urlProjectBindings',
        'credentialViewMode',
        'suppressNativeAutofill',
        'credentialModuleEnabled',
        'disabledCredentialSites',
      ],
    },
    password: {
      name: '密码显示',
      keys: [
        'passwordModuleEnabled',
        'disabledPasswordSites',
      ],
    },
    masterGoNav: {
      name: 'MasterGo 导航',
      keys: [
        'mastergoNavNodes',
        'mastergoNavGroups',
        'mastergoNavPoolCapacity',
        'mastergoNavCollapsed',
        'mastergoNavSide',
        'mastergoNavTheme',
        'masterGoNavModuleEnabled',
        'disabledMasterGoNavSites',
      ],
    },
    timestampFormatter: {
      name: '时间戳格式化',
      keys: [
        'timestampFormatterModuleEnabled',
        'disabledTimestampFormatterSites',
        'timestampFormatterShowUTC',
        'timestampFormatterShowRelative',
      ],
    },
    imagePreview: {
      name: '图片预览',
      keys: [
        'imagePreviewModuleEnabled',
        'disabledImagePreviewSites',
        'imagePreviewMaxSize',
      ],
    },
    qrCodeTool: {
      name: '二维码工具',
      keys: [
        'qrCodeToolModuleEnabled',
        'disabledQrCodeToolSites',
      ],
    },
    global: {
      name: '全局设置（模块隐藏/顺序）',
      keys: [
        'globalDisabledSites',
        'moduleOrder',
        'hiddenModules',
      ],
    },
  };

  // 凭证体量最大的三个键：卸载链接容量不足时只有它们参与裁剪
  var CREDENTIAL_KEYS = ['credentialProjects', 'titleProjectBindings', 'urlProjectBindings'];

  // 全部键（去重，保持模块顺序）
  var ALL_KEYS = [];
  Object.keys(GEEK_DATA_KEYS).forEach(function (id) {
    GEEK_DATA_KEYS[id].keys.forEach(function (k) {
      if (ALL_KEYS.indexOf(k) === -1) ALL_KEYS.push(k);
    });
  });

  function isEmptyValue(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    if (typeof v === 'string') return v === '';
    return false;
  }

  /** 某个模块在给定数据里是否有实质内容 */
  function moduleHasData(moduleId, data) {
    var mod = GEEK_DATA_KEYS[moduleId];
    if (!mod || !data) return false;
    return mod.keys.some(function (k) { return !isEmptyValue(data[k]); });
  }

  /** 数据里实际携带了哪些模块（与导出文件的 modules 字段同构，导入对话框据此勾选） */
  function presentModules(data) {
    var out = {};
    Object.keys(GEEK_DATA_KEYS).forEach(function (id) {
      out[id] = moduleHasData(id, data || {});
    });
    return out;
  }

  function hasAnyData(data) {
    if (!data) return false;
    return ALL_KEYS.some(function (k) { return !isEmptyValue(data[k]); });
  }

  function countCredentials(projects) {
    return (projects || []).reduce(function (n, p) {
      return n + ((p.credentials || []).length);
    }, 0);
  }

  global.GEEK_DATA_KEYS = GEEK_DATA_KEYS;
  global.GEEK_ALL_DATA_KEYS = ALL_KEYS;
  global.GEEK_CREDENTIAL_KEYS = CREDENTIAL_KEYS;
  global.GEEK_DATA_UTILS = {
    isEmptyValue: isEmptyValue,
    moduleHasData: moduleHasData,
    presentModules: presentModules,
    hasAnyData: hasAnyData,
    countCredentials: countCredentials,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
