"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const Catalog = require("../src/catalog-data.js");
const Codec = require("../src/gvas-codec.js");
const Core = require("../src/editor-core.js");

const HANZI_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;
const TAG_RE = /<(?:R|G|Y|B|W|O|P)>|<\/>/;

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function assertCleanString(s, where) {
  if (typeof s !== "string") return;
  assert(!HANZI_RE.test(s), `Hanzi found at ${where}: ${s}`);
  assert(!TAG_RE.test(s), `Tag found at ${where}: ${s}`);
}

function walkStrings(value, where, seen) {
  if (typeof value === "string") {
    assertCleanString(value, where);
    return;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((v, i) => walkStrings(v, `${where}[${i}]`, seen));
    return;
  }
  for (const k of Object.keys(value)) walkStrings(value[k], `${where}.${k}`, seen);
}

async function testCatalog() {
  assert.strictEqual(Catalog.getNpcName(0), "우문일");
  assert.strictEqual(Catalog.getMountName(9), "검독수리");
  assert.strictEqual(Catalog.getItem(1).debug, true);
  assert.strictEqual(Catalog.getItem(1).bucket, 0);
  const roots = [
    "items", "skills", "npcs", "mounts", "guilds", "mapViews", "mapCodes",
    "meridians", "inherits", "attributes", "itemBuckets", "codeAtlas"
  ];
  const seen = new Set();
  for (const key of roots) walkStrings(Catalog[key], key, seen);

  const atlas = Catalog.getCodeAtlas();
  assert(atlas && atlas === Catalog.codeAtlas, "codeAtlas missing");
  const combatIds = atlas.gasMmc.combat.map(m => m.id);
  for (const id of ["AttackPowerMMC", "DefenseMMC", "CritMMC", "DodgeMMC", "MaxHealthMMC", "MaxManaMMC", "TurnRateMMC", "ActionPointMMC"]) {
    assert(combatIds.includes(id), `missing combat MMC ${id}`);
  }
  const lifeIds = atlas.gasMmc.life.map(m => m.id);
  for (const id of ["Alchemy", "Cooking", "DaZao", "Fishing", "Gathering", "ZhiYi"]) {
    assert(lifeIds.includes(id), `missing life MMC ${id}`);
  }
  const specialIds = atlas.gasMmc.special.map(m => m.id);
  assert(specialIds.includes("MMC_Special_XiXing"), "missing MMC_Special_XiXing");
  const attrNames = atlas.attributeSet.items.map(a => a.name);
  for (const name of ["CritChance", "CritMultiplier", "ArmorDamageReduction", "DodgeChance", "LifeSteal"]) {
    assert(attrNames.includes(name), `missing JHAttributeSet ${name}`);
  }
  assert.strictEqual(atlas.extraDifficultyBuff.stages.length, 10, "ExtraDifficultyBuff must have 10 stages");
  for (const tok of ["AllEnemies", "OnlyBoss", "Team"]) {
    assert(atlas.extraDifficultyBuff.EExtraBuffType.includes(tok), `missing EExtraBuffType ${tok}`);
  }
  for (const tok of ["+2.5%", "25%", "CD-1", "CD+1"]) {
    assert(atlas.extraDifficultyBuff.modifierTokens.includes(tok), `missing modifier token ${tok}`);
  }
  const smOpaque = atlas.saveManager.OPAQUE_PROPS.map(p => p.name);
  assert.deepStrictEqual(smOpaque, ["Quests", "JHGatherSpecs", "WorldWalkNPCInfos", "MonsterNPCInfos"]);
}

