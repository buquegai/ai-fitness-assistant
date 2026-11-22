import asyncio
import io
import re
from datetime import timedelta
from urllib.parse import urlparse

import httpx
from PIL import Image, ImageOps, UnidentifiedImageError

from .config import Settings

class ServiceError(Exception):
    def __init__(self, message: str, code: str = "service_error", status: int = 503):
        self.message, self.code, self.status = message, code, status
        super().__init__(message)

def public_url(value: str | None) -> bool:
    if not value:
        return False
    p = urlparse(value)
    return p.scheme in ('http', 'https') and bool(p.hostname) and not p.username and not p.password

def clean_image(data: bytes) -> bytes:
    if len(data) > 10 * 1024 * 1024:
        raise ServiceError('图片不能超过 10 MB（兆字节）', 'invalid_image', 413)
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ('JPEG', 'PNG', 'WEBP') or getattr(image, 'n_frames', 1) > 1:
                raise ServiceError('请上传静态 JPG、PNG 或 WebP 图片', 'invalid_image', 422)
            if image.width * image.height > 40_000_000:
                raise ServiceError('图片分辨率过大，请压缩后上传', 'invalid_image', 422)
            image.load()
            normalized = ImageOps.exif_transpose(image).convert('RGB')
            normalized.thumbnail((1920, 1920))
            # 新建图像彻底移除 EXIF/GPS 等元数据。
            clean = Image.new('RGB', normalized.size)
            clean.paste(normalized)
            output = io.BytesIO()
            clean.save(output, format='JPEG', quality=88)
            return output.getvalue()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as e:
        raise ServiceError('无法读取这张图片，请换一张清晰的静态图片', 'invalid_image', 422) from e

class ImageStorage:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._client = None

    def client(self):
        if not self.settings.oss_ready:
            raise ServiceError('图片存储未配置，请在后端填写阿里云 OSS 配置', 'storage_not_configured')
        if self._client is None:
            import alibabacloud_oss_v2 as oss
            cfg = oss.config.load_default()
            cfg.region = self.settings.oss_region
            cfg.endpoint = self.settings.oss_endpoint
            cfg.credentials_provider = oss.credentials.StaticCredentialsProvider(
                self.settings.oss_access_key_id, self.settings.oss_access_key_secret,
                self.settings.oss_session_token or None)
            self._client = oss.Client(cfg)
        return self._client

    async def upload(self, key: str, data: bytes):
        import alibabacloud_oss_v2 as oss
        client = self.client()
        try:
            await asyncio.to_thread(client.put_object, oss.PutObjectRequest(
                bucket=self.settings.oss_bucket, key=key, body=data, content_type='image/jpeg', acl='private'))
        except Exception as e:
            raise ServiceError('图片上传失败，请检查 OSS 权限、服务地址后重试', 'storage_error') from e

    def signed_url(self, key: str) -> str:
        import alibabacloud_oss_v2 as oss
        try:
            return self.client().presign(oss.GetObjectRequest(bucket=self.settings.oss_bucket, key=key),
                                         expires=timedelta(minutes=5)).url
        except ServiceError:
            raise
        except Exception as e:
            raise ServiceError('无法获取图片临时链接，请检查 OSS 配置', 'storage_error') from e

    async def delete(self, key: str):
        import alibabacloud_oss_v2 as oss
        client = self.client()
        try:
            await asyncio.to_thread(client.delete_object, oss.DeleteObjectRequest(bucket=self.settings.oss_bucket, key=key))
        except Exception as e:
            raise ServiceError('图片清理失败，原记录仍保留，请重试', 'storage_error') from e

class SearchService:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def search(self, query: str) -> list[dict]:
        if not self.settings.tavily_api_key:
            raise ServiceError('搜索服务未配置，请填写 Tavily API Key（搜索接口密钥）', 'search_not_configured')
        try:
            async with httpx.AsyncClient(timeout=35) as client:
                response = await client.post('https://api.tavily.com/search',
                    headers={'Authorization': f'Bearer {self.settings.tavily_api_key}'},
                    json={'query': query, 'max_results': 6, 'search_depth': 'basic', 'include_answer': False})
                response.raise_for_status()
                results = response.json().get('results', [])
                seen, output = set(), []
                for r in results:
                    url = r.get('url', '')
                    if not public_url(url) or url in seen:
                        continue
                    seen.add(url)
                    output.append({'title': str(r.get('title', '来源网页'))[:200], 'url': url,
                                   'content': str(r.get('content', ''))[:3500]})
                return output
        except (httpx.HTTPError, ValueError, TypeError) as e:
            raise ServiceError('搜索暂不可用，已保留当前内容，请稍后重试搜索', 'search_error') from e

def ingredient_keywords(names: list[str]) -> str:
    # 仅允许食材关键词进入搜索；不传递对话、自拍、个人资料或身体指标。
    cleaned = []
    for name in names[:15]:
        if re.search(r'@|https?:|\d|身高|体重|体脂|电话|身份证|地址|姓名', name):
            continue
        cleaned.append(re.sub(r'[^\w\u4e00-\u9fff ]', '', name)[:25])
    return ' '.join(cleaned)

