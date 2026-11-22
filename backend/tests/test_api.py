import io
import json
from datetime import datetime, timedelta, timezone
from fastapi.testclient import TestClient
from PIL import Image
import pytest
import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor

from app.config import Settings
from app.main import create_app
from app.services import ServiceError

class FakeStorage:
    def __init__(self): self.deleted = []; self.fail = False
    async def upload(self, key, data): pass
    async def delete(self, key):
        if self.fail: raise ServiceError('图片清理失败，请重试')
        self.deleted.append(key)
    def signed_url(self, key): return 'https://example.org/signed-image'

class FakeAgent:
    async def run(self, request):
        yield {'event': 'status', 'data': {'text': '测试处理阶段'}}
        yield {'event': 'delta', 'data': {'text': '测试回复：'}}
        yield {'event': 'delta', 'data': {'text': request.text}}

class FailingAgent:
    async def run(self, request):
        yield {'event': 'delta', 'data': {'text': '保留的部分内容'}}
        raise ServiceError('模拟服务失败', 'test_error')

def settings(tmp_path):
    return Settings(_env_file=None, database_path=str(tmp_path/'api.sqlite'), deepseek_api_key='', tavily_api_key='')

def events(response):
    output=[]
    for block in response.text.split('\n\n'):
        lines=block.splitlines()
        if len(lines) >= 2:
            output.append((lines[0].removeprefix('event: '), json.loads(lines[1].removeprefix('data: '))))
    return output

def test_missing_key_is_honest_and_history_survives(tmp_path):
    app=create_app(settings(tmp_path))
    with TestClient(app) as c:
        assert c.get('/api/settings/status').json()['model'] is False
        assert 'deepseek_api_key' not in c.get('/api/settings/status').text
        chat=c.post('/api/conversations').json()
        body=dict(conversation_id=chat['id'],request_id='first',text='你好')
        response=c.post('/api/chat/stream',json=body)
        data=events(response)
        assert any(kind=='error' and value['code']=='model_not_configured' for kind,value in data)
        assert data[-1][1]['message']['status']=='error'
        restored=c.get('/api/conversations/'+chat['id']).json()
        assert len(restored['messages'])==2
        assert restored['messages'][0]['cards'][0]['type']=='request_context'
        assert c.post('/api/chat/stream',json=body).status_code==409
        body['retry']=True
        assert c.post('/api/chat/stream',json=body).status_code==200
        assert len(c.get('/api/conversations/'+chat['id']).json()['messages'])==2

def test_stream_preserves_order_isolation_and_same_request_deduplication(tmp_path):
    app=create_app(settings(tmp_path),agent=FakeAgent())
    with TestClient(app) as c:
        a=c.post('/api/conversations').json()['id']; b=c.post('/api/conversations').json()['id']
        body=dict(conversation_id=a,request_id='req',text='我的测试')
        ev=events(c.post('/api/chat/stream',json=body))
        assert ev[0][0]=='start' and ev[-1][0]=='done'
        assert ev[-1][1]['message']['content']=='测试回复：我的测试'
        assert c.get('/api/conversations/'+b).json()['messages']==[]
        assert c.post('/api/chat/stream',json={**body,'retry':True}).status_code==409

def test_failure_keeps_partial_and_retry_does_not_duplicate(tmp_path):
    app=create_app(settings(tmp_path),agent=FailingAgent())
    with TestClient(app) as c:
        id_=c.post('/api/conversations').json()['id']
        body=dict(conversation_id=id_,request_id='req',text='测试失败')
        c.post('/api/chat/stream',json=body)
        c.post('/api/chat/stream',json={**body,'retry':True})
        messages=c.get('/api/conversations/'+id_).json()['messages']
        assert len(messages)==2 and '保留的部分内容' in messages[-1]['content']
        assert messages[-1]['status']=='error'

def test_image_deletion_failure_keeps_record_then_removes_reference(tmp_path):
    storage=FakeStorage(); app=create_app(settings(tmp_path),agent=FakeAgent(),storage=storage)
    with TestClient(app) as c:
        id_=c.post('/api/conversations').json()['id']
        buf=io.BytesIO(); Image.new('RGB',(8,8)).save(buf,'PNG')
        upload=c.post('/api/images',data={'conversation_id':id_,'consent':'true'},files={'file':('test.png',buf.getvalue(),'image/png')})
        assert upload.status_code==201
        image_id=upload.json()['id']
        c.post('/api/chat/stream',json=dict(conversation_id=id_,request_id='img',text='看图',image_id=image_id))
        storage.fail=True
        assert c.delete('/api/images/'+image_id).status_code==503
        assert app.state.db.image(image_id)['status']=='active'
        storage.fail=False
        assert c.delete('/api/images/'+image_id).status_code==200
        assert app.state.db.image(image_id)['status']=='deleted'
        assert all(m['image_id'] is None for m in app.state.db.messages(id_))
        assert c.get(f'/api/images/{image_id}/content').status_code==410

