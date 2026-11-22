param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw '请先安装 uv（Python 项目管理工具）。' }
if (-not (Test-Path -LiteralPath '.env')) {
    Copy-Item -LiteralPath '.env.example' -Destination '.env'
    Write-Host '已创建 .env（环境配置文件）；请填写 DeepSeek、Tavily 和 OSS 密钥。密钥留空也能打开页面。'
}
uv sync --frozen --python 3.12
if ($LASTEXITCODE -ne 0) { throw '后端依赖安装失败。' }
if (-not $SkipBuild) {
    Push-Location -LiteralPath 'frontend'
    try {
        npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw '前端依赖安装失败。' }
        npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
    } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath 'frontend/dist/index.html')) { throw '未找到前端构建文件，请取消 -SkipBuild 后重试。' }
Write-Host '页面：http://127.0.0.1:8000 ；接口文档：http://127.0.0.1:8000/docs'
Write-Host '按 Ctrl+C（中断键）停止服务。修改 .env 后需要重启。'
uv run uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
