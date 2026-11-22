export type Task = 'chat' | 'ingredients' | 'nutrition' | 'recipes' | 'body' | 'plan';
export type Ingredient = { name: string; grams: number | null; state: '生' | '熟' | '未知'; certainty: '较确定' | '待确认' };
export type Profile = {
  goal: string; experience: string; days_per_week: number | null; minutes_per_session: number | null;
  equipment: string; limitations: string; age: number | null; height_cm: number | null; weight_kg: number | null;
  activity: string; allergies: string[]; dislikes: string[]; taste: string; cooking_equipment: string;
  max_cooking_minutes: number | null; body_fat: number | null; body_fat_date: string;
};
export const emptyProfile: Profile = { goal: '', experience: '', days_per_week: null, minutes_per_session: null,
  equipment: '', limitations: '', age: null, height_cm: null, weight_kg: null, activity: '', allergies: [],
  dislikes: [], taste: '', cooking_equipment: '', max_cooking_minutes: null, body_fat: null, body_fat_date: '' };
export type Card = { type: string; [key: string]: any };
export type Message = { id: string; conversation_id: string; request_id: string; role: 'user' | 'assistant';
  content: string; cards: Card[]; image_id: string | null; status: string; created_at: string };
export type Conversation = { id: string; title: string; updated_at: string; context: Record<string, any> };
export type ChatBody = { conversation_id: string; request_id: string; text: string; task: Task; web_enabled: boolean;
  image_id?: string; ingredients?: Ingredient[]; profile?: Profile; plan_id?: string; retry?: boolean };
export type Services = { model: boolean; model_name: string; search: boolean; storage: boolean; vision: boolean; retention_days: number };