async function testDemoAndPresets() {
  const demoBytes = await Core.createDemoSavBytes(Catalog, Codec);
  const syncBytes = Core.createDemoSavBytesSync(Catalog, Codec);
  assert(demoBytes instanceof Uint8Array && demoBytes.length > 100);
  assert(syncBytes instanceof Uint8Array && syncBytes.length > 100);

  const session = Core.createSession(Codec, Catalog);
  await session.loadBytes(Buffer.from(demoBytes), { filename: "0.sav" });
  assert.strictEqual(session.validate().valid, true);
  assert.strictEqual(session.isConfigSave(), false);

  assert.strictEqual(session.addBagItem(1, 5), false, "debug item must be blocked");
  assert.strictEqual(session.addSkill(0, 8, 5), false, "debug skill 8 must be blocked");
  assert.strictEqual(session.addBagItem(100, 5), true);
  assert.strictEqual(session.setNpcAttr(0, 9, 1234), true);
  assert.strictEqual(session.setCompanionFavor(17012, 95), true);

  const heroFav = session.getCharacterDetail(0).friendliness.find(f => f.npcId === 17012);
  const compFav = session.getCharacterDetail(17012).friendliness.find(f => f.npcId === 0);
  assert(heroFav && heroFav.favor === 95, "hero -> companion favor");
  assert(compFav && compFav.favor === 95, "companion -> hero favor");

  assert.strictEqual(session.unlockAllMeridians(0), true);
  assert.strictEqual(session.unlockAllMounts(), true);
  assert.strictEqual(session.unlockAllRecipes(), true);

  const presets = ["wealth_max", "hero_cultivation", "party_favor_max", "skills_lv10", "unlock_mounts_recipes", "reset_pill_limits"];
  for (const p of presets) assert.strictEqual(session.applyPreset(p), true, p);
  assert.strictEqual(session.applyPreset("config_score_max"), false);

  const out = Buffer.from(await session.exportBytes());
  const s2 = Core.createSession(Codec, Catalog);
  await s2.loadBytes(out, { filename: "0.sav" });
  assert.strictEqual(s2.validate().valid, true);
  assert.strictEqual(s2.getSummary().money, 9999999);
  assert.strictEqual(s2.getSummary().unlockedMountCount, 10);

  const cfgBytes = Buffer.from(await Core.createDemoConfigSavBytes(Catalog, Codec));
  const cfg = Core.createSession(Codec, Catalog);
  await cfg.loadBytes(cfgBytes, { filename: "JHSaveConfig.sav" });
  assert.strictEqual(cfg.isConfigSave(), true);
  assert.strictEqual(cfg.applyPreset("config_score_max"), true);
  const cfgOut = Buffer.from(await cfg.exportBytes());
  const cfg2 = Core.createSession(Codec, Catalog);
  await cfg2.loadBytes(cfgOut, { filename: "JHSaveConfig.sav" });
  assert.strictEqual(cfg2.validate().valid, true);
  assert.strictEqual(cfg2.getSummary().score, 99999);
  const ids = cfg2.getSummary().inheritIds || [];
  for (const id of [1, 2, 3, 4, 5, 7, 8, 9]) assert(ids.includes(id), `missing inherit ${id}`);
}

