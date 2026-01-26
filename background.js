// 后台脚本 - 处理快捷键
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-password') {
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 获取当前状态
    const result = await chrome.storage.local.get(['passwordVisible']);
    const isVisible = result.passwordVisible || false;
    const newState = !isVisible;
    
    // 保存新状态
    await chrome.storage.local.set({ passwordVisible: newState });
    
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
