from pathlib import Path
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[2]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", env_file_encoding="utf-8", extra="ignore")
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-flash"
    model_supports_vision: bool = True
    model_timeout_seconds: int = Field(default=90, ge=5, le=300)
    tavily_api_key: str = ""
    oss_region: str = ""
    oss_endpoint: str = ""
    oss_bucket: str = ""
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""
    oss_session_token: str = ""
    image_retention_days: int = Field(default=7, ge=1, le=30)
    database_path: str = "data/fitness.sqlite3"
    allowed_origins: str = "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:8000,http://localhost:8000"

    @property
    def db_path(self) -> Path:
        p = Path(self.database_path)
        return p if p.is_absolute() else ROOT / p

    @property
    def oss_ready(self) -> bool:
        return all([self.oss_region, self.oss_endpoint, self.oss_bucket, self.oss_access_key_id, self.oss_access_key_secret])

    def status(self) -> dict:
        return {"model": bool(self.deepseek_api_key), "model_name": self.deepseek_model,
                "vision": self.model_supports_vision, "search": bool(self.tavily_api_key),
                "storage": self.oss_ready, "retention_days": self.image_retention_days}

