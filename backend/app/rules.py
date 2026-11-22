"""模型负责理解和建议；数值计算、来源约束、排序由普通 Python 执行。"""
from .schemas import Ingredient, NutritionItem, Profile, Recipe, Plan

WEIGHTS = {'fitness': 0.40, 'ease': 0.25, 'taste': 0.20, 'speed': 0.15}
NUTRIENTS = ('kcal', 'protein', 'fat', 'carbs')

def calculate_nutrition(ingredients: list[Ingredient], items: list[NutritionItem], urls: set[str]):
    references = {x.name: x for x in items}
    rows = []
    for ingredient in ingredients:
        ref = references.get(ingredient.name)
        raw = ref.per_100g.model_dump() if ref else dict.fromkeys(NUTRIENTS)
        basis = ref.basis if ref else '暂无可靠数据'
        source = ref.source_url if ref and ref.source_url in urls else None
        if basis == '网页参考' and not source:
            basis = '模型估算'
        if basis == '暂无可靠数据':
            raw = dict.fromkeys(NUTRIENTS)
        factor = ingredient.grams / 100 if ingredient.grams is not None else 1
        values = {k: round(v * factor, 1) if v is not None else None for k, v in raw.items()}
        rows.append({**ingredient.model_dump(), 'values': values, 'reference': raw,
                     'unit': '本份' if ingredient.grams is not None else '每 100 克',
                     'basis': basis, 'source_url': source, 'note': ref.note if ref else '缺少参考数据'})
    complete = bool(rows) and all(r['grams'] is not None and all(v is not None for v in r['values'].values()) for r in rows)
    totals = {k: round(sum(r['values'][k] for r in rows), 1) for k in NUTRIENTS} if complete else None
    ratios = None
    if totals:
        energy = totals['protein'] * 4 + totals['fat'] * 9 + totals['carbs'] * 4
        if energy > 0:
            ratios = {k: round(totals[k] * f / energy * 100, 1) for k, f in [('protein', 4), ('fat', 9), ('carbs', 4)]}
    return {'type': 'nutrition', 'items': rows, 'complete': complete, 'totals': totals, 'ratios': ratios,
            'note': '数据为参考/估算；用油与酱料需单独计入。' if complete else '份量或营养数据不完整，暂不显示整餐总量。'}

def rank_recipes(recipes: list[dict], mode='total') -> list[dict]:
    if mode not in ('total', 'ease', 'speed', 'taste'):
        raise ValueError('不支持的排序方式')
    return sorted(recipes, key=lambda r: (-(r['total'] if mode == 'total' else r['scores'][mode]),
                                          -r['total'], r['minutes'] if r['minutes'] is not None else 9999, r['title']))

def prepare_recipes(recipes: list[Recipe], profile: Profile, sources: list[dict], allow_original: bool):
    urls = {r['url']: r['title'] for r in sources}
    result, seen = [], set()
    for recipe in recipes:
        data = recipe.model_dump()
        if recipe.title in seen:
            continue
        if recipe.origin == '搜索所得':
            if recipe.source_url not in urls:
                continue
            data['source_title'] = urls[recipe.source_url]
        elif not allow_original:
            continue
        else:
            data['source_url'] = None
            data['source_title'] = 'AI 原创，未找到网页来源'
        text = ' '.join(recipe.ingredients + recipe.steps).casefold()
        restrictions = profile.allergies + profile.dislikes
        if any(x.casefold() in text for x in restrictions if x):
            continue
        if restrictions and not recipe.restrictions_checked:
            continue
        if profile.max_cooking_minutes is not None and (recipe.minutes is None or recipe.minutes > profile.max_cooking_minutes):
            continue
        if not profile.taste:
            data['scores']['taste'] = 50.0
        data['total'] = round(sum(data['scores'][k] * w for k, w in WEIGHTS.items()), 1)
        seen.add(recipe.title)
        result.append(data)
    return rank_recipes(result)

def plan_missing(profile: Profile) -> list[str]:
    required = {'goal': '健身目标', 'experience': '训练经验', 'days_per_week': '每周训练天数',
                'minutes_per_session': '每次训练时长', 'equipment': '场地/器械', 'limitations': '运动限制（无也请填写）'}
    return [label for field, label in required.items() if not getattr(profile, field)]

def validate_plan(plan: Plan, profile: Profile):
    if profile.days_per_week and sum(d.kind == '训练' for d in plan.days) != profile.days_per_week:
        raise ValueError('训练天数与用户要求不一致，请重新生成')
    if profile.minutes_per_session and any(d.minutes > profile.minutes_per_session for d in plan.days):
        raise ValueError('单次用时超过用户要求，请重新生成')
    if any(d.kind == '训练' and (d.minutes == 0 or not d.exercises) for d in plan.days):
        raise ValueError('训练日需要明确动作和非零训练时长')
    return plan
