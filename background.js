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
  for (const mgr of managers) {
    if (mgr.canHandle?.(msg)) {
      mgr.handle(msg, sender)
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }
  }
});
