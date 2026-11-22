from pathlib import Path
import io
import pytest
from PIL import Image

from app.db import Database
from app.rules import calculate_nutrition, prepare_recipes, rank_recipes, validate_plan
from app.schemas import Ingredient, NutritionItem, Profile, Recipe, Plan
from app.services import clean_image, ServiceError, ingredient_keywords

def recipe(**overrides):
    data = dict(title='测试菜谱', ingredients=['番茄', '豆腐'], steps=['蒸熟'], minutes=15, difficulty='简单',
                scores=dict(fitness=80, ease=90, taste=100, speed=70), reason='测试理由', score_reason='测试分项说明',
                source_url='https://example.org/recipe', source_title='来源', origin='搜索所得', restrictions_checked=True)
    data.update(overrides)
    return Recipe(**data)

def sample_plan():
    return Plan(title='一周计划', summary='每周三练', days=[dict(day=i, title='训练' if i in (1, 3, 5) else '休息',
        kind='训练' if i in (1, 3, 5) else '休息', minutes=30 if i in (1, 3, 5) else 0, warmup='轻松走动',
        exercises=[dict(name='深蹲', sets_reps='2组8次', rest='60秒', alternative='坐站练习')] if i in (1, 3, 5) else [],
        diet='均衡搭配', caution='以舒适为准') for i in range(1, 8)], review=['记录疲劳'])

def test_unknown_portion_never_becomes_meal_total():
    card = calculate_nutrition([Ingredient(name='豆腐')], [NutritionItem(name='豆腐', per_100g=dict(kcal=80, protein=8, fat=4, carbs=2), basis='模型估算')], set())
    assert card['totals'] is None
    assert card['items'][0]['unit'] == '每 100 克'
    assert card['items'][0]['values']['kcal'] == 80

def test_missing_nutrients_not_zero_and_source_not_invented():
    card = calculate_nutrition([Ingredient(name='豆腐', grams=200)], [NutritionItem(name='豆腐', per_100g=dict(kcal=80, protein=8, fat=None, carbs=2), basis='网页参考', source_url='https://invented.invalid')], set())
    assert card['totals'] is None
    assert card['items'][0]['values']['fat'] is None
    assert card['items'][0]['source_url'] is None
    assert card['items'][0]['basis'] == '模型估算'

def test_known_portion_calculates_scaled_nutrition():
    card = calculate_nutrition([Ingredient(name='豆腐', grams=200)], [NutritionItem(name='豆腐', per_100g=dict(kcal=80, protein=8, fat=4, carbs=2), basis='模型估算')], set())
    assert card['totals'] == dict(kcal=160, protein=16, fat=8, carbs=4)
    assert abs(sum(card['ratios'].values()) - 100) < 0.2

def test_filters_sources_restrictions_and_neutral_taste():
    source = [{'url': 'https://example.org/recipe', 'title': '实际网页标题'}]
    profile = Profile(allergies=['花生'], max_cooking_minutes=20)
    items = [recipe(), recipe(title='不合适', ingredients=['花生酱']), recipe(title='太慢', minutes=30),
             recipe(title='虚构来源', source_url='https://invented.invalid'), recipe(title='未知用时', minutes=None)]
    output = prepare_recipes(items, profile, source, False)
    assert len(output) == 1
    assert output[0]['scores']['taste'] == 50
    assert output[0]['total'] == 75
    assert output[0]['source_title'] == '实际网页标题'
    assert rank_recipes(output) == output

def test_plan_day_count_and_time_enforced():
    p = sample_plan()
    validate_plan(p, Profile(days_per_week=3, minutes_per_session=30))
    with pytest.raises(ValueError):
        validate_plan(p, Profile(days_per_week=2, minutes_per_session=30))
    with pytest.raises(ValueError):
        validate_plan(p, Profile(days_per_week=3, minutes_per_session=20))

def test_plan_versions_survive_conversation_delete(tmp_path):
    db = Database(tmp_path / 'test.sqlite')
    chat = db.create_conversation()
    first = db.save_plan(sample_plan().model_dump(), 'message:0')
    duplicate = db.save_plan(sample_plan().model_dump(), 'message:0')
    second = db.save_plan(sample_plan().model_dump(), 'message:1', first['id'])
    assert first['id'] == duplicate['id']
    assert second['family_id'] == first['family_id']
    assert second['version'] == 2
    db.delete_conversation(chat['id'])
    assert len(db.plans()) == 2

def test_images_normalize_remove_metadata_and_reject_other_files():
    raw = io.BytesIO()
    image = Image.new('RGB', (30, 30), 'red')
    exif = Image.Exif(); exif[271] = 'Private camera'
    image.save(raw, format='JPEG', exif=exif)
    result = clean_image(raw.getvalue())
    assert not Image.open(io.BytesIO(result)).getexif()
    with pytest.raises(ServiceError):
        clean_image(b'<script>not an image</script>')

def test_search_keywords_exclude_body_metrics():
    assert ingredient_keywords(['鸡胸肉', '体重70kg', 'https://private.invalid', '番茄']) == '鸡胸肉 番茄'
