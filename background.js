// 后台脚本 - 处理快捷键
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-password') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 以 tabId 为 key 读取当前状态
    const key = `passwordVisible_${tab.id}`;
    const result = await chrome.storage.session.get([key]);
    const isVisible = result[key] || false;
    const newState = !isVisible;
    
    // 保存新状态
    await chrome.storage.session.set({ [key]: newState });
    
    // 发送消息给content script
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'togglePassword',
        show: newState
      });
    } catch (error) {
      console.log('无法发送消息到当前页面，可能需要刷新页面');
    }
  }
});