def test_expired_images_blocked_and_cleaned(tmp_path):
    storage=FakeStorage(); app=create_app(settings(tmp_path),agent=FakeAgent(),storage=storage)
    with TestClient(app) as c:
        id_=c.post('/api/conversations').json()['id']
        app.state.db.add_image('expired',id_,'some-key',(datetime.now(timezone.utc)-timedelta(days=1)).isoformat())
        assert c.get('/api/images/expired/content').status_code==410
        c.portal.call(app.state.clean_expired)
        assert app.state.db.image('expired')['status']=='expired'
        assert storage.deleted==['some-key']

def test_validation_origin_and_image_conversation_ownership(tmp_path):
    app=create_app(settings(tmp_path),agent=FakeAgent(),storage=FakeStorage())
    with TestClient(app) as c:
        a=c.post('/api/conversations').json()['id']; b=c.post('/api/conversations').json()['id']
        app.state.db.add_image('private',a,'key',(datetime.now(timezone.utc)+timedelta(days=1)).isoformat())
        assert c.post('/api/chat/stream',json=dict(conversation_id=b,request_id='x',image_id='private')).status_code==404
        assert c.put('/api/profile',json={'days_per_week':9}).status_code==422
        assert c.post('/api/conversations',headers={'Origin':'https://untrusted.invalid'}).status_code==403

def test_stop_cancels_work_releases_lock_and_keeps_partial_reply(tmp_path):
    started = threading.Event()
    cancelled = threading.Event()
    class SlowAgent:
        async def run(self, request):
            try:
                yield {'event': 'delta', 'data': {'text': '已生成的内容'}}
                started.set()
                await asyncio.sleep(120)
            finally:
                cancelled.set()
    app=create_app(settings(tmp_path),agent=SlowAgent())
    with TestClient(app) as c, ThreadPoolExecutor(max_workers=1) as pool:
        id_=c.post('/api/conversations').json()['id']
        future=pool.submit(c.post,'/api/chat/stream',json=dict(conversation_id=id_,request_id='slow',text='慢请求'))
        assert started.wait(5)
        assert c.post('/api/chat/stream',json=dict(conversation_id=id_,request_id='duplicate',text='再问一次')).status_code==409
        assert c.post(f'/api/conversations/{id_}/stop').status_code==200
        assert cancelled.wait(5)
        result=events(future.result(timeout=5))
        assert result[-1][1]['message']['status']=='interrupted'
        assert result[-1][1]['message']['content']=='已生成的内容'
        assert c.delete('/api/conversations/'+id_).status_code==200

def test_sort_adds_new_snapshot_and_updates_followup_context(tmp_path):
    app=create_app(settings(tmp_path),agent=FakeAgent())
    with TestClient(app) as c:
        id_=c.post('/api/conversations').json()['id']
        recipes=[dict(title='第一道',total=90,minutes=30,scores=dict(ease=50,speed=40,taste=80)),
                 dict(title='第二道',total=80,minutes=10,scores=dict(ease=90,speed=90,taste=70))]
        message=app.state.db.add_message(id_,'r','assistant',cards=[dict(type='recipes',recipes=recipes,mode='total')])
        result=c.post(f"/api/messages/{message['id']}/cards/0/sort",json={'mode':'ease'})
        assert result.status_code==200
        assert result.json()['cards'][0]['recipes'][0]['title']=='第二道'
        assert app.state.db.message(message['id'])['cards'][0]['recipes'][0]['title']=='第一道'
        assert app.state.db.conversation(id_)['context']['recipe_order'][0]['title']=='第二道'

def test_saved_plan_versions_and_sources_are_server_owned(tmp_path):
    from test_rules import sample_plan
    app=create_app(settings(tmp_path),agent=FakeAgent())
    with TestClient(app) as c:
        id_=c.post('/api/conversations').json()['id']
        first=app.state.db.add_message(id_,'p1','assistant',cards=[dict(type='plan',plan=sample_plan().model_dump(),parent_id=None)])
        saved=c.post('/api/plans',json=dict(message_id=first['id'],card_index=0)).json()
        second=app.state.db.add_message(id_,'p2','assistant',cards=[dict(type='plan',plan=sample_plan().model_dump(),parent_id=saved['id'])])
        revised=c.post('/api/plans',json=dict(message_id=second['id'],card_index=0)).json()
        assert revised['version']==2 and revised['family_id']==saved['family_id']
        assert c.post('/api/plans',json=dict(message_id=second['id'],card_index=0)).json()['id']==revised['id']
        assert c.post('/api/plans',json=dict(message_id='invented',card_index=0)).status_code==404
        c.delete('/api/conversations/'+id_)
        assert len(c.get('/api/plans').json())==2
