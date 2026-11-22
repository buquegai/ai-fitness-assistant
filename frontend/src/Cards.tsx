import { useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, Clipboard, Clock3, Dumbbell, ExternalLink, Plus, Save, SlidersHorizontal, Trash2, Utensils, WandSparkles } from 'lucide-react';
import { api } from './api';
import type { Card, Ingredient, Message, Task } from './types';

type Props = { card: Card; message: Message; index: number; busy: boolean;
  act: (text: string, task?: Task, ingredients?: Ingredient[], planId?: string) => void;
  notify: (text: string) => void; openProfile: () => void; showRecipe: (recipe: any) => void;
  append: (message: Message) => void; saved: () => void };

function safeLink(url: string | null | undefined) {
  try { const parsed = new URL(url || ''); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; }
}

export function SourceLink({ url, label = '查看来源' }: { url?: string; label?: string }) {
  const href = safeLink(url);
  return href ? <a className="source-link" href={href} target="_blank" rel="noopener noreferrer">{label}<ArrowUpRight size={13} /></a> : null;
}

function IngredientsCard({ card, busy, act }: Props) {
  const [items, setItems] = useState<Ingredient[]>(card.items);
  const update = (i: number, field: keyof Ingredient, value: any) => setItems(previous => previous.map((item, j) => j === i ? { ...item, [field]: value } : item));
  const valid = items.length > 0 && items.every(i => i.name.trim() && (i.grams === null || (i.grams > 0 && i.grams <= 10000)));
  return <section className="result-card">
    <div className="card-title"><span className="card-symbol"><Utensils size={18} /></span><div><h3>先确认一下食材</h3><p>可修改名称和份量，让分析更贴近这一餐</p></div></div>
    <div className="ingredient-header"><span>食材</span><span>重量（克）</span><span>状态</span><span /></div>
    {items.map((item, i) => <div className="ingredient-row" key={i}>
      <div><input aria-label={`食材 ${i + 1} 名称`} value={item.name} maxLength={80} onChange={e => update(i, 'name', e.target.value)} /><small>{item.certainty}</small></div>
      <input aria-label={`食材 ${i + 1} 重量`} type="number" min="1" max="10000" placeholder="待填写" value={item.grams ?? ''} onChange={e => update(i, 'grams', e.target.value === '' ? null : Number(e.target.value))} />
      <select aria-label={`食材 ${i + 1} 生熟状态`} value={item.state} onChange={e => update(i, 'state', e.target.value)}><option>未知</option><option>生</option><option>熟</option></select>
      <button className="icon-button" aria-label={`移除食材 ${i + 1}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
    </div>)}
    <button className="text-button" disabled={items.length >= 30} onClick={() => setItems([...items, { name: '', grams: null, state: '未知', certainty: '待确认' }])}><Plus size={15} />补充食材 / 用油</button>
    <p className="helper">没有重量时，展示每 100 克参考值，不计算整餐总量。</p>
    <div className="card-actions"><button className="button primary" disabled={busy || !valid} onClick={() => act('请根据我确认的食材与份量分析营养。', 'nutrition', items)}>确认并分析</button><button className="button secondary" disabled={busy || !valid} onClick={() => act('根据这些食材搜索健身菜谱。', 'recipes', items)}>找健身菜谱<ArrowUpRight size={15} /></button></div>
  </section>;
}

function NutritionCard({ card, act, busy }: Props) {
  const display = (n: number | null | undefined) => n == null ? '—' : n;
  return <section className="result-card"><div className="card-title"><span className="card-symbol"><Utensils size={18} /></span><div><h3>这一餐的营养参考</h3><p>{card.note}</p></div></div>
    {card.totals && <div className="nutrition-totals">{[['kcal', '热量', '千卡'], ['protein', '蛋白质', '克'], ['fat', '脂肪', '克'], ['carbs', '碳水', '克']].map(([key, name, unit]) => <div key={key}><small>{name}</small><strong>{display(card.totals[key])}<span>{unit}</span></strong></div>)}</div>}
    {card.items.map((item: any, i: number) => <div className="nutrition-item" key={i}><div className="between"><strong>{item.name}</strong><span className="tag">{item.unit} · {item.basis}</span></div>
      <div className="nutrition-values"><span>{display(item.values.kcal)} 千卡</span><span>蛋白质 {display(item.values.protein)} g</span><span>脂肪 {display(item.values.fat)} g</span><span>碳水 {display(item.values.carbs)} g</span></div>
      <p className="helper">{item.state} · {item.grams == null ? '份量未填写' : `${item.grams} 克`} {item.note}</p><SourceLink url={item.source_url} /></div>)}
    {card.ratios && <p className="helper">近似供能比例：蛋白质 {card.ratios.protein}% · 脂肪 {card.ratios.fat}% · 碳水 {card.ratios.carbs}%</p>}
    <button className="button primary" disabled={busy} onClick={() => act('根据已确认食材搜索健身菜谱。', 'recipes')}>用这些食材找菜谱<ArrowUpRight size={15} /></button>
  </section>;
}

function RecipesCard(props: Props) {
  const { card, message, index, busy, append, notify, showRecipe, act } = props;
  const [sorting, setSorting] = useState(false);
  async function sort(mode: string) {
    setSorting(true);
    try { append(await api(`/messages/${message.id}/cards/${index}/sort`, { method: 'POST', body: JSON.stringify({ mode }) })); }
    catch (e) { notify((e as Error).message); } finally { setSorting(false); }
  }
  return <section className="result-card recipes-card"><div className="card-title"><span className="card-symbol"><SlidersHorizontal size={18} /></span><div><h3>{card.original ? '原创建议' : '为你找到的健身菜谱'}</h3><p>评分是偏好参考；来源和推荐理由都可以查看</p></div></div>
    <div className="sort-tabs">{[['total', '综合推荐'], ['ease', '简单优先'], ['speed', '快捷优先'], ['taste', '口味优先']].map(([mode, label]) => <button disabled={busy || sorting} className={card.mode === mode ? 'selected' : ''} key={mode} onClick={() => sort(mode)}>{label}</button>)}</div>
    {card.recipes.length === 0 && <div className="empty-small">没有符合当前条件的菜谱。可以修改忌口之外的条件，或换一组食材。</div>}
    {card.recipes.map((recipe: any, i: number) => <article className="recipe-row" key={recipe.title}>
      <div className="recipe-rank">{String(i + 1).padStart(2, '0')}</div><div className="recipe-main"><div className="between"><h4>{recipe.title}</h4><span className="score">{recipe.total}<small> 分</small></span></div>
      <div className="recipe-meta"><span><Clock3 size={13} />{recipe.minutes == null ? '用时未知' : `${recipe.minutes} 分钟`}</span><span>{recipe.difficulty}</span><span>{recipe.origin}</span></div><p>{recipe.reason}</p>
      <details><summary>为什么推荐 <ChevronDown size={13} /></summary><div className="score-grid">{[['fitness', '目标匹配 · 40%'], ['ease', '容易程度 · 25%'], ['taste', '口味预测 · 20%'], ['speed', '省时程度 · 15%']].map(([key, label]) => <span key={key}>{label}<b>{recipe.scores[key]}</b></span>)}</div><p className="helper">{recipe.score_reason}</p></details>
      <div className="card-actions"><button className="text-button" onClick={() => showRecipe(recipe)}>查看做法<ArrowUpRight size={14} /></button><SourceLink url={recipe.source_url} label="原始来源" /></div></div></article>)}
    <div className="card-actions"><button className="text-button" disabled={busy} onClick={() => act('请根据当前食材生成原创建议，并明确标注为原创。', 'recipes')}><WandSparkles size={15} />试试原创建议</button><button className="text-button" onClick={props.openProfile}>调整筛选条件</button></div>
  </section>;
}

export function PlanContent({ plan }: { plan: any }) {
  return <div className="plan-content"><p>{plan.summary}</p>{plan.days.map((day: any) => <details key={day.day} className="plan-day"><summary><span className="day-number">{String(day.day).padStart(2, '0')}</span><span><strong>{day.title}</strong><small>{day.kind} · {day.minutes} 分钟</small></span><ChevronDown size={17} /></summary>
    <div className="plan-day-body"><p><b>热身 / 准备：</b>{day.warmup}</p>{day.exercises.map((ex: any, i: number) => <div className="exercise" key={i}><strong>{ex.name}</strong><span>{ex.sets_reps} · 休息 {ex.rest}</span><small>替代：{ex.alternative}</small></div>)}<p><b>饮食方向：</b>{day.diet}</p><p className="helper">{day.caution}</p></div></details>)}
    {plan.review.length > 0 && <div className="review-box"><b>每周小复盘</b><ul>{plan.review.map((item: string) => <li key={item}>{item}</li>)}</ul></div>}</div>;
}

export function ResultCard(props: Props) {
  const { card, message, index, notify, busy, act, saved } = props;
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  if (card.type === 'ingredients') return <IngredientsCard {...props} />;
  if (card.type === 'nutrition') return <NutritionCard {...props} />;
  if (card.type === 'recipes') return <RecipesCard {...props} />;
  if (card.type === 'missing_profile') return <button className="button secondary" onClick={props.openProfile}>补充个人资料<ArrowUpRight size={16} /></button>;
  if (card.type === 'body') return <section className="result-card"><h3>照片中的可见观察</h3>{[['observations', '可见特征'], ['limitations', '观察限制'], ['suggestions', '建议方向']].map(([key, title]) => <div key={key}><h4>{title}</h4><ul>{card[key].map((item: string, i: number) => <li key={i}>{item}</li>)}</ul></div>)}<p className="helper">不从照片计算体脂率；这不是医学评估。</p><button className="button secondary" onClick={props.openProfile}>补充资料并制定计划</button></section>;
  if (card.type === 'plan') return <section className="result-card"><div className="card-title"><span className="card-symbol"><Dumbbell size={18} /></span><div><h3>{card.plan.title}</h3><p>7 天安排 · 随时可以在对话中调整</p></div></div><PlanContent plan={card.plan} /><div className="card-actions">
    <button className="button primary" disabled={busy || saving} onClick={async () => { setSaving(true); try { const p = await api('/plans', { method: 'POST', body: JSON.stringify({ message_id: message.id, card_index: index }) }); setSavedId(p.id); notify(`计划已保存 · 版本 ${p.version}`); saved(); } catch (e) { notify((e as Error).message); } finally { setSaving(false); } }}>{savedId ? <Check size={15} /> : <Save size={15} />}{savedId ? '已保存' : '保存计划'}</button>
    <button className="button secondary" disabled={busy} onClick={() => act('我想调整这份计划，请先问我需要修改哪些地方。', 'chat', undefined, savedId || undefined)}>调整计划</button>
    <button className="icon-button" title="复制计划文本" aria-label="复制计划文本" onClick={() => navigator.clipboard.writeText(`${card.plan.title}\n${card.plan.summary}\n` + card.plan.days.map((d: any) => `第${d.day}天 ${d.title} ${d.minutes}分钟\n${d.warmup}\n${d.exercises.map((e: any) => `${e.name} ${e.sets_reps} 休息${e.rest}`).join('\n')}\n饮食：${d.diet}\n${d.caution}`).join('\n\n')).then(() => notify('计划文本已复制')).catch(() => notify('复制失败，请手动选中文字'))}><Clipboard size={16} /></button></div></section>;
  return null;
}

export function RecipeDetail({ recipe, act }: { recipe: any; act: (text: string) => void }) {
  return <div className="recipe-detail"><span className="eyebrow">今天的餐桌</span><h2>{recipe.title}</h2><div className="recipe-meta"><span><Clock3 size={14} />{recipe.minutes ?? '未知'} 分钟</span><span>{recipe.difficulty}</span></div><h3>准备食材</h3><div className="ingredient-chips">{recipe.ingredients.map((s: string, i: number) => <span className="tag" key={i}>{s}</span>)}</div><h3>开始烹饪</h3><ol className="cooking-steps">{recipe.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol><div className="review-box">{recipe.nutrition_note}</div><SourceLink url={recipe.source_url} label={recipe.source_title || '查看原始菜谱'} /><button className="button primary full-width" onClick={() => act(`请把“${recipe.title}”改成少油版。`)}><WandSparkles size={16} />改成少油版</button></div>;
}
