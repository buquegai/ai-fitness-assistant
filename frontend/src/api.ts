export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const message = Array.isArray(data.detail) ? '填写的信息不符合要求，请检查数值和必填项。' : data.detail;
    throw new Error(message || `请求失败（${response.status}）`);
  }
  return response.json();
}

export async function streamChat(body: object, signal: AbortSignal, onEvent: (event: string, data: any) => void) {
  const response = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : '消息发送失败，请检查输入后重试。');
  }
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '', doneEvent = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = block.split('\n');
        const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || 'message';
        const payload = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (payload) { onEvent(event, JSON.parse(payload)); if (event === 'done') doneEvent = true; }
      }
      if (done) break;
    }
    if (!doneEvent) throw new Error('连接中断，已生成内容会保留。请重试本次回复。');
  } finally { reader.releaseLock(); }
}
