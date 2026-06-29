/*
 * @Author: 林晨 linchen@yixin.im
 * @Date: 2026-06-29 00:00:00
 * @FilePath: /ChromeExt/background/managers/PasswordManager.js
 * @Description: 密码显示/隐藏快捷键管理
 */

class PasswordManager {
  constructor() {
    chrome.commands.onCommand.addListener(cmd => this._onCommand(cmd));
  }

  canHandle() { return false; } // 只监听命令，不处理消息

  async _onCommand(command) {
    if (command !== 'toggle-password') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const key = `passwordVisible_${tab.id}`;
    const result = await chrome.storage.session.get([key]);
    const newState = !(result[key] || false);
    await chrome.storage.session.set({ [key]: newState });
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'togglePassword', show: newState });
    } catch (_) {}
  }
}
