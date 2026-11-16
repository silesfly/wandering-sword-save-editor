#!/usr/bin/env python3
"""일검풍운결 (Wandering Sword) 세이브 에디터 v1.0 — 표준 라이브러리 전용 CLI 및 로컬 보안 서버."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import random
import re
import secrets
import stat
import struct
import subprocess
import sys
import threading
import time
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
SLOT_CLASS = "/Script/JH.JHSaveGame"
CONFIG_CLASS = "/Script/JH.JHSaveGameConfig"
OPAQUE_PROPS = {"Quests", "JHGatherSpecs", "WorldWalkNPCInfos", "MonsterNPCInfos"}
MAX_INT32 = 2147483647
MAX_FAVOR = 100
MAX_SKILL_LEVEL = 10
MAX_SAVE_BYTES = 64 * 1024 * 1024

PRESETS: dict[str, dict[str, str]] = {
    "wealth_max": {
        "label": "최대 재화·수련치",
        "target": "slot",
        "desc": "엽전 9,999,999, 주인공 무학 점수 999,999 이상, 경맥 점수 99,999 이상으로 설정합니다.",
    },
    "hero_cultivation": {
        "label": "주인공 대성 수련",
        "target": "slot",
        "desc": "주인공의 기혈·진기·내공·공방·삼재 능력치와 내공 상한을 대성 수치로 끌어올립니다.",
    },
    "party_favor_max": {
        "label": "동료 호감도 100",
        "target": "slot",
        "desc": "현재 대열 동료와 주인공 사이의 양방향 호감도를 모두 100으로 설정합니다.",
    },
    "skills_lv10": {
        "label": "습득 무공 10식",
        "target": "slot",
        "desc": "주인공과 현재 대열 동료의 습득 무공 등급을 모두 10식으로 올립니다.",
    },
    "unlock_mounts_recipes": {
        "label": "탈것·도안 전체 해금",
        "target": "slot",
        "desc": "탈것 10종과 연단·요리·단조 도안을 모두 해금합니다.",
    },
    "reset_pill_limits": {
        "label": "복용 제한 초기화",
        "target": "slot",
        "desc": "모든 인물의 영단·음식 복용 횟수 제한 기록을 초기화합니다.",
    },
    "config_score_max": {
        "label": "전승 점수·특전 해금",
        "target": "config",
        "desc": "전역 설정 세이브의 전승 점수를 99,999로 올리고 추천 전승 특전을 해금합니다.",
    },
}


class BinReader:
    def __init__(self, buf: bytes):
        self.buf = buf
        self.pos = 0

    def rem(self) -> int:
        return len(self.buf) - self.pos

    def bytes(self, n: int) -> bytes:
        if n < 0 or self.pos + n > len(self.buf):
            raise ValueError("세이브 파일이 손상되었거나 길이가 부족합니다.")
        out = self.buf[self.pos : self.pos + n]
        self.pos += n
        return out

    def u8(self) -> int:
        return self.bytes(1)[0]

    def u16(self) -> int:
        return struct.unpack("<H", self.bytes(2))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self.bytes(4))[0]

    def u32(self) -> int:
        return struct.unpack("<I", self.bytes(4))[0]

    def i64(self) -> int:
        return struct.unpack("<q", self.bytes(8))[0]

    def u64(self) -> int:
        return struct.unpack("<Q", self.bytes(8))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self.bytes(4))[0]

    def f32_raw(self) -> tuple[float, int]:
        raw = self.bytes(4)
        u = struct.unpack("<I", raw)[0]
        f = struct.unpack("<f", raw)[0]
        return f, u

    def fstr(self) -> tuple[str, str]:
        n = self.i32()
        if n == 0:
            return ("", "empty")
        if n > 0:
            raw = self.bytes(n)
            if raw[-1:] != b"\x00":
                raise ValueError("세이브 문자열 종단 바이트가 올바르지 않습니다.")
            return (raw[:-1].decode("latin1"), "latin1")
        count = -n
        if count > len(self.buf):
            raise ValueError("세이브 유니코드 문자열 길이가 비정상적입니다.")
        raw = self.bytes(count * 2)
        if raw[-2:] != b"\x00\x00":
            raise ValueError("세이브 유니코드 문자열 종단 바이트가 올바르지 않습니다.")
        try:
            return (raw[:-2].decode("utf-16-le"), "utf16")
        except UnicodeDecodeError as exc:
            raise ValueError("세이브 문자열 인코딩이 올바르지 않습니다.") from exc


class BinWriter:
    def __init__(self):
        self.parts: list[bytes] = []

    def to_bytes(self) -> bytes:
        return b"".join(self.parts)

    def bytes(self, b: bytes) -> None:
        self.parts.append(b)

    def u8(self, v: int) -> None:
        self.parts.append(struct.pack("<B", int(v) & 0xFF))

    def u16(self, v: int) -> None:
        self.parts.append(struct.pack("<H", int(v) & 0xFFFF))

    def i32(self, v: int) -> None:
        self.parts.append(struct.pack("<i", int(v)))

    def u32(self, v: int) -> None:
        self.parts.append(struct.pack("<I", int(v)))

    def i64(self, v: int) -> None:
        self.parts.append(struct.pack("<q", int(v)))

    def u64(self, v: int) -> None:
        self.parts.append(struct.pack("<Q", int(v)))

    def f32_bits(self, u: int) -> None:
        self.parts.append(struct.pack("<I", int(u) & 0xFFFFFFFF))

    def f32(self, v: float) -> None:
        self.parts.append(struct.pack("<f", float(v)))

    def fstr(self, s: str, enc: str | None = None) -> None:
        if s == "" and enc in (None, "empty"):
            self.i32(0)
            return
        if enc == "latin1" or (enc is None and all(ord(c) < 128 for c in s)):
            try:
                raw = s.encode("latin1") + b"\x00"
                if enc == "latin1" or all(ord(c) < 128 for c in s):
                    self.i32(len(raw))
                    self.bytes(raw)
                    return
            except UnicodeEncodeError:
                pass
        raw = s.encode("utf-16-le") + b"\x00\x00"
        self.i32(-(len(raw) // 2))
        self.bytes(raw)


def _check(cond: bool, msg: str = "세이브 파일 구조가 올바르지 않습니다.") -> None:
    if not cond:
        raise ValueError(msg)


def read_map_scalar_or_struct(r: BinReader, t: str) -> Any:
    if t == "IntProperty":
        return r.i32()
    if t in ("BoolProperty", "ByteProperty"):
        return r.u8()
    if t == "FloatProperty":
        return r.f32_raw()
    if t in ("StrProperty", "NameProperty"):
        return r.fstr()
    if t == "StructProperty":
        return read_prop_list(r)
    raise ValueError("지원하지 않는 맵 속성 형식입니다.")


def write_map_scalar_or_struct(w: BinWriter, t: str, val: Any) -> None:
    if t == "IntProperty":
        w.i32(val)
    elif t in ("BoolProperty", "ByteProperty"):
        w.u8(val)
    elif t == "FloatProperty":
        w.f32_bits(val[1])
    elif t in ("StrProperty", "NameProperty"):
        w.fstr(val[0], val[1])
    elif t == "StructProperty":
        write_prop_list(w, val)
    else:
        raise ValueError("지원하지 않는 맵 속성 형식입니다.")


def read_struct_body(r: BinReader, sname: str) -> Any:
    if sname in ("Vector", "Rotator"):
        return [r.f32_raw(), r.f32_raw(), r.f32_raw()]
    if sname == "DateTime":
        return r.i64()
    if sname == "Guid":
        return r.bytes(16)
    if sname == "IntPoint":
        return [r.i32(), r.i32()]
    return read_prop_list(r)


def write_struct_body(w: BinWriter, sname: str, val: Any) -> None:
    if sname in ("Vector", "Rotator"):
        for _, bits in val:
            w.f32_bits(bits)
    elif sname == "DateTime":
        w.i64(val)
    elif sname == "Guid":
        w.bytes(val)
    elif sname == "IntPoint":
        w.i32(val[0])
        w.i32(val[1])
    else:
        write_prop_list(w, val)


def read_prop_list(r: BinReader) -> list[dict[str, Any]]:
    props: list[dict[str, Any]] = []
    while True:
        name, name_enc = r.fstr()
        if name == "None":
            props.append({"name": "None", "name_enc": name_enc})
            break
        ptype, ptype_enc = r.fstr()
        size = r.i64()
        _check(size >= 0, "속성 크기 정보가 손상되었습니다.")
        p: dict[str, Any] = {"name": name, "name_enc": name_enc, "type": ptype, "type_enc": ptype_enc, "size": size}
        if name in OPAQUE_PROPS:
            if ptype == "ArrayProperty":
                p["elem_type"], p["elem_enc"] = r.fstr()
                p["guid_flag"] = r.u8()
                p["opaque"] = r.bytes(size)
            elif ptype == "MapProperty":
                p["key_type"] = r.fstr()
                p["val_type"] = r.fstr()
                p["guid_flag"] = r.u8()
                p["opaque"] = r.bytes(size)
            else:
                raise ValueError("보존 영역 속성 형식이 예상과 다릅니다.")
            props.append(p)
            continue
        if ptype == "IntProperty":
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            p["val"] = r.i32()
        elif ptype == "UInt32Property":
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            p["val"] = r.u32()
        elif ptype == "Int64Property":
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            p["val"] = r.i64()
        elif ptype == "FloatProperty":
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            f, u = r.f32_raw()
            p["val"] = f
            p["val_bits"] = u
        elif ptype == "BoolProperty":
            p["val"] = r.u8()
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
        elif ptype in ("StrProperty", "NameProperty"):
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            s, senc = r.fstr()
            p["val"] = s
            p["val_enc"] = senc
        elif ptype == "ByteProperty":
            enum_name, enum_enc = r.fstr()
            p["enum_name"] = enum_name
            p["enum_enc"] = enum_enc
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            if enum_name == "None":
                p["val"] = r.u8()
            else:
                v, venc = r.fstr()
                p["val"] = v
                p["val_enc"] = venc
        elif ptype == "EnumProperty":
            enum_name, enum_enc = r.fstr()
            p["enum_name"] = enum_name
            p["enum_enc"] = enum_enc
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            v, venc = r.fstr()
            p["val"] = v
            p["val_enc"] = venc
        elif ptype == "StructProperty":
            sname, senc = r.fstr()
            p["struct_name"] = sname
            p["struct_enc"] = senc
            p["struct_guid"] = r.bytes(16)
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            start = r.pos
            p["val"] = read_struct_body(r, sname)
            _check(r.pos - start == size, "구조체 속성 길이가 일치하지 않습니다.")
        elif ptype == "ArrayProperty":
            elem_type, elem_enc = r.fstr()
            p["elem_type"] = elem_type
            p["elem_enc"] = elem_enc
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            start = r.pos
            count = r.i32()
            _check(count >= 0, "배열 요소 개수가 올바르지 않습니다.")
            p["count"] = count
            if elem_type == "ByteProperty":
                p["raw_bytes"] = r.bytes(count)
            elif elem_type == "IntProperty":
                p["items"] = [r.i32() for _ in range(count)]
            elif elem_type in ("StrProperty", "NameProperty"):
                p["items"] = [r.fstr() for _ in range(count)]
            elif elem_type == "StructProperty":
                inner_name, inner_enc = r.fstr()
                inner_type, inner_tenc = r.fstr()
                inner_size = r.i64()
                sname, senc = r.fstr()
                sguid = r.bytes(16)
                sgflag = r.u8()
                _check(sgflag == 0)
                p["struct_header"] = {
                    "name": (inner_name, inner_enc),
                    "type": (inner_type, inner_tenc),
                    "size": inner_size,
                    "struct_name": (sname, senc),
                    "guid": sguid,
                }
                body_start = r.pos
                p["items"] = [read_struct_body(r, sname) for _ in range(count)]
                _check(r.pos - body_start == inner_size, "구조체 배열 길이가 일치하지 않습니다.")
            else:
                raise ValueError("지원하지 않는 배열 요소 형식입니다.")
            _check(r.pos - start == size, "배열 속성 길이가 일치하지 않습니다.")
        elif ptype == "SetProperty":
            elem_type, elem_enc = r.fstr()
            p["elem_type"] = elem_type
            p["elem_enc"] = elem_enc
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            start = r.pos
            removed_count = r.i32()
            _check(removed_count == 0)
            count = r.i32()
            _check(count >= 0, "집합 요소 개수가 올바르지 않습니다.")
            if elem_type == "IntProperty":
                p["items"] = [r.i32() for _ in range(count)]
            elif elem_type in ("NameProperty", "StrProperty"):
                p["items"] = [r.fstr() for _ in range(count)]
            else:
                raise ValueError("지원하지 않는 집합 요소 형식입니다.")
            _check(r.pos - start == size, "집합 속성 길이가 일치하지 않습니다.")
        elif ptype == "MapProperty":
            kt, kenc = r.fstr()
            vt, venc = r.fstr()
            p["key_type"] = (kt, kenc)
            p["val_type"] = (vt, venc)
            p["guid_flag"] = r.u8()
            _check(p["guid_flag"] == 0)
            start = r.pos
            removed_count = r.i32()
            _check(removed_count == 0)
            count = r.i32()
            _check(count >= 0, "맵 항목 개수가 올바르지 않습니다.")
            entries = []
            for _ in range(count):
                k = read_map_scalar_or_struct(r, kt)
                v = read_map_scalar_or_struct(r, vt)
                entries.append((k, v))
            p["entries"] = entries
            _check(r.pos - start == size, "맵 속성 길이가 일치하지 않습니다.")
        else:
            raise ValueError("알 수 없는 세이브 속성 형식입니다.")
        props.append(p)
    return props


def write_prop_list(w: BinWriter, props: list[dict[str, Any]]) -> None:
    for p in props:
        w.fstr(p["name"], p.get("name_enc"))
        if p["name"] == "None":
            return
        ptype = p["type"]
        w.fstr(ptype, p.get("type_enc"))
        if "opaque" in p:
            raw_op = p["opaque"]
            w.i64(len(raw_op))
            if ptype == "ArrayProperty":
                w.fstr(p["elem_type"], p.get("elem_enc"))
                w.u8(0)
            elif ptype == "MapProperty":
                w.fstr(p["key_type"][0], p["key_type"][1])
                w.fstr(p["val_type"][0], p["val_type"][1])
                w.u8(0)
            w.bytes(raw_op)
            continue
        if ptype == "IntProperty":
            w.i64(4)
            w.u8(0)
            w.i32(p["val"])
        elif ptype == "UInt32Property":
            w.i64(4)
            w.u8(0)
            w.u32(p["val"])
        elif ptype == "Int64Property":
            w.i64(8)
            w.u8(0)
            w.i64(p["val"])
        elif ptype == "FloatProperty":
            w.i64(4)
            w.u8(0)
            if "val_bits" in p:
                w.f32_bits(p["val_bits"])
            else:
                w.f32(p["val"])
        elif ptype == "BoolProperty":
            w.i64(0)
            w.u8(p["val"])
            w.u8(0)
        elif ptype in ("StrProperty", "NameProperty"):
            bw = BinWriter()
            bw.fstr(p["val"], p.get("val_enc"))
            payload = bw.to_bytes()
            w.i64(len(payload))
            w.u8(0)
            w.bytes(payload)
        elif ptype == "ByteProperty":
            w_enum = p["enum_name"]
            if w_enum == "None":
                w.i64(1)
                w.fstr(w_enum, p.get("enum_enc"))
                w.u8(0)
                w.u8(p["val"])
            else:
                bw = BinWriter()
                bw.fstr(p["val"], p.get("val_enc"))
                payload = bw.to_bytes()
                w.i64(len(payload))
                w.fstr(w_enum, p.get("enum_enc"))
                w.u8(0)
                w.bytes(payload)
        elif ptype == "EnumProperty":
            bw = BinWriter()
            bw.fstr(p["val"], p.get("val_enc"))
            payload = bw.to_bytes()
            w.i64(len(payload))
            w.fstr(p["enum_name"], p.get("enum_enc"))
            w.u8(0)
            w.bytes(payload)
        elif ptype == "StructProperty":
            bw = BinWriter()
            write_struct_body(bw, p["struct_name"], p["val"])
            payload = bw.to_bytes()
            w.i64(len(payload))
            w.fstr(p["struct_name"], p.get("struct_enc"))
            w.bytes(p["struct_guid"])
            w.u8(0)
            w.bytes(payload)
        elif ptype == "ArrayProperty":
            elem_type = p["elem_type"]
            bw = BinWriter()
            if elem_type == "ByteProperty":
                bw.i32(len(p["raw_bytes"]))
                bw.bytes(p["raw_bytes"])
            elif elem_type == "IntProperty":
                bw.i32(len(p["items"]))
                for x in p["items"]:
                    bw.i32(x)
            elif elem_type in ("StrProperty", "NameProperty"):
                bw.i32(len(p["items"]))
                for s, senc in p["items"]:
                    bw.fstr(s, senc)
            elif elem_type == "StructProperty":
                sh = p["struct_header"]
                sname, senc = sh["struct_name"]
                ibw = BinWriter()
                for item in p["items"]:
                    write_struct_body(ibw, sname, item)
                ibytes = ibw.to_bytes()
                bw.i32(len(p["items"]))
                bw.fstr(sh["name"][0], sh["name"][1])
                bw.fstr(sh["type"][0], sh["type"][1])
                bw.i64(len(ibytes))
                bw.fstr(sname, senc)
                bw.bytes(sh["guid"])
                bw.u8(0)
                bw.bytes(ibytes)
            payload = bw.to_bytes()
            w.i64(len(payload))
            w.fstr(elem_type, p.get("elem_enc"))
            w.u8(0)
            w.bytes(payload)
        elif ptype == "SetProperty":
            elem_type = p["elem_type"]
            bw = BinWriter()
            bw.i32(0)
            bw.i32(len(p["items"]))
            if elem_type == "IntProperty":
                for x in p["items"]:
                    bw.i32(x)
            elif elem_type in ("NameProperty", "StrProperty"):
                for s, senc in p["items"]:
                    bw.fstr(s, senc)
            payload = bw.to_bytes()
            w.i64(len(payload))
            w.fstr(elem_type, p.get("elem_enc"))
            w.u8(0)
            w.bytes(payload)
        elif ptype == "MapProperty":
            kt, kenc = p["key_type"]
            vt, venc = p["val_type"]
            bw = BinWriter()
            bw.i32(0)
            bw.i32(len(p["entries"]))
            for k, v in p["entries"]:
                write_map_scalar_or_struct(bw, kt, k)
                write_map_scalar_or_struct(bw, vt, v)
            payload = bw.to_bytes()
            w.i64(len(payload))
            w.fstr(kt, kenc)
            w.fstr(vt, venc)
            w.u8(0)
            w.bytes(payload)


def read_item(r: BinReader, ver: int) -> dict[str, Any]:
    guid = [r.i32(), r.i32(), r.i32(), r.i32()]
    table_id = r.i32()
    count = r.i32()
    flag44 = r.i32()
    na = r.i32()
    _check(0 <= na <= 1024, "장비 부가 속성 개수가 비정상적입니다.")
    aff_a = [(r.u8(), r.i32(), r.f32_raw()) for _ in range(na)]
    nb = r.i32()
    _check(0 <= nb <= 1024, "장비 보조 속성 개수가 비정상적입니다.")
    aff_b = [(r.u8(), r.i32(), r.f32_raw()) for _ in range(nb)]
    f68 = r.i32() if ver >= 6 else 0
    flag45 = r.i32() if ver >= 9 else 0
    flag46 = r.i32() if ver >= 10 else 0
    return {
        "guid": guid,
        "table_id": table_id,
        "count": count,
        "flag44": flag44,
        "aff_a": aff_a,
        "aff_b": aff_b,
        "f68": f68,
        "flag45": flag45,
        "flag46": flag46,
    }


def write_item(w: BinWriter, it: dict[str, Any], ver: int) -> None:
    for g in it["guid"]:
        w.i32(g)
    w.i32(it["table_id"])
    w.i32(it["count"])
    w.i32(it["flag44"])
    w.i32(len(it["aff_a"]))
    for t, i, (_, bits) in it["aff_a"]:
        w.u8(t)
        w.i32(i)
        w.f32_bits(bits)
    w.i32(len(it["aff_b"]))
    for t, i, (_, bits) in it["aff_b"]:
        w.u8(t)
        w.i32(i)
        w.f32_bits(bits)
    if ver >= 6:
        w.i32(it["f68"])
    if ver >= 9:
        w.i32(it["flag45"])
    if ver >= 10:
        w.i32(it["flag46"])


def _read_count(r: BinReader, limit: int = 100000) -> int:
    n = r.i32()
    _check(0 <= n <= limit, "인물 배열 길이가 비정상적입니다.")
    return n


def read_npc(r: BinReader, ver: int) -> dict[str, Any]:
    npc_id = r.i32()
    f3c = r.i32()
    f200 = r.i32()
    attrs = [(r.u8(), r.f32_raw()) for _ in range(_read_count(r, 1024))]
    arr_a0 = [(r.i32(), r.i32(), r.i32(), r.i32(), r.i32()) for _ in range(_read_count(r))]
    map_b0 = [(r.i32(), r.i32(), r.i32(), r.i32(), r.i32()) for _ in range(_read_count(r))]
    map_110 = [(r.i32(), r.u8()) for _ in range(_read_count(r))]
    map_160 = [(r.i32(), r.u8()) for _ in range(_read_count(r))]
    map_1b0 = [(r.i32(), r.i32()) for _ in range(_read_count(r))]
    f204 = r.i32()
    items_78 = [read_item(r, ver) for _ in range(_read_count(r))]
    items_90 = [read_item(r, ver) for _ in range(_read_count(r))]
    cname = r.fstr()
    s208 = {
        "ints": [r.i32(), r.i32(), r.i32()],
        "name": r.fstr(),
        "bools": [r.i32(), r.i32(), r.i32()],
        "byte": r.u8(),
    }
    map_230 = [(r.i32(), r.i32()) for _ in range(_read_count(r))] if ver >= 2 else []
    arr_280 = [(r.i32(), r.u8(), r.i32()) for _ in range(_read_count(r))] if ver >= 4 else []
    f88 = r.i32() if ver >= 11 else 0
    arr_100 = [r.i32() for _ in range(_read_count(r))] if ver >= 12 else []
    arr_50 = [r.fstr() for _ in range(_read_count(r))] if ver >= 13 else []
    f40 = r.i32() if ver >= 14 else 0
    return {
        "npc_id": npc_id,
        "f3c": f3c,
        "f200": f200,
        "attrs": attrs,
        "arr_a0": arr_a0,
        "map_b0": map_b0,
        "map_110": map_110,
        "map_160": map_160,
        "map_1b0": map_1b0,
        "f204": f204,
        "items_78": items_78,
        "items_90": items_90,
        "cname": cname,
        "s208": s208,
        "map_230": map_230,
        "arr_280": arr_280,
        "f88": f88,
        "arr_100": arr_100,
        "arr_50": arr_50,
        "f40": f40,
    }


def write_npc(w: BinWriter, n: dict[str, Any], ver: int) -> None:
    w.i32(n["npc_id"])
    w.i32(n["f3c"])
    w.i32(n["f200"])
    w.i32(len(n["attrs"]))
    for aid, (_, bits) in n["attrs"]:
        w.u8(aid)
        w.f32_bits(bits)
    w.i32(len(n["arr_a0"]))
    for t in n["arr_a0"]:
        for x in t:
            w.i32(x)
    w.i32(len(n["map_b0"]))
    for t in n["map_b0"]:
        for x in t:
            w.i32(x)
    w.i32(len(n["map_110"]))
    for k, v in n["map_110"]:
        w.i32(k)
        w.u8(v)
    w.i32(len(n["map_160"]))
    for k, v in n["map_160"]:
        w.i32(k)
        w.u8(v)
    w.i32(len(n["map_1b0"]))
    for k, v in n["map_1b0"]:
        w.i32(k)
        w.i32(v)
    w.i32(n["f204"])
    w.i32(len(n["items_78"]))
    for it in n["items_78"]:
        write_item(w, it, ver)
    w.i32(len(n["items_90"]))
    for it in n["items_90"]:
        write_item(w, it, ver)
    w.fstr(n["cname"][0], n["cname"][1])
    for x in n["s208"]["ints"]:
        w.i32(x)
    w.fstr(n["s208"]["name"][0], n["s208"]["name"][1])
    for x in n["s208"]["bools"]:
        w.i32(x)
    w.u8(n["s208"]["byte"])
    if ver >= 2:
        w.i32(len(n["map_230"]))
        for k, v in n["map_230"]:
            w.i32(k)
            w.i32(v)
    if ver >= 4:
        w.i32(len(n["arr_280"]))
        for a, b, c in n["arr_280"]:
            w.i32(a)
            w.u8(b)
            w.i32(c)
    if ver >= 11:
        w.i32(n["f88"])
    if ver >= 12:
        w.i32(len(n["arr_100"]))
        for x in n["arr_100"]:
            w.i32(x)
    if ver >= 13:
        w.i32(len(n["arr_50"]))
        for s, senc in n["arr_50"]:
            w.fstr(s, senc)
    if ver >= 14:
        w.i32(n["f40"])


def decode_inner_bytes(inner: bytes, ver: int) -> dict[str, Any]:
    r = BinReader(inner)
    magic = r.bytes(4)
    _check(magic == b"GVAS", "유효한 세이브 헤더가 아닙니다.")
    sg_ver = r.i32()
    pkg_ver = r.i32()
    eng_maj = r.u16()
    eng_min = r.u16()
    eng_patch = r.u16()
    eng_changelist = r.u32()
    eng_branch = r.fstr()
    cv_fmt = r.i32()
    cv_count = _read_count(r, 4096)
    cvs = [(r.bytes(16), r.i32()) for _ in range(cv_count)]
    cls_name = r.fstr()
    if cls_name[0] == SLOT_CLASS:
        pre_field: int | None = r.i32()
        props = read_prop_list(r)
        post_zero = r.i32()
        items = [read_item(r, ver) for _ in range(_read_count(r, 500000))]
        npcs = [read_npc(r, ver) for _ in range(_read_count(r, 200000))]
    elif cls_name[0] == CONFIG_CLASS:
        pre_field = None
        props = read_prop_list(r)
        post_zero = r.i32()
        items = []
        npcs = []
    else:
        raise ValueError("지원하지 않는 일검풍운결 세이브 클래스입니다.")
    _check(r.rem() == 0, "세이브 파일 끝에 해석되지 않은 잔여 바이트가 있습니다.")
    return {
        "ver": ver,
        "magic": "GVAS",
        "sg_ver": sg_ver,
        "pkg_ver": pkg_ver,
        "eng_maj": eng_maj,
        "eng_min": eng_min,
        "eng_patch": eng_patch,
        "eng_changelist": eng_changelist,
        "eng_branch": eng_branch,
        "cv_fmt": cv_fmt,
        "cvs": cvs,
        "cls": cls_name[0],
        "cls_enc": cls_name[1],
        "pre_field": pre_field,
        "props": props,
        "post_zero": post_zero,
        "items": items,
        "npcs": npcs,
    }


def decode_sav_bytes(raw: bytes) -> dict[str, Any]:
    if not isinstance(raw, (bytes, bytearray)) or len(raw) < 8:
        raise ValueError("세이브 파일 크기가 너무 작거나 형식이 올바르지 않습니다.")
    if len(raw) > MAX_SAVE_BYTES:
        raise ValueError("세이브 파일 크기가 허용 범위를 벗어났습니다.")
    raw_bytes = bytes(raw)
    ver = struct.unpack_from("<i", raw_bytes, 0)[0]
    _check(1 <= ver <= 30, "세이브 버전이 허용 범위(1~30)를 벗어났습니다.")
    if ver > 5:
        _check(len(raw_bytes) >= 12, "압축 세이브 헤더 길이가 부족합니다.")
        uncomp_size, comp_size = struct.unpack_from("<ii", raw_bytes, 4)
        _check(uncomp_size > 0 and comp_size > 0, "압축 세이브 크기 정보가 손상되었습니다.")
        _check(uncomp_size <= MAX_SAVE_BYTES, "세이브 압축 해제 크기가 허용 범위를 벗어났습니다.")
        _check(12 + comp_size == len(raw_bytes), "압축 데이터 길이가 헤더와 일치하지 않습니다.")
        try:
            dobj = zlib.decompressobj()
            inner = dobj.decompress(raw_bytes[12:], MAX_SAVE_BYTES + 1)
        except zlib.error as exc:
            raise ValueError("세이브 압축 해제에 실패했습니다.") from exc
        _check(
            dobj.eof and not dobj.unconsumed_tail and len(inner) <= MAX_SAVE_BYTES,
            "세이브 압축 해제 크기가 허용 범위를 벗어났습니다.",
        )
        _check(not dobj.unused_data, "압축 스트림 뒤에 잔여 바이트가 남아 있습니다.")
        _check(len(inner) == uncomp_size, "압축 해제된 크기가 헤더와 일치하지 않습니다.")
    else:
        inner = raw_bytes[4:]
    return decode_inner_bytes(inner, ver)


def encode_inner_bytes(doc: dict[str, Any]) -> bytes:
    ver = int(doc["ver"])
    w = BinWriter()
    w.bytes(b"GVAS")
    w.i32(doc["sg_ver"])
    w.i32(doc["pkg_ver"])
    w.u16(doc["eng_maj"])
    w.u16(doc["eng_min"])
    w.u16(doc["eng_patch"])
    w.u32(doc["eng_changelist"])
    w.fstr(doc["eng_branch"][0], doc["eng_branch"][1])
    w.i32(doc["cv_fmt"])
    w.i32(len(doc["cvs"]))
    for g, v in doc["cvs"]:
        w.bytes(g)
        w.i32(v)
    w.fstr(doc["cls"], doc.get("cls_enc", "latin1"))
    if doc.get("pre_field") is not None:
        w.i32(doc["pre_field"])
    write_prop_list(w, doc["props"])
    w.i32(doc.get("post_zero", 0))
    if doc["cls"] == SLOT_CLASS:
        w.i32(len(doc["items"]))
        for it in doc["items"]:
            write_item(w, it, ver)
        w.i32(len(doc["npcs"]))
        for np in doc["npcs"]:
            write_npc(w, np, ver)
    return w.to_bytes()


def encode_sav_bytes(doc: dict[str, Any]) -> bytes:
    ver = int(doc["ver"])
    inner = encode_inner_bytes(doc)
    if ver > 5:
        comp = zlib.compress(inner)
        return struct.pack("<iii", ver, len(inner), len(comp)) + comp
    return struct.pack("<i", ver) + inner


_CATALOG_CACHE: dict[str, dict[str, Any]] = {}


def load_catalog(root_dir: str = ROOT_DIR) -> dict[str, Any]:
    key = os.path.abspath(root_dir)
    if key in _CATALOG_CACHE:
        return _CATALOG_CACHE[key]
    p = os.path.join(key, "src", "catalog-data.js")
    if os.path.exists(p):
        with open(p, "r", encoding="utf-8") as f:
            s = f.read()
    else:
        h = os.path.join(key, "dist", "WanderingSwordSaveEditor-v1.0.html")
        if not os.path.exists(h):
            raise FileNotFoundError("카탈로그 데이터 파일을 찾을 수 없습니다.")
        with open(h, "r", encoding="utf-8") as f:
            s = f.read()
    m = re.search(r"var\s+DATA\s*=\s*(\{.*?\})\s*;", s, re.S)
    if not m:
        raise ValueError("카탈로그 데이터를 읽지 못했습니다.")
    data = json.loads(m.group(1))
    _CATALOG_CACHE[key] = data
    return data


def find_prop(props: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    for p in props:
        if p.get("name") == name:
            return p
    return None


def _insert_before_none(props: list[dict[str, Any]], prop: dict[str, Any]) -> dict[str, Any]:
    for idx in range(len(props) - 1, -1, -1):
        if props[idx].get("name") == "None":
            props.insert(idx, prop)
            return prop
    props.append(prop)
    props.append({"name": "None", "name_enc": "latin1"})
    return prop


def ensure_int_prop(props: list[dict[str, Any]], name: str, default: int = 0) -> dict[str, Any]:
    p = find_prop(props, name)
    if p is None:
        p = {
            "name": name,
            "name_enc": "latin1",
            "type": "IntProperty",
            "type_enc": "latin1",
            "guid_flag": 0,
            "val": int(default),
        }
        _insert_before_none(props, p)
    return p


def _ensure_int_collection_prop(props: list[dict[str, Any]], name: str, prop_type: str) -> dict[str, Any]:
    p = find_prop(props, name)
    if p is None:
        p = {
            "name": name,
            "name_enc": "latin1",
            "type": prop_type,
            "type_enc": "latin1",
            "elem_type": "IntProperty",
            "elem_enc": "latin1",
            "guid_flag": 0,
            "items": [],
        }
        _insert_before_none(props, p)
    p.setdefault("items", [])
    return p


def ensure_array_int_prop(props: list[dict[str, Any]], name: str) -> dict[str, Any]:
    return _ensure_int_collection_prop(props, name, "ArrayProperty")


def ensure_set_int_prop(props: list[dict[str, Any]], name: str) -> dict[str, Any]:
    return _ensure_int_collection_prop(props, name, "SetProperty")


def f32_pair(val: float) -> tuple[float, int]:
    fv = float(val)
    b = struct.unpack("<I", struct.pack("<f", fv))[0]
    return fv, b


def clamp_int(val: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(val)))


def validate_doc(doc: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if doc.get("magic") != "GVAS":
        errors.append("세이브 헤더 식별값이 올바르지 않습니다.")
    ver = doc.get("ver")
    if not isinstance(ver, int) or not 1 <= ver <= 30:
        errors.append("세이브 버전이 1~30 범위를 벗어났습니다.")
    cls = doc.get("cls")
    if cls not in (SLOT_CLASS, CONFIG_CLASS):
        errors.append("지원하지 않는 세이브 클래스입니다.")
    props = doc.get("props")
    if not isinstance(props, list):
        errors.append("속성 목록이 배열이 아닙니다.")
        props = []
    elif not any(p.get("name") == "None" for p in props):
        errors.append("속성 목록 끝에 종료 항목이 없습니다.")
    if cls == SLOT_CLASS:
        for it in doc.get("items") or []:
            cnt = it.get("count", 0)
            if not isinstance(cnt, int) or not 1 <= cnt <= MAX_INT32:
                errors.append("가방 물품 수량이 허용 범위를 벗어났습니다.")
                break
        for npc in doc.get("npcs") or []:
            m110 = npc.get("map_110") or []
            if any(not isinstance(v, int) or not 0 <= v <= 255 for _, v in m110):
                errors.append("인물 호감도가 0~255 범위를 벗어났습니다.")
                break
            a0 = npc.get("arr_a0") or []
            if any(not isinstance(x[1], int) or not 0 <= x[1] <= 20 for x in a0):
                errors.append("무공 등급이 0~20 범위를 벗어났습니다.")
                break
    return {"valid": len(errors) == 0, "errors": errors, "warnings": warnings}


def assert_valid_doc(doc: dict[str, Any]) -> dict[str, Any]:
    verdict = validate_doc(doc)
    if not verdict["valid"]:
        raise ValueError("; ".join(verdict["errors"]))
    return verdict


def _npc_name(cat: dict[str, Any], npc_id: int) -> str:
    if int(npc_id) == 0:
        return "우문일"
    return str((cat.get("npcs") or {}).get(str(npc_id)) or f"강호 인물 #{npc_id}")


def _mount_name(cat: dict[str, Any], mount_id: int) -> str:
    if int(mount_id) <= 0:
        return "미장착"
    return str((cat.get("mounts") or {}).get(str(mount_id)) or f"탈것 #{mount_id}")


def _map_name(cat: dict[str, Any], raw_map: Any) -> str:
    if raw_map is None or str(raw_map) == "":
        return "미상 지역"
    key = str(raw_map)
    codes = cat.get("mapCodes") or {}
    views = cat.get("mapViews") or {}
    if key in codes:
        return str(codes[key])
    if key in views:
        return str(views[key])
    return "강호 지역"


def _inherit_name(cat: dict[str, Any], inherit_id: int) -> str:
    return str((cat.get("inherits") or {}).get(str(inherit_id)) or f"전승 #{inherit_id}")


def _format_play_time(sec: Any) -> str:
    total = max(0, int(sec or 0))
    hours = total // 3600
    minutes = (total % 3600) // 60
    return f"{hours}시간 {minutes:02d}분"


def _prop_val(props: list[dict[str, Any]], name: str, default: Any = None) -> Any:
    p = find_prop(props, name)
    return p.get("val", default) if p is not None else default


def inspect_doc(doc: dict[str, Any], cat: dict[str, Any]) -> dict[str, Any]:
    is_config = doc.get("cls") == CONFIG_CLASS
    props = doc.get("props") or []
    out: dict[str, Any] = {
        "saveType": "전역 설정 저장" if is_config else "일반 슬롯 저장",
        "saveVersion": doc.get("ver"),
        "isConfig": is_config,
    }
    if is_config:
        ids = list((find_prop(props, "InheritIds") or {}).get("items") or [])
        out["score"] = int(_prop_val(props, "Score", 0) or 0)
        out["inheritIds"] = ids
        out["inheritNames"] = [_inherit_name(cat, int(i)) for i in ids]
        out["pictorialCount"] = len((find_prop(props, "PictorialBookIds") or {}).get("items") or [])
        out["skillArchiveCount"] = len((find_prop(props, "SkillIds") or {}).get("items") or [])
        out["itemArchiveCount"] = len((find_prop(props, "ItemIds") or {}).get("items") or [])
        out["endingCount"] = len((find_prop(props, "EndingIds") or {}).get("items") or [])
        return out

    raw_map = _prop_val(props, "MapName", None)
    if raw_map is None:
        raw_map = _prop_val(props, "MapCode", "")
    sec = int(_prop_val(props, "SaveGameTime", 0) or 0)
    tm = str(_prop_val(props, "TurnMode", "ETurnMode::RealTime"))
    out["mapNameKo"] = _map_name(cat, raw_map)
    out["saveGameTime"] = sec
    out["playTimeText"] = _format_play_time(sec)
    out["turnModeKo"] = "턴제 전투" if "TurnBased" in tm else "실시간 전투"
    out["money"] = int(_prop_val(props, "Money", 0) or 0)
    mp = find_prop(props, "MountIds")
    mount_ids = [int(mid) for mid, _ in (mp.get("entries") or [])] if mp else []
    sel = int(_prop_val(props, "SelectedMountId", 0) or 0)
    out["selectedMountId"] = sel
    out["selectedMountName"] = _mount_name(cat, sel)
    out["unlockedMountCount"] = len(mount_ids)
    out["bagItemCount"] = len(doc.get("items") or [])
    out["npcCount"] = len(doc.get("npcs") or [])
    team_ids = [int(x) for x in ((find_prop(props, "TeamInfos") or {}).get("items") or [])]
    out["teamIds"] = team_ids
    out["teamNames"] = [_npc_name(cat, tid) for tid in team_ids]
    npcs = doc.get("npcs") or []
    hero = next((n for n in npcs if n.get("npc_id") == 0), npcs[0] if npcs else {})
    attrs = dict(hero.get("attrs") or [])

    def av(aid: int) -> int:
        v = attrs.get(aid)
        val = v[0] if isinstance(v, tuple) else (v if v is not None else 0)
        return int(round(float(val)))

    out["hero"] = {
        "name": _npc_name(cat, int(hero.get("npc_id", 0))),
        "skillExp": int(hero.get("f200", 0)),
        "jingMaiPoint": int(hero.get("f204", 0)),
        "addNeiGongLimit": int(hero.get("f3c", 0)),
        "hp": av(1),
        "maxHp": av(2),
        "mp": av(3),
        "maxMp": av(4),
        "inner": av(42),
        "atk": av(9),
        "def": av(11),
        "skillCount": len(hero.get("arr_a0") or []),
        "meridianCount": sum(1 for m in (hero.get("map_b0") or []) if m[3] != 0),
    }
    return out


def format_inspect_korean(info: dict[str, Any], file_path: str, sha256_hex: str) -> str:
    lines = [
        f"파일 경로: {file_path}",
        f"무결성 해시: {sha256_hex}",
        f"세이브 구분: {info['saveType']} (버전 {info['saveVersion']})",
    ]
    if info["isConfig"]:
        inherits = ", ".join(info["inheritNames"]) if info["inheritNames"] else "없음"
        lines.extend(
            [
                f"전승 점수: {info['score']:,}",
                f"활성 전승 특전: {inherits}",
                f"도감 기록: 도감 {info['pictorialCount']}종 / 무공 {info['skillArchiveCount']}종 / 물품 {info['itemArchiveCount']}종 / 결말 {info['endingCount']}종",
            ]
        )
        return "\n".join(lines)
    hero = info["hero"]
    team_str = ", ".join(info["teamNames"]) if info["teamNames"] else "우문일 단독"
    lines.extend(
        [
            f"현재 지역: {info['mapNameKo']} | 플레이 시간: {info['playTimeText']} | 전투 방식: {info['turnModeKo']}",
            f"보유 엽전: {info['money']:,} | 장착 탈것: {info['selectedMountName']} (해금 {info['unlockedMountCount']}종)",
            f"가방 물품: {info['bagItemCount']}칸 | 기록 인물: {info['npcCount']}명 | 현재 대열: {team_str}",
            (
                f"주인공 ({hero['name']}): 기혈 {hero['hp']}/{hero['maxHp']}, 진기 {hero['mp']}/{hero['maxMp']}, "
                f"내공 {hero['inner']} (상한 추가 +{hero['addNeiGongLimit']}), 공격력 {hero['atk']}, 방어력 {hero['def']}"
            ),
            (
                f"수련 현황: 무학 점수 {hero['skillExp']:,}, 경맥 점수 {hero['jingMaiPoint']:,}, "
                f"습득 무공 {hero['skillCount']}종, 개통 혈도 {hero['meridianCount']}개"
            ),
        ]
    )
    return "\n".join(lines)


def _find_npc(doc: dict[str, Any], npc_id: int) -> dict[str, Any] | None:
    target = int(npc_id)
    for n in doc.get("npcs") or []:
        if int(n.get("npc_id", -1)) == target:
            return n
    return None


def _set_npc_attr_min(npc: dict[str, Any], aid: int, min_val: float) -> None:
    attrs = list(npc.get("attrs") or [])
    for idx, (cur_id, (cur_f, _)) in enumerate(attrs):
        if int(cur_id) == aid:
            if float(cur_f) < min_val:
                attrs[idx] = (aid, f32_pair(min_val))
            npc["attrs"] = attrs
            return
    attrs.append((aid, f32_pair(min_val)))
    npc["attrs"] = attrs


def _set_favor_oneway(owner: dict[str, Any], other_id: int, val: int) -> None:
    fv = clamp_int(val, 0, MAX_FAVOR)
    oid = int(other_id)
    m110 = list(owner.get("map_110") or [])
    for idx, (k, _) in enumerate(m110):
        if int(k) == oid:
            m110[idx] = (oid, fv)
            owner["map_110"] = m110
            return
    m110.append((oid, fv))
    owner["map_110"] = m110


def _set_favor_bidirectional(doc: dict[str, Any], a_id: int, b_id: int, val: int) -> None:
    if int(a_id) == int(b_id):
        return
    na = _find_npc(doc, a_id)
    nb = _find_npc(doc, b_id)
    if na is None or nb is None:
        return
    _set_favor_oneway(na, b_id, val)
    _set_favor_oneway(nb, a_id, val)


def _make_mount_entry(mid: int) -> tuple[int, list[dict[str, Any]]]:
    return (
        int(mid),
        [
            {
                "name": "MountId",
                "name_enc": "latin1",
                "type": "IntProperty",
                "type_enc": "latin1",
                "guid_flag": 0,
                "val": int(mid),
            },
            {"name": "None", "name_enc": "latin1"},
        ],
    )


def _unlock_all_mounts(props: list[dict[str, Any]], cat: dict[str, Any]) -> None:
    mp = find_prop(props, "MountIds")
    if mp is None:
        mp = {
            "name": "MountIds",
            "name_enc": "latin1",
            "type": "MapProperty",
            "type_enc": "latin1",
            "key_type": ("IntProperty", "latin1"),
            "val_type": ("StructProperty", "latin1"),
            "guid_flag": 0,
            "entries": [],
        }
        _insert_before_none(props, mp)
    existing = {int(k): v for k, v in (mp.get("entries") or [])}
    mount_ids = sorted(int(k) for k in (cat.get("mounts") or {}) if str(k).isdigit() and int(k) > 0) or list(range(1, 11))
    for mid in mount_ids:
        if mid not in existing:
            existing[mid] = _make_mount_entry(mid)[1]
    mp["entries"] = [(mid, existing[mid]) for mid in sorted(existing)]
    sel = ensure_int_prop(props, "SelectedMountId", 0)
    if int(sel.get("val", 0)) <= 0 and mount_ids:
        sel["val"] = mount_ids[0]


def _unlock_all_recipes(props: list[dict[str, Any]], cat: dict[str, Any]) -> None:
    recipes = cat.get("recipes") or {}
    mapping = (
        ("AlchemyRecipes", recipes.get("alchemy") or {}),
        ("CookingRecipes", recipes.get("cooking") or {}),
        ("FusionRecipes", recipes.get("fusion") or {}),
    )
    for prop_name, table in mapping:
        p = ensure_array_int_prop(props, prop_name)
        merged = {int(x) for x in (p.get("items") or [])}
        for k in table:
            if str(k).lstrip("-").isdigit() and int(k) > 0:
                merged.add(int(k))
        p["items"] = sorted(merged)


def _unlock_npc_meridians(npc: dict[str, Any], cat: dict[str, Any]) -> None:
    meridians = cat.get("meridians") or {}
    cur_list = list(npc.get("map_b0") or [])
    by_id: dict[int, tuple[int, int, int, int, int]] = {}
    order: list[int] = []
    for entry in cur_list:
        mid = int(entry[1] if entry[1] else entry[0])
        by_id[mid] = entry
        if mid not in order:
            order.append(mid)
    for k in sorted((int(x) for x in meridians if str(x).isdigit() and int(x) > 0)):
        max_lv = int((meridians.get(str(k)) or {}).get("maxLevel") or 0)
        if k in by_id:
            old = by_id[k]
            by_id[k] = (k, k, max(int(old[2]), max_lv), 1, 1)
        else:
            by_id[k] = (k, k, max_lv, 1, 1)
            order.append(k)
    npc["map_b0"] = [by_id[mid] for mid in order]
    npc["f204"] = max(int(npc.get("f204", 0)), 9999)


def _add_bag_item(doc: dict[str, Any], cat: dict[str, Any], table_id: int, count: int) -> None:
    tid = int(table_id)
    row = (cat.get("items") or {}).get(str(tid))
    if row is None:
        raise ValueError(f"카탈로그에 없는 물품 번호입니다: {tid}")
    bucket = int(row[1])
    if bucket == 0:
        raise ValueError("디버그 전용 물품은 추가할 수 없습니다.")
    add_cnt = clamp_int(count, 1, 1 if bucket == 2 else MAX_INT32)
    items = doc.setdefault("items", [])
    if bucket != 2:
        for it in items:
            if int(it["table_id"]) == tid and int(it["flag44"]) == 0:
                it["count"] = clamp_int(int(it["count"]) + add_cnt, 1, MAX_INT32)
                return
    seed = 1
    for it in items:
        if it.get("guid") and int(it["guid"][0]) >= seed:
            seed = int(it["guid"][0]) + 1
    items.append(
        {
            "guid": [seed, 0, 0, 0],
            "table_id": tid,
            "count": add_cnt,
            "flag44": 0,
            "aff_a": [],
            "aff_b": [],
            "f68": 0,
            "flag45": 0,
            "flag46": 0,
        }
    )


def _add_or_set_skill(npc: dict[str, Any], cat: dict[str, Any], skill_id: int, level: int) -> None:
    sid = int(skill_id)
    if sid <= 0 or sid == 8:
        raise ValueError("추가할 수 없는 무공 번호입니다.")
    if str(sid) not in (cat.get("skills") or {}):
        raise ValueError(f"카탈로그에 없는 무공 번호입니다: {sid}")
    lv = clamp_int(level, 1, MAX_SKILL_LEVEL)
    skills = list(npc.get("arr_a0") or [])
    for idx, entry in enumerate(skills):
        if int(entry[0]) == sid:
            skills[idx] = (sid, lv, int(entry[2]), int(entry[3]), int(entry[4]))
            npc["arr_a0"] = skills
            return
    skills.append((sid, lv, -1, 1, 0))
    npc["arr_a0"] = skills


def apply_preset_doc(doc: dict[str, Any], preset_id: str, cat: dict[str, Any]) -> None:
    if preset_id not in PRESETS:
        raise ValueError(f"알 수 없는 프리셋입니다: {preset_id}")
    target = PRESETS[preset_id]["target"]
    is_config = doc.get("cls") == CONFIG_CLASS
    if (target == "config") != is_config:
        raise ValueError("현재 세이브 종류에 적용할 수 없는 프리셋입니다.")
    props = doc["props"]
    if preset_id == "wealth_max":
        ensure_int_prop(props, "Money", 0)["val"] = 9999999
        hero = _find_npc(doc, 0)
        if hero is not None:
            hero["f200"] = max(int(hero.get("f200", 0)), 999999)
            hero["f204"] = max(int(hero.get("f204", 0)), 99999)
    elif preset_id == "hero_cultivation":
        hero = _find_npc(doc, 0)
        if hero is None:
            raise ValueError("주인공 데이터를 찾을 수 없습니다.")
        targets = {1: 9999, 2: 9999, 3: 9999, 4: 9999, 6: 500, 7: 500, 8: 500, 9: 1500, 11: 1500, 42: 2000, 44: 999, 45: 999}
        for aid, tval in targets.items():
            _set_npc_attr_min(hero, aid, float(tval))
        hero["f3c"] = max(int(hero.get("f3c", 0)), 9999)
    elif preset_id == "party_favor_max":
        team_ids = [int(x) for x in ((find_prop(props, "TeamInfos") or {}).get("items") or [])]
        for tid in team_ids:
            if tid != 0:
                _set_favor_bidirectional(doc, tid, 0, MAX_FAVOR)
            for other in team_ids:
                if tid != other:
                    _set_favor_bidirectional(doc, tid, other, MAX_FAVOR)
    elif preset_id == "skills_lv10":
        team_ids = [int(x) for x in ((find_prop(props, "TeamInfos") or {}).get("items") or [])]
        for nid in [0] + team_ids:
            npc = _find_npc(doc, nid)
            if npc is not None:
                npc["arr_a0"] = [(a, MAX_SKILL_LEVEL, c, d, e) for a, _, c, d, e in (npc.get("arr_a0") or [])]
    elif preset_id == "unlock_mounts_recipes":
        _unlock_all_mounts(props, cat)
        _unlock_all_recipes(props, cat)
    elif preset_id == "reset_pill_limits":
        for npc in doc.get("npcs") or []:
            npc["map_230"] = []
    elif preset_id == "config_score_max":
        ensure_int_prop(props, "Score", 0)["val"] = 99999
        inh = ensure_set_int_prop(props, "InheritIds")
        existing = [int(x) for x in (inh.get("items") or [])]
        nxt = [1, 2, 3, 4, 5] + ([6] if 6 in existing else []) + [7, 8, 9]
        inh["items"] = list(dict.fromkeys(nxt))


def apply_cli_edits(doc: dict[str, Any], args: Any, cat: dict[str, Any]) -> None:
    for pid in getattr(args, "preset", None) or []:
        apply_preset_doc(doc, pid, cat)
    props = doc["props"]
    is_config = doc.get("cls") == CONFIG_CLASS

    if getattr(args, "score", None) is not None:
        if not is_config:
            raise ValueError("전승 점수는 전역 설정 세이브(JHSaveConfig.sav)에서만 수정할 수 있습니다.")
        ensure_int_prop(props, "Score", 0)["val"] = clamp_int(args.score, 0, MAX_INT32)

    slot_flags_used = any(
        [
            getattr(args, "money", None) is not None,
            bool(getattr(args, "turn_mode", None)),
            getattr(args, "skill_exp", None) is not None,
            getattr(args, "meridian_points", None) is not None,
            getattr(args, "neigong_limit", None) is not None,
            bool(getattr(args, "add_item", None)),
            bool(getattr(args, "add_skill", None)),
            getattr(args, "favor_all", None) is not None,
            bool(getattr(args, "unlock_mounts", False)),
            bool(getattr(args, "unlock_recipes", False)),
            bool(getattr(args, "unlock_meridians", False)),
        ]
    )
    if is_config and slot_flags_used:
        raise ValueError("일반 슬롯 전용 편집 옵션은 전역 설정 세이브에 사용할 수 없습니다.")

    if getattr(args, "money", None) is not None:
        ensure_int_prop(props, "Money", 0)["val"] = clamp_int(args.money, 0, MAX_INT32)
    if getattr(args, "turn_mode", None):
        p = find_prop(props, "TurnMode")
        if p is None:
            p = {
                "name": "TurnMode",
                "name_enc": "latin1",
                "type": "EnumProperty",
                "type_enc": "latin1",
                "enum_name": "ETurnMode",
                "enum_enc": "latin1",
                "guid_flag": 0,
                "val": "ETurnMode::RealTime",
                "val_enc": "latin1",
            }
            _insert_before_none(props, p)
        p["val"] = "ETurnMode::TurnBased" if args.turn_mode == "turnbased" else "ETurnMode::RealTime"
        p["val_enc"] = "latin1"

    hero = _find_npc(doc, 0)
    if hero is not None:
        if getattr(args, "skill_exp", None) is not None:
            hero["f200"] = clamp_int(args.skill_exp, 0, MAX_INT32)
        if getattr(args, "meridian_points", None) is not None:
            hero["f204"] = clamp_int(args.meridian_points, 0, MAX_INT32)
        if getattr(args, "neigong_limit", None) is not None:
            hero["f3c"] = clamp_int(args.neigong_limit, 0, MAX_INT32)
        for spec in getattr(args, "add_skill", None) or []:
            if ":" not in spec:
                raise ValueError("무공 추가 형식은 번호:등급 이어야 합니다.")
            sid_s, lv_s = spec.split(":", 1)
            _add_or_set_skill(hero, cat, int(sid_s), int(lv_s))
        if getattr(args, "unlock_meridians", False):
            _unlock_npc_meridians(hero, cat)

    for spec in getattr(args, "add_item", None) or []:
        if ":" not in spec:
            raise ValueError("물품 추가 형식은 번호:수량 이어야 합니다.")
        iid_s, cnt_s = spec.split(":", 1)
        _add_bag_item(doc, cat, int(iid_s), int(cnt_s))

    if getattr(args, "favor_all", None) is not None:
        fv = clamp_int(args.favor_all, 0, MAX_FAVOR)
        team_ids = [int(x) for x in ((find_prop(props, "TeamInfos") or {}).get("items") or [])]
        for tid in team_ids:
            if tid != 0:
                _set_favor_bidirectional(doc, tid, 0, fv)
        for npc in doc.get("npcs") or []:
            if int(npc.get("npc_id", 0)) != 0 and npc.get("map_110"):
                npc["map_110"] = [(k, fv if int(k) == 0 else v) for k, v in npc["map_110"]]
        if hero is not None and hero.get("map_110"):
            hero["map_110"] = [(k, fv) for k, _ in hero["map_110"]]

    if getattr(args, "unlock_mounts", False):
        _unlock_all_mounts(props, cat)
    if getattr(args, "unlock_recipes", False):
        _unlock_all_recipes(props, cat)


def is_game_running() -> bool:
    if os.environ.get("WS_SIMULATE_GAME_RUNNING") == "1":
        return True
    names = ("jh-win64-shipping", "wandering_sword")
    try:
        if os.name == "nt":
            out = subprocess.check_output(
                ["tasklist"],
                stderr=subprocess.DEVNULL,
                text=True,
                errors="ignore",
                timeout=5,
            ).lower()
            return any(n in out for n in names)
        if os.path.isdir("/proc"):
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                comm_path = os.path.join("/proc", pid, "comm")
                try:
                    with open(comm_path, "rb") as f:
                        comm = f.read().decode("utf-8", "ignore").strip().lower()
                    if any(n in comm for n in names):
                        return True
                except OSError:
                    continue
    except Exception:
        return False
    return False


class SafeSaveStore:
    _dev = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}

    def __init__(self) -> None:
        self._meta_lock = threading.Lock()
        self._file_locks: dict[str, threading.RLock] = {}

    def _get_file_lock(self, path: str) -> threading.RLock:
        key = os.path.normcase(os.path.abspath(path))
        with self._meta_lock:
            lock = self._file_locks.get(key)
            if lock is None:
                lock = threading.RLock()
                self._file_locks[key] = lock
            return lock

    @staticmethod
    def _write_all_fd(fd: int, payload: bytes) -> None:
        view = memoryview(payload)
        sent = 0
        total = len(view)
        while sent < total:
            written = os.write(fd, view[sent:])
            if written <= 0:
                raise OSError("저장 데이터를 디스크에 완전히 기록하지 못했습니다.")
            sent += written

    def validate_path(self, path: str, must_exist: bool = True) -> str:
        if not isinstance(path, str) or not path or "\x00" in path:
            raise ValueError("저장 경로가 비어 있거나 올바르지 않습니다.")
        if path.startswith(("\\\\", "//")):
            raise ValueError("네트워크 공유 경로는 사용할 수 없습니다.")
        if os.name == "nt":
            if len(path) >= 2 and path[1] == ":":
                if len(path) > 2 and path[2] not in "\\/":
                    raise ValueError("대체 데이터 스트림 경로는 사용할 수 없습니다.")
                if ":" in path[2:]:
                    raise ValueError("대체 데이터 스트림 경로는 사용할 수 없습니다.")
            elif ":" in path:
                raise ValueError("대체 데이터 스트림 경로는 사용할 수 없습니다.")
        elif ":" in path:
            raise ValueError("대체 데이터 스트림 경로는 사용할 수 없습니다.")

        norm = path.replace("/", "\\")
        for idx, part in enumerate(norm.split("\\")):
            if not part or part in (".", ".."):
                continue
            if os.name == "nt" and idx == 0 and len(part) == 2 and part[1] == ":":
                continue
            stem = part.rstrip(" .").split(".")[0].lower()
            if stem in self._dev:
                raise ValueError("예약된 장치 이름은 저장 파일로 사용할 수 없습니다.")

        if os.path.splitext(path)[1].lower() != ".sav":
            raise ValueError("저장 파일 확장자는 .sav 이어야 합니다.")
        if must_exist and not os.path.lexists(path):
            raise FileNotFoundError("저장 파일을 찾을 수 없습니다.")

        cur = os.path.abspath(path)
        chain: list[str] = []
        while True:
            chain.append(cur)
            nxt = os.path.dirname(cur)
            if nxt == cur:
                break
            cur = nxt
        for p in reversed(chain):
            if not os.path.lexists(p):
                continue
            st = os.lstat(p)
            is_reparse = bool(getattr(st, "st_file_attributes", 0) & 0x400)
            if os.path.islink(p) or stat.S_ISLNK(st.st_mode) or is_reparse:
                raise ValueError("심볼릭 링크 또는 재분석 지점 경로는 사용할 수 없습니다.")
            if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
                raise ValueError("하드링크된 세이브 파일은 사용할 수 없습니다.")
        return path

    def read_bytes(self, path: str) -> tuple[bytes, str]:
        self.validate_path(path, True)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
        fd = os.open(path, flags)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode) or st.st_nlink > 1:
                raise ValueError("안전하지 않은 저장 파일입니다.")
            if st.st_size > MAX_SAVE_BYTES:
                raise ValueError("세이브 파일 크기가 허용 범위를 벗어났습니다.")
            chunks: list[bytes] = []
            total_read = 0
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                total_read += len(chunk)
                if total_read > MAX_SAVE_BYTES:
                    raise ValueError("세이브 파일 크기가 허용 범위를 벗어났습니다.")
                chunks.append(chunk)
            raw = b"".join(chunks)
        finally:
            os.close(fd)
        return raw, hashlib.sha256(raw).hexdigest()

    def _allocate_backup_path(self, path: str) -> tuple[str, int]:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
        for attempt in range(100):
            suffix = f"{stamp}" if attempt == 0 else f"{stamp}-{attempt}"
            cand = f"{path}.{suffix}.bak"
            try:
                bfd = os.open(cand, flags, 0o600)
                return cand, bfd
            except FileExistsError:
                continue
        raise RuntimeError("백업 파일을 생성하지 못했습니다.")

    def write_bytes(
        self,
        path: str,
        data: bytes,
        expected_sha256: str | None = None,
        create_backup: bool = True,
    ) -> dict[str, Any]:
        if is_game_running():
            raise RuntimeError("일검풍운결 게임이 실행 중입니다. 게임을 종료한 뒤 저장하세요.")
        if not isinstance(data, (bytes, bytearray)) or len(data) < 1 or len(data) > MAX_SAVE_BYTES:
            raise ValueError("세이브 데이터 크기가 허용 범위를 벗어났습니다.")
        self.validate_path(path, False)
        with self._get_file_lock(path):
            self.validate_path(path, False)
            cur_bytes: bytes | None = None
            cur_sha: str | None = None
            bak_path: str | None = None
            if os.path.lexists(path):
                cur_bytes, cur_sha = self.read_bytes(path)
                if expected_sha256 is not None and not hmac.compare_digest(cur_sha, expected_sha256.lower()):
                    raise FileExistsError("열어 둔 세이브 파일이 외부에서 변경되었습니다. 다시 불러온 뒤 저장하세요.")
            elif expected_sha256 is not None:
                raise FileExistsError("열어 둔 세이브 파일이 외부에서 삭제되었습니다. 다시 불러온 뒤 저장하세요.")
            if create_backup and cur_bytes is not None and cur_sha is not None:
                bak_path, bfd = self._allocate_backup_path(path)
                bfd_open = True
                try:
                    self._write_all_fd(bfd, cur_bytes)
                    os.fsync(bfd)
                    os.close(bfd)
                    bfd_open = False
                    with open(bak_path, "rb") as bf:
                        bak_read = bf.read(MAX_SAVE_BYTES + 1)
                    if len(bak_read) != len(cur_bytes) or hashlib.sha256(bak_read).hexdigest() != cur_sha:
                        raise RuntimeError("자동 백업 무결성 검증에 실패했습니다.")
                except Exception:
                    if bfd_open:
                        try:
                            os.close(bfd)
                        except OSError:
                            pass
                    try:
                        if os.path.lexists(bak_path):
                            os.unlink(bak_path)
                    except OSError:
                        pass
                    raise
            new_sha = hashlib.sha256(data).hexdigest()
            abs_dir = os.path.dirname(os.path.abspath(path)) or "."
            tmp = os.path.join(abs_dir, f".{os.path.basename(path)}.tmp.{os.getpid()}.{random.randrange(1 << 30):x}")
            flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
            fd = os.open(tmp, flags, 0o600)
            try:
                self._write_all_fd(fd, data)
                os.fsync(fd)
            except Exception:
                os.close(fd)
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            else:
                os.close(fd)
            try:
                with open(tmp, "rb") as tf:
                    tmp_read = tf.read()
                if len(tmp_read) != len(data) or hashlib.sha256(tmp_read).hexdigest() != new_sha:
                    raise RuntimeError("임시 세이브 파일 무결성 검증에 실패했습니다.")
                os.replace(tmp, path)
            except Exception:
                try:
                    if os.path.lexists(tmp):
                        os.unlink(tmp)
                except OSError:
                    pass
                raise
            return {
                "path": path,
                "sha256": new_sha,
                "backupFile": os.path.basename(bak_path) if bak_path else None,
            }


def run_loopback_server(
    save_dir: str,
    host: str = "127.0.0.1",
    port: int = 8765,
    html_path: str | None = None,
    quiet: bool = False,
) -> ThreadingHTTPServer:
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("보안을 위해 루프백 주소(127.0.0.1, localhost, ::1)에서만 서버를 실행할 수 있습니다.")
    if not os.path.isdir(save_dir):
        raise FileNotFoundError("세이브 폴더를 찾을 수 없습니다.")
    token = secrets.token_hex(24)
    resolved_html = html_path or os.path.join(ROOT_DIR, "dist", "WanderingSwordSaveEditor-v1.0.html")
    with open(resolved_html, "r", encoding="utf-8") as f:
        html_bytes = (
            f.read()
            .replace('<meta name="ws-loopback-token" content="">', f'<meta name="ws-loopback-token" content="{token}">')
            .encode("utf-8")
        )
    store = SafeSaveStore()
    actual_port_box = [port]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt: str, *args: Any) -> None:
            if not quiet:
                super().log_message(fmt, *args)

        def _send(self, code: int, body: bytes = b"", ctype: str = "application/json; charset=utf-8") -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def _json(self, code: int, obj: dict[str, Any]) -> None:
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _guard(self) -> bool:
            ap = actual_port_box[0]
            host_h = self.headers.get("Host", "")
            allowed_hosts = {
                f"127.0.0.1:{ap}",
                f"localhost:{ap}",
                f"[::1]:{ap}",
                "127.0.0.1",
                "localhost",
                "::1",
                "[::1]",
            }
            if host_h not in allowed_hosts:
                self._json(403, {"ok": False, "error": "허용되지 않은 호스트 헤더입니다."})
                return False
            sfs = self.headers.get("Sec-Fetch-Site")
            if sfs is not None and sfs not in ("same-origin", "none"):
                self._json(403, {"ok": False, "error": "교차 사이트 요청은 차단됩니다."})
                return False
            return True

        def _api_guard(self) -> bool:
            if not self._guard():
                return False
            if not hmac.compare_digest(self.headers.get("X-WS-Token", ""), token):
                self._json(403, {"ok": False, "error": "보안 토큰이 일치하지 않습니다."})
                return False
            return True

        def do_GET(self) -> None:
            if not self._guard():
                return
            p = urlparse(self.path).path
            if p == "/":
                self._send(200, html_bytes, "text/html; charset=utf-8")
                return
            if p == "/favicon.ico":
                self._send(204, b"", "image/x-icon")
                return
            if p == "/api/status":
                if not self._api_guard():
                    return
                files: list[str] = []
                for n in sorted(os.listdir(save_dir)):
                    if n.lower().endswith(".sav"):
                        try:
                            store.validate_path(os.path.join(save_dir, n), True)
                            files.append(n)
                        except Exception:
                            continue
                default_file = "0.sav" if "0.sav" in files else (files[0] if files else None)
                self._json(200, {"ok": True, "files": files, "defaultFile": default_file})
                return
            self._json(404, {"ok": False, "error": "요청한 경로를 찾을 수 없습니다."})

        def do_POST(self) -> None:
            if not self._api_guard():
                return
            ctype = self.headers.get("Content-Type", "")
            if not ctype.lower().startswith("application/json"):
                self._json(415, {"ok": False, "error": "요청 본문은 JSON 형식이어야 합니다."})
                return
            ap = actual_port_box[0]
            origin = self.headers.get("Origin")
            allowed_origins = {
                f"http://127.0.0.1:{ap}",
                f"http://localhost:{ap}",
                f"http://[::1]:{ap}",
            }
            if origin is not None and origin not in allowed_origins:
                self._json(403, {"ok": False, "error": "허용되지 않은 요청 출처입니다."})
                return
            try:
                clen = int(self.headers.get("Content-Length", "0"))
                if clen <= 0 or clen > 64 * 1024 * 1024:
                    raise ValueError("요청 본문 크기가 허용 범위를 벗어났습니다.")
                body = json.loads(self.rfile.read(clen).decode("utf-8"))
                name = body.get("file", "")
                if not isinstance(name, str) or not name or any(c in name for c in ("/", "\\")) or name in (".", ".."):
                    raise ValueError("올바르지 않은 파일 이름입니다.")
                target_path = os.path.join(save_dir, name)
                route = urlparse(self.path).path
                if route == "/api/open":
                    raw, sha = store.read_bytes(target_path)
                    doc = decode_sav_bytes(raw)
                    assert_valid_doc(doc)
                    self._json(
                        200,
                        {
                            "ok": True,
                            "file": name,
                            "sha256": sha,
                            "base64": base64.b64encode(raw).decode("ascii"),
                        },
                    )
                    return
                if route == "/api/save":
                    b64 = body.get("base64", "")
                    if not isinstance(b64, str) or not b64:
                        raise ValueError("저장할 세이브 데이터가 비어 있습니다.")
                    data = base64.b64decode(b64, validate=True)
                    doc = decode_sav_bytes(data)
                    assert_valid_doc(doc)
                    expected = body.get("expectedSha256")
                    res = store.write_bytes(target_path, data, expected if expected else None, True)
                    self._json(
                        200,
                        {
                            "ok": True,
                            "file": name,
                            "sha256": res["sha256"],
                            "backupFile": res["backupFile"],
                        },
                    )
                    return
                self._json(404, {"ok": False, "error": "요청한 경로를 찾을 수 없습니다."})
            except FileExistsError as exc:
                self._json(409, {"ok": False, "error": str(exc)})
            except FileNotFoundError as exc:
                self._json(404, {"ok": False, "error": str(exc)})
            except RuntimeError as exc:
                self._json(423, {"ok": False, "error": str(exc)})
            except Exception as exc:
                self._json(400, {"ok": False, "error": str(exc)})

    srv = ThreadingHTTPServer((host, port), Handler)
    actual_port_box[0] = srv.server_address[1]
    setattr(srv, "ws_token", token)
    return srv


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="wandering_sword_editor.py",
        description="일검풍운결 세이브 에디터 v1.0 명령줄 도구 및 로컬 보안 서버",
    )
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ins = sub.add_parser("inspect", help="세이브 요약 정보를 한국어로 조회합니다.")
    p_ins.add_argument("file", help="조회할 .sav 파일 경로")
    p_ins.add_argument("--json", action="store_true", help="요약 결과를 JSON으로 출력합니다.")

    p_val = sub.add_parser("validate", help="세이브 무결성 및 왕복 직렬화를 검증합니다.")
    p_val.add_argument("file", help="검증할 .sav 파일 경로")
    p_val.add_argument("--json", action="store_true", help="검증 결과를 JSON으로 출력합니다.")

    p_pre = sub.add_parser("presets", help="사용 가능한 빠른 프리셋 목록을 출력합니다.")
    p_pre.add_argument("--json", action="store_true", help="프리셋 목록을 JSON으로 출력합니다.")

    p_edit = sub.add_parser("edit", help="세이브 파일을 안전하게 백업하고 수정합니다.")
    p_edit.add_argument("file", help="원본 .sav 파일 경로")
    p_edit.add_argument("-o", "--output", help="저장할 대상 .sav 경로 (생략 시 원본 경로에 백업 후 저장)")
    p_edit.add_argument("--no-backup", action="store_true", help="자동 .bak 백업 생성을 건너뜁니다.")
    p_edit.add_argument("--preset", action="append", default=[], help="적용할 프리셋 식별자 (반복 지정 가능)")
    p_edit.add_argument("--money", type=int, help="보유 엽전 설정")
    p_edit.add_argument("--turn-mode", choices=("realtime", "turnbased"), help="전투 방식 변경 (realtime 또는 turnbased)")
    p_edit.add_argument("--skill-exp", type=int, help="주인공 무학 점수 설정")
    p_edit.add_argument("--meridian-points", type=int, help="주인공 경맥 점수 설정")
    p_edit.add_argument("--neigong-limit", type=int, help="주인공 추가 내공 상한 설정")
    p_edit.add_argument("--add-item", action="append", default=[], help="가방 물품 추가 (번호:수량)")
    p_edit.add_argument("--add-skill", action="append", default=[], help="주인공 무공 추가/등급 설정 (번호:등급)")
    p_edit.add_argument("--favor-all", type=int, help="동료 호감도 일괄 설정 (0~100)")
    p_edit.add_argument("--score", type=int, help="전역 설정 세이브 전승 점수 설정")
    p_edit.add_argument("--unlock-mounts", action="store_true", help="탈것 10종 전체 해금")
    p_edit.add_argument("--unlock-recipes", action="store_true", help="연단·요리·단조 도안 전체 해금")
    p_edit.add_argument("--unlock-meridians", action="store_true", help="주인공 경맥·혈도 전체 개통")

    p_srv = sub.add_parser("serve", help="단일 HTML 에디터용 로컬 루프백 보안 서버를 실행합니다.")
    p_srv.add_argument("dir", help=".sav 파일이 들어 있는 세이브 폴더 경로")
    p_srv.add_argument("--host", default="127.0.0.1", help="바인딩 호스트 (기본값: 127.0.0.1)")
    p_srv.add_argument("--port", type=int, default=8765, help="바인딩 포트 (기본값: 8765)")
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    args = ap.parse_args(argv)
    try:
        if args.cmd == "presets":
            if args.json:
                print(json.dumps(PRESETS, ensure_ascii=False, indent=2))
            else:
                for pid, meta in PRESETS.items():
                    kind_ko = "전역 설정" if meta["target"] == "config" else "일반 슬롯"
                    print(f"- {pid} [{kind_ko}] {meta['label']}: {meta['desc']}")
            return 0

        if args.cmd == "serve":
            srv = run_loopback_server(args.dir, args.host, args.port)
            print(f"일검풍운결 세이브 에디터 로컬 서버 실행 중: http://{args.host}:{srv.server_address[1]}")
            try:
                srv.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                srv.server_close()
            return 0

        cat = load_catalog(ROOT_DIR)
        store = SafeSaveStore()
        raw, sha = store.read_bytes(args.file)
        doc = decode_sav_bytes(raw)

        if args.cmd == "validate":
            verdict = validate_doc(doc)
            inner_orig = zlib.decompress(raw[12:]) if doc["ver"] > 5 else raw[4:]
            inner_rebuilt = encode_inner_bytes(doc)
            lossless = hashlib.sha256(inner_orig).hexdigest() == hashlib.sha256(inner_rebuilt).hexdigest()
            if not lossless:
                verdict["valid"] = False
                verdict["errors"].append("내부 왕복 직렬화 해시가 원본과 일치하지 않습니다.")
            payload = {"ok": verdict["valid"], "sha256": sha, "losslessInnerGvas": lossless, **verdict}
            if args.json:
                print(json.dumps(payload, ensure_ascii=False, indent=2))
            elif verdict["valid"]:
                print(f"검증 통과: {args.file} (해시: {sha}, 무손실 직렬화 일치)")
            else:
                print(f"검증 실패: {'; '.join(verdict['errors'])}", file=sys.stderr)
            return 0 if verdict["valid"] else 1

        if args.cmd == "inspect":
            assert_valid_doc(doc)
            summary = inspect_doc(doc, cat)
            if args.json:
                print(json.dumps({"ok": True, "file": args.file, "sha256": sha, "summary": summary}, ensure_ascii=False, indent=2))
            else:
                print(format_inspect_korean(summary, args.file, sha))
            return 0

        if args.cmd == "edit":
            apply_cli_edits(doc, args, cat)
            assert_valid_doc(doc)
            out_bytes = encode_sav_bytes(doc)
            out_path = args.output or args.file
            same_file = os.path.abspath(out_path) == os.path.abspath(args.file)
            res = store.write_bytes(
                out_path,
                out_bytes,
                expected_sha256=sha if same_file else None,
                create_backup=not args.no_backup,
            )
            print(
                json.dumps(
                    {
                        "ok": True,
                        "file": out_path,
                        "sha256": res["sha256"],
                        "backupFile": res["backupFile"],
                    },
                    ensure_ascii=False,
                )
            )
            return 0
    except Exception as exc:
        print(f"오류: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
