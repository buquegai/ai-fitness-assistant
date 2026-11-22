from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, str_strip_whitespace=True)

class Profile(StrictModel):
    goal: str = Field(default="", max_length=80)
    experience: str = Field(default="", max_length=100)
    days_per_week: int | None = Field(default=None, ge=1, le=7)
    minutes_per_session: int | None = Field(default=None, ge=10, le=180)
    equipment: str = Field(default="", max_length=300)
    limitations: str = Field(default="", max_length=300)
    age: int | None = Field(default=None, ge=18, le=100)
    height_cm: float | None = Field(default=None, ge=100, le=230)
    weight_kg: float | None = Field(default=None, ge=30, le=300)
    activity: str = Field(default="", max_length=100)
    allergies: list[str] = Field(default_factory=list, max_length=20)
    dislikes: list[str] = Field(default_factory=list, max_length=20)
    taste: str = Field(default="", max_length=200)
    cooking_equipment: str = Field(default="", max_length=200)
    max_cooking_minutes: int | None = Field(default=None, ge=5, le=180)
    body_fat: float | None = Field(default=None, ge=2, le=70)
    body_fat_date: str = Field(default="", max_length=20)

    @field_validator('allergies', 'dislikes')
    @classmethod
    def normalize_restrictions(cls, values):
        result = list(dict.fromkeys(v.strip() for v in values if v.strip()))
        if any(len(v) > 60 for v in result):
            raise ValueError('单项饮食限制最多 60 个字符')
        return result

class Ingredient(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    grams: float | None = Field(default=None, gt=0, le=10000)
    state: Literal["生", "熟", "未知"] = "未知"
    certainty: Literal["较确定", "待确认"] = "待确认"

class NutrientValues(StrictModel):
    kcal: float | None = Field(default=None, ge=0, le=1000)
    protein: float | None = Field(default=None, ge=0, le=100)
    fat: float | None = Field(default=None, ge=0, le=100)
    carbs: float | None = Field(default=None, ge=0, le=100)

class NutritionItem(StrictModel):
    name: str = Field(min_length=1, max_length=80)
    per_100g: NutrientValues
    source_url: str | None = None
    basis: Literal["网页参考", "模型估算", "暂无可靠数据"]
    note: str = Field(default="", max_length=500)

class Scores(StrictModel):
    fitness: float = Field(ge=0, le=100)
    ease: float = Field(ge=0, le=100)
    taste: float = Field(ge=0, le=100)
    speed: float = Field(ge=0, le=100)

class Recipe(StrictModel):
    title: str = Field(min_length=1, max_length=100)
    ingredients: list[str] = Field(min_length=1, max_length=30)
    steps: list[str] = Field(min_length=1, max_length=20)
    minutes: int | None = Field(default=None, ge=1, le=600)
    difficulty: Literal["简单", "中等", "复杂", "未知"]
    scores: Scores
    reason: str = Field(max_length=500)
    score_reason: str = Field(max_length=700)
    source_url: str | None = None
    source_title: str = Field(default="", max_length=200)
    origin: Literal["搜索所得", "AI 原创改编"]
    restrictions_checked: bool = False
    nutrition_note: str = Field(default="暂无可靠数据", max_length=500)

class Exercise(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    sets_reps: str = Field(min_length=1, max_length=100)
    rest: str = Field(max_length=100)
    alternative: str = Field(max_length=150)

class PlanDay(StrictModel):
    day: int = Field(ge=1, le=7)
    title: str = Field(min_length=1, max_length=100)
    kind: Literal["训练", "休息"]
    minutes: int = Field(ge=0, le=180)
    warmup: str = Field(max_length=400)
    exercises: list[Exercise] = Field(default_factory=list, max_length=10)
    diet: str = Field(max_length=1000)
    caution: str = Field(max_length=500)

class Plan(StrictModel):
    title: str = Field(min_length=1, max_length=100)
    summary: str = Field(max_length=800)
    days: list[PlanDay] = Field(min_length=7, max_length=7)
    review: list[str] = Field(max_length=6)
    @model_validator(mode="after")
    def unique_days(self):
        if sorted(x.day for x in self.days) != list(range(1, 8)):
            raise ValueError("计划必须包含不重复的第 1–7 天")
        self.days.sort(key=lambda d: d.day)
        return self

class ChatRequest(StrictModel):
    conversation_id: str = Field(min_length=1, max_length=64)
    request_id: str = Field(min_length=1, max_length=64)
    text: str = Field(default="", max_length=8000)
    image_id: str | None = Field(default=None, max_length=64)
    task: Literal["chat", "ingredients", "nutrition", "recipes", "body", "plan"] = "chat"
    web_enabled: bool = True
    ingredients: list[Ingredient] | None = Field(default=None, max_length=30)
    profile: Profile | None = None
    plan_id: str | None = Field(default=None, max_length=64)
    retry: bool = False

class Rename(StrictModel):
    title: str = Field(min_length=1, max_length=80)

class SortRequest(StrictModel):
    mode: Literal["total", "ease", "speed", "taste"] = "total"

class SavePlan(StrictModel):
    message_id: str
    card_index: int = Field(ge=0)

