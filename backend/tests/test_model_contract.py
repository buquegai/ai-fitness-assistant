"""验证真实 LangChain 客户端的协议形状；HTTP 使用替代响应，不调用付费服务。"""
import json
import httpx
import pytest
from langchain_openai import ChatOpenAI
from app.agent import FitnessAgent, IngredientsResult
from app.config import Settings
from app.db import Database
from app.schemas import ChatRequest
from app.services import SearchService, ImageStorage

@pytest.mark.asyncio
async def test_multimodal_json_contract_reaches_openai_compatible_endpoint(tmp_path):
    received=[]
    def handler(request):
        body=json.loads(request.content)
        received.append(body)
        result={'summary':'待确认','items':[{'name':'番茄','grams':None,'state':'生','certainty':'待确认'}]}
        return httpx.Response(200,json={'id':'chat-test','object':'chat.completion','created':1,'model':'deepseek-flash',
          'choices':[{'index':0,'message':{'role':'assistant','content':json.dumps(result,ensure_ascii=False)},'finish_reason':'stop'}],
          'usage':{'prompt_tokens':10,'completion_tokens':10,'total_tokens':20}})
    settings=Settings(_env_file=None,database_path=str(tmp_path/'contract.sqlite'),deepseek_api_key='test-only')
    agent=FitnessAgent(settings,Database(settings.db_path),SearchService(settings),ImageStorage(settings))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model=ChatOpenAI(api_key='test-only',base_url='https://model.invalid',model='deepseek-flash',
                        http_async_client=client,extra_body={'thinking':{'type':'disabled'}})
        agent.model=lambda: model
        result=await agent.structured(IngredientsResult,'识别图片',image_url='https://example.org/private-signed.jpg')
    assert result.items[0].name=='番茄'
    assert received[0]['response_format']=={'type':'json_object'}
    assert received[0]['thinking']['type']=='disabled'
    assert received[0]['messages'][-1]['content'][1]['type']=='image_url'
    assert received[0]['messages'][-1]['content'][1]['image_url']['url'].endswith('private-signed.jpg')

@pytest.mark.asyncio
async def test_plain_agent_stream_uses_saved_conversation_and_preserves_tokens(tmp_path):
    received=[]
    def handler(request):
        body=json.loads(request.content); received.append(body)
        if not body.get('stream'):
            route={'task':'chat','ingredient_names':[],'profile_updates':{}}
            return httpx.Response(200,json={'id':'route','object':'chat.completion','created':1,'model':'deepseek-flash',
              'choices':[{'index':0,'message':{'role':'assistant','content':json.dumps(route)},'finish_reason':'stop'}]})
        chunks=[]
        for token in ['你好','，继续练习。']:
            part={'id':'stream','object':'chat.completion.chunk','created':1,'model':'deepseek-flash',
                  'choices':[{'index':0,'delta':{'content':token},'finish_reason':None}]}
            chunks.append('data: '+json.dumps(part,ensure_ascii=False)+'\n\n')
        chunks.append('data: [DONE]\n\n')
        return httpx.Response(200,headers={'content-type':'text/event-stream'},content=''.join(chunks).encode())
    settings=Settings(_env_file=None,database_path=str(tmp_path/'contract.sqlite'),deepseek_api_key='test-only',tavily_api_key='')
    db=Database(settings.db_path); conversation=db.create_conversation()
    db.add_message(conversation['id'],'previous','user','我只能在家练习')
    agent=FitnessAgent(settings,db,SearchService(settings),ImageStorage(settings))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        model=ChatOpenAI(api_key='test-only',base_url='https://model.invalid',model='deepseek-flash',http_async_client=client)
        agent.model=lambda: model
        result=[item async for item in agent.run(ChatRequest(conversation_id=conversation['id'],request_id='new',text='你好',web_enabled=False))]
    assert ''.join(x['data']['text'] for x in result if x['event']=='delta')=='你好，继续练习。'
    assert any(m.get('content')=='我只能在家练习' for m in received[-1]['messages'])
    assert not received[-1].get('tools')
