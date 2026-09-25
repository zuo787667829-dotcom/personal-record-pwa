import { voiceConfig } from './voice-config.js';

export function encodeWav(samples, sampleRate = 16000) {
  const data = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(data);
  const str = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, data.byteLength - 8, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data'); view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => { const v = Math.max(-1, Math.min(1, value)); view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true); });
  return new Blob([data], { type: 'audio/wav' });
}

export async function transcribeAudio(blob, signal) {
  if (!voiceConfig.endpoint) throw new Error('云端语音尚未配置，可保存为待转写');
  if (new URL(voiceConfig.endpoint).protocol !== 'https:') throw new Error('语音服务必须使用 HTTPS');
  if (!navigator.onLine) throw new Error('当前离线，可保存录音后重试');
  if (blob.size > 20 * 1024 * 1024) throw new Error('录音过大，暂不支持转写');
  if (!window.confirm('本次录音将发送至腾讯云后端及小米 MiMo 进行转写。是否继续？')) throw new Error('未上传录音，可保存为待转写');
  const token = await voiceConfig.getAccessToken();
  if (!token) throw new Error('请先登录');
  const context = new (window.AudioContext || window.webkitAudioContext)();
  let wav;
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    if (decoded.duration > 120.5 || !decoded.duration) throw new Error('仅支持两分钟以内录音，原录音仍保留');
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    wav = encodeWav((await offline.startRendering()).getChannelData(0));
  } finally { await context.close(); }
  signal?.throwIfAborted();
  const response = await fetch(voiceConfig.endpoint, { method: 'POST', credentials: 'omit', cache: 'no-store', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'audio/wav' }, body: wav, signal });
  const result = await response.json();
  if (response.status === 401) voiceConfig.clearAccessToken();
  if (!response.ok) throw new Error(result.error || '转写失败，请重试');
  if (typeof result.transcript !== 'string' || !result.transcript.trim()) throw new Error('没有识别到文字，请重试');
  return result.transcript;
}
