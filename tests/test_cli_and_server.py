import base64
import glob
import hashlib
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zlib
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import wandering_sword_editor as wse  # noqa: E402

HANZI_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def run_cli(argv: list[str]) -> tuple[int, str, str]:
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    with redirect_stdout(out_buf), redirect_stderr(err_buf):
        code = wse.main(argv)
    return code, out_buf.getvalue(), err_buf.getvalue()


class CliAndServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="wse_test_")
        cls.demo_slot_src = os.path.join(cls.tmp, "seed_slot.sav")
        cls.demo_cfg_src = os.path.join(cls.tmp, "seed_cfg.sav")
        js = (
            "const path=require('path'),fs=require('fs');"
            f"const base={json.dumps(str(ROOT))};"
            "const Catalog=require(path.join(base,'src/catalog-data.js'));"
            "const Codec=require(path.join(base,'src/gvas-codec.js'));"
            "const Core=require(path.join(base,'src/editor-core.js'));"
            f"fs.writeFileSync({json.dumps(cls.demo_slot_src)},Core.createDemoSavBytesSync(Catalog,Codec));"
            f"fs.writeFileSync({json.dumps(cls.demo_cfg_src)},Core.createDemoConfigSavBytesSync(Catalog,Codec));"
        )
        subprocess.run(["node", "-e", js], check=True, cwd=str(ROOT))
        cls.cat = wse.load_catalog(wse.ROOT_DIR)

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_presets_inspect_validate_and_edit_slot_and_config(self) -> None:
        work = tempfile.mkdtemp(dir=self.tmp)
        slot_path = os.path.join(work, "0.sav")
        cfg_path = os.path.join(work, "JHSaveConfig.sav")
        shutil.copyfile(self.demo_slot_src, slot_path)
        shutil.copyfile(self.demo_cfg_src, cfg_path)
        orig_slot_bytes = Path(slot_path).read_bytes()

        code, out, _ = run_cli(["presets", "--json"])
        self.assertEqual(code, 0)
        self.assertIn("wealth_max", json.loads(out))
        self.assertIsNone(HANZI_RE.search(out))

        code, out, _ = run_cli(["validate", slot_path, "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["valid"])

        code, out, _ = run_cli(["inspect", slot_path])
        self.assertEqual(code, 0)
        self.assertIsNone(HANZI_RE.search(out))
        self.assertIn("우문일", out)
        self.assertIn("실시간 전투", out)

        code, out, err = run_cli(
            [
                "edit",
                slot_path,
                "--preset",
                "wealth_max",
                "--turn-mode",
                "turnbased",
                "--add-item",
                "100:4",
                "--add-skill",
                "104:9",
                "--favor-all",
                "95",
                "--unlock-mounts",
                "--unlock-recipes",
                "--unlock-meridians",
            ]
        )
        self.assertEqual(code, 0, err)
        res = json.loads(out)
        self.assertTrue(res["ok"])
        baks = glob.glob(slot_path + ".*.bak")
        self.assertEqual(len(baks), 1)
        self.assertEqual(sha256(Path(baks[0]).read_bytes()), sha256(orig_slot_bytes))

        edited_doc = wse.decode_sav_bytes(Path(slot_path).read_bytes())
        self.assertTrue(wse.validate_doc(edited_doc)["valid"])
        summary = wse.inspect_doc(edited_doc, self.cat)
        self.assertEqual(summary["money"], 9999999)
        self.assertEqual(summary["turnModeKo"], "턴제 전투")
        self.assertEqual(summary["unlockedMountCount"], 10)
        self.assertGreaterEqual(summary["hero"]["jingMaiPoint"], 99999)

        before_bad = Path(slot_path).read_bytes()
        code, _, err = run_cli(["edit", slot_path, "--add-item", "1:1"])
        self.assertEqual(code, 1)
        self.assertIsNone(HANZI_RE.search(err))
        self.assertEqual(Path(slot_path).read_bytes(), before_bad)

        code, out, err = run_cli(["edit", cfg_path, "--preset", "config_score_max"])
        self.assertEqual(code, 0, err)
        cfg_doc = wse.decode_sav_bytes(Path(cfg_path).read_bytes())
        cfg_sum = wse.inspect_doc(cfg_doc, self.cat)
        self.assertEqual(cfg_sum["score"], 99999)
        self.assertTrue({1, 2, 3, 4, 5, 7, 8, 9}.issubset(set(cfg_sum["inheritIds"])))

    def test_safe_save_store_security_and_guards(self) -> None:
        store = wse.SafeSaveStore()
        d = tempfile.mkdtemp(dir=self.tmp)
        target = os.path.join(d, "0.sav")
        Path(target).write_bytes(b"valid-seed")

        link = os.path.join(d, "link.sav")
        os.symlink(target, link)
        with self.assertRaises(ValueError):
            store.validate_path(link)

        hard = os.path.join(d, "hard.sav")
        os.link(target, hard)
        try:
            with self.assertRaises(ValueError):
                store.validate_path(hard)
            with self.assertRaises(ValueError):
                store.read_bytes(hard)
        finally:
            os.unlink(hard)

        for raw_bad in ("\\\\server\\share\\0.sav", "//server/share/0.sav"):
            with self.assertRaises(ValueError):
                store.validate_path(raw_bad, must_exist=False)

        for rel_bad in ("0.sav:evil.sav", "CON.sav", "CON.txt.sav", "NUL.sav", "COM1.sav", "bad.txt"):
            with self.assertRaises(ValueError):
                store.validate_path(os.path.join(d, rel_bad), must_exist=False)

        with self.assertRaises(FileExistsError):
            store.write_bytes(target, b"updated", expected_sha256="0" * 64)

        old_env = os.environ.get("WS_SIMULATE_GAME_RUNNING")
        os.environ["WS_SIMULATE_GAME_RUNNING"] = "1"
        try:
            with self.assertRaises(RuntimeError) as cm:
                store.write_bytes(target, b"blocked")
            self.assertIn("게임", str(cm.exception))
            self.assertIsNone(HANZI_RE.search(str(cm.exception)))
        finally:
            if old_env is None:
                os.environ.pop("WS_SIMULATE_GAME_RUNNING", None)
            else:
                os.environ["WS_SIMULATE_GAME_RUNNING"] = old_env

    def test_loopback_server_security_and_roundtrip(self) -> None:
        d = tempfile.mkdtemp(dir=self.tmp)
        slot = os.path.join(d, "0.sav")
        shutil.copyfile(self.demo_slot_src, slot)

        with self.assertRaises(ValueError):
            wse.run_loopback_server(d, host="0.0.0.0", port=0, quiet=True)

        srv = wse.run_loopback_server(d, host="127.0.0.1", port=0, quiet=True)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        base = f"http://127.0.0.1:{srv.server_port}"

        with urllib.request.urlopen(base + "/", timeout=5) as resp:
            self.assertEqual(resp.status, 200)
            self.assertEqual(resp.headers.get("Cross-Origin-Resource-Policy"), "same-origin")
            head_chunk = resp.read(4096)
        m = re.search(rb'<meta name="ws-loopback-token" content="([0-9a-f]+)">', head_chunk)
        self.assertIsNotNone(m)
        token = m.group(1).decode("ascii")

        def call(path: str, method: str = "GET", body: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, bytes]:
            hdrs = {"X-WS-Token": token}
            if headers:
                hdrs.update(headers)
            req = urllib.request.Request(base + path, data=body, method=method, headers=hdrs)
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                try:
                    return e.code, e.read()
                finally:
                    e.close()

        self.assertEqual(call("/api/status", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(call("/api/status", headers={"X-WS-Token": "wrong"})[0], 403)
        self.assertEqual(call("/api/status", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(
            call("/api/open", "POST", b'{"file":"0.sav"}', {"Content-Type": "application/json", "Origin": "http://evil.example"})[0],
            403,
        )
        self.assertEqual(call("/api/open", "POST", b"{}", {"Content-Type": "text/plain"})[0], 415)

        st, raw_status = call("/api/status")
        self.assertEqual(st, 200)
        self.assertIn("0.sav", json.loads(raw_status)["files"])

        st, raw_open = call("/api/open", "POST", b'{"file":"0.sav"}', {"Content-Type": "application/json"})
        self.assertEqual(st, 200)
        opened = json.loads(raw_open)
        doc = wse.decode_sav_bytes(base64.b64decode(opened["base64"]))
        wse.ensure_int_prop(doc["props"], "Money", 0)["val"] = 777777
        new_b64 = base64.b64encode(wse.encode_sav_bytes(doc)).decode("ascii")

        save_payload = json.dumps({"file": "0.sav", "expectedSha256": opened["sha256"], "base64": new_b64}).encode("utf-8")
        st, raw_save = call("/api/save", "POST", save_payload, {"Content-Type": "application/json"})
        self.assertEqual(st, 200)
        saved_json = json.loads(raw_save)
        self.assertTrue(saved_json["backupFile"].endswith(".bak"))
        self.assertTrue(os.path.exists(os.path.join(d, saved_json["backupFile"])))

        stale_payload = json.dumps({"file": "0.sav", "expectedSha256": "0" * 64, "base64": new_b64}).encode("utf-8")
        self.assertEqual(call("/api/save", "POST", stale_payload, {"Content-Type": "application/json"})[0], 409)

        fresh_payload = json.dumps({"file": "0.sav", "expectedSha256": saved_json["sha256"], "base64": new_b64}).encode("utf-8")
        os.environ["WS_SIMULATE_GAME_RUNNING"] = "1"
        try:
            self.assertEqual(call("/api/save", "POST", fresh_payload, {"Content-Type": "application/json"})[0], 423)
        finally:
            os.environ.pop("WS_SIMULATE_GAME_RUNNING", None)

        os.unlink(slot)
        self.assertEqual(call("/api/save", "POST", fresh_payload, {"Content-Type": "application/json"})[0], 409)
        self.assertFalse(os.path.exists(slot))

    def test_store_concurrency_short_write_and_cross_codec(self) -> None:
        d = tempfile.mkdtemp(dir=self.tmp)
        store = wse.SafeSaveStore()

        sw_path = os.path.join(d, "short.sav")
        shutil.copyfile(self.demo_slot_src, sw_path)
        seed_bytes, seed_sha = store.read_bytes(sw_path)
        doc_sw = wse.decode_sav_bytes(seed_bytes)
        wse.ensure_int_prop(doc_sw["props"], "Money", 0)["val"] = 123456
        updated_sw = wse.encode_sav_bytes(doc_sw)
        real_os_write = os.write

        def partial_write(fd: int, buf: object) -> int:
            mv = memoryview(buf)
            return real_os_write(fd, mv[: min(7, len(mv))])

        with mock.patch("wandering_sword_editor.os.write", side_effect=partial_write):
            res_sw = store.write_bytes(sw_path, updated_sw, expected_sha256=seed_sha, create_backup=True)
        self.assertEqual(sha256(Path(sw_path).read_bytes()), sha256(updated_sw))
        self.assertEqual(sha256(Path(os.path.join(d, res_sw["backupFile"])).read_bytes()), seed_sha)

        bak_fail_dir = os.path.join(d, "bak_fail")
        os.makedirs(bak_fail_dir)
        bf_path = os.path.join(bak_fail_dir, "0.sav")
        shutil.copyfile(self.demo_slot_src, bf_path)
        _, bf_sha = store.read_bytes(bf_path)
        real_open = open

        def fail_bak_read(file_arg: object, mode: str = "r", *a: object, **kw: object):  # type: ignore[no-untyped-def]
            if isinstance(file_arg, str) and file_arg.endswith(".bak") and "r" in mode:
                raise OSError("백업 재읽기 강제 실패")
            return real_open(file_arg, mode, *a, **kw)  # type: ignore[arg-type]

        with mock.patch("builtins.open", side_effect=fail_bak_read):
            with self.assertRaises(OSError):
                store.write_bytes(bf_path, updated_sw, expected_sha256=bf_sha, create_backup=True)
        self.assertEqual(sha256(Path(bf_path).read_bytes()), bf_sha)
        self.assertEqual([f for f in os.listdir(bak_fail_dir) if f.endswith(".bak")], [])

        def corrupt_bak_read(file_arg: object, mode: str = "r", *a: object, **kw: object):  # type: ignore[no-untyped-def]
            if isinstance(file_arg, str) and file_arg.endswith(".bak") and "r" in mode:
                return io.BytesIO(b"corrupt")
            return real_open(file_arg, mode, *a, **kw)  # type: ignore[arg-type]

        with mock.patch("builtins.open", side_effect=corrupt_bak_read):
            with self.assertRaises(RuntimeError):
                store.write_bytes(bf_path, updated_sw, expected_sha256=bf_sha, create_backup=True)
        self.assertEqual(sha256(Path(bf_path).read_bytes()), bf_sha)
        self.assertEqual([f for f in os.listdir(bak_fail_dir) if f.endswith(".bak")], [])

        bomb_header = struct.pack("<iii", 12, wse.MAX_SAVE_BYTES + 100, 8) + b"\x78\x9c\x03\x00\x00\x00\x00\x01"
        with self.assertRaises(ValueError):
            wse.decode_sav_bytes(bomb_header)

        padded_sav = bytearray(seed_bytes + b"\xde\xad\xbe\xef")
        struct.pack_into("<i", padded_sav, 8, struct.unpack_from("<i", padded_sav, 8)[0] + 4)
        with self.assertRaises(ValueError):
            wse.decode_sav_bytes(bytes(padded_sav))

        os.unlink(sw_path)
        with self.assertRaises(FileExistsError):
            store.write_bytes(sw_path, updated_sw, expected_sha256=res_sw["sha256"], create_backup=True)
        self.assertFalse(os.path.exists(sw_path))

        conc_dir = os.path.join(d, "conc")
        os.makedirs(conc_dir)
        conc_path = os.path.join(conc_dir, "0.sav")
        shutil.copyfile(self.demo_slot_src, conc_path)
        _, conc_seed_sha = store.read_bytes(conc_path)
        variants: list[bytes] = []
        for idx in range(4):
            vd = wse.decode_sav_bytes(seed_bytes)
            wse.ensure_int_prop(vd["props"], "Money", 0)["val"] = 500000 + idx
            variants.append(wse.encode_sav_bytes(vd))

        barrier = threading.Barrier(4)
        outcomes: list[tuple[str, int]] = []
        out_lock = threading.Lock()

        def worker(i: int) -> None:
            barrier.wait(timeout=10)
            try:
                store.write_bytes(conc_path, variants[i], expected_sha256=conc_seed_sha, create_backup=True)
                tag = "ok"
            except FileExistsError:
                tag = "conflict"
            with out_lock:
                outcomes.append((tag, i))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        oks = [i for tag, i in outcomes if tag == "ok"]
        conflicts = [i for tag, i in outcomes if tag == "conflict"]
        self.assertEqual(len(oks), 1)
        self.assertEqual(len(conflicts), 3)
        self.assertEqual(Path(conc_path).read_bytes(), variants[oks[0]])
        baks = [f for f in os.listdir(conc_dir) if f.endswith(".bak")]
        self.assertEqual(len(baks), 1)
        self.assertEqual(sha256(Path(os.path.join(conc_dir, baks[0])).read_bytes()), conc_seed_sha)

        real_dir = os.environ.get("WS_REAL_SAVES_DIR")
        real_zero = os.path.join(real_dir, "0.sav") if real_dir and os.path.isfile(os.path.join(real_dir, "0.sav")) else None
        cross_src = real_zero or self.demo_slot_src
        before_doc = wse.decode_sav_bytes(Path(cross_src).read_bytes())
        before_opaque = {
            p["name"]: sha256(p["opaque"])
            for p in before_doc["props"]
            if p.get("name") in wse.OPAQUE_PROPS and "opaque" in p
        }
        before_bag = [(it["table_id"], it["guid"]) for it in before_doc["items"] if it["table_id"] != 100]
        team_ids_before = set((wse.find_prop(before_doc["props"], "TeamInfos") or {}).get("items") or [])
        unedited_npc_id = next(
            (n["npc_id"] for n in before_doc["npcs"] if n["npc_id"] != 0 and n["npc_id"] not in team_ids_before),
            None,
        )
        before_npc_bits = (
            [(aid, bits) for aid, (_, bits) in next(n for n in before_doc["npcs"] if n["npc_id"] == unedited_npc_id)["attrs"]]
            if unedited_npc_id is not None
            else None
        )

        js_out = os.path.join(d, "js_mutated.sav")
        py_out = os.path.join(d, "py_mutated.sav")
        cfg_out = os.path.join(d, "py_cfg.sav")

        node_mutate = (
            "const fs=require('fs'),path=require('path');"
            f"const base={json.dumps(str(ROOT))};"
            "const Catalog=require(path.join(base,'src/catalog-data.js'));"
            "const Codec=require(path.join(base,'src/gvas-codec.js'));"
            "const Core=require(path.join(base,'src/editor-core.js'));"
            "(async()=>{"
            "const s=Core.createSession(Codec,Catalog);"
            f"await s.loadBytes(fs.readFileSync({json.dumps(cross_src)}),{{filename:'0.sav'}});"
            "if(!s.applyPreset('wealth_max')) throw new Error('preset1');"
            "if(!s.applyPreset('party_favor_max')) throw new Error('preset2');"
            "if(!s.addBagItem(100,3)) throw new Error('bag');"
            "if(!s.unlockAllMounts()) throw new Error('mounts');"
            f"fs.writeFileSync({json.dumps(js_out)},Buffer.from(await s.exportBytes()));"
            "})().catch(e=>{console.error(e);process.exit(1);});"
        )
        subprocess.run(["node", "-e", node_mutate], check=True)

        py_decoded = wse.decode_sav_bytes(Path(js_out).read_bytes())
        self.assertTrue(wse.validate_doc(py_decoded)["valid"])
        info = wse.inspect_doc(py_decoded, self.cat)
        self.assertEqual(info["money"], 9999999)
        self.assertEqual(info["unlockedMountCount"], 10)
        for oname, osha in before_opaque.items():
            self.assertEqual(sha256(wse.find_prop(py_decoded["props"], oname)["opaque"]), osha)
        after_bag = [(it["table_id"], it["guid"]) for it in py_decoded["items"] if it["table_id"] != 100]
        self.assertEqual(after_bag, before_bag)
        if before_npc_bits is not None:
            after_npc_bits = [
                (aid, bits)
                for aid, (_, bits) in next(n for n in py_decoded["npcs"] if n["npc_id"] == unedited_npc_id)["attrs"]
            ]
            self.assertEqual(after_npc_bits, before_npc_bits)

        wse.apply_preset_doc(py_decoded, "skills_lv10", self.cat)
        Path(py_out).write_bytes(wse.encode_sav_bytes(py_decoded))

        cfg_doc = wse.decode_sav_bytes(Path(self.demo_cfg_src).read_bytes())
        wse.apply_preset_doc(cfg_doc, "config_score_max", self.cat)
        Path(cfg_out).write_bytes(wse.encode_sav_bytes(cfg_doc))

        node_verify = (
            "const fs=require('fs'),path=require('path'),assert=require('assert');"
            f"const base={json.dumps(str(ROOT))};"
            "const Catalog=require(path.join(base,'src/catalog-data.js'));"
            "const Codec=require(path.join(base,'src/gvas-codec.js'));"
            "const Core=require(path.join(base,'src/editor-core.js'));"
            "(async()=>{"
            "const s1=Core.createSession(Codec,Catalog);"
            f"await s1.loadBytes(fs.readFileSync({json.dumps(py_out)}),{{filename:'0.sav'}});"
            "assert.strictEqual(s1.validate().valid,true);"
            "assert.strictEqual(s1.getSummary().money,9999999);"
            "const s2=Core.createSession(Codec,Catalog);"
            f"await s2.loadBytes(fs.readFileSync({json.dumps(cfg_out)}),{{filename:'JHSaveConfig.sav'}});"
            "assert.strictEqual(s2.validate().valid,true);"
            "assert.strictEqual(s2.getSummary().score,99999);"
            "})().catch(e=>{console.error(e);process.exit(1);});"
        )
        subprocess.run(["node", "-e", node_verify], check=True)

    def test_real_saves_if_configured(self) -> None:
        real = os.environ.get("WS_REAL_SAVES_DIR")
        if not real or not os.path.isdir(real):
            return
        files = sorted(Path(real).glob("*.sav"))
        self.assertGreaterEqual(len(files), 1)
        for p in files:
            raw = p.read_bytes()
            doc = wse.decode_sav_bytes(raw)
            self.assertTrue(wse.validate_doc(doc)["valid"], p.name)
            inner = zlib.decompress(raw[12:]) if doc["ver"] > 5 else raw[4:]
            self.assertEqual(sha256(inner), sha256(wse.encode_inner_bytes(doc)), p.name)
            if p.name == "0.sav":
                q_prop = wse.find_prop(doc["props"], "Quests")
                self.assertIsNotNone(q_prop)
                before_q = sha256(q_prop["opaque"])
                wse.apply_preset_doc(doc, "wealth_max", self.cat)
                rebuilt = wse.decode_sav_bytes(wse.encode_sav_bytes(doc))
                after_q = sha256(wse.find_prop(rebuilt["props"], "Quests")["opaque"])
                self.assertEqual(before_q, after_q)

    def test_opaque_props_inspect_and_lossless_roundtrip(self) -> None:
        work = tempfile.mkdtemp(dir=self.tmp)
        sav_path = os.path.join(work, "opaque.sav")
        doc = wse.decode_sav_bytes(Path(self.demo_slot_src).read_bytes())
        payloads = {
            "Quests": b"\x01\x02\x03\x04\x05\x06\x07\x08\x09",
            "JHGatherSpecs": b"\x10\x20\x30\x40\x50",
            "WorldWalkNPCInfos": b"\x11\x22\x33\x44\x55\x66\x77",
            "MonsterNPCInfos": b"\x63\x58\x4d\x42\x37\x2c\x21\x16\x0b\x00",
        }
        none_idx = next(i for i, p in enumerate(doc["props"]) if p.get("name") == "None")
        injected = [
            {
                "name": "Quests",
                "name_enc": "latin1",
                "type": "ArrayProperty",
                "type_enc": "latin1",
                "size": len(payloads["Quests"]),
                "elem_type": "StructProperty",
                "elem_enc": "latin1",
                "guid_flag": 0,
                "opaque": payloads["Quests"],
            },
            {
                "name": "JHGatherSpecs",
                "name_enc": "latin1",
                "type": "MapProperty",
                "type_enc": "latin1",
                "size": len(payloads["JHGatherSpecs"]),
                "key_type": ("IntProperty", "latin1"),
                "val_type": ("IntProperty", "latin1"),
                "guid_flag": 0,
                "opaque": payloads["JHGatherSpecs"],
            },
            {
                "name": "WorldWalkNPCInfos",
                "name_enc": "latin1",
                "type": "ArrayProperty",
                "type_enc": "latin1",
                "size": len(payloads["WorldWalkNPCInfos"]),
                "elem_type": "StructProperty",
                "elem_enc": "latin1",
                "guid_flag": 0,
                "opaque": payloads["WorldWalkNPCInfos"],
            },
            {
                "name": "MonsterNPCInfos",
                "name_enc": "latin1",
                "type": "MapProperty",
                "type_enc": "latin1",
                "size": len(payloads["MonsterNPCInfos"]),
                "key_type": ("IntProperty", "latin1"),
                "val_type": ("StructProperty", "latin1"),
                "guid_flag": 0,
                "opaque": payloads["MonsterNPCInfos"],
            },
        ]
        doc["props"][none_idx:none_idx] = injected
        Path(sav_path).write_bytes(wse.encode_sav_bytes(doc))

        code, out, err = run_cli(["inspect", sav_path, "--json"])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        summary = payload["summary"]
        self.assertEqual(summary["opaquePresentCount"], 4)
        self.assertEqual(summary["opaqueTotalBytes"], sum(len(v) for v in payloads.values()))
        self.assertIs(summary["opaqueReadOnly"], True)
        by_name = {item["name"]: item for item in summary["opaqueProps"]}
        self.assertEqual(list(by_name.keys()), list(wse.OPAQUE_PROP_ORDER))
        for name, raw_op in payloads.items():
            self.assertIs(by_name[name]["present"], True)
            self.assertEqual(by_name[name]["byteLength"], len(raw_op))
            self.assertIs(by_name[name]["readOnly"], True)
            self.assertIs(by_name[name]["preserved"], True)

        code, text_out, err = run_cli(["inspect", sav_path])
        self.assertEqual(code, 0, err)
        self.assertIsNone(HANZI_RE.search(text_out))
        for name in payloads:
            self.assertIn(name, text_out)
        self.assertIn("원형 보존 영역", text_out)

        code, _, err = run_cli(["edit", sav_path, "--money", "777777"])
        self.assertEqual(code, 0, err)
        rebuilt = wse.decode_sav_bytes(Path(sav_path).read_bytes())
        for name, raw_op in payloads.items():
            prop = wse.find_prop(rebuilt["props"], name)
            self.assertIsNotNone(prop)
            self.assertEqual(sha256(prop["opaque"]), sha256(raw_op))


if __name__ == "__main__":
    unittest.main()
