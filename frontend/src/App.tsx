import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Activity, ArrowDown, ArrowLeft, ArrowRight, Check, ChevronDown, Clock3, Dumbbell, ImagePlus, LoaderCircle, Menu, MessageSquarePlus, MoreHorizontal, PanelRightClose, Plus, Send, Settings2, ShieldCheck, Sparkles, Square, Trash2, Utensils, X } from 'lucide-react';
import { api, streamChat } from './api';
import { RecipeDetail, ResultCard, PlanContent } from './Cards';
import ProfileForm from './ProfileForm';
import type { Card, ChatBody, Conversation, Ingredient, Message, Profile, Services, Task } from './types';
import { emptyProfile } from './types';

type PendingImage = { id: string; url: string; file?: File };
type ActiveRun = { controller: AbortController; requestId: string; userId?: string; assistantId?: string; content: string; cards: Card[]; body: ChatBody; userCreated: boolean };
const LIMIT = 10 * 1024 * 1024;

function normalizeError(error: unknown) {
  if (error instanceof DOMException && error.name === 'AbortError') return '生成已停止，已收到的内容已保留。';
  return error instanceof Error ? error.message : '请求没有完成，请检查网络后重试。';
}
function titleText(value: string) { return value.replace(/[\u0000-\u001f]/g, '').slice(0, 30).trim() || '新对话'; }
function timeLabel(date?: string) {
  if (!date) return '现在';
  const d = new Date(date), now = new Date();
  const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(d);
  return d.toDateString() === now.toDateString() ? time : new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(d);
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState(localStorage.getItem('fit:last') || '');
  const [messages, setMessages] = useState<Message[]>([]);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [draftProfile, setDraftProfile] = useState<Profile>(emptyProfile);
  const [plans, setPlans] = useState<any[]>([]);
  const [services, setServices] = useState<Services | null>(null);
  const [input, setInput] = useState('');
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [selectedTask, setSelectedTask] = useState<Task>('chat');
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [drawer, setDrawer] = useState<'' | 'profile' | 'plans' | 'settings' | 'recipe'>('');
  const [selectedRecipe, setSelectedRecipe] = useState<any>(null);
  const [activeMenu, setActiveMenu] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [online, setOnline] = useState(true);
  const [consent, setConsent] = useState(() => localStorage.getItem('fit:image-consent') === 'accepted');
  const [staleImages, setStaleImages] = useState<string[]>([]);
  const [tailVisible, setTailVisible] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const flash = useCallback((message: string) => { setToast(message); window.setTimeout(() => setToast(''), 3300); }, []);
  const refreshConversations = useCallback(async () => {
    const data = await api<Conversation[]>('/conversations'); setConversations(data);
  }, []);
  const refreshPlans = useCallback(async () => {
    const data = await api<any[]>('/plans'); setPlans(data);
  }, []);
  const appendMessage = useCallback((message: Message) => {
    setMessages(prev => [...prev, message]); void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    let on = true;
    Promise.all([api('/conversations'), api<Profile>('/profile'), api<Services>('/settings/status'), api<any[]>('/plans')]).then(([chats, savedProfile, status, savedPlans]) => {
      if (!on) return;
      setConversations(chats as Conversation[]); setProfile({ ...emptyProfile, ...(savedProfile as Profile) }); setServices(status as Services); setPlans(savedPlans as any[]);
      const items = chats as Conversation[];
      if (!items.length) return createConversation();
      const preferred = localStorage.getItem('fit:last') || conversationId;
      const selected = items.find(x => x.id === preferred) || items[0];
      setConversationId(selected.id); localStorage.setItem('fit:last', selected.id);
      return api<any>(`/conversations/${selected.id}`).then(item => { if (on) { setMessages(item.messages); setProfile({ ...emptyProfile, ...savedProfile, ...item.context.profile }); restoreRetry(item.messages); } });
    }).catch(e => { if (on) setError(normalizeError(e)); });
    return () => { on = false; };
    // Load the last selected session once on startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!tailVisible || drawer || document.visibilityState !== 'visible') return;
    const id = requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }));
    return () => cancelAnimationFrame(id);
  }, [messages, busy, tailVisible, drawer]);

  useEffect(() => {
    localStorage.setItem('fit:last', conversationId);
    return () => { if (pendingImage) URL.revokeObjectURL(pendingImage.url); };
  }, [conversationId, pendingImage]);

  async function createConversation() {
    try { const item = await api<Conversation>('/conversations', { method: 'POST' }); setConversations(c => [item, ...c]); setConversationId(item.id); setMessages([]); setDrawer(''); setSidebar(false); setInput(''); setPendingImage(null); setSelectedTask('chat'); setError(''); setStaleImages([]); failedRunRef.current = null; setProfile({ ...emptyProfile, ...await api<Profile>('/profile') }); localStorage.setItem('fit:last', item.id); }
    catch (e) { setError(normalizeError(e)); }
  }

  async function selectConversation(id: string) {
    if (busy || id === conversationId) { setSidebar(false); return; }
    try { const item = await api<any>(`/conversations/${id}`); setConversationId(id); setMessages(item.messages); setStaleImages([]); setPendingImage(null); setSelectedTask('chat'); setProfile({ ...emptyProfile, ...await api<Profile>('/profile'), ...item.context.profile }); restoreRetry(item.messages); setDrawer(''); setSidebar(false); setActiveMenu(''); setInput(''); setError(''); setTailVisible(true); localStorage.setItem('fit:last', id); }
    catch (e) { flash(normalizeError(e)); }
  }

  function collectFile(file?: File) {
    if (!file || busy) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { flash('请选择 JPG、PNG 或 WebP 图片。'); return; }
    if (file.size <= 0 || file.size > LIMIT) { flash('图片不能超过 10 MB，请压缩后再试。'); return; }
    setPendingImage({ id: '', url: URL.createObjectURL(file), file });
    if (fileRef.current) fileRef.current.value = '';
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find(i => i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile(); if (file) collectFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find(x => x.type.startsWith('image/'));
    if (file) collectFile(file);
  }

  const sendMessage = useCallback(async (text = input, task: Task = 'chat', ingredients?: Ingredient[], planId?: string, profileOverride?: Profile) => {
    if (busy) return;
    if (!conversationId) { flash('正在准备新对话，请稍等。'); return; }
    const clean = text.trim();
    if (!clean && !pendingImage && !ingredients?.length && task === 'chat') { flash('先写一句问题，或添加一张图片。'); inputRef.current?.focus(); return; }
    if (pendingImage && !consent) {
      if (!window.confirm(`图片将通过阿里云 OSS 私有存储并发送给 DeepSeek 分析，最多保留 ${services?.retention_days || 7} 天。身体照片可以遮挡脸部，且不用于直接测算体脂率。是否发送？`)) return;
      localStorage.setItem('fit:image-consent', 'accepted'); setConsent(true);
    }
    const requestId = crypto.randomUUID(), controller = new AbortController();
    abortRef.current = controller; setBusy(true); setError('');
    const body: ChatBody = { conversation_id: conversationId, request_id: requestId, text: clean, task, web_enabled: online };
    let uploadedId = pendingImage?.id;
    if (pendingImage?.file && !uploadedId) {
      setStage('正在上传图片');
      const form = new FormData(); form.set('conversation_id', conversationId); form.set('consent', 'true'); form.set('file', pendingImage.file);
      try {
        const result = await api<{ id: string }>('/images', { method: 'POST', body: form, signal: controller.signal });
        uploadedId = result.id;
      } catch (e) { setError(normalizeError(e)); setBusy(false); setStage(''); abortRef.current = null; return; }
    }
    if (uploadedId) body.image_id = uploadedId;
    if (ingredients) body.ingredients = ingredients;
    if (profileOverride) body.profile = profileOverride;
    if (planId) body.plan_id = planId;
    const user: Message = { id: crypto.randomUUID(), conversation_id: conversationId, request_id: requestId, role: 'user', content: clean, cards: [], image_id: uploadedId || null, status: 'complete', created_at: new Date().toISOString() };
    const assistant: Message = { ...user, id: crypto.randomUUID(), role: 'assistant', content: '', cards: [], image_id: null, status: 'streaming' };
    const run: ActiveRun = { controller, requestId, userId: user.id, assistantId: assistant.id, content: '', cards: [], body, userCreated: true };
    setActiveRun(run); setStage('正在连接模型'); failedRunRef.current = null; setMessages(old => [...old, user, assistant]); setInput(''); setSelectedTask('chat'); setPendingImage(null); setTailVisible(true);
    try {
      await streamChat(body, controller.signal, (name, data) => {
        if (name === 'start') {
          run.assistantId = data.assistant_id;
          setMessages(prev => prev.map(m => m.id === assistant.id ? { ...m, id: data.assistant_id } : m.id === user.id ? data.user : m));
        } else if (name === 'delta') run.content += data.text;
        else if (name === 'status') setStage(data.text);
        else if (name === 'notice') run.content += `\n\n${data.text}\n\n`;
        else if (name === 'card') run.cards.push(data);
        else if (name === 'error') { run.content += `${run.content ? '\n\n' : ''}${data.message}`; setError(data.message); }
        else if (name === 'done') {
          const final = data.message as Message;
          setMessages(prev => prev.map(m => m.id === (run.assistantId || assistant.id) ? final : m));
          if (final.status !== 'complete') failedRunRef.current = run;
        }
        if (['delta', 'card', 'notice'].includes(name)) {
          setMessages(prev => prev.map(m => m.id === (run.assistantId || assistant.id) ? { ...m, content: run.content, cards: [...run.cards], status: 'streaming' } : m));
        }
      });
      await Promise.all([refreshConversations(), refreshPlans()]);
      const refreshed = await api<any>(`/conversations/${conversationId}`); setProfile({ ...emptyProfile, ...refreshed.context.profile });
    } catch (e) {
      const message = normalizeError(e);
      if (controller.signal.aborted) run.content += `${run.content ? '\n\n' : ''}${message}`;
      else setError(message);
      setMessages(prev => prev.map(m => m.id === (run.assistantId || assistant.id) ? { ...m, content: run.content || message, cards: [...run.cards], status: controller.signal.aborted ? 'interrupted' : 'error' } : m));
      setFailedRun(run);
    } finally { if (abortRef.current === controller) abortRef.current = null; setActiveRun(null); setBusy(false); setStage(''); void refreshConversations(); }
  }, [input, pendingImage, conversationId, online, busy, consent, services, flash, refreshConversations, refreshPlans]);

  function setFailedRun(run: ActiveRun) { failedRunRef.current = run; }
  const failedRunRef = useRef<ActiveRun | null>(null);

  function restoreRetry(items: Message[]) {
    failedRunRef.current = null;
    const assistant = [...items].reverse().find(m => m.role === 'assistant');
    if (!assistant || assistant.status === 'complete' || assistant.status === 'streaming') return;
    const user = items.find(m => m.role === 'user' && m.request_id === assistant.request_id);
    const meta = user?.cards.find(c => c.type === 'request_context');
    if (!user || !meta) return;
    const body = { ...meta.request, conversation_id: user.conversation_id, request_id: user.request_id, text: user.content, image_id: user.image_id || undefined } as ChatBody;
    failedRunRef.current = { controller: new AbortController(), requestId: user.request_id, userId: user.id, assistantId: assistant.id, content: assistant.content, cards: assistant.cards, body, userCreated: true };
  }

  function retryMessage() {
    const run = failedRunRef.current;
    if (!run) { flash('没有可以重试的消息。'); return; }
    failedRunRef.current = null;
    void runStreamRetry(run);
  }

  async function runStreamRetry(prior: ActiveRun) {
    const controller = new AbortController(), run: ActiveRun = { ...prior, controller, content: '', cards: [], body: { ...prior.body, retry: true } };
    abortRef.current = controller; setBusy(true); setError(''); setActiveRun(run);
    const assistantId = prior.assistantId!;
    setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, content: '', cards: [], status: 'streaming' } : m));
    try {
      await streamChat(run.body, controller.signal, (name, data) => {
        if (name === 'start') { run.assistantId = data.assistant_id; setMessages(prev => prev.map(m => m.id === assistantId ? { ...m, id: data.assistant_id } : m)); }
        else if (name === 'status') setStage(data.text);
        else if (name === 'notice') run.content += `\n\n${data.text}\n\n`;
        else if (name === 'delta') run.content += data.text;
        else if (name === 'card') run.cards.push(data);
        else if (name === 'error') { run.content += `${run.content ? '\n\n' : ''}${data.message}`; setError(data.message); }
        else if (name === 'done') { setMessages(prev => prev.map(m => m.id === run.assistantId ? data.message : m)); failedRunRef.current = data.message.status === 'complete' ? null : run; }
        if (['delta', 'card', 'notice'].includes(name)) setMessages(prev => prev.map(m => m.id === run.assistantId ? { ...m, content: run.content, cards: [...run.cards], status: 'streaming' } : m));
      });
      await Promise.all([refreshConversations(), refreshPlans()]);
    } catch (e) { setError(normalizeError(e)); failedRunRef.current = run; setMessages(prev => prev.map(m => m.id === run.assistantId ? { ...m, content: run.content || normalizeError(e), cards: [...run.cards], status: controller.signal.aborted ? 'interrupted' : 'error' } : m)); }
    finally { if (abortRef.current === controller) abortRef.current = null; setActiveRun(null); setBusy(false); setStage(''); void refreshConversations(); }
  }

  async function stopGeneration() {
    const controller = abortRef.current;
    setStage('正在停止生成');
    try { await api(`/conversations/${conversationId}/stop`, { method: 'POST' }); }
    catch (e) { flash(normalizeError(e)); }
    finally { controller?.abort(); }
  }

  async function deleteConversation(id: string) {
    if (busy) return;
    if (!window.confirm('删除此对话会同时清理关联照片和会话记忆；已单独保存的计划不受影响。是否继续？')) return;
    setActiveMenu('');
    try { await api(`/conversations/${id}`, { method: 'DELETE' }); const rest = conversations.filter(x => x.id !== id); setConversations(rest); if (conversationId === id) { setConversationId(''); setMessages([]); } flash('对话和会话照片已删除。'); if (!rest.length && conversationId === id) await createConversation(); else if (conversationId === id && rest[0]) await selectConversation(rest[0].id); }
    catch (e) { flash(normalizeError(e)); }
  }

  async function deletePlan(id: string) { if (!window.confirm('删除此计划版本？其他版本会保留。')) return; try { await api(`/plans/${id}`, { method: 'DELETE' }); await refreshPlans(); flash('该计划版本已删除。'); } catch (e) { flash(normalizeError(e)); } }

  async function saveProfile(next: Profile, persistent: boolean) {
    if (!conversationId) throw new Error('请先创建对话。');
    const saved = await api<Profile>(`/conversations/${conversationId}/profile`, { method: 'PUT', body: JSON.stringify(next) });
    if (persistent) await api('/profile', { method: 'PUT', body: JSON.stringify(saved) });
    setProfile(saved); setDraftProfile(saved); flash(persistent ? '个人资料已保存，可用于新对话。' : '个人资料仅用于当前对话。');
  }

  function makePlan(p: Profile) {
    const missing = ['goal', 'experience', 'days_per_week', 'minutes_per_session', 'equipment', 'limitations'].filter(key => !p[key as keyof Profile]);
    if (missing.length) { flash('请先填写目标、训练经验、训练天数、时长、器械和运动限制（无也请填写“无”）。'); return; }
    setProfile(p); setDrawer('');
    void sendMessage('请根据我提供的个人资料，制定一周 7 天的训练和饮食建议。', 'plan', undefined, undefined, p);
  }

  function openProfile() { setDraftProfile({ ...profile }); setDrawer('profile'); }

  function stageBodyImage() { setSelectedTask('body'); setInput('请观察照片中可见的体型特征，并给出一般训练建议。'); fileRef.current?.click(); }

  async function removePendingImage() {
    if (pendingImage?.id) { try { await api(`/images/${pendingImage.id}`, { method: 'DELETE' }); } catch (e) { flash(normalizeError(e)); return; } }
    if (pendingImage) URL.revokeObjectURL(pendingImage.url);
    setPendingImage(null);
  }

  async function deleteStale(id: string) {
    try { await api(`/images/${id}`, { method: 'DELETE' }); setStaleImages(prev => [...new Set([...prev, id])]); setMessages(prev => prev.map(m => m.image_id === id ? { ...m, image_id: null, cards: [...m.cards, { type: 'image_removed', status: 'deleted' }] } : m)); flash('图片已清理。文字分析仍保留。'); }
    catch (e) { flash(normalizeError(e)); }
  }


  function send() { void sendMessage(input, selectedTask); }
  function usePrompt(text: string) { setSelectedTask('chat'); setInput(text); inputRef.current?.focus(); }

  function contentFor(message: Message, index: number) {
    const isAssistant = message.role === 'assistant';
    const imageUrl = message.image_id && !staleImages.includes(message.image_id) ? `/api/images/${message.image_id}/content` : null;
    return <article className={`message ${isAssistant ? 'assistant' : 'user'}`} key={message.id}>
      <div className="message-avatar">{isAssistant ? <Sparkles size={17} /> : <span>我</span>}</div>
      <div className="message-column"><div className="message-meta"><span>{isAssistant ? '轻练' : '你'}</span><time>{timeLabel(message.created_at)}</time>{isAssistant && message.status === 'streaming' && <span className="generating-label"><span className="live-dot" />正在回复</span>}</div>
        <div className={isAssistant ? 'message-body' : 'user-bubble'}>
          {!message.image_id && message.cards.some(c => c.type === 'image_removed') && <div className="expired-photo"><ImagePlus size={18} /><span>图片已过期或删除</span></div>}
          {message.image_id && <div className="message-photo">{imageUrl ? <><img src={imageUrl} alt="用户上传的健身分析照片" onError={() => setStaleImages(p => [...new Set([...p, message.image_id!])])} /><div className="image-toolbar"><button disabled={busy} onClick={() => void deleteStale(message.image_id!)}>删除这张图片</button></div></> : <div className="expired-photo"><ImagePlus size={19} /><span>图片已过期或暂时无法读取</span><button disabled={busy} onClick={() => void deleteStale(message.image_id!)}>清理记录</button></div>}</div>}
          {!!message.content && (isAssistant ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={{a: ({children, href}) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: () => <span>外部图片未加载</span>}}>{message.content}</ReactMarkdown> : <p>{message.content}</p>)}
          {isAssistant && message.status === 'streaming' && <div className="generation-stage"><LoaderCircle size={14} className="spin" />{stage || '正在回复'}</div>}
          {isAssistant && message.cards?.map((card, cardIndex) => <ResultCard key={`${message.id}-${cardIndex}`} card={card} message={message} index={cardIndex} busy={busy} act={(text, task = 'chat', ing, planId) => void sendMessage(text, task, ing, planId)} notify={flash} openProfile={openProfile} showRecipe={r => { setSelectedRecipe(r); setDrawer('recipe'); }} append={appendMessage} saved={() => void refreshPlans()} />)}
          {isAssistant && message.status !== 'complete' && message.status !== 'streaming' && <div className="card-actions"><span className="helper">{message.status === 'interrupted' ? '已停止，之前的回答仍然保留。' : '这次没有完成，之前的回答仍然保留。'}</span>{failedRunRef.current?.assistantId === message.id && <button className="text-button" onClick={retryMessage}>重试此回复</button>}</div>}
        </div>
      </div>
    </article>;
  }

  function groupMessages(list: Message[]) {
    const items: Array<{ type: 'date'; label: string; key: string } | { type: 'message'; message: Message; index: number }> = [];
    let lastDay = '';
    list.forEach((message, index) => { const d = new Date(message.created_at || Date.now()); const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; if (key !== lastDay) { const now = new Date(); const same = d.toDateString() === now.toDateString(); items.push({ type: 'date', label: same ? '今天的灵感' : d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }), key: key + index }); lastDay = key; } items.push({ type: 'message', message, index }); });
    return items;
  }

  const activeConversation = conversations.find(c => c.id === conversationId);

  return <div className="app-shell" onDrop={handleDrop} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}>
    <aside className={`sidebar ${sidebar ? 'sidebar-open' : ''}`}>
      <div className="sidebar-top"><a className="brand" href="#" onClick={e => e.preventDefault()}><span className="brand-symbol"><Activity size={21} strokeWidth={2.5} /></span><span><strong>轻练</strong><small>MOVE A LITTLE BETTER</small></span></a><button className="icon-button mobile-only" aria-label="关闭菜单" onClick={() => setSidebar(false)}><X size={19} /></button></div>
      <button className="new-chat" onClick={() => void createConversation()} disabled={busy}><MessageSquarePlus size={17} />开始一段新对话<Plus size={16} className="new-chat-plus" /></button>
      <div className="sidebar-section-label">最近的对话<span>{conversations.length}</span></div>
      <div className="conversation-list">{conversations.map(item => <div key={item.id} className={`conversation-item ${item.id === conversationId ? 'selected' : ''}`}>
        <button className="conversation-select" onClick={() => void selectConversation(item.id)} disabled={busy}><span className="conversation-dot" /><span className="conversation-name">{titleText(item.title)}</span></button>
        <button className="icon-button conversation-menu-btn" aria-label={`对话 ${item.title} 菜单`} onClick={() => setActiveMenu(activeMenu === item.id ? '' : item.id)} disabled={busy}><MoreHorizontal size={17} /></button>
        {activeMenu === item.id && <div className="popover chat-popover"><button onClick={() => { const n = window.prompt('给这段对话取个名字', item.title); if (n) void api(`/conversations/${item.id}`, { method: 'PATCH', body: JSON.stringify({ title: n.slice(0, 80) }) }).then(refreshConversations).catch(e => flash(normalizeError(e))); setActiveMenu(''); }}><Settings2 size={14} />重命名</button><button className="danger-text" onClick={() => void deleteConversation(item.id)}><Trash2 size={14} />删除对话</button></div>}
      </div>)}
      {conversations.length === 0 && <p className="sidebar-empty">一段新对话，等你开始。</p>}</div>
      <div className="sidebar-bottom"><button className={`sidebar-action ${drawer === 'plans' ? 'active' : ''}`} onClick={() => { void refreshPlans(); setDrawer(drawer === 'plans' ? '' : 'plans'); setSidebar(false); }}><Dumbbell size={17} /><span>我的训练计划</span>{plans.length > 0 && <span className="side-count">{plans.length}</span>}</button><button className="sidebar-action" onClick={openProfile}><Settings2 size={17} /><span>个人资料</span><ArrowRight className="side-arrow" size={15} /></button>
        <div className="sidebar-user"><span className="avatar">L</span><span><strong>你的健身空间</strong><small>{services?.model ? `${services.model_name} · AI 助手已连接` : '配置 DeepSeek 后即可生成建议'}</small></span><button className="icon-button" aria-label="设置与隐私" onClick={() => setDrawer('settings')}><MoreHorizontal size={17} /></button></div></div>
    </aside>
    {sidebar && <button className="sidebar-backdrop" aria-label="关闭菜单" onClick={() => setSidebar(false)} />}

    <main className="workspace"><header className="topbar"><div className="topbar-left"><button className="icon-button mobile-only" aria-label="打开菜单" onClick={() => setSidebar(true)}><Menu size={19} /></button><div className="breadcrumb"><span>你的空间</span><span className="crumb-divider">/</span><strong>{titleText(activeConversation?.title || '新对话')}</strong></div></div><div className="topbar-right"><button className={`privacy-chip ${online ? 'network-on' : ''}`} onClick={() => setOnline(!online)} title={online ? '联网搜索已开启' : '联网搜索已关闭'}><span className="network-dot" />{online ? '联网搜索' : '仅用模型'}<ChevronDown size={13} /></button><button className="icon-button top-icon" aria-label="个人资料" onClick={openProfile}><Settings2 size={17} /></button><span className="header-avatar">L</span></div></header>
      <section className={`chat-area ${messages.length ? 'has-messages' : 'welcome-area'}`} ref={scrollRef} onScroll={() => { const el = scrollRef.current; if (el) setTailVisible(el.scrollHeight - el.scrollTop - el.clientHeight < 180); }}>
        {messages.length === 0 ? <div className="welcome-content">
          <div className="welcome-mark"><Activity size={25} /></div><span className="eyebrow welcome-label">YOUR DAILY WELLNESS COMPANION</span>
          <h1>你好，准备好<br /><span>轻松动起来了吗？</span></h1><p className="welcome-copy">从一顿饭开始，或给本周计划加一点灵感。</p>
          <div className="quick-grid"><button className="quick-card" onClick={() => usePrompt('请识别我上传的食材，并询问我是否确认份量。')}><span className="quick-icon green"><ImagePlus size={18} /></span><span><strong>拍照认识食材</strong><small>看看这顿饭的营养搭配</small></span><ArrowRight size={16} /></button><button className="quick-card" onClick={() => usePrompt('根据我现有的食材，搜索适合我健身目标的菜谱。')}><span className="quick-icon amber"><Utensils size={18} /></span><span><strong>找一道合适的菜</strong><small>联网搜索真实菜谱来源</small></span><ArrowRight size={16} /></button><button className="quick-card" onClick={stageBodyImage}><span className="quick-icon blue"><ImagePlus size={18} /></span><span><strong>观察身体外观</strong><small>不由照片测算体脂率</small></span><ArrowRight size={16} /></button><button className="quick-card" onClick={() => openProfile()}><span className="quick-icon violet"><Dumbbell size={18} /></span><span><strong>做一份本周计划</strong><small>按你的时间与设备安排</small></span><ArrowRight size={16} /></button></div>
          <div className="welcome-note"><ShieldCheck size={15} /><span>重视你的隐私，也会如实标注营养估算的不确定性</span></div>
        </div> : <div className="message-feed">{groupMessages(messages).map((item, index) => item.type === 'date' ? <div className="date-divider" key={item.key}><span />{item.label}<span /></div> : contentFor(item.message, item.index))}{busy && activeRun && !messages.some(m => m.id === activeRun.assistantId && m.status === 'streaming') && <div className="typing-indicator"><LoaderCircle size={16} className="spin" />正在整理你的问题…</div>}<div ref={bottomRef} /></div>}
        {!tailVisible && messages.length > 0 && <button className="scroll-down" aria-label="回到最新内容" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}><ArrowDown size={17} /></button>}
      </section>
      <div className="composer-region">
        {error && <div className="error-banner" role="alert"><span><ShieldCheck size={15} />{error}</span><button onClick={() => setError('')} aria-label="关闭错误提示"><X size={15} /></button></div>}
        <div className={`composer ${pendingImage ? 'has-attachment' : ''}`}>
          {pendingImage && <div className="attachment"><img src={pendingImage.url} alt="待发送图片预览" /><span><Check size={12} />{pendingImage.id ? '图片已安全上传' : '图片已选中'}</span><button className="icon-button" aria-label="移除附件" onClick={() => void removePendingImage()}><X size={15} /></button></div>}
          <textarea ref={inputRef} value={input} rows={1} maxLength={8000} placeholder="说说你今天的饮食或运动计划…" onChange={e => { setInput(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 150)}px`; }} onPaste={handlePaste} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} aria-label="给轻练发送消息" />
          <div className="composer-bottom"><div className="composer-tools"><button className="attach-button" disabled={busy} onClick={() => fileRef.current?.click()}><ImagePlus size={17} /><span>添加图片</span></button><span className="tool-divider" /><button className="composer-mode" disabled={busy} onClick={() => setOnline(!online)}><span className={online ? 'mode-dot active' : 'mode-dot'} />{online ? '联网搜索' : '仅用模型'}</button>{pendingImage && <span className="upload-helper">图片私有保存 · 最多 {services?.retention_days || 7} 天</span>}</div>
            <div className="composer-send"><span className="enter-hint">Enter 发送 · Shift + Enter 换行</span>{busy ? <button className="send-button stop-button" aria-label="停止生成" onClick={stopGeneration}><Square size={15} fill="currentColor" /></button> : <button className="send-button" disabled={!input.trim() && !pendingImage} aria-label="发送消息" onClick={send}><Send size={16} /></button>}</div></div>
          <input ref={fileRef} type="file" className="sr-only" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => collectFile(e.target.files?.[0])} />
        </div><p className="composer-footnote"><ShieldCheck size={12} />轻练会标注参考和估算，也会遵循你的运动限制。AI 建议不能代替专业医疗意见。</p>
      </div>
    </main>

    {drawer && <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setDrawer(''); }}><aside className={`drawer drawer-${drawer}`}><header className="drawer-header">{drawer === 'profile' ? <><span className="drawer-symbol"><Settings2 size={18} /></span><span>个人资料与训练偏好</span></> : drawer === 'plans' ? <><span className="drawer-symbol"><Dumbbell size={18} /></span><span>我的训练计划</span></> : drawer === 'settings' ? <><span className="drawer-symbol"><ShieldCheck size={18} /></span><span>设置与隐私</span></> : <><span className="drawer-symbol"><Utensils size={18} /></span><span>菜谱详情</span></>}<button className="icon-button" aria-label="关闭面板" onClick={() => setDrawer('')}><PanelRightClose size={19} /></button></header>
        {drawer === 'profile' && <ProfileForm initial={draftProfile} save={saveProfile} generate={makePlan} busy={busy} />}
        {drawer === 'recipe' && selectedRecipe && <RecipeDetail recipe={selectedRecipe} act={text => { setDrawer(''); void sendMessage(text, 'chat'); }} />}
        {drawer === 'plans' && <div className="saved-plans">{plans.length === 0 ? <div className="drawer-empty"><div className="welcome-mark"><Dumbbell size={22} /></div><h3>计划还在路上</h3><p>告诉我你的训练目标，我们一起安排。</p><button className="button primary" onClick={() => { openProfile(); }}>制定我的第一份计划</button></div> : plans.map(p => <article className="saved-plan-card" key={p.id}><div className="between"><span className="eyebrow">第 {p.version} 版计划</span><button className="icon-button danger-icon" aria-label="删除计划" onClick={() => void deletePlan(p.id)}><Trash2 size={15} /></button></div><h3>{p.data.title}</h3><PlanContent plan={p.data} /><button className="text-button" disabled={busy} onClick={() => { setDrawer(''); void sendMessage(`我想调整计划“${p.data.title}”，请先问我需要修改哪些地方。`, 'chat', undefined, p.id); }}>在对话中调整<ArrowRight size={15} /></button></article>)}</div>}
        {drawer === 'settings' && <div className="settings-panel"><div className="settings-heading"><span className="eyebrow">SERVICE STATUS</span><h2>连接与隐私</h2><p>服务状态仅显示是否已配置，不会展示任何 API Key（接口密钥）。</p></div><div className="service-status">{[["DeepSeek 模型", services?.model, services?.model_name], ["DeepSeek 图片识别", services?.vision, services?.vision ? '已开启' : '未开启'], ["Tavily 联网搜索", services?.search, services?.search ? '可搜索食谱' : '未配置'], ["阿里云 OSS 存储", services?.storage, services?.storage ? `图片保留 ${services.retention_days} 天` : '未配置']].map(([label, ready, sub]) => <div className="service-item" key={label as string}><span className="service-indicator"><span className={ready ? 'service-dot ready' : 'service-dot'} /></span><span><strong>{label}</strong><small>{sub as string}</small></span><span className={`status-tag ${ready ? '' : 'off'}`}>{ready ? '已配置' : '未配置'}</span></div>)}</div>
          <div className="privacy-card"><ShieldCheck size={18} /><div><strong>图片私有存储</strong><p>发送照片后，经后端安全存储和处理。过期图片显示占位，保留的文字分析不受影响。</p></div></div>
          <div className="privacy-card"><ShieldCheck size={18} /><div><strong>对话和计划由你管理</strong><p>删除对话将同时尝试清理该会话的图片和记忆；单独保存的训练计划可在「我的训练计划」中删除。</p></div></div>
          <button className="button secondary full-width" onClick={() => { setDrawer('plans'); void refreshPlans(); }}>查看已保存的训练计划<ArrowRight size={15} /></button><div className="config-hint"><strong>首次启动需要设置服务配置</strong><p>请由开发者在 `ai-fitness-assistant/.env` 中配置服务密钥；网页不会收集或显示密钥。</p></div></div>}
      </aside></div>}

    {toast && <div className="toast" role="status"><Check size={16} />{toast}</div>}
  </div>;
}
