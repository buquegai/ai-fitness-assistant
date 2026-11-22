import { useState } from 'react';
import { ArrowUpRight, Save } from 'lucide-react';
import type { Profile } from './types';

export default function ProfileForm({ initial, save, generate, busy }: { initial: Profile; save: (p: Profile, persistent: boolean) => Promise<void>; generate: (p: Profile) => void; busy: boolean }) {
  const [p, setP] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const field = (key: keyof Profile, value: any) => setP(old => ({ ...old, [key]: value }));
  const numeric = (key: keyof Profile, value: string) => field(key, value === '' ? null : Number(value));
  async function submit(persistent: boolean) { setSaving(true); setError(''); try { await save(p, persistent); } catch (e) { setError((e as Error).message); } finally { setSaving(false); } }
  return <div className="profile-form"><span className="eyebrow">更了解你一点</span><h2>个人资料</h2><p className="helper">先填训练条件，其他信息可按需补充。不知道的项目可以留空。</p>
    <fieldset><legend>01 · 目标与训练</legend><label>健身目标<select aria-label="健身目标" value={p.goal} onChange={e => field('goal', e.target.value)}><option value="">请选择</option>{['减脂', '增肌', '维持', '提升体能'].map(x => <option key={x}>{x}</option>)}</select></label>
      <label>训练经验<select aria-label="训练经验" value={p.experience} onChange={e => field('experience', e.target.value)}><option value="">请选择</option>{['刚开始', '偶尔训练', '规律训练'].map(x => <option key={x}>{x}</option>)}</select></label>
      <div className="form-grid"><label>每周训练天数<input type="number" min="1" max="7" value={p.days_per_week ?? ''} onChange={e => numeric('days_per_week', e.target.value)} placeholder="例如 3" /></label><label>每次时长（分钟）<input type="number" min="10" max="180" value={p.minutes_per_session ?? ''} onChange={e => numeric('minutes_per_session', e.target.value)} placeholder="例如 30" /></label></div>
      <label>场地 / 器械<input value={p.equipment} maxLength={300} onChange={e => field('equipment', e.target.value)} placeholder="例如：居家、瑜伽垫、哑铃" /></label>
      <label>运动限制<input value={p.limitations} maxLength={300} onChange={e => field('limitations', e.target.value)} placeholder="如膝盖不适；没有请填“无”" /></label></fieldset>
    <fieldset><legend>02 · 饮食与烹饪</legend><label>过敏原<input value={p.allergies.join('，')} onChange={e => field('allergies', e.target.value.split(/[,，]/))} placeholder="如花生、虾，用逗号分隔" /></label><label>忌口 / 不喜欢的食材<input value={p.dislikes.join('，')} onChange={e => field('dislikes', e.target.value.split(/[,，]/))} placeholder="用逗号分隔" /></label><label>口味偏好<input value={p.taste} onChange={e => field('taste', e.target.value)} placeholder="例如：清淡、微辣" /></label><label>烹饪设备<input value={p.cooking_equipment} onChange={e => field('cooking_equipment', e.target.value)} placeholder="例如：空气炸锅、电饭煲" /></label><label>每道菜用时上限（分钟）<input type="number" min="5" max="180" value={p.max_cooking_minutes ?? ''} onChange={e => numeric('max_cooking_minutes', e.target.value)} placeholder="不限可留空" /></label></fieldset>
    <details className="optional-fields"><summary>03 · 身体与活动信息（选填）</summary><div className="form-grid">{[['age', '年龄', '18', '100'], ['height_cm', '身高（厘米）', '100', '230'], ['weight_kg', '体重（千克）', '30', '300'], ['body_fat', '已有体脂测量值（%）', '2', '70']].map(([key, title, min, max]) => <label key={key}>{title}<input type="number" step="any" min={min} max={max} value={(p[key as keyof Profile] as number) ?? ''} onChange={e => numeric(key as keyof Profile, e.target.value)} /></label>)}</div><label>日常活动水平<input value={p.activity} onChange={e => field('activity', e.target.value)} placeholder="如久坐办公、经常走动" /></label><label>体脂测量日期<input type="date" value={p.body_fat_date} onChange={e => field('body_fat_date', e.target.value)} /></label></details>
    {error && <p className="inline-error" role="alert">{error}</p>}
    <div className="profile-actions"><div className="two-buttons"><button className="button secondary" disabled={busy || saving} onClick={() => submit(false)}>仅用于本次</button><button className="button secondary" disabled={busy || saving} onClick={() => submit(true)}><Save size={15} />保存资料</button></div><button className="button primary full-width" disabled={busy || saving} onClick={() => generate(p)}>用这些条件生成 7 天计划<ArrowUpRight size={16} /></button><p className="helper">资料变更不会自动覆盖已保存的计划。</p></div></div>;
}
