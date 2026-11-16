#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/extract_catalog.py

Extract a pure-Korean Wandering Sword catalog from the verified corpus,
parsed locres JSON files, and UE4 Maps table data, then emit a compact UMD
bundle at src/catalog-data.js.

This script intentionally keeps all runtime strings free of CJK Hanzi and
rich-text markup so the generated catalog can be shipped as-is.
"""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

HANZI_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")
RICH_TAG_RE = re.compile(
    r"<skill_flags[^>]*>|<[A-Za-z0-9_/\s\"=-]+>|</>\s*"
)
VIEW_NAME_RE = re.compile(rb"(\d+)_ViewName\x00")

MAX_USE_RE = re.compile(r"캐릭터당 최대\s*(\d+)")

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "src" / "catalog-data.js"

WIKI_ROOT = REPO_ROOT.parents[1] / "무협위키"
DEFAULT_ENTITIES = WIKI_ROOT / "games/wandering-sword/corpus/ingame-entities-ko.json"
DEFAULT_LOCRES_DIR = WIKI_ROOT / ".local/graph/wandering-sword-data/parsed_locres"
DEFAULT_TABLES_DIR = WIKI_ROOT / ".local/graph/wandering-sword-data/tables"

NOTABLE_COMPANION_IDS = [
    0,
    17012,
    12011,
    12010,
    11509,
    10804,
    10701,
    10309,
    10269,
    10268,
    10221,
    10131,
    10047,
    11708,
    8506,
    8001,
    7502,
    5513,
    19112,
    19703,
    19706,
]

ITEM_BUCKETS = {
    0: "디버그 제외",
    1: "영단·음식",
    2: "장비",
    3: "재료·선물",
    4: "임무·귀중품",
    5: "무공 비급",
    6: "제작 도면",
    7: "기타 물품",
}

ATTRIBUTE_ROWS: List[Tuple[int, str]] = [
    (1, "현재 기혈"),
    (2, "최대 기혈"),
    (3, "현재 진기"),
    (4, "최대 진기"),
    (5, "경지 등급"),
    (6, "역도"),
    (7, "근골"),
    (8, "신법"),
    (9, "공격력"),
    (10, "치명타율"),
    (11, "방어력"),
    (12, "회피율"),
    (13, "이동력"),
    (14, "집기 속도"),
    (15, "권장 숙련"),
    (16, "권장 경험치"),
    (17, "검법 숙련"),
    (18, "검법 경험치"),
    (19, "도법 숙련"),
    (20, "도법 경험치"),
    (21, "암기 숙련"),
    (22, "암기 경험치"),
    (23, "창곤 숙련"),
    (24, "창곤 경험치"),
    (25, "기문 숙련"),
    (26, "기문 경험치"),
    (27, "단조 등급"),
    (28, "단조 경험치"),
    (29, "의술 등급"),
    (30, "의술 경험치"),
    (31, "주량 등급"),
    (32, "주량 경험치"),
    (33, "구변 등급"),
    (34, "구변 경험치"),
    (35, "서화 등급"),
    (36, "서화 경험치"),
    (37, "다도 등급"),
    (38, "다도 경험치"),
    (39, "명성"),
    (40, "기혈 회복률"),
    (41, "진기 회복률"),
    (42, "내공"),
    (43, "실제 방어"),
    (44, "현재 정력"),
    (45, "최대 정력"),
    (46, "기혈 재생 배율"),
    (47, "진기 재생 배율"),
    (48, "수선 등급"),
    (49, "수선 경험치"),
    (50, "치명타 저항"),
    (51, "명중"),
    (52, "피해 배율"),
    (53, "피격 피해 배율"),
    (54, "진기 호막"),
    (55, "도주 성공률"),
    (56, "전폐 획득 배율"),
    (57, "무학 점수 배율"),
    (58, "대지도 이동 속도"),
    (59, "지역 이동 속도"),
    (60, "치명타 피해 배율"),
    (61, "낚시 등급"),
    (62, "낚시 경험치"),
    (63, "요리 등급"),
    (64, "요리 경험치"),
    (65, "연단 등급"),
    (66, "연단 경험치"),
    (67, "채집 등급"),
    (68, "채집 경험치"),
    (69, "진기 소모 배율"),
]


def _load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def normalize_space(text: str) -> str:
    text = text.replace("\r\n", " ").replace("\r", " ").replace("\n", " ")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def strip_markup(text: Any) -> str:
    if text is None:
        return ""
    if not isinstance(text, str):
        text = str(text)
    text = text.replace("\r\n", " ")
    text = RICH_TAG_RE.sub(" ", text)
    text = normalize_space(text)
    return text


def strip_hanzi(text: str) -> str:
    if not text:
        return ""
    return normalize_space(HANZI_RE.sub("", text))


def clean_ko(text: Any) -> str:
    return strip_hanzi(strip_markup(text))


def clean_desc(text: Any) -> str:
    return clean_ko(text)


def parse_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def id_before_underscore(key: str) -> Optional[str]:
    if "_" not in key:
        return None
    left = key.split("_", 1)[0]
    if not left:
        return None
    try:
        int(left)
    except ValueError:
        return None
    return str(int(left))


def sorted_numeric_keys(mapping: Dict[str, Any]) -> List[str]:
    def key_fn(k: str) -> Tuple[int, str]:
        try:
            return (0, str(int(k)).zfill(12))
        except ValueError:
            return (1, k)

    return sorted(mapping.keys(), key=key_fn)


def bucket_for_item(item_id: int, ko_name: str) -> int:
    if item_id < 10 or "치트" in ko_name or "테스트" in ko_name:
        return 0
    if 100 <= item_id <= 999:
        return 1
    if 1000 <= item_id <= 9999:
        return 2
    if 10000 <= item_id <= 11999:
        return 3
    if 12000 <= item_id <= 12999:
        return 4
    if 13000 <= item_id <= 13999:
        return 5
    if 100000 <= item_id <= 100999:
        return 6
    return 7


def skill_category(desc: str) -> str:
    head = desc[:30]
    if "권장" in head:
        return "권장"
    if "검법" in head:
        return "검법"
    if "도법" in head:
        return "도법"
    if "창곤" in head:
        return "창곤"
    if "암기" in head:
        return "암기"
    if "심법" in head:
        return "심법"
    if "경공" in head:
        return "경공"
    return "무학"


def attribute_group(attr_id: int) -> str:
    if (
        1 <= attr_id <= 14
        or 39 <= attr_id <= 45
        or attr_id in (50, 51, 54)
    ):
        return "핵심 전투"
    if 15 <= attr_id <= 26:
        return "무기 수련"
    if (
        27 <= attr_id <= 38
        or attr_id in (48, 49)
        or 61 <= attr_id <= 68
    ):
        return "생활 기예"
    if (
        attr_id in (46, 47)
        or attr_id in (52, 53)
        or 55 <= attr_id <= 60
        or attr_id == 69
    ):
        return "보조·배율"
    return "보조·배율"


def build_attributes() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for attr_id, name in ATTRIBUTE_ROWS:
        rows.append(
            {
                "id": attr_id,
                "name": clean_ko(name),
                "group": attribute_group(attr_id),
                "format": "%d",
            }
        )
    return rows


def read_fstring(data: bytes, pos: int) -> Tuple[str, int]:
    if pos < 0 or pos + 4 > len(data):
        raise ValueError("FString length is out of bounds")
    length = struct.unpack_from("<i", data, pos)[0]
    pos += 4
    if length == 0:
        return "", pos
    if length > 0:
        n = length
        if pos + n > len(data):
            raise ValueError("ANSI FString bytes are out of bounds")
        raw = data[pos : pos + n]
        pos += n
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = raw.decode("latin-1", errors="replace")
        return text.rstrip("\x00"), pos
    n = -length
    byte_len = n * 2
    if pos + byte_len > len(data):
        raise ValueError("UTF-16 FString bytes are out of bounds")
    raw = data[pos : pos + byte_len]
    pos += byte_len
    try:
        text = raw.decode("utf-16-le", errors="replace")
    except Exception:
        text = ""
    return text.rstrip("\x00"), pos


def parse_maps_uasset(path: Path) -> Dict[int, str]:
    data = path.read_bytes()
    if len(data) < 24:
        return {}
    try:
        magic, legacy_ver, legacy_ue3, fv_ue4, fv_lic, custom_cnt = struct.unpack_from(
            "<iiiiii", data, 0
        )
    except struct.error:
        return {}
    del magic, legacy_ver, legacy_ue3, fv_ue4, fv_lic

    pos = 24 + custom_cnt * 20
    if pos < 0 or pos + 4 > len(data):
        return {}
    try:
        total_hdr_size = struct.unpack_from("<i", data, pos)[0]
    except struct.error:
        return {}
    del total_hdr_size
    pos += 4

    try:
        _folder, pos = read_fstring(data, pos)
    except ValueError:
        return {}

    if pos + 12 > len(data):
        return {}
    try:
        pkg_flags, name_cnt, name_off = struct.unpack_from("<Iii", data, pos)
    except struct.error:
        return {}
    del pkg_flags

    if name_cnt <= 0 or name_off < 0 or name_off >= len(data):
        return {}

    names: List[str] = []
    npos = name_off
    for _ in range(name_cnt):
        try:
            name, npos = read_fstring(data, npos)
        except ValueError:
            break
        if npos + 4 > len(data):
            break
        npos += 4
        names.append(name)

    lv_set: Dict[int, str] = {}
    for idx, name in enumerate(names):
        if "LV_" not in name:
            continue
        code = name.split("/")[-1].split(".")[0]
        if code:
            lv_set[idx] = code
    return lv_set


def build_map_codes(
    lv_set: Dict[int, str],
    uexp_path: Path,
    map_views: Dict[str, str],
) -> Dict[str, str]:
    map_codes: Dict[str, str] = {}
    try:
        uexp = uexp_path.read_bytes()
    except OSError:
        uexp = b""

    if uexp and lv_set:
        for match in VIEW_NAME_RE.finditer(uexp):
            try:
                map_id = int(match.group(1))
            except ValueError:
                continue
            map_key = str(map_id)
            if map_key not in map_views:
                continue

            start = match.start()
            end = match.end()
            scan_start = max(0, start - 200)
            scan_end = min(len(uexp), end + 250)

            best_off: Optional[int] = None
            best_code: Optional[str] = None
            for off in range(scan_start, max(scan_start, scan_end - 7)):
                try:
                    ni, zero = struct.unpack_from("<ii", uexp, off)
                except struct.error:
                    continue
                if zero != 0 or ni not in lv_set:
                    continue
                if best_off is None or abs(off - start) < abs(best_off - start):
                    best_off = off
                    best_code = lv_set[ni]

            if best_code:
                map_codes[best_code] = map_views[map_key]

    map_codes.setdefault("LV_World", "세계 지도")
    map_codes.setdefault("LV_WuDang_P", "무당파")
    return map_codes


def build_entities(entities: Dict[str, Any]) -> Dict[str, Any]:
    items_raw = entities.get("items", [])
    skills_raw = entities.get("skills", [])
    npcs_raw = entities.get("named_npcs", [])

    items: Dict[str, List[Any]] = {}
    for row in items_raw:
        if not isinstance(row, dict):
            continue
        item_id = parse_int(row.get("item_id"), -1)
        if item_id < 0:
            continue
        ko_name = clean_ko(row.get("ko", ""))
        if not ko_name:
            ko_name = "물품 #" + str(item_id)

        raw_desc = row.get("desc_ko", "")
        clean_description = clean_desc(raw_desc)
        max_use = 0
        if isinstance(raw_desc, str):
            match = MAX_USE_RE.search(raw_desc)
            if match:
                max_use = parse_int(match.group(1), 0)

        bucket = bucket_for_item(item_id, ko_name)
        short_desc = clean_description[:90]
        items[str(item_id)] = [ko_name, bucket, max_use, short_desc]

    skills: Dict[str, List[str]] = {}
    for row in skills_raw:
        if not isinstance(row, dict):
            continue
        skill_id = parse_int(row.get("skill_id"), -1)
        if skill_id < 0:
            continue
        ko_name = clean_ko(row.get("ko", ""))
        if not ko_name:
            ko_name = "무공 #" + str(skill_id)

        raw_desc = row.get("desc_ko", "")
        clean_description = clean_desc(raw_desc)
        cat = skill_category(raw_desc if isinstance(raw_desc, str) else "")
        skills[str(skill_id)] = [ko_name, cat, clean_description[:80]]

    npcs: Dict[str, str] = {}
    for row in npcs_raw:
        if not isinstance(row, dict):
            continue
        npc_id = parse_int(row.get("npc_id"), -1)
        if npc_id < 0:
            continue
        name = clean_ko(row.get("ko", ""))
        if not name:
            name = "강호 인물 #" + str(npc_id)
        npcs[str(npc_id)] = name

    npcs["0"] = "우문일"

    notable_companions: List[int] = []
    seen_comp = set()
    for npc_id in NOTABLE_COMPANION_IDS:
        key = str(npc_id)
        if key in npcs and npc_id not in seen_comp:
            notable_companions.append(npc_id)
            seen_comp.add(npc_id)

    return {
        "items": items,
        "skills": skills,
        "npcs": npcs,
        "notableCompanions": notable_companions,
    }


def build_mounts(mounts_doc: Dict[str, Any]) -> Dict[str, str]:
    mounts: Dict[str, str] = {}
    mount_section = mounts_doc.get("Mount", {})
    if isinstance(mount_section, dict):
        for key, value in mount_section.items():
            if not isinstance(key, str) or not key.endswith("_Description"):
                continue
            mount_id = key.split("_", 1)[0]
            if not mount_id:
                continue
            try:
                mount_id = str(int(mount_id))
            except ValueError:
                continue
            ko = ""
            if isinstance(value, dict):
                ko = clean_ko(value.get("ko", ""))
            if not ko:
                ko = "탈것 #" + mount_id
            mounts[mount_id] = ko

    mounts["9"] = "검독수리"
    mounts.setdefault("0", "미장착")
    return mounts


def build_guilds_and_views(maps_doc: Dict[str, Any]) -> Tuple[Dict[str, str], Dict[str, str]]:
    guilds: Dict[str, str] = {}
    map_views: Dict[str, str] = {}

    guild_section = maps_doc.get("Guilds", {})
    if isinstance(guild_section, dict):
        for key, value in guild_section.items():
            if not isinstance(key, str) or not key.endswith("_Name"):
                continue
            guild_id = key.split("_", 1)[0]
            try:
                guild_id = str(int(guild_id))
            except ValueError:
                continue
            ko = ""
            if isinstance(value, dict):
                ko = clean_ko(value.get("ko", ""))
            if not ko:
                ko = "문파 #" + guild_id
            guilds[guild_id] = ko

    maps_section = maps_doc.get("Maps", {})
    if isinstance(maps_section, dict):
        for key, value in maps_section.items():
            if not isinstance(key, str) or not key.endswith("_ViewName"):
                continue
            map_id = key.split("_", 1)[0]
            try:
                map_id = str(int(map_id))
            except ValueError:
                continue
            ko = ""
            if isinstance(value, dict):
                ko = clean_ko(value.get("ko", ""))
            if not ko:
                ko = "지역 #" + map_id
            map_views[map_id] = ko

    return guilds, map_views


def build_system(system_doc: Dict[str, Any]) -> Dict[str, Any]:
    meridians: Dict[str, Dict[str, Any]] = {}
    inherits: Dict[str, str] = {}
    recipes: Dict[str, Dict[str, str]] = {
        "alchemy": {},
        "cooking": {},
        "fusion": {},
    }

    jingmais = system_doc.get("JingMais", {})
    if isinstance(jingmais, dict):
        meridian_names: Dict[str, str] = {}
        meridian_descs: Dict[str, str] = {}
        for key, value in jingmais.items():
            if not isinstance(key, str):
                continue
            for suffix, bucket in (("_ViewName", meridian_names), ("_Description", meridian_descs)):
                if key.endswith(suffix):
                    try:
                        meridian_id = str(int(key.split("_", 1)[0]))
                    except ValueError:
                        break
                    bucket[meridian_id] = clean_ko(value.get("ko", "")) if isinstance(value, dict) else ""
                    break

        all_ids = set(meridian_names) | set(meridian_descs)
        for meridian_id in all_ids:
            try:
                numeric_id = int(meridian_id)
            except ValueError:
                continue
            name = meridian_names.get(meridian_id, "")
            desc = meridian_descs.get(meridian_id, "")
            if not name:
                name = "경혈 #" + meridian_id
            meridians[str(numeric_id)] = {
                "name": name,
                "desc": desc,
                "maxLevel": 0 if numeric_id <= 6 else 3,
            }

    inherit_section = system_doc.get("Inherit", {})
    if isinstance(inherit_section, dict):
        for key, value in inherit_section.items():
            if not isinstance(key, str) or not key.endswith("_Name"):
                continue
            inherit_id = key.split("_", 1)[0]
            try:
                inherit_id = str(int(inherit_id))
            except ValueError:
                continue
            ko = ""
            if isinstance(value, dict):
                ko = clean_ko(value.get("ko", ""))
            if not ko:
                ko = "전승 #" + inherit_id
            inherits[inherit_id] = ko
    inherits.setdefault("6", "구판 전승")

    recipe_sections = [
        ("Alchemy", "alchemy", "_RecipeName"),
        ("Cooking", "cooking", "_RecipeName"),
        ("Fusions", "fusion", "_Name"),
    ]
    for source_key, target_key, suffix in recipe_sections:
        section = system_doc.get(source_key, {})
        if not isinstance(section, dict):
            continue
        for key, value in section.items():
            if not isinstance(key, str) or not key.endswith(suffix):
                continue
            recipe_id = key[: -len(suffix)]
            try:
                recipe_id = str(int(recipe_id))
            except ValueError:
                continue
            ko = ""
            if isinstance(value, dict):
                ko = clean_ko(value.get("ko", ""))
            if not ko:
                ko = "제작법 #" + recipe_id
            recipes[target_key][recipe_id] = ko

    return {
        "meridians": meridians,
        "inherits": inherits,
        "recipes": recipes,
    }


def build_catalog(
    entities_path: Path,
    locres_dir: Path,
    tables_dir: Path,
) -> Dict[str, Any]:
    entities_doc = _load_json(entities_path)
    if not isinstance(entities_doc, dict):
        raise ValueError("entities JSON root must be an object")

    entity_catalog = build_entities(entities_doc)

    mounts_doc = _load_json(locres_dir / "mounts.json")
    if not isinstance(mounts_doc, dict):
        mounts_doc = {}
    mounts = build_mounts(mounts_doc)

    maps_doc = _load_json(locres_dir / "maps_and_guilds.json")
    if not isinstance(maps_doc, dict):
        maps_doc = {}
    guilds, map_views = build_guilds_and_views(maps_doc)

    lv_set = parse_maps_uasset(tables_dir / "Maps.uasset")
    map_codes = build_map_codes(lv_set, tables_dir / "Maps.uexp", map_views)

    system_doc = _load_json(locres_dir / "system.json")
    if not isinstance(system_doc, dict):
        system_doc = {}
    system_catalog = build_system(system_doc)

    catalog: Dict[str, Any] = {
        "version": 1,
        "game": "일검풍운결",
        "gameKo": "일검풍운결",
        "attributes": build_attributes(),
        "itemBuckets": {str(k): v for k, v in ITEM_BUCKETS.items()},
        "items": entity_catalog["items"],
        "skills": entity_catalog["skills"],
        "npcs": entity_catalog["npcs"],
        "notableCompanions": entity_catalog["notableCompanions"],
        "mounts": mounts,
        "guilds": guilds,
        "mapViews": map_views,
        "mapCodes": map_codes,
        "meridians": system_catalog["meridians"],
        "inherits": system_catalog["inherits"],
        "recipes": system_catalog["recipes"],
    }
    return catalog


def js_data_json(catalog: Dict[str, Any]) -> str:
    return json.dumps(
        catalog,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def build_js(catalog: Dict[str, Any], template_path: Path = DEFAULT_OUT) -> str:
    source_path = template_path if template_path.exists() else DEFAULT_OUT
    template = source_path.read_text(encoding="utf-8")
    marker = "var DATA = "
    start = template.index(marker) + len(marker)
    _, end = json.JSONDecoder().raw_decode(template, start)
    return template[:start] + js_data_json(catalog) + template[end:]


def validate_generated_text(text: str) -> Tuple[bool, List[str]]:
    errors: List[str] = []
    hanzi = HANZI_RE.findall(text)
    if hanzi:
        errors.append("CJK Hanzi found: " + "".join(hanzi[:20]))
    tags = RICH_TAG_RE.findall(text)
    if tags:
        errors.append("rich-text markup found: " + repr(tags[:10]))
    return (not errors, errors)


def check_only(out_path: Path) -> int:
    if not out_path.exists():
        print("CHECK FAILED: output file does not exist: " + str(out_path))
        return 1
    try:
        text = out_path.read_text(encoding="utf-8")
    except OSError as exc:
        print("CHECK FAILED: cannot read output file: " + str(exc))
        return 1

    ok = True
    errors: List[str] = []

    marker = "var DATA = "
    idx = text.find(marker)
    if idx < 0:
        errors.append("embedded DATA marker not found")
        ok = False
    else:
        json_start = idx + len(marker)
        decoder = json.JSONDecoder()
        try:
            _objs, consumed = decoder.raw_decode(text, json_start)
            if consumed <= json_start:
                errors.append("embedded JSON could not be parsed")
                ok = False
        except json.JSONDecodeError as exc:
            errors.append("embedded JSON parse error: " + str(exc))
            ok = False

    purity_ok, purity_errors = validate_generated_text(text)
    if not purity_ok:
        ok = False
        errors.extend(purity_errors)

    if ok:
        print("CHECK OK: " + str(out_path))
        print("bytes=" + str(len(text.encode("utf-8"))) + " hanzi=0 tags=0")
        return 0

    print("CHECK FAILED: " + str(out_path))
    for msg in errors:
        print("  - " + msg)
    return 1


def print_summary(catalog: Dict[str, Any], out_path: Path, js: str) -> None:
    print("Wandering Sword catalog extracted")
    print("  out: " + str(out_path))
    print("  bytes: " + str(len(js.encode("utf-8"))))
    print("  attributes: " + str(len(catalog.get("attributes", []))))
    print("  items: " + str(len(catalog.get("items", {}))))
    print("  skills: " + str(len(catalog.get("skills", {}))))
    print("  npcs: " + str(len(catalog.get("npcs", {}))))
    print("  mounts: " + str(len(catalog.get("mounts", {}))))
    print("  guilds: " + str(len(catalog.get("guilds", {}))))
    print("  mapViews: " + str(len(catalog.get("mapViews", {}))))
    print("  mapCodes: " + str(len(catalog.get("mapCodes", {}))))
    print("  meridians: " + str(len(catalog.get("meridians", {}))))
    print("  inherits: " + str(len(catalog.get("inherits", {}))))
    print(
        "  recipes: alchemy="
        + str(len(catalog.get("recipes", {}).get("alchemy", {})))
        + " cooking="
        + str(len(catalog.get("recipes", {}).get("cooking", {})))
        + " fusion="
        + str(len(catalog.get("recipes", {}).get("fusion", {})))
    )
    print("  notableCompanions: " + str(len(catalog.get("notableCompanions", []))))


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract the pure-Korean Wandering Sword catalog bundle."
    )
    parser.add_argument(
        "--entities",
        default=str(DEFAULT_ENTITIES),
        help="Path to ingame-entities-ko.json",
    )
    parser.add_argument(
        "--locres-dir",
        default=str(DEFAULT_LOCRES_DIR),
        help="Directory containing parsed_locres JSON files",
    )
    parser.add_argument(
        "--tables-dir",
        default=str(DEFAULT_TABLES_DIR),
        help="Directory containing Maps.uasset and Maps.uexp",
    )
    parser.add_argument(
        "--out",
        default=str(DEFAULT_OUT),
        help="Output path for src/catalog-data.js",
    )
    parser.add_argument(
        "--check-only",
        action="store_true",
        help="Validate an existing catalog-data.js without reading external sources",
    )
    return parser.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    out_path = Path(args.out).expanduser().resolve()

    if args.check_only:
        return check_only(out_path)

    entities_path = Path(args.entities).expanduser()
    locres_dir = Path(args.locres_dir).expanduser()
    tables_dir = Path(args.tables_dir).expanduser()

    try:
        catalog = build_catalog(entities_path, locres_dir, tables_dir)
    except Exception as exc:
        print("ERROR: failed to extract catalog: " + str(exc), file=sys.stderr)
        return 1

    js = build_js(catalog, out_path)
    valid, errors = validate_generated_text(js)
    if not valid:
        print("ERROR: generated catalog failed purity gate", file=sys.stderr)
        for msg in errors:
            print("  - " + msg, file=sys.stderr)
        return 1

    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        out_path.write_text(js, encoding="utf-8")
    except OSError as exc:
        print("ERROR: cannot write output file: " + str(exc), file=sys.stderr)
        return 1

    print_summary(catalog, out_path, js)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
