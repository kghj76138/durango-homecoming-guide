/* Data-backed cooking lookup. Game DLL verification gates publication. */
(function () {
  'use strict';

  function tagLevel(value, level, levels) {
    if (value == null) return level;
    if (typeof value === 'number' || /^\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*$/.test(value)) return Number(value);
    const values = levels[value];
    return values && values[level - 1] != null ? Number(values[level - 1]) : 0;
  }

  function itemTags(item, level, levels) {
    const out = {};
    for (const [tag, value] of Object.entries(item.tags || {})) out[tag] = tagLevel(value, level, levels);
    return out;
  }

  function matches(tags, filter) {
    return !filter || !Object.keys(filter).length || Object.entries(filter).some(([tag, minimum]) => (tags[tag] || 0) >= Number(minimum));
  }

  function accepts(tags, slot) {
    return matches(tags, slot.required_tags) && matches(tags, slot.required_materials);
  }

  function resultFor(recipe, materials, catalog, level) {
    for (const branch of recipe.results || []) {
      if (!branch.condition) continue;
      const criteria = branch.condition.criteria || [];
      if (criteria.every(rule => {
        const selected = materials[rule.slot_id] || [];
        const ids = Array.isArray(selected) ? selected : [selected];
        const actual = Math.max(0, ...ids.map(id => itemTags(catalog.items[id], level, catalog.tag_levels)[rule.tag_id] || 0));
        return rule.condition === '>0' ? actual > 0 : rule.condition === '<0' ? actual < 0 : false;
      })) return branch.item;
    }
    return (recipe.results || []).find(branch => !branch.condition)?.item || null;
  }

  function craftedLevel(recipe, materialLevels, skillLevel, great) {
    const cap = Math.max(Number(skillLevel) || 0, 0);
    let level = materialLevels.length ? Math.floor(materialLevels.reduce((a, b) => a + b, 0) / materialLevels.length) :
      Math.max(Number(recipe.min_level) || 0, 1);
    if (cap > 0) level = Math.min(level, cap);
    if (Number(recipe.min_level) > 0) level = Math.max(level, Number(recipe.min_level));
    if (Number(recipe.max_level) > 0) level = Math.min(level, Number(recipe.max_level));
    level = Math.max(level, 1);
    if (great && !(cap > 0 && level >= cap))
      level = Number(recipe.max_level) > 0 ? Math.min(level + 1, Number(recipe.max_level)) : level + 1;
    return level;
  }

  function cookedTags(tags, recipeId, catalog, seasoningTags, grade = "normal") {
    const next = Object.assign({}, tags);
    delete next.raw_food;
    delete next.wet;
    for (const tag of catalog.removed[recipeId] || []) delete next[tag];
    const rows = [...(catalog.traits[recipeId] || [])];
    if (seasoningTags) {
      const spice = Object.keys(seasoningTags).find(tag => seasoningTags[tag] > 0 && tag in catalog.spices);
      if (spice) rows.push(...catalog.spices[spice]);
    }
    for (const row of rows) {
      if (grade === "failure" && (catalog.underdone || []).includes(recipeId) && row.Tag === "energy_fire") continue;
      if (row.Tag === 'savory_plus' && !(tags.meat > 0 || tags.fish > 0)) continue;
      const previous = next[row.Tag] || 0;
      const limit = catalog.tags[row.Tag]?.max_level;
      next[row.Tag] = row.Tag.endsWith('_plus_amplifier') ? row.Level :
        (limit ? Math.min(previous + row.Level, limit) : previous + row.Level);
    }
    if (grade === 'failure' && (catalog.burns || []).includes(recipeId)) {
      next.burned = 1;
      for (const tag of Object.keys(next)) {
        if (tag.endsWith('_plus_amplifier')) {
          next[tag] -= 1;
          if (next[tag] <= 0) delete next[tag];
        }
      }
    }
    return next;
  }

  function craftedTags(resultId, recipeId, materials, materialLevel, resultLevel, grade, catalog) {
    const output = itemTags(catalog.items[resultId], resultLevel, catalog.tag_levels);
    const recipe = catalog.recipes[recipeId];
    const primary = recipe.slots.some(slot => slot.slot_id === 'base') ? 'base' : 'main';
    const primaryIds = materials[primary] || [];
    const kinds = catalog.kind_tags[recipeId] || [];
    const inherit = catalog.inheriting.includes(recipeId);
    const sums = {}, highest = {};
    for (const id of primaryIds) {
      for (const [tag, rawLevel] of Object.entries(itemTags(catalog.items[id], materialLevel, catalog.tag_levels))) {
        const value = Math.max(1, Number(rawLevel));
        if (kinds.includes(tag)) highest[tag] = Math.max(highest[tag] || 0, value);
        else if (inherit && catalog.trait_tags.includes(tag)) sums[tag] = (sums[tag] || 0) + value;
      }
    }
    for (const [tag, value] of Object.entries(highest)) output[tag] = value;
    for (const [tag, sum] of Object.entries(sums)) output[tag] = Math.floor(sum / primaryIds.length + 0.5);
    for (const [left, right] of catalog.cancelled_pairs) {
      if (left in output && right in output) { delete output[left]; delete output[right]; }
    }
    if (catalog.topping_recipes.includes(recipeId)) {
      for (const id of materials.topping || []) {
        const toppingTags = itemTags(catalog.items[id], materialLevel, catalog.tag_levels);
        const match = catalog.topping_effects.find(([source]) => source === id || source in toppingTags);
        if (!match) continue;
        const trait = match[1];
        output[trait] = trait.endsWith('_plus_plus') ? 2 + (grade === 'great' ? 1 : 0) :
          Math.max(Math.floor(resultLevel / 10), 1) + (grade === 'great' ? 2 : 0);
      }
    }
    return output;
  }

  function cookedName(name, recipeId, grade, baseTags, catalog, garnishId = null) {
    const recipeName = catalog.recipes[recipeId]?.name;
    if (!name || !recipeName) return name;
    const statePrefixes = ['설익은 ', '잘 익은 ', '덜 익은 ', '탄 ', '타버린 '];
    const stripStates = value => {
      let again;
      do {
        again = false;
        for (const prefix of statePrefixes) {
          if (value.length > prefix.length && value.startsWith(prefix)) {
            value = value.slice(prefix.length); again = true;
          }
        }
      } while (again);
      return value;
    };
    let rest = stripStates(name);
    if (recipeId === 'steam' && (rest.startsWith('찐') || rest.startsWith('잘 만든 찐') ||
        (rest.startsWith('잘 만든 ') && rest.endsWith(' 찜')))) return name;
    if (recipeId === 'skewer' || recipeId === 's02_skewer') {
      while (rest.startsWith('잘 만든 ')) rest = rest.slice('잘 만든 '.length);
      const hasTail = rest.endsWith(' ' + recipeName);
      const plain = hasTail ? rest.slice(0, -recipeName.length - 1) : rest;
      if (grade === 'great') return `잘 만든 ${plain} 꼬치구이`;
      if (grade === 'burnt') return `탄 ${plain} 꼬치구이`;
      if (grade === 'underdone') return `덜 익은 ${stripStates(hasTail ? '잘 익은 ' + rest : '설익은 ' + rest + ' ' + recipeName)}`;
      return hasTail ? '잘 익은 ' + rest : '설익은 ' + rest + ' ' + recipeName;
    }
    let template = null;
    if (recipeId === 's02_cooking' && grade !== 'burnt' && garnishId) {
      const garnish = itemTags(catalog.items[garnishId], 1, catalog.tag_levels);
      const pick = key => key in garnish;
      template = pick('worm') ? '벌레를 얹은 {item} 찜' :
        pick('leather') ? '가죽을 덮은 {item} 찜' :
        pick('meat') ? '고기를 얹은 {item} 찜' :
        pick('fish') ? '생선을 얹은 {item} 찜' :
        garnishId.includes('lotus_root') ? '연근을 얹은 {item} 찜' :
        pick('medicine') ? '약재를 얹은 {item} 찜' : '뭔가를 얹은 {item} 찜';
    }
    if (recipeId === 'steam') template = grade === 'great' ? '잘 만든 찐{item}' : '찐{item}';
    const dried = catalog.dried_names[recipeId];
    if (!template && grade === 'normal' && dried) {
      if ('fish' in baseTags) template = dried[1];
      else if ('meat' in baseTags) template = dried[0];
    }
    const row = catalog.name_templates[recipeId];
    if (!template && row) template = row[grade === 'great' ? 1 : grade === 'burnt' ? 2 : 0];
    if (!template && row) template = row[0];
    const result = template ? template.replace('{item}', rest) : rest + ' ' + recipeName;
    return grade === 'burnt' && (!row || !row[2]) ? '탄 ' + stripStates(result) : result;
  }

  function nameGrade(recipeId, result, priorTags, catalog) {
    if (priorTags.burned || (result === 'failure' && (catalog.burns || []).includes(recipeId))) return 'burnt';
    if (result === 'failure' && (catalog.underdone || []).includes(recipeId)) return 'underdone';
    return result === 'great' ? 'great' : 'normal';
  }

  const effectLabels = {accuracy_plus:'정확도', agility_plus:'민첩', armorcraft_plus:'방어구 제작',
    attack_plus:'공격력', bitter:'쓴맛', butchering_plus:'도축', charisma_plus:'매력',
    construction_plus:'건축', cook_plus:'요리', critical_plus:'치명타', defense_plus:'방어력',
    dexterity_plus:'손재주', digestivetime:'소화 시간', disassembling_plus:'해체',
    durability:'내구도', effect_off:'상태효과 종료', effect_on:'상태효과', effect_on_level:'상태효과 레벨',
    endurance_plus:'지구력', energy_expression:'즉시 에너지 비율', energy_expression_over_time:'지속 에너지',
    energy_potential:'에너지 잠재량', farming_plus:'농사', fatigue:'피로', furnishing_plus:'가구 제작',
    gathering_plus:'채집', handicraft_plus:'수공', health:'건강', intelligence_plus:'지능', life:'생명',
    max_energy_plus:'최대 에너지', mining_plus:'채광', modifier_effect_time:'버프 지속 시간',
    oily:'기름진맛', perception_plus:'감각', salty:'짠맛', satiety:'배부름', savory:'감칠맛',
    smith_plus:'대장', sour:'신맛', strength_plus:'힘', sweet:'단맛',
    tailor_plus:'재봉', weaponcraft_plus:'무기 제작', will_plus:'의지'};
  const effectLabel = key => effectLabels[key] || key.replaceAll('_', ' ');
  const ruleLabel = {ratio:'배율', incr:'증가', decr:'감소', set:'지정'};

  function formula(value, level, table, fallback = 0) {
    if (value == null || value === '') return fallback;
    if (typeof value === 'number' || /^\s*[+-]?(?:\d+\.?\d*|\.\d+)\s*$/.test(value)) return Number(value);
    const calculated = table[value]?.[level - 1];
    return typeof calculated === 'number' && Number.isFinite(calculated) ? calculated : fallback;
  }

  function foodEffect(itemId, level, tags, catalog) {
    const bands = catalog.food_bands[itemId] || [];
    const band = bands.find(([lo, hi]) => lo <= level && level <= hi) || bands[0];
    if (!band) return null;
    const base = band[2];
    const increments = {}, ratios = {}, setNumbers = {}, setStrings = {};
    let stage = 0;
    for (const [tagId, rawLevel] of Object.entries(tags)) {
      const tag = catalog.tags[tagId];
      if (!tag) continue;
      const tagLevel = Math.max(Number(rawLevel) || 0, 1);
      if (tagId.endsWith('_plus_amplifier')) stage = 2;
      else if (stage < 1 && catalog.trait_tags.includes(tagId)) stage = 1;
      for (const [key, modifier] of Object.entries(tag.modifiers || {})) {
        if (!modifier || modifier.formula == null || modifier.formula === '') continue;
        const action = modifier.function;
        const expression = modifier.formula;
        if (typeof expression === 'string' && /^['"].*['"]$/.test(expression)) {
          if (action === 'set') { setStrings[key] = expression.slice(1, -1); delete setNumbers[key]; }
          continue;
        }
        const value = formula(expression, tagLevel, catalog.modifier_formulas);
        if (action === 'set') { setNumbers[key] = value; delete setStrings[key]; }
        else if (action === 'incr' || action === 'decr')
          increments[key] = (increments[key] || 0) + (action === 'decr' ? -value : value);
        else if (action === 'ratio') ratios[key] = (ratios[key] ?? 1) * value;
      }
    }
    for (const key of catalog.buff_keys) {
      const scale = catalog.food_scales[itemId][key][stage];
      if (scale !== 1) ratios[key] = (ratios[key] ?? 1) * scale;
    }
    const ev = (key, fallback = 0) => formula(base[key], level, catalog.food_formulas, fallback);
    const apply = (key, value) => key in setNumbers || key in setStrings ? (setNumbers[key] ?? 0) :
      (value + (increments[key] || 0)) * (ratios[key] ?? 1);
    const potential = apply('energy_potential', ev('energy_potential'));
    const expression = Math.min(1, Math.max(0, apply('energy_expression', ev('energy_expression', 1))));
    const buffs = {};
    for (const key of catalog.buff_keys) {
      const value = apply(key, base[key] ? ev(key) : 0);
      if (Math.abs(value) > 0.0001) buffs[key] = value;
    }
    const seconds = Math.max(0, apply('modifier_effect_time', Number(base.modifier_effect_time) || 300));
    const effect = 'effect_on' in setNumbers ? '' : (setStrings.effect_on ?? base.effect_on ?? '');
    const taste = catalog.taste;
    let peak = 0, score = 0;
    for (const entry of taste.sensitivities) {
      let raw = ev(entry.key);
      for (const [tagId, rawLevel] of Object.entries(tags)) {
        const lv = Math.max(Number(rawLevel) || 0, 1);
        if (tagId === taste.raw.Tag) {
          if (entry.key === taste.raw.Taste) raw += taste.raw.Flat;
          continue;
        }
        for (const change of taste.modifiers) {
          if (change.Tag === tagId && change.Taste === entry.key)
            raw += change.PerLevel * lv + change.Flat;
        }
      }
      const normalized = raw / entry.value;
      peak = Math.max(peak, Math.abs(normalized));
      score += normalized;
    }
    return {
      energy: potential * expression, digest: Math.max(0, potential * (1 - expression)),
      energyRatio: ev('energy_ratio'),
      health: apply('health', ev('health')), healthRatio: ev('health_ratio'),
      life: apply('life', ev('life')), lifeRatio: ev('life_ratio'),
      fatigue: apply('fatigue', ev('fatigue')), satiety: apply('satiety', ev('satiety')),
      digestive: Math.max(1, apply('digestivetime', Number(base.digestivetime) || 0)),
      water: Boolean(base.water), container: base.effect_container || 'food_ability', seconds,
      buffs: seconds > 0 ? buffs : {}, effect,
      effectLevel: effect ? Math.max(1, Math.round('effect_on_level' in setNumbers ?
        setNumbers.effect_on_level : ev('effect_on_level', 1))) : 0,
      taste: peak > 0.0001 ? score * taste.amplifier : null,
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { tagLevel, itemTags, matches, accepts, resultFor, craftedLevel, cookedTags, craftedTags,
      cookedName, nameGrade, foodEffect };
  }
  if (typeof document === 'undefined') return;

  const root = document.getElementById('food-combinations');
  const source = document.getElementById('food-combinations-data');
  if (!root || !source) return;
  const catalog = JSON.parse(source.textContent);
  const recipeSelect = root.querySelector('[data-recipe]');
  const levelInput = root.querySelector('[data-level]');
  const resultLevelInput = root.querySelector('[data-result-level]');
  const skillLevelInput = root.querySelector('[data-skill-level]');
  const slotBox = root.querySelector('[data-slots]');
  const gradeSelect = root.querySelector('[data-grade]');
  const secondSelect = root.querySelector('[data-second]');
  const secondGradeSelect = root.querySelector('[data-second-grade]');
  const secondSlotBox = root.querySelector('[data-second-slots]');
  const answer = root.querySelector('[data-answer]');

  function fillSlots(recipe, box, omitBase) {
    const level = Number(levelInput.value);
    box.replaceChildren();
    box.dataset.unresolved = 'no';
    if (!recipe) return;
    if (!Number.isInteger(level) || level < 1 || level > 70) {
      answer.textContent = '레벨은 1~70으로 입력하세요.';
      return;
    }
    for (const slot of recipe.slots) {
      if (omitBase && slot.slot_id === 'base') continue;
      const label = document.createElement('label');
      const effectiveMax = Math.max(slot.count_min, slot.count_max);
      label.textContent = `${slot.slot_id} (${slot.count_min}~${effectiveMax}개) `;
      const ids = Object.keys(catalog.items).filter(id => accepts(itemTags(catalog.items[id], level, catalog.tag_levels), slot));
      ids.sort((a, b) => catalog.items[a].name.localeCompare(catalog.items[b].name, 'ko'));
      if (slot.count_min > 0 && !ids.length) {
        box.dataset.unresolved = 'yes';
        const notice = document.createElement('span');
        notice.textContent = ` 추출 자료 미해결: 요구 태그 ${JSON.stringify(slot.required_tags || {})}, ` +
          `재질 ${JSON.stringify(slot.required_materials || {})}, 개수 ${slot.count_min}~${effectiveMax}`;
        label.append(notice);
      }
      if (slot.count_min > slot.count_max) {
        const correction = document.createElement('span');
        correction.textContent = ` 추출본 상한 ${slot.count_max} → 현 게임 보정 ${effectiveMax}`;
        label.append(correction);
      }
      for (let index = 0; index < effectiveMax; index++) {
        const select = document.createElement('select');
        select.dataset.slot = slot.slot_id;
        select.dataset.required = index < slot.count_min ? 'yes' : 'no';
        select.append(new Option(index < slot.count_min ? '재료 선택' : '추가 재료 없음', ''));
        for (const id of ids) select.append(new Option(catalog.items[id].name, id));
        label.append(select);
      }
      box.append(label);
    }
  }

  function renderSlots() {
    fillSlots(catalog.recipes[recipeSelect.value], slotBox, false);
    fillSlots(catalog.recipes[secondSelect.value], secondSlotBox, true);
    answer.textContent = slotBox.dataset.unresolved === 'yes' || secondSlotBox.dataset.unresolved === 'yes' ?
      '추출 자료에서 이 슬롯의 미가공 후보 또는 슬롯 개수 조건을 확인할 수 없습니다. 위 표의 조건을 참고하세요.' :
      '각 재료 칸을 선택하면 결과 음식과 성질을 표시합니다. 도구·작업대·기술 요구는 위 제작법 표를 확인하세요.';
    renderAnswer();
  }

  function renderSecondSlots() {
    fillSlots(catalog.recipes[secondSelect.value], secondSlotBox, true);
    renderAnswer();
  }

  function selectedMaterials(box) {
    const materials = {};
    for (const select of box.querySelectorAll('select')) {
      if (select.dataset.required === 'yes' && !select.value) return null;
      if (select.value) (materials[select.dataset.slot] ||= []).push(select.value);
    }
    return materials;
  }

  function renderAnswer() {
    const recipeId = recipeSelect.value;
    const recipe = catalog.recipes[recipeId];
    const level = Number(levelInput.value);
    if (!recipe || !Number.isInteger(level) || level < 1 || level > 70) return;
    if (slotBox.dataset.unresolved === 'yes' || (secondSelect.value && secondSlotBox.dataset.unresolved === 'yes')) {
      answer.textContent = '이 제작법은 추출 자료의 미가공 후보 또는 슬롯 수 조건이 미해결입니다. 위 표의 요구 조건을 확인하세요.';
      return;
    }
    const materials = selectedMaterials(slotBox);
    if (!materials) return;
    const count = Object.values(materials).reduce((total, ids) => total + ids.length, 0);
    const calculatedLevel = craftedLevel(recipe, Array(count).fill(level),
      Number(skillLevelInput.value), gradeSelect.value === 'great');
    const outputLevel = resultLevelInput.value ? Number(resultLevelInput.value) : calculatedLevel;
    if (!Number.isInteger(outputLevel) || outputLevel < 1 || outputLevel > 70) {
      answer.textContent = '완성 음식 레벨은 1~70으로 입력하세요.';
      return;
    }
    let result = null;
    let tags = null;
    let name = null;
    if (recipe.type === 1) {
      result = materials.base?.[0];
      tags = itemTags(catalog.items[result], level, catalog.tag_levels);
      name = catalog.items[result].name;
      if (catalog.items[result].food || tags.drinkable > 0) {
        const seasoning = materials.seasoning ? itemTags(catalog.items[materials.seasoning[0]], level, catalog.tag_levels) : null;
        const firstGrade = nameGrade(recipeId, gradeSelect.value, tags, catalog);
        name = cookedName(name, recipeId, firstGrade, tags, catalog, materials.eatable?.[0]);
        tags = cookedTags(tags, recipeId, catalog, seasoning, gradeSelect.value);
      }
    } else {
      result = resultFor(recipe, materials, catalog, level);
      if (result) {
        tags = craftedTags(result, recipeId, materials, level, outputLevel, gradeSelect.value, catalog);
        name = catalog.items[result].name;
      }
    }
    if (!result) {
      answer.textContent = '선택한 재료와 일치하는 음식 결과 분기가 없습니다.';
      return;
    }
    let modified = recipe.type === 1 && recipe.deduct ? 1 : 0;
    let remaining = recipe.type === 1 ? 2 - modified : 2;
    if (secondSelect.value) {
      const second = catalog.recipes[secondSelect.value];
      const baseSlot = second.slots.find(slot => slot.slot_id === 'base');
      if (!tags || !catalog.items[result].food || remaining <= 0 ||
          (baseSlot && !accepts(tags, baseSlot))) {
        answer.textContent = '이 결과 음식은 선택한 두 번째 조리의 주재료 조건이나 남은 가공 횟수를 충족하지 않습니다.';
        return;
      }
      const secondMaterials = selectedMaterials(secondSlotBox);
      if (!secondMaterials) return;
      const seasoningId = secondMaterials.seasoning?.[0];
      const seasoning = seasoningId ? itemTags(catalog.items[seasoningId], outputLevel, catalog.tag_levels) : null;
      const secondGrade = nameGrade(secondSelect.value, secondGradeSelect.value, tags, catalog);
      name = cookedName(name, secondSelect.value, secondGrade, tags, catalog, secondMaterials.eatable?.[0]);
      tags = cookedTags(tags, secondSelect.value, catalog, seasoning, secondGradeSelect.value);
      if (second.deduct) { modified++; remaining--; }
    }
    const fmt = value => Number(value).toFixed(1).replace(/\.0$/, '');
    const traits = Object.entries(tags).filter(([id]) => catalog.tags[id]);
    const lines = [`결과: ${name} (${result}) Lv${recipe.type === 1 ? level : outputLevel} +${modified} · 남은 가공 ${remaining}회`,
      recipe.type === 0 ? `결과 레벨: 재료 평균·기술·제작법 범위·대성공을 적용한 ${calculatedLevel}` +
        (resultLevelInput.value ? `, 실제 완성물 입력 ${outputLevel}` : '') : '제자리 조리: 재료 자체의 레벨 유지',
      `음식 성질: ${traits.map(([id, value]) => `${catalog.tags[id].name} Lv${value}`).join(', ') || '없음'}`];
    for (const [id, value] of traits) {
      const modifiers = catalog.tags[id].modifiers;
      for (const [key, rule] of Object.entries(modifiers)) {
        const applied = typeof rule.formula === 'string' && /^[\"'].*[\"']$/.test(rule.formula) ?
          rule.formula.slice(1, -1) : fmt(formula(rule.formula, value, catalog.modifier_formulas));
        lines.push(`${catalog.tags[id].name} Lv${value}: ${effectLabel(key)} ${ruleLabel[rule.function] || rule.function} ${applied}`);
      }
    }
    const effect = foodEffect(result, recipe.type === 1 ? level : outputLevel, tags, catalog);
    if (effect) {
      lines.push(`먹을 때: 즉시 에너지 ${fmt(effect.energy)}, 소화 에너지 ${fmt(effect.digest)}, ` +
        `건강 ${fmt(effect.health)}, 생명 ${fmt(effect.life)}, 피로 ${fmt(effect.fatigue)}, 배부름 ${fmt(effect.satiety)}`);
      lines.push(`에너지/건강/생명 비율 ${fmt(effect.energyRatio)}/${fmt(effect.healthRatio)}/${fmt(effect.lifeRatio)}, ` +
        `소화 시간 ${fmt(effect.digestive)}, 수분 ${effect.water ? '예' : '아니요'}, 효과 용기 ${effect.container}`);
      lines.push(`버프 ${fmt(effect.seconds)}초: ` +
        (Object.entries(effect.buffs).map(([key, value]) => `${effectLabel(key)} ${fmt(value)}`).join(', ') || '없음'));
      lines.push(`상태효과 ${effect.effect || '없음'}${effect.effect ? ' Lv' + effect.effectLevel : ''}, ` +
        `첫 섭취 맛 점수 ${effect.taste == null ? '판정 없음' : fmt(effect.taste)}`);
    }
    answer.textContent = lines.join('\n');
  }

  recipeSelect.addEventListener('change', renderSlots);
  levelInput.addEventListener('change', renderSlots);
  resultLevelInput.addEventListener('change', renderAnswer);
  skillLevelInput.addEventListener('change', renderAnswer);
  secondSelect.addEventListener('change', renderSecondSlots);
  gradeSelect.addEventListener('change', renderAnswer);
  secondGradeSelect.addEventListener('change', renderAnswer);
  slotBox.addEventListener('change', renderAnswer);
  secondSlotBox.addEventListener('change', renderAnswer);
  renderSlots();
}());
