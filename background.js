/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-29 00:00:00
 * @FilePath: /ChromeExt/background.js
 * @Description: 后台入口 - 加载各功能模块，统一路由消息
 *               新增功能：在 background/managers/ 下新建 Manager 类，加入 managers 数组即可
 */

importScripts(
  'background/managers/PasswordManager.js',
  'background/managers/TabPoolManager.js',
);

const managers = [
  new PasswordManager(),
  new TabPoolManager(),
];

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 二维码整页扫描：按 URL 由后台抓取图片字节并转 data URL（绕过页面 CORS）
  if (msg && msg.type === 'qr-fetch-image') {
    (async () => {
      try {
        // 默认 omit：普通公开图片（CDN 返回 ACAO:*）可被正常抓取。
        // 若失败（如需要登录态的同源图片），再带 cookie 重试一次。
        // 注意：跨域 + include + ACAO:* 会被浏览器拦截，所以 include 仅作为兜底，不能作为默认。
        let resp = await fetch(msg.url, { credentials: 'omit', cache: 'force-cache' });
        if (!resp.ok) {
          resp = await fetch(msg.url, { credentials: 'include', cache: 'force-cache' });
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(fr.result);
          fr.onerror = () => reject(fr.error || new Error('readAsDataURL failed'));
          fr.readAsDataURL(blob);
        });
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }
  // 二维码：抓取 .svg 文本（需解析尺寸后栅格化，故返回文本而非 data URL）
  if (msg && msg.type === 'qr-fetch-text') {
    (async () => {
      try {
        let resp = await fetch(msg.url, { credentials: 'omit', cache: 'force-cache' });
        if (!resp.ok) {
          resp = await fetch(msg.url, { credentials: 'include', cache: 'force-cache' });
        }
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const text = await resp.text();
        sendResponse({ ok: true, text });
      } catch (e) {
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    })();
    return true;
  }
  for (const mgr of managers) {
    if (mgr.canHandle?.(msg)) {
      mgr.handle(msg, sender)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }
});

// ───────── 二维码右键菜单 ─────────
if (chrome.contextMenus) {
  const ensureMenus = () => {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({ id: 'qr-generate', title: '为选中文本生成二维码', contexts: ['selection'] });
      // 统一的「解码二维码」：既挂在 image（<img> 二维码右键）也挂在 page（背景图/Canvas 二维码，整页右键也行）
      chrome.contextMenus.create({
        id: 'qr-decode',
        title: '解码二维码',
        contexts: ['image', 'page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      });
    });
  };
  // 每次 SW 启动都确保菜单存在（onInstalled 在某些情况下可能不触发，导致菜单丢失）
  ensureMenus();
  chrome.runtime.onInstalled.addListener(ensureMenus);

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || tab.id == null) return;
    if (info.menuItemId === 'qr-generate') {
      chrome.tabs.sendMessage(tab.id, { type: 'qr-generate', text: info.selectionText || '' });
    } else if (info.menuItemId === 'qr-decode') {
      const tabId = tab.id;
      // 由 content 脚本根据右键目标元素完成解码：
      // 有 srcUrl（<img> 右键）走 qr-decode-image；否则（背景图/Canvas）走 qr-decode-page。
      // 实际抓取图片字节由 content 通过 qr-fetch-image 请求后台完成（带 host 权限 + cookie）。
      if (info.srcUrl) {
        chrome.tabs.sendMessage(tabId, { type: 'qr-decode-image', srcUrl: info.srcUrl });
      } else {
        chrome.tabs.sendMessage(tabId, { type: 'qr-decode-page' });
      }
    }
  });
}

