import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.beforeEach(async ({ page, request }) => {
  const chats = await (await request.get('/api/conversations')).json();
  for (const c of chats) await request.delete(`/api/conversations/${c.id}`);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /你好/ })).toBeVisible();
  await expect.poll(async () => (await (await request.get('/api/conversations')).json()).length).toBe(1);
});

test('desktop layout and honest service configuration', async ({ page }) => {
  await expect(page.getByText('拍照认识食材')).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  fs.mkdirSync('test-results/screenshots', { recursive: true });
  await page.screenshot({ path: 'test-results/screenshots/desktop.png', fullPage: true });
  await page.getByRole('button', { name: '设置与隐私', exact: true }).click();
  await expect(page.getByRole('heading', { name: '连接与隐私' })).toBeVisible();
  await expect(page.locator('.status-tag.off')).toHaveCount(3);
});

test('failed request persists and retries without duplicate user message', async ({ page, request }) => {
  await page.getByRole('textbox', { name: '给轻练发送消息' }).fill('你好，我想从居家训练开始');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('.message.assistant')).toContainText('模型未配置');
  await expect(page.getByRole('button', { name: '重试此回复' })).toBeVisible();
  await page.getByRole('button', { name: '重试此回复' }).click();
  await expect(page.locator('.message.user')).toHaveCount(1);
  await expect(page.locator('.message.assistant')).toHaveCount(1);
  await page.reload();
  await expect(page.locator('.message.assistant')).toContainText('模型未配置');
  await expect(page.getByRole('button', { name: '重试此回复' })).toBeVisible();
  const chats = await (await request.get('/api/conversations')).json();
  const data = await (await request.get(`/api/conversations/${chats[0].id}`)).json();
  expect(data.messages.length).toBe(2);
});

test('profile can stay in one conversation and plan submission uses entered values', async ({ page, request }) => {
  await page.getByRole('button', { name: '做一份本周计划', exact: false }).click();
  await page.getByRole('combobox', { name: '健身目标', exact: true }).selectOption('减脂');
  await page.getByRole('combobox', { name: '训练经验', exact: true }).selectOption('刚开始');
  await page.getByLabel('每周训练天数').fill('3');
  await page.getByLabel('每次时长（分钟）').fill('30');
  await page.getByLabel('场地 / 器械').fill('居家，无器械');
  await page.getByLabel('运动限制', { exact: true }).fill('无');
  await page.getByRole('button', { name: '仅用于本次' }).click();
  await expect(page.getByRole('status')).toContainText('仅用于当前对话');
  const profile = await (await request.get('/api/profile')).json();
  expect(profile.days_per_week).toBeNull();
  const submission = page.waitForRequest(r => r.url().endsWith('/api/chat/stream'));
  await page.getByRole('button', { name: '用这些条件生成 7 天计划' }).click();
  const body = (await submission).postDataJSON();
  expect(body.profile.days_per_week).toBe(3);
  expect(body.profile.minutes_per_session).toBe(30);
  await expect(page.locator('.message.assistant')).toContainText('模型未配置');
});

test('image stays local before send and can be removed without API upload', async ({ page }) => {
  let uploads = 0;
  page.on('request', r => { if (r.url().endsWith('/api/images') && r.method() === 'POST') uploads++; });
  await page.locator('input[type=file]').setInputFiles({ name: 'food.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1WQAAAAASUVORK5CYII=', 'base64') });
  await expect(page.getByAltText('待发送图片预览')).toBeVisible();
  expect(uploads).toBe(0);
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '移除附件' }).click();
  await expect(page.getByAltText('待发送图片预览')).toHaveCount(0);
});

test('mobile layout supports menu profile and composer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '打开菜单', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/screenshots/mobile.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '打开菜单', exact: true }).click();
  await page.locator('.sidebar').getByRole('button', { name: '个人资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '个人资料', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '关闭面板' })).toBeVisible();
});

test('streaming cards support ingredient edits and structured actions', async ({ page }) => {
  let requestCount = 0;
  await page.route('**/api/chat/stream', async route => {
    requestCount++;
    const body = route.request().postDataJSON();
    if (requestCount === 2) {
      expect(body.task).toBe('nutrition');
      expect(body.ingredients[0].grams).toBe(150);
    }
    const card = { type: 'ingredients', items: [{ name: '番茄', grams: null, state: '生', certainty: '待确认' }] };
    const assistant = { id: `mock-${requestCount}`, role: 'assistant', content: '请确认食材和份量。', cards: [card], status: 'complete', request_id: body.request_id, conversation_id: body.conversation_id, created_at: new Date().toISOString() };
    const events = [['start', { user: { ...assistant, id: 'mock-user', role: 'user', content: body.text, cards: [] }, assistant_id: assistant.id }], ['status', { text: '正在识别食材' }], ['delta', { text: assistant.content }], ['card', card], ['done', { message: assistant }]];
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('') });
  });
  await page.getByRole('textbox', { name: '给轻练发送消息' }).fill('我有番茄');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('heading', { name: '先确认一下食材' })).toBeVisible();
  await page.getByLabel('食材 1 重量').fill('150');
  await page.getByRole('button', { name: '确认并分析', exact: true }).click();
  await expect.poll(() => requestCount).toBe(2);
});
