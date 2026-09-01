/*
 * 恢复页逻辑：读取两处抢救备份并提供下载
 * 1) 本页 localStorage 的全量备份（扩展安装期间访问本页时自动同步，优先）
 * 2) 卸载 URL hash 携带的压缩备份（兜底，受 1023 字符限制，凭证可能被裁剪）
 *
 * 备份口径与扩展内「导出」一致：除凭证数据外，还包含模块隐藏、模块顺序、
 * 各模块开关与站点禁用列表等全部设置（见 ../shared/dataKeys.js）。
 * 本页为应急页，不依赖扩展的任何脚本，故自带一份模块清单用于展示。
 */
(function () {
  var STORAGE_KEY = 'geekToolboxRescueBackup';

  // 与 shared/dataKeys.js 保持一致（仅用于展示，新增模块时同步此处）
  var MODULES = {
    credential: { name: '凭证管理', keys: ['credentialProjects', 'titleProjectBindings', 'urlProjectBindings', 'credentialViewMode', 'suppressNativeAutofill', 'credentialModuleEnabled', 'disabledCredentialSites'] },
    password: { name: '密码显示', keys: ['passwordModuleEnabled', 'disabledPasswordSites'] },
    masterGoNav: { name: 'MasterGo 导航', keys: ['mastergoNavNodes', 'mastergoNavGroups', 'mastergoNavPoolCapacity', 'mastergoNavCollapsed', 'mastergoNavSide', 'mastergoNavTheme', 'masterGoNavModuleEnabled', 'disabledMasterGoNavSites'] },
    timestampFormatter: { name: '时间戳格式化', keys: ['timestampFormatterModuleEnabled', 'disabledTimestampFormatterSites', 'timestampFormatterShowUTC', 'timestampFormatterShowRelative'] },
    imagePreview: { name: '图片预览', keys: ['imagePreviewModuleEnabled', 'disabledImagePreviewSites', 'imagePreviewMaxSize'] },
    qrCodeTool: { name: '二维码工具', keys: ['qrCodeToolModuleEnabled', 'disabledQrCodeToolSites'] },
    global: { name: '全局设置（模块隐藏/顺序）', keys: ['globalDisabledSites', 'moduleOrder', 'hiddenModules'] },
  };

  function isEmpty(v) {
    if (v === undefined || v === null) return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    if (typeof v === 'string') return v === '';
    return false;
  }

  function hasAnyData(data) {
    if (!data) return false;
    return Object.keys(data).some(function (k) { return !isEmpty(data[k]); });
  }

  function moduleHasData(id, data) {
    return MODULES[id].keys.some(function (k) { return !isEmpty(data[k]); });
  }

  function presentModules(data) {
    var out = {};
    Object.keys(MODULES).forEach(function (id) { out[id] = moduleHasData(id, data || {}); });
    return out;
  }

  function countCredentials(projects) {
    return (projects || []).reduce(function (n, p) {
      return n + ((p.credentials || []).length);
    }, 0);
  }

  function readLocalStorageBackup() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var record = JSON.parse(raw);
      if (!record || !record.data || typeof record.data !== 'object') return null;
      if (!hasAnyData(record.data)) return null;
      return {
        source: 'local',
        syncedAt: record.syncedAt || '',
        payload: {
          version: record.version || '',
          exportedAt: record.syncedAt || new Date().toISOString(),
          modules: presentModules(record.data),
          data: record.data,
        },
      };
    } catch (e) { return null; }
  }

  function readUrlBackup() {
    var m = location.hash.match(/^#d=(.+)$/);
    if (!m) return null;
    try {
      var json = LZString.decompressFromEncodedURIComponent(m[1]);
      if (!json) return null;
      var obj = JSON.parse(json);
      if (!obj || !obj.data) return null;
      // 生成链接时无任何数据（凭证与设置都为空）的载荷，视同未携带数据
      if (!hasAnyData(obj.data)) return null;
      if (!obj.modules) obj.modules = presentModules(obj.data);
      return { source: 'url', payload: obj };
    } catch (e) { return null; }
  }

  function fmtTime(iso) {
    if (!iso) return '未知时间';
    try {
      var d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleString();
    } catch (e) { return iso; }
  }

  function showToast(text) {
    var el = document.getElementById('toast');
    el.textContent = text;
    el.classList.add('show');
    setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function downloadJson(obj) {
    var json = JSON.stringify(obj, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'geek_toolbox_rescue_' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function copyJson(obj) {
    var json = JSON.stringify(obj, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(
        function () { showToast('已复制到剪贴板'); },
        function () { fallbackCopy(json); }
      );
    } else {
      fallbackCopy(json);
    }
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('已复制到剪贴板');
    } catch (e) {
      showToast('复制失败，请使用下载按钮');
    }
    document.body.removeChild(ta);
  }

  /** 单个模块的备份摘要；该模块无数据时返回 null */
  function describeModule(id, data) {
    if (!moduleHasData(id, data)) return null;
    var parts = [];

    if (id === 'credential') {
      var projects = data.credentialProjects || [];
      var credCount = countCredentials(projects);
      if (projects.length) parts.push('项目 ' + projects.length + ' 个');
      if (credCount) parts.push('凭证 ' + credCount + ' 条');
      var binds = Object.keys(data.titleProjectBindings || {}).length
        + Object.keys(data.urlProjectBindings || {}).length;
      if (binds) parts.push('页面绑定 ' + binds + ' 条');
      if (!isEmpty(data.credentialViewMode)) parts.push('视图：' + (data.credentialViewMode === 'tab' ? '标签' : '列表'));
      if (data.suppressNativeAutofill !== undefined) parts.push('原生填充提示：' + (data.suppressNativeAutofill ? '已抑制' : '允许'));
      if (data.credentialModuleEnabled !== undefined) parts.push('开关：' + (data.credentialModuleEnabled ? '开' : '关'));
      if (!isEmpty(data.disabledCredentialSites)) parts.push('站点禁用 ' + data.disabledCredentialSites.length + ' 个');
    }

    if (id === 'masterGoNav') {
      var nodes = data.mastergoNavNodes || data.mastergoNavGroups || [];
      if (nodes.length) parts.push('节点 ' + nodes.length + ' 个');
      if (!isEmpty(data.mastergoNavSide)) parts.push('停靠：' + (data.mastergoNavSide === 'right' ? '右' : '左'));
      if (data.mastergoNavCollapsed !== undefined) parts.push('折叠：' + (data.mastergoNavCollapsed ? '是' : '否'));
      if (!isEmpty(data.mastergoNavPoolCapacity)) parts.push('预加载 ' + data.mastergoNavPoolCapacity + ' 个');
      if (data.masterGoNavModuleEnabled !== undefined) parts.push('开关：' + (data.masterGoNavModuleEnabled ? '开' : '关'));
      if (!isEmpty(data.disabledMasterGoNavSites)) parts.push('站点禁用 ' + data.disabledMasterGoNavSites.length + ' 个');
    }

    if (id === 'timestampFormatter') {
      if (data.timestampFormatterModuleEnabled !== undefined) parts.push('开关：' + (data.timestampFormatterModuleEnabled ? '开' : '关'));
      if (data.timestampFormatterShowUTC !== undefined) parts.push('UTC：' + (data.timestampFormatterShowUTC ? '显示' : '隐藏'));
      if (data.timestampFormatterShowRelative !== undefined) parts.push('相对时间：' + (data.timestampFormatterShowRelative ? '显示' : '隐藏'));
      if (!isEmpty(data.disabledTimestampFormatterSites)) parts.push('站点禁用 ' + data.disabledTimestampFormatterSites.length + ' 个');
    }

    if (id === 'imagePreview') {
      if (data.imagePreviewModuleEnabled !== undefined) parts.push('开关：' + (data.imagePreviewModuleEnabled ? '开' : '关'));
      if (!isEmpty(data.imagePreviewMaxSize)) parts.push('阈值 ' + data.imagePreviewMaxSize);
      if (!isEmpty(data.disabledImagePreviewSites)) parts.push('站点禁用 ' + data.disabledImagePreviewSites.length + ' 个');
    }

    if (id === 'password') {
      if (data.passwordModuleEnabled !== undefined) parts.push('开关：' + (data.passwordModuleEnabled ? '开' : '关'));
      if (!isEmpty(data.disabledPasswordSites)) parts.push('站点禁用 ' + data.disabledPasswordSites.length + ' 个');
    }

    if (id === 'qrCodeTool') {
      if (data.qrCodeToolModuleEnabled !== undefined) parts.push('开关：' + (data.qrCodeToolModuleEnabled ? '开' : '关'));
      if (!isEmpty(data.disabledQrCodeToolSites)) parts.push('站点禁用 ' + data.disabledQrCodeToolSites.length + ' 个');
    }

    if (id === 'global') {
      if (!isEmpty(data.hiddenModules)) parts.push('已隐藏模块 ' + data.hiddenModules.length + ' 个');
      if (!isEmpty(data.moduleOrder)) parts.push('模块顺序 ' + data.moduleOrder.length + ' 项');
      if (!isEmpty(data.globalDisabledSites)) parts.push('全局禁用站点 ' + data.globalDisabledSites.length + ' 个');
    }

    if (!parts.length) return null;
    return { name: MODULES[id].name, detail: parts.join(' · ') };
  }

  function renderFound(backup) {
    var statusEl = document.getElementById('status');
    var data = backup.payload.data || {};
    var truncated = !!backup.payload._truncated;
    var summaries = Object.keys(MODULES)
      .map(function (id) { return describeModule(id, data); })
      .filter(Boolean);

    var listHtml = summaries.map(function (s) {
      return '<div class="mod"><span class="mod-name">' + s.name + '</span>'
        + '<span class="mod-detail">' + s.detail + '</span></div>';
    }).join('');

    if (backup.source === 'local') {
      statusEl.className = 'status ok';
      statusEl.innerHTML =
        '<b>✅ 找到完整备份</b>（扩展使用期间自动同步到本机浏览器）<br>' +
        '<span class="kv">同步时间：' + fmtTime(backup.syncedAt) +
        (backup.payload.version ? ' · 扩展版本 v' + backup.payload.version : '') + '</span>' +
        (listHtml ? '<div class="mod-list">' + listHtml + '</div>' : '');
    } else {
      statusEl.className = 'status warn';
      statusEl.innerHTML =
        '<b>⚠️ 找到兜底备份</b>（随卸载链接携带，容量有限' + (truncated ? '，<b>凭证部分已被裁剪，可能不完整</b>' : '') + '）<br>' +
        '<span class="kv">导出时间：' + fmtTime(backup.payload.exportedAt) + '</span>' +
        (listHtml ? '<div class="mod-list">' + listHtml + '</div>' : '') +
        (truncated
          ? '<br><span class="kv">提示：凭证数据超出卸载链接容量上限，仅保留了较新的部分；各模块设置已完整保留。</span>'
          : '');
    }

    document.getElementById('actions').style.display = '';
    document.getElementById('downloadBtn').addEventListener('click', function () {
      downloadJson(backup.payload);
      showToast('备份文件已下载');
    });
    document.getElementById('copyBtn').addEventListener('click', function () {
      copyJson(backup.payload);
    });

    document.getElementById('rawWrap').style.display = '';
    document.getElementById('raw').textContent = JSON.stringify(backup.payload, null, 2);
  }

  function renderEmpty() {
    var statusEl = document.getElementById('status');
    statusEl.className = 'status empty';
    statusEl.innerHTML =
      '<b>未找到备份数据。</b><br>' +
      '可能原因：<br>' +
      '1. 扩展安装期间从未访问过本页面（完整备份需要在安装状态下访问一次本页完成同步）；<br>' +
      '2. 卸载链接未携带有效数据（卸载时扩展内既没有凭证也没有任何设置）。<br>' +
      '<span class="kv">建议：重新安装扩展后，定期使用弹窗右上角的「导出」保存备份文件。</span>';
  }

  function init() {
    var backup = readLocalStorageBackup() || readUrlBackup();
    if (backup) { renderFound(backup); return; }

    // 扩展装着时，content 脚本的 localStorage 写入发生在 document_idle 之后，
    // 可能晚于本页首次读取——短暂轮询等待，避免把"还没写到"误判成"没有备份"
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var b = readLocalStorageBackup();
      if (b) { clearInterval(timer); renderFound(b); }
      else if (tries >= 30) { clearInterval(timer); renderEmpty(); }
    }, 100);

    window.addEventListener('storage', function (e) {
      if (e.key !== STORAGE_KEY) return;
      var b = readLocalStorageBackup();
      if (b) { clearInterval(timer); renderFound(b); }
    });
  }

  init();
})();
