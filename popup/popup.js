// 功能模块管理
const FeatureManager = {
  // 密码显示功能
  passwordToggle: {
    isVisible: false,
    
    async init() {
      // 从存储中读取状态
      const result = await chrome.storage.local.get(['passwordVisible']);
      this.isVisible = result.passwordVisible || false;
      this.updateUI();
    },
    
    async toggle() {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // 检查是否是特殊页面（chrome://、edge://等）
      if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('about:')) {
        alert('此页面不支持密码查看功能');
        return;
      }
      
      this.isVisible = !this.isVisible;
      
      // 保存状态
      await chrome.storage.local.set({ passwordVisible: this.isVisible });
      
      // 发送消息给content script
      try {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'togglePassword',
          show: this.isVisible
        });
      } catch (error) {
        console.log('无法连接到页面，可能需要刷新页面');
        // 即使发送失败也更新UI，因为状态已保存，刷新后会生效
      }
      
      this.updateUI();
    },
    
    updateUI() {
      const toggleText = document.getElementById('toggleText');
      toggleText.textContent = this.isVisible ? '隐藏所有密码' : '显示所有密码';
    }
  },
  
  // 未来可以在这里添加更多功能模块
  // 例如：
  // autoFill: { ... },
  // passwordGenerator: { ... }
};

// 在页面中切换密码显示的函数
function togglePasswordVisibility(shouldShow) {
  const passwordInputs = document.querySelectorAll('input[type="password"], input[type="text"][data-password-toggle]');
  
  passwordInputs.forEach(input => {
    if (shouldShow) {
      if (input.type === 'password') {
        input.type = 'text';
        input.setAttribute('data-password-toggle', 'true');
      }
    } else {
      if (input.getAttribute('data-password-toggle') === 'true') {
        input.type = 'password';
        input.removeAttribute('data-password-toggle');
      }
    }
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  await FeatureManager.passwordToggle.init();
  
  const toggleButton = document.getElementById('togglePassword');
  
  toggleButton.addEventListener('click', () => {
    FeatureManager.passwordToggle.toggle();
  });
});