function testCorruptions() {
  const cases = [
    Buffer.from([1, 2, 3]),
    Buffer.alloc(16, 99),
    (() => {
      const b = Buffer.alloc(40);
      b.writeInt32LE(12, 0);
      b.writeInt32LE(100, 4);
      b.writeInt32LE(28, 8);
      b.fill(0xab, 12);
      return b;
    })(),
    (() => {
      const b = Buffer.alloc(24);
      b.writeInt32LE(12, 0);
      b.writeInt32LE(100 * 1024 * 1024, 4);
      b.writeInt32LE(12, 8);
      b.fill(0x78, 12);
      return b;
    })(),
    (() => {
      const orig = Buffer.from(Core.createDemoSavBytesSync(Catalog, Codec));
      const b = Buffer.concat([orig, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
      b.writeInt32LE(b.readInt32LE(8) + 4, 8);
      return b;
    })()
  ];
  for (const buf of cases) {
    let threw = false;
    try {
      Codec.decodeSavSync(buf);
    } catch (e) {
      threw = true;
      assert(e instanceof Error);
      assert(!HANZI_RE.test(e.message), `Hanzi in error: ${e.message}`);
      assert(!/[A-Za-z]/.test(e.message), `English token in error: ${e.message}`);
    }
    assert(threw, "corrupt buffer did not throw");
  }
}

async function testPureKoreanValidateMessages() {
  const demoBytes = Core.createDemoSavBytesSync(Catalog, Codec);
  const doc = Codec.decodeSavSync(demoBytes);
  doc.magic = "XXXX";
  doc.props = doc.props.filter(p => p && p.name !== "None");
  doc.props.push({ name: "CustomRawEnglishProp", nameEnc: "latin1", type: "IntProperty", typeEnc: "latin1", guidFlag: 0 });
  doc.props.push({ name: "CustomRawEnglishProp", nameEnc: "latin1", type: "IntProperty", typeEnc: "latin1", guidFlag: 0 });
  const session = Core.createSession(Codec, Catalog);
  session.loadDoc(doc);
  const v = session.validate();
  assert.strictEqual(v.valid, false);
  assert(v.errors.length >= 2, "expected >=2 errors");
  assert(v.warnings.length >= 2, "expected >=2 warnings");
  for (const msg of [...v.errors, ...v.warnings]) {
    assert(!HANZI_RE.test(msg), `Hanzi in validate msg: ${msg}`);
    assert(!/[A-Za-z]/.test(msg), `English token in validate msg: ${msg}`);
  }
}

async function testRealSaves() {
  const dir = process.env.WS_REAL_SAVES_DIR;
  if (!dir || !fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".sav")).sort().map(f => path.join(dir, f));
  assert(files.length >= 1, "no .sav files in WS_REAL_SAVES_DIR");
  const session = Core.createSession(Codec, Catalog);

  for (const file of files) {
    const raw = fs.readFileSync(file);
    const doc = Codec.decodeSavSync(raw);
    if (doc.saveVersion > 5) {
      assert.strictEqual(sha256(zlib.inflateSync(raw.subarray(12))), sha256(Codec.encodeInner(doc)), `lossless inner mismatch: ${file}`);
    }
    session.loadDoc(doc);
    const v = session.validate();
    assert.strictEqual(v.valid, true, `validate failed: ${file}: ${v.errors.join("; ")}`);
    assert.strictEqual(v.errors.length, 0, file);
  }

  const zero = files.find(f => path.basename(f) === "0.sav");
  if (zero) {
    const raw = fs.readFileSync(zero);
    const doc = Codec.decodeSavSync(raw);
    const opaqueNames = ["Quests", "JHGatherSpecs", "WorldWalkNPCInfos", "MonsterNPCInfos"];
    const beforeOpaque = {};
    for (const oname of opaqueNames) {
      const op = doc.props.find(p => p.name === oname);
      if (op && op.opaque) beforeOpaque[oname] = sha256(Buffer.from(op.opaque));
    }
    assert(beforeOpaque.Quests, "0.sav Quests opaque missing");
    const beforeEquipAff = JSON.stringify(doc.npcs[0].equippedItems.map(it => [it.guid, it.affA, it.affB]));
    const beforeBagGuids = doc.items.filter(it => it.tableId !== 100).map(it => [it.tableId, it.guid, it.affA, it.affB]);
    const uneditedNpcBefore = doc.npcs.length > 1 ? JSON.stringify(doc.npcs[1].attrs.map(a => [a.id, a.val.bits])) : null;

    session.loadDoc(doc);
    assert.strictEqual(session.applyPreset("wealth_max"), true);
    assert.strictEqual(session.applyPreset("unlock_mounts_recipes"), true);
    assert.strictEqual(session.addBagItem(100, 3), true);
    const out = await session.exportBytes();
    const doc2 = Codec.decodeSavSync(Buffer.from(out));
    for (const oname of Object.keys(beforeOpaque)) {
      const op2 = doc2.props.find(p => p.name === oname);
      assert.strictEqual(sha256(Buffer.from(op2.opaque)), beforeOpaque[oname], `${oname} opaque altered`);
    }
    const afterEquipAff = JSON.stringify(doc2.npcs[0].equippedItems.map(it => [it.guid, it.affA, it.affB]));
    assert.strictEqual(afterEquipAff, beforeEquipAff, "equipped item affixes altered");
    const afterBagGuids = doc2.items.filter(it => it.tableId !== 100).map(it => [it.tableId, it.guid, it.affA, it.affB]);
    assert.strictEqual(JSON.stringify(afterBagGuids), JSON.stringify(beforeBagGuids), "existing bag item GUIDs/affixes altered");
    if (uneditedNpcBefore !== null) {
      const uneditedNpcAfter = JSON.stringify(doc2.npcs[1].attrs.map(a => [a.id, a.val.bits]));
      assert.strictEqual(uneditedNpcAfter, uneditedNpcBefore, "unedited NPC float32 raw bits altered");
    }
  }
  return files.length;
}

async function testOpaquePropsInspectAndRoundtrip() {
  const doc = Core.createDemoDoc();
  const noneIdx = doc.props.findIndex(p => p && p.name === "None");
  assert(noneIdx >= 0, "None terminator missing");
  const payloads = {
    Quests: { type: "ArrayProperty", extra: { elemType: { str: "StructProperty", enc: "latin1" } }, bytes: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
    JHGatherSpecs: { type: "MapProperty", extra: { keyType: { str: "IntProperty", enc: "latin1" }, valType: { str: "IntProperty", enc: "latin1" } }, bytes: Buffer.from([10, 20, 30, 40, 50]) },
    WorldWalkNPCInfos: { type: "ArrayProperty", extra: { elemType: { str: "StructProperty", enc: "latin1" } }, bytes: Buffer.from([11, 22, 33, 44, 55, 66, 77]) },
    MonsterNPCInfos: { type: "MapProperty", extra: { keyType: { str: "IntProperty", enc: "latin1" }, valType: { str: "StructProperty", enc: "latin1" } }, bytes: Buffer.from([99, 88, 77, 66, 55, 44, 33, 22, 11, 0]) }
  };
  const injected = Object.keys(payloads).map(name => ({
    name,
    nameEnc: "latin1",
    type: payloads[name].type,
    typeEnc: "latin1",
    size: payloads[name].bytes.length,
    ...payloads[name].extra,
    guidFlag: 0,
    opaque: new Uint8Array(payloads[name].bytes)
  }));
  doc.props.splice(noneIdx, 0, ...injected);

  const encoded = Buffer.from(Codec.encodeSavSync(doc));
  const decoded = Codec.decodeSavSync(encoded);
  const inspected = Codec.inspect(decoded);
  assert.strictEqual(inspected.readOnly, true);
  assert.strictEqual(inspected.preserved, true);
  assert.strictEqual(inspected.opaquePresentCount, 4);
  const expectedTotal = Object.values(payloads).reduce((acc, p) => acc + p.bytes.length, 0);
  assert.strictEqual(inspected.opaqueTotalBytes, expectedTotal);

  for (const item of inspected.opaqueProps) {
    assert.strictEqual(item.present, true);
    assert.strictEqual(item.readOnly, true);
    assert.strictEqual(item.preserved, true);
    assert.strictEqual(item.byteLength, payloads[item.name].bytes.length);
  }

  const session = Core.createSession(Codec, Catalog);
  await session.loadBytes(encoded, { filename: "opaque_test.sav" });
  const sum = session.getSummary();
  assert.strictEqual(sum.opaquePresentCount, 4);
  assert.strictEqual(sum.opaqueTotalBytes, expectedTotal);
  assert.strictEqual(sum.opaqueReadOnly, true);
  assert.strictEqual(session.setMoney(8888888), true);

  const reExported = Buffer.from(await session.exportBytes());
  const reDecoded = Codec.decodeSavSync(reExported);
  for (const name of Object.keys(payloads)) {
    const prop = reDecoded.props.find(p => p && p.name === name);
    assert(prop && prop.opaque, `opaque prop ${name} missing after roundtrip`);
    assert.strictEqual(sha256(Buffer.from(prop.opaque)), sha256(payloads[name].bytes), `${name} opaque SHA-256 mismatch`);
  }
}

function testHtmlBundle() {
  const file = path.resolve(__dirname, "../dist/WanderingSwordSaveEditor-v1.0.html");
  assert(fs.existsSync(file), "bundle missing");
  const stat = fs.statSync(file);
  assert(stat.size < 10 * 1024 * 1024, "bundle >= 10 MiB");
  const html = fs.readFileSync(file, "utf8");
  assert(!HANZI_RE.test(html), "Hanzi in bundle");
  assert(!TAG_RE.test(html), "markup tag in bundle");
  assert(!/(?:https?|ftp|wss?):\/\/|(?:src|href|action|poster|data|cite)\s*=\s*["']?\s*\/\//i.test(html), "external URL in bundle");
  assert(html.includes('<meta name="ws-loopback-token" content="">'), "loopback meta missing");
  assert(html.includes('id="editorCodeAtlasBox"'), "editorCodeAtlasBox missing in bundle");
  for (const token of ["AttackPowerMMC", "MMC_Special_XiXing", "ArmorDamageReduction", "ExtraDifficultyBuff", "WorldWalkNPCInfos"]) {
    assert(html.includes(token), `REA atlas token ${token} missing in bundle`);
  }
}

(async () => {
  try {
    await testCatalog();
    await testDemoAndPresets();
    testCorruptions();
    await testPureKoreanValidateMessages();
    await testOpaquePropsInspectAndRoundtrip();
    const realCount = await testRealSaves();
    testHtmlBundle();
    console.log(`PASS test_editor.cjs (realSaves=${realCount})`);
    process.exit(0);
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
