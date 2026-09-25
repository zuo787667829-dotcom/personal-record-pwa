// Public configuration only. NEVER put API keys or database passwords here.
let personalCode = '';
export const voiceConfig = {
  endpoint: "",
  // Personal trial: separate capability code, never the MiMo API key.
  // Memory only; closing/reloading the page clears it. No account needed.
  async getAccessToken() {
    if (!personalCode) {
      const value = window.prompt('请输入你自己的语音访问码（不是 MiMo API Key）。本次打开期间记住，关闭页面后清除。');
      if (!value) throw new Error('未填写访问码，录音可保存后重试');
      if (!/^[a-f0-9]{48}$/.test(value.trim())) throw new Error('请填写配置工具生成的 48 位语音访问码，不要填写 MiMo 密钥');
      personalCode = value.trim();
    }
    return personalCode;
  },
  clearAccessToken() { personalCode = ''; }
};
