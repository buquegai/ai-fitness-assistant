# 轻练 · AI 健身助手

基于第 2 章 LangChain（智能体开发框架）学习内容实现的单用户本地项目。前端采用 React + Vite（网页组件与构建工具），后端采用 FastAPI（接口框架），默认模型为 DeepSeek 的 `deepseek-flash`（支持图片的模型名称）。

## 启动

需要 Python 3.12、Node.js 20.19+ 或 22.12+，以及 uv（Python 项目管理工具）。

在此项目目录打开 PowerShell（命令终端），运行：

```powershell
.\start.ps1
```

此命令安装锁定依赖、生成 `.env`（本地环境配置）、构建前端，再启动后端。打开 <http://127.0.0.1:8000>。已安装和构建后可以用 `./start.ps1 -SkipBuild`（跳过前端构建）加快启动。

如果系统禁止执行脚本，可在当前终端执行 `Set-ExecutionPolicy -Scope Process Bypass`（仅为当前终端允许脚本），也可以按下面的开发命令手动启动。

## 填写服务配置

将 `.env.example`（配置示例）复制为 `.env`（本地配置），所有密钥默认留空，且已被 `.gitignore`（版本忽略规则）排除。配置后重启服务。

| 配置字段 | 中文说明 |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek 接口密钥 |
| `DEEPSEEK_BASE_URL` | 模型接口地址，默认 `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | 模型名称，默认 `deepseek-flash` |
| `MODEL_SUPPORTS_VISION` | 是否允许图片输入；换成不支持图片的模型时设为 `false` |
| `TAVILY_API_KEY` | Tavily 联网搜索密钥 |
| `OSS_REGION` | OSS 地域，例如 `cn-hangzhou`（杭州） |
| `OSS_ENDPOINT` | OSS 外网服务地址，例如 `https://oss-cn-hangzhou.aliyuncs.com` |
| `OSS_BUCKET` | 私有存储空间名称 |
| `OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` | 访问密钥标识 / 密钥 |
| `OSS_SESSION_TOKEN` | 使用临时凭证时的安全令牌，可选 |

OSS 需要读取、上传、删除项目对象的权限。使用私有 Bucket（存储空间）；后端上传、清理图片，不需要浏览器直传权限。应用保存对象标识，读取时签发 5 分钟有效链接，DeepSeek 用该链接读取图片。用户照片不会传给 Tavily。

默认图片保留 7 天。服务运行时每 5 分钟清理一次过期对象；到期即停止提供访问。**服务关闭期间无法执行清理**，建议在 OSS 控制台同时为 `fitness/`（图片对象前缀）配置 7 天生命周期规则。第三方服务日志的保留按其服务条款执行。

官方模型说明：<https://api-docs.deepseek.com/quick_start/pricing>；图片输入格式：<https://api-docs.deepseek.com/guides/vision/>。模型名称和权限可能随账号及平台变化，真实调用需用自己的密钥验证。

## 已实现的流程

- 食材照片或文字清单 → 可编辑识别结果 → 确认重量/生熟状态 → 营养参考与供能比例。
- Tavily 搜索 → 来源白名单校验 → 忌口/用时过滤 → 固定权重排序 → 查看做法、继续改编。
- 身体照片 → 可见外观观察 → 一般训练建议；不会仅凭照片计算体脂率。
- 个人资料 → 7 天计划 → 对话调整 → 独立保存与版本管理。
- 流式聊天、停止生成、同一消息重试、新建/切换/重命名/删除会话、刷新恢复。
- 图片本地预览、发送前用途确认、元数据移除、私有上传、删除和过期清理。
- 服务未配置时明确提示，不把演示数据当作真实模型结果。

## 代码阅读顺序

| 文件 | 中文用途 |
|---|---|
| `backend/app/config.py` | 环境配置与服务状态 |
| `backend/app/schemas.py` | 输入校验与结构化结果类型 |
| `backend/app/services.py` | OSS 图片服务、Tavily 搜索、图片清理 |
| `backend/app/rules.py` | 确定性的营养计算、评分、过滤和计划校验 |
| `backend/app/agent.py` | 需求路由、图片分析、搜索结果整理、计划和 LangChain 工具调用 |
| `backend/app/db.py` | 会话、结果卡片、资料、计划的 SQLite 存储 |
| `backend/app/main.py` | FastAPI 接口、SSE（服务器推送事件）、图片清理任务 |
| `frontend/src/App.tsx` | 聊天工作台与页面状态 |
| `frontend/src/Cards.tsx` | 食材、营养、菜谱、身材、计划卡片 |
| `frontend/src/ProfileForm.tsx` | 个人资料表单 |

`agent.py`（智能体文件）通过结构化路由选择业务流程。常规追问使用 `create_agent`（创建智能体）及 `web_search`（联网搜索工具）。业务卡片使用 JSON（结构化数据）输出并经过 Pydantic（数据校验）验证。SQLite 显式保存用户可见消息和卡片，每次调用重建本会话最近 16 条消息及当前结构化上下文；没有使用隐式模型长期记忆或多智能体。

## 开发与验证

后端：

```powershell
uv sync --frozen --python 3.12
uv run uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 --reload
```

前端，在另一个终端中进入 `frontend`（前端目录）：

```powershell
npm ci
npm run dev
```

开发页面为 <http://127.0.0.1:5173>，由 Vite 转发 `/api`（接口路径）到后端。接口文档为 <http://127.0.0.1:8000/docs>。

测试与构建：

```powershell
uv run pytest -q
```

在 `frontend`（前端目录）中：

```powershell
npm run build
npx playwright install chromium
npm run test:e2e
```

`pytest`（后端自动测试）使用临时数据库和替代服务，验证边界、数据保留、计算和版本规则。`test:e2e`（浏览器端到端测试）使用独立测试数据库、空密钥；结构化卡片场景使用显式网络替代响应。**测试通过不等于真实 DeepSeek / Tavily / OSS 联调通过**，接入真实密钥后还需完成下列人工验收。

1. 文本对话、流式响应及停止生成；确认停止后能继续发消息。
2. 食材图片上传并识别，修改份量后计算营养；验证来源和估算标签。
3. 搜索并排序菜谱，追问“第二道菜”，确认引用的是最近展示顺序。
4. 上传身体照片，确认不产生体脂数值或医学诊断。
5. 生成计划、保存、修改并保存第二版，检查旧版仍在。
6. 删除图片/会话，确认 OSS 对象也清理；临时撤销删除权限，确认不会误报成功。

## 当前边界

- 默认绑定 `127.0.0.1`（本机地址），仅面向本人使用，未实现账号与多用户隔离；公开部署前需要身份认证等工作。
- 营养数据依赖资料与份量，未知字段不当作零；口味是偏好预测。程序校验不能保证模型对食材、运动和过敏原的判断完全正确。
- 首版饮食计划提供饮食结构建议，不输出个性化热量处方或蛋白质数值目标。
- 图片失败时保留文本上下文；照片删除不会自动删除已生成的文字观察。删除会话可清除相关应用内记忆。
- 保存的计划与会话独立；删掉某一计划版本不会删掉其他版本。
- 多次模型调用可能增加延迟和接口费用。历史消息有长度上限，较早的细节可能需要用户补充。
