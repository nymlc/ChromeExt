/*
 * 恢复页逻辑：读取两处抢救备份并提供下载
 * 1) 本页 localStorage 的全量备份（扩展安装期间访问本页时自动同步，优先）
 * 2) 卸载 URL hash 携带的压缩备份（兜底，受 1023 字符限制可能被裁剪）
 */
(function () {
  var STORAGE_KEY = 'geekToolboxRescueBackup';

  function readLocalStorageBackup() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var record = JSON.parse(raw);
      if (!record || !record.data || typeof record.data !== 'object') return null;
      var hasContent = (record.data.credentialProjects || []).length > 0
        || Object.keys(record.data.titleProjectBindings || {}).length > 0
        || Object.keys(record.data.urlProjectBindings || {}).length > 0;
      if (!hasContent) return null;
      return {
        source: 'local',
        syncedAt: record.syncedAt || '',
        payload: {
          version: record.version || '',
          exportedAt: record.syncedAt || new Date().toISOString(),
          modules: { credential: true },
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
      return { source: 'url', payload: obj };
    } catch (e) { return null; }
  }

  function countCredentials(projects) {
    return (projects || []).reduce(function (n, p) {
      return n + ((p.credentials || []).length);
    }, 0);
  }

  function fmtTime(iso) {
    if (!iso) return '未知时间';
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
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

  function renderFound(backup) {
    var statusEl = document.getElementById('status');
    var data = backup.payload.data || {};
    var projects = data.credentialProjects || [];
    var credCount = countCredentials(projects);
    var truncated = !!backup.payload._truncated;

    if (backup.source === 'local') {
      statusEl.className = 'status ok';
      statusEl.innerHTML =
        '<b>✅ 找到完整备份</b>（扩展使用期间自动同步到本机浏览器）<br>' +
        '<span class="kv">同步时间：' + fmtTime(backup.syncedAt) +
        ' · 项目 ' + projects.length + ' 个 · 凭证 ' + credCount + ' 条' +
        (backup.payload.version ? ' · 扩展版本 v' + backup.payload.version : '') + '</span>';
    } else {
      statusEl.className = 'status warn';
      statusEl.innerHTML =
        '<b>⚠️ 找到兜底备份</b>（随卸载链接携带，容量有限' + (truncated ? '，<b>已被裁剪，可能不完整</b>' : '') + '）<br>' +
        '<span class="kv">导出时间：' + fmtTime(backup.payload.exportedAt) +
        ' · 项目 ' + projects.length + ' 个 · 凭证 ' + (backup.payload._credentialCount != null ? backup.payload._credentialCount : credCount) + ' 条</span>' +
        (truncated ? '<br><span class="kv">提示：数据量超出卸载链接容量上限，仅保留了较新的部分凭证。</span>' : '');
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
      '2. 卸载链接未携带数据（扩展内没有任何凭证数据）。<br>' +
      '<span class="kv">建议：重新安装扩展后，定期使用弹窗右上角的「导出」保存备份文件。</span>';
  }

  function init() {
    var backup = readLocalStorageBackup() || readUrlBackup();
    if (backup) renderFound(backup);
    else renderEmpty();
  }

  init();
})();
