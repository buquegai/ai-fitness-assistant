import asyncio
import logging
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .agent import FitnessAgent
from .config import ROOT, Settings
from .db import Database, dump, now, uid
from .rules import rank_recipes
from .schemas import ChatRequest, Profile, Rename, SavePlan, SortRequest
from .services import ImageStorage, SearchService, ServiceError, clean_image

logger = logging.getLogger(__name__)

def create_app(settings: Settings | None = None, *, agent=None, storage=None):
    settings = settings or Settings()
    db = Database(settings.db_path)
    storage = storage or ImageStorage(settings)
    agent = agent or FitnessAgent(settings, db, SearchService(settings), storage)
    active: set[str] = set()
    running: dict[str, asyncio.Task] = {}
    maintenance_lock = asyncio.Lock()

    async def clean_expired():
        async with maintenance_lock:
            for image in db.images(expired=True):
                if image['conversation_id'] in active:
                    continue
                try:
                    await storage.delete(image['object_key'])
                    db.remove_image(image['id'], 'expired')
                except ServiceError:
                    # 保留数据库记录，下次自动重试；应用不再提供已过期图片。
                    logger.warning('过期图片清理失败，将在下一轮重试：%s', image['id'])

    async def janitor():
        while True:
            await clean_expired()
            await asyncio.sleep(300)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(janitor())
        yield
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        for job in list(running.values()):
            job.cancel()
        if running:
            await asyncio.gather(*list(running.values()), return_exceptions=True)

    app = FastAPI(title='AI 健身助手', version='0.1.0', lifespan=lifespan)
    app.state.db, app.state.agent = db, agent
    app.state.clean_expired = clean_expired
    origins = [s.strip() for s in settings.allowed_origins.split(',') if s.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], allow_headers=['Content-Type'])

    @app.middleware('http')
    async def local_origin_guard(request: Request, call_next):
        origin = request.headers.get('origin')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin and origin not in origins:
            return JSONResponse({'detail': '不允许此网页来源访问本地服务'}, status_code=403)
        response = await call_next(request)
        if request.url.path.startswith('/api'):
            response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        return response

    @app.exception_handler(ServiceError)
    async def service_error(request, exc):
        return JSONResponse({'detail': exc.message, 'code': exc.code}, status_code=exc.status)

    def require_conversation(id_):
        conversation = db.conversation(id_)
        if not conversation:
            raise ServiceError('对话不存在或已经删除', 'not_found', 404)
        return conversation

    def require_idle(id_):
        require_conversation(id_)
        if id_ in active:
            raise ServiceError('当前对话正在生成，请先停止或等待完成', 'conversation_busy', 409)

    def require_image(id_, conversation_id=None):
        image = db.image(id_)
        if not image or (conversation_id and image['conversation_id'] != conversation_id):
            raise ServiceError('图片不属于当前对话或不存在', 'not_found', 404)
        if image['status'] != 'active' or image['expires_at'] <= now():
            raise ServiceError('图片已过期或删除，请重新上传', 'image_expired', 410)
        return image

    @app.get('/api/health')
    async def health():
        return {'ok': True, 'version': '0.1.0'}

    @app.get('/api/settings/status')
    async def status():
        return settings.status()

    @app.get('/api/conversations')
    async def conversations():
        return db.conversations()

    @app.post('/api/conversations', status_code=201)
    async def new_conversation():
        return db.create_conversation()

    @app.get('/api/conversations/{id_}')
    async def get_conversation(id_: str):
        conversation = require_conversation(id_)
        return {**conversation, 'messages': db.messages(id_), 'generating': id_ in active}

    @app.patch('/api/conversations/{id_}')
    async def rename(id_: str, body: Rename):
        require_conversation(id_)
        db.rename(id_, body.title)
        return db.conversation(id_)

    @app.delete('/api/conversations/{id_}')
    async def delete_conversation(id_: str):
        require_idle(id_)
        active.add(id_)
        try:
            async with maintenance_lock:
                for image in db.images(id_):
                    await storage.delete(image['object_key'])
                    db.remove_image(image['id'])
                db.delete_conversation(id_)
            return {'deleted': True}
        finally:
            active.discard(id_)

    @app.get('/api/profile')
    async def profile():
        return Profile.model_validate(db.profile())

    @app.put('/api/profile')
    async def save_profile(body: Profile):
        db.save_profile(body.model_dump())
        return body

    @app.put('/api/conversations/{id_}/profile')
    async def session_profile(id_: str, body: Profile):
        require_idle(id_)
        db.context(id_, profile=body.model_dump())
        return body

    @app.post('/api/images', status_code=201)
    async def upload_image(conversation_id: str = Form(...), consent: bool = Form(...), file: UploadFile = File(...)):
        require_idle(conversation_id)
        if not consent:
            raise ServiceError('请先确认图片存储和分析用途', 'consent_required', 422)
        id_ = uid()
        key = f'fitness/{conversation_id}/{id_}.jpg'
        active.add(conversation_id)
        try:
            data = await file.read(10 * 1024 * 1024 + 1)
            await file.close()
            cleaned = await asyncio.to_thread(clean_image, data)
            await storage.upload(key, cleaned)
            expires = (datetime.now(timezone.utc) + timedelta(days=settings.image_retention_days)).isoformat()
            try:
                db.add_image(id_, conversation_id, key, expires)
            except Exception:
                await storage.delete(key)
                raise
            return {'id': id_, 'url': f'/api/images/{id_}/content', 'expires_at': expires}
        finally:
            active.discard(conversation_id)

    @app.get('/api/images/{id_}/content')
    async def image_content(id_: str):
        image = require_image(id_)
        return RedirectResponse(storage.signed_url(image['object_key']), status_code=307)

    @app.delete('/api/images/{id_}')
    async def delete_image(id_: str):
        image = db.image(id_)
        if not image:
            raise ServiceError('图片不存在', 'not_found', 404)
        require_idle(image['conversation_id'])
        if image['status'] == 'active':
            active.add(image['conversation_id'])
            try:
                async with maintenance_lock:
                    await storage.delete(image['object_key'])
                    db.remove_image(id_)
            finally:
                active.discard(image['conversation_id'])
        return {'deleted': True}

    @app.get('/api/plans')
    async def plans():
        return db.plans()

    @app.post('/api/plans', status_code=201)
    async def save_plan(body: SavePlan):
        message = db.message(body.message_id)
        if not message or body.card_index >= len(message['cards']):
            raise ServiceError('计划卡片不存在', 'not_found', 404)
        require_idle(message['conversation_id'])
        card = message['cards'][body.card_index]
        if card.get('type') != 'plan':
            raise ServiceError('请选择计划卡片', 'invalid_card', 422)
        result = db.save_plan(card['plan'], f'{body.message_id}:{body.card_index}', card.get('parent_id'))
        db.context(message['conversation_id'], last_plan_id=result['id'])
        return result

    @app.delete('/api/plans/{id_}')
    async def delete_plan(id_: str):
        if not db.plan(id_):
            raise ServiceError('计划不存在', 'not_found', 404)
        db.delete_plan(id_)
        return {'deleted': True}

    @app.post('/api/messages/{id_}/cards/{index}/sort')
    async def sort_card(id_: str, index: int, body: SortRequest):
        message = db.message(id_)
        if not message or index < 0 or index >= len(message['cards']):
            raise ServiceError('菜谱卡片不存在', 'not_found', 404)
        require_idle(message['conversation_id'])
        card = message['cards'][index]
        if card.get('type') != 'recipes':
            raise ServiceError('此卡片不支持排序', 'invalid_card', 422)
        recipes = rank_recipes(card['recipes'], body.mode)
        db.context(message['conversation_id'], recipe_order=recipes)
        labels = {'total': '综合推荐', 'ease': '简单优先', 'speed': '快捷优先', 'taste': '口味优先'}
        # 新消息保存新的展示顺序，旧回复不被改写。
        return db.add_message(message['conversation_id'], uid(), 'assistant',
                              f'已切换为{labels[body.mode]}，后续“第几道菜”按下面的顺序理解。',
                              [{**card, 'recipes': recipes, 'mode': body.mode}])

    @app.post('/api/chat/stream')
    async def chat(body: ChatRequest, request: Request):
        require_idle(body.conversation_id)
        if not body.text and not body.image_id and not body.ingredients and body.task == 'chat':
            raise ServiceError('请输入文字或上传图片', 'empty_message', 422)
        if body.image_id:
            require_image(body.image_id, body.conversation_id)
        if body.plan_id and not db.plan(body.plan_id):
            raise ServiceError('要修改的计划不存在', 'not_found', 404)
        existing = db.turn(body.conversation_id, body.request_id)
        if existing:
            if not body.retry or existing[-1]['status'] == 'complete':
                raise ServiceError('这条消息已经提交，请勿重复发送', 'duplicate_request', 409)
            user = next(m for m in existing if m['role'] == 'user')
            if user['content'] != body.text or user['image_id'] != body.image_id:
                raise ServiceError('重试内容与原消息不一致，请重新发送', 'retry_mismatch', 409)
            assistant = next((m for m in existing if m['role'] == 'assistant'), None)
            if assistant:
                db.update_message(assistant['id'], '', [], 'streaming')
            else:
                assistant = db.add_message(body.conversation_id, body.request_id, 'assistant', status='streaming')
        else:
            metadata = body.model_dump(exclude={'image_id', 'text', 'retry'})
            user = db.add_message(body.conversation_id, body.request_id, 'user', body.text,
                                  cards=[{'type': 'request_context', 'request': metadata}], image_id=body.image_id)
            assistant = db.add_message(body.conversation_id, body.request_id, 'assistant', status='streaming')
            conversation = db.conversation(body.conversation_id)
            if conversation['title'] == '新对话':
                db.rename(body.conversation_id, (body.text or '图片分析')[:30])
        active.add(body.conversation_id)

        def event(name, data):
            return f'event: {name}\ndata: {dump(data)}\n\n'

        async def generate():
            text, cards, state = '', [], 'interrupted'
            queue = asyncio.Queue()

            async def produce():
                nonlocal text, cards, state
                try:
                    async for item in agent.run(body):
                        kind, payload = item['event'], item['data']
                        if kind == 'delta':
                            text += payload['text']
                        elif kind == 'card':
                            cards.append(payload)
                        elif kind == 'notice':
                            text += '\n\n' + payload['text'] + '\n\n'
                        if kind in ('delta', 'card', 'notice'):
                            db.update_message(assistant['id'], text, cards, 'streaming')
                        await queue.put(event(kind, payload))
                    state = 'complete'
                except asyncio.CancelledError:
                    state = 'interrupted'
                    raise
                except ServiceError as e:
                    state = 'error'
                    text += ('\n\n' if text else '') + e.message
                    await queue.put(event('error', {'message': e.message, 'code': e.code}))
                except Exception as e:
                    state = 'error'
                    logger.warning('模型调用失败，异常类型：%s', type(e).__name__)
                    message = '模型服务暂时不可用，请检查密钥、模型名称或网络后重试。'
                    text += ('\n\n' if text else '') + message
                    await queue.put(event('error', {'message': message, 'code': 'model_error'}))
                finally:
                    db.update_message(assistant['id'], text, cards, state)
                    active.discard(body.conversation_id)
                    running.pop(body.conversation_id, None)
                    await queue.put(event('done', {'message': db.message(assistant['id'])}))
                    await queue.put(None)

            job = asyncio.create_task(produce())
            running[body.conversation_id] = job
            try:
                yield event('start', {'user': user, 'assistant_id': assistant['id']})
                while True:
                    if await request.is_disconnected():
                        break
                    try:
                        item = await asyncio.wait_for(queue.get(), timeout=1)
                    except asyncio.TimeoutError:
                        yield ': keep-alive\n\n'
                        continue
                    if item is None:
                        break
                    yield item
            finally:
                if not job.done():
                    job.cancel()
                    with suppress(asyncio.CancelledError):
                        await job

        return StreamingResponse(generate(), media_type='text/event-stream', headers={'X-Accel-Buffering': 'no'})

    @app.post('/api/conversations/{id_}/stop')
    async def stop(id_: str):
        require_conversation(id_)
        job = running.get(id_)
        if job:
            job.cancel()
            with suppress(asyncio.CancelledError):
                await job
        return {'stopped': True}

    dist = ROOT / 'frontend' / 'dist'
    if dist.exists():
        app.mount('/assets', StaticFiles(directory=dist / 'assets'), name='assets')

        @app.get('/')
        async def index():
            return FileResponse(dist / 'index.html')

    return app

app = create_app()
