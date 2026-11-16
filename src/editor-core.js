(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./gvas-codec.js"),
      require("./catalog-data.js")
    );
  } else {
    root.WanderingSwordEditorCore = factory(
      root.WanderingSwordCodec,
      root.WanderingSwordCatalog
    );
  }
}(typeof globalThis !== "undefined" ? globalThis : typeof self !== "undefined" ? self : this, function (Codec, Catalog) {
  "use strict";

  var SLOT_CLASS = "/Script/JH.JHSaveGame";
  var CONFIG_CLASS = "/Script/JH.JHSaveGameConfig";
  var MAX_INT32 = 2147483647;
  var MAX_FAVOR = 100;
  var MIN_FAVOR = 0;
  var MAX_SKILL_LEVEL = 10;
  var MAX_BAG_COUNT = 99999999;

  var ATTR_GROUP_MAP = {};
  (function () {
    var i;
    for (i = 1; i <= 4; i += 1) ATTR_GROUP_MAP[i] = "기혈·진기";
    for (i = 5; i <= 8; i += 1) ATTR_GROUP_MAP[i] = "기본 능력";
    for (i = 9; i <= 14; i += 1) ATTR_GROUP_MAP[i] = "전투 능력";
    [15, 17, 19, 21, 23, 25].forEach(function (id) { ATTR_GROUP_MAP[id] = "무기 숙련"; });
    [28, 30, 32, 34, 36, 38, 49, 62, 64, 66, 68].forEach(function (id) { ATTR_GROUP_MAP[id] = "생활 기예"; });
    [42, 44, 45].forEach(function (id) { ATTR_GROUP_MAP[id] = "내공·정력"; });
  }());

  var PRESETS = [
    { id: "wealth_max", target: "slot", label: "재화·점수 풍족", desc: "보유 금전 9,999,999와 주인공 무학 점수 999,999, 경맥 점수 99,999를 부여합니다." },
    { id: "hero_cultivation", target: "slot", label: "주인공 능력 강화", desc: "주인공의 기혈·진기·내공·공격·방어·정력과 심법 상한을 대폭 강화합니다." },
    { id: "party_favor_max", target: "slot", label: "동료 호감 최대", desc: "주인공과 파티 동료 간 양방향 호감도를 100으로 맞춥니다." },
    { id: "skills_lv10", target: "slot", label: "파티 무공 10레벨", desc: "주인공과 파티 동료가 습득한 모든 무공 등급을 10으로 올립니다." },
    { id: "unlock_mounts_recipes", target: "slot", label: "탈것·도안 전체 해금", desc: "탈것 10종과 연단·요리·단조 도안을 모두 해금합니다." },
    { id: "reset_pill_limits", target: "slot", label: "복용 제한 초기화", desc: "영단·음식 복용 횟수 제한 기록을 초기화합니다." },
    { id: "config_score_max", target: "config", label: "전승 점수·특전 해금", desc: "전승 점수를 99,999로 설정하고 전승 특전을 해금합니다." }
  ];

  var PRESET_MAP = {};
  PRESETS.forEach(function (p) { PRESET_MAP[p.id] = p; });

  function noneProp() {
    return { name: "None", nameEnc: "latin1" };
  }

  function propIndex(doc, name) {
    var props = doc && doc.props;
    if (!Array.isArray(props)) return -1;
    for (var i = 0; i < props.length; i += 1) {
      if (props[i] && props[i].name === name) return i;
    }
    return -1;
  }

  function findProp(doc, name) {
    var idx = propIndex(doc, name);
    return idx >= 0 ? doc.props[idx] : null;
  }

  function insertProp(doc, prop) {
    if (!doc || !Array.isArray(doc.props)) doc.props = [];
    var idx = propIndex(doc, "None");
    if (idx < 0) {
      doc.props.push(prop);
      doc.props.push(noneProp());
    } else {
      doc.props.splice(idx, 0, prop);
    }
    return prop;
  }

  function ensureProp(doc, name, create) {
    var prop = findProp(doc, name);
    if (!prop) {
      prop = create();
      insertProp(doc, prop);
    }
    return prop;
  }

  function intProp(name, val) {
    return {
      name: name,
      nameEnc: "latin1",
      type: "IntProperty",
      typeEnc: "latin1",
      guidFlag: 0,
      val: toInt(val)
    };
  }

  function strProp(name, val) {
    return {
      name: name,
      nameEnc: "latin1",
      type: "StrProperty",
      typeEnc: "latin1",
      guidFlag: 0,
      val: String(val),
      valEnc: "latin1"
    };
  }

  function enumProp(name, enumName, val) {
    return {
      name: name,
      nameEnc: "latin1",
      type: "EnumProperty",
      typeEnc: "latin1",
      enumName: { str: enumName, enc: "latin1" },
      guidFlag: 0,
      val: val,
      valEnc: "latin1"
    };
  }

  function arrayPropInt(name, val) {
    return {
      name: name,
      nameEnc: "latin1",
      type: "ArrayProperty",
      typeEnc: "latin1",
      elemType: { str: "IntProperty", enc: "latin1" },
      guidFlag: 0,
      val: (val || []).map(toInt)
    };
  }

  function setPropInt(name, val) {
    return {
      name: name,
      nameEnc: "latin1",
      type: "SetProperty",
      typeEnc: "latin1",
      elemType: { str: "IntProperty", enc: "latin1" },
      guidFlag: 0,
      removedCount: 0,
      val: (val || []).map(toInt)
    };
  }

  function mapMountProp(entries) {
    return {
      name: "MountIds",
      nameEnc: "latin1",
      type: "MapProperty",
      typeEnc: "latin1",
      keyType: { str: "IntProperty", enc: "latin1" },
      valType: { str: "StructProperty", enc: "latin1" },
      guidFlag: 0,
      removedCount: 0,
      entries: entries || []
    };
  }

  function makeMountEntry(mountId) {
    return {
      key: toInt(mountId),
      val: [
        intProp("MountId", mountId),
        noneProp()
      ]
    };
  }

  function toInt(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    n = Math.trunc(n);
    if (n < -MAX_INT32 - 1) n = -MAX_INT32 - 1;
    if (n > MAX_INT32) n = MAX_INT32;
    return n | 0;
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) n = min;
    n = Math.trunc(n);
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function propVal(doc, name, fallback) {
    var p = findProp(doc, name);
    return p ? p.val : fallback;
  }

  function setPropVal(doc, name, val) {
    var p = findProp(doc, name);
    if (p) p.val = val;
    return p;
  }

  function isConfigDoc(doc) {
    return !!(doc && doc.className && doc.className.str === CONFIG_CLASS);
  }

  function attrValue(entry) {
    if (!entry) return 0;
    var v = entry.val;
    if (v && typeof v === "object") return Number(v.val) || 0;
    return Number(v) || 0;
  }

  function setAttrEntry(entry, value) {
    entry.val = { val: Number(value) };
    return entry;
  }

  function findAttr(npc, id) {
    if (!npc || !Array.isArray(npc.attrs)) return null;
    for (var i = 0; i < npc.attrs.length; i += 1) {
      if (npc.attrs[i] && npc.attrs[i].id === id) return npc.attrs[i];
    }
    return null;
  }

  function ensureAttr(npc, id) {
    var item = findAttr(npc, id);
    if (!item) {
      item = { id: id, val: { val: 0 } };
      npc.attrs = npc.attrs || [];
      npc.attrs.push(item);
      npc.attrs.sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
    }
    return item;
  }

  function findNpc(doc, npcId) {
    if (!doc || !Array.isArray(doc.npcs)) return null;
    var id = toInt(npcId);
    for (var i = 0; i < doc.npcs.length; i += 1) {
      if (doc.npcs[i] && toInt(doc.npcs[i].npcId) === id) return doc.npcs[i];
    }
    return null;
  }

  function makeItem(guidSeed, tableId, count, flag44) {
    return {
      guid: [toInt(guidSeed), 0, 0, 0],
      tableId: toInt(tableId),
      count: toInt(count),
      flag44: toInt(flag44 || 0),
      affA: [],
      affB: [],
      f68: 0,
      flag45: 0,
      flag46: 0
    };
  }

  function makeAttrList(seed) {
    var list = [];
    for (var id = 1; id <= 69; id += 1) {
      var base = (seed + id * 7) % 40;
      if (id === 1 || id === 2) base = 260 + seed;
      if (id === 3 || id === 4) base = 180 + seed;
      if (id === 5) base = 6 + (seed % 5);
      if (id === 6 || id === 7 || id === 8) base = 25 + (seed % 15);
      if (id === 9) base = 80 + seed;
      if (id === 10) base = 12 + (seed % 15);
      if (id === 11) base = 40 + seed;
      if (id === 12) base = 5 + (seed % 20);
      if (id === 13) base = 450 + seed;
      if (id === 42) base = 120 + seed;
      if (id === 44 || id === 45) base = 110 + seed;
      list.push({ id: id, val: { val: base } });
    }
    return list;
  }

  function makeMeridians(isHero) {
    var out = [];
    for (var i = 1; i <= 6; i += 1) {
      out.push({
        key: i,
        id: i,
        level: 0,
        unlocked: 1,
        active: 1
      });
    }
    [10, 11, 12].forEach(function (id) {
      out.push({
        key: id,
        id: id,
        level: isHero ? 3 : 1,
        unlocked: 1,
        active: 1
      });
    });
    return out;
  }

  function makeDemoNpc(npcId, allNpcIds, isHero) {
    var skills = isHero ? [
      { skillId: 100, level: 8, slotIndex: -1, activeA: 1, activeB: 0 },
      { skillId: 101, level: 6, slotIndex: -1, activeA: 1, activeB: 0 },
      { skillId: 105, level: 4, slotIndex: -1, activeA: 1, activeB: 0 }
    ] : [
      { skillId: 102, level: 5, slotIndex: -1, activeA: 1, activeB: 0 },
      { skillId: 104, level: 3, slotIndex: -1, activeA: 1, activeB: 0 }
    ];
    var npc = {
      npcId: toInt(npcId),
      addNeiGongLimit: isHero ? 240 : 80,
      skillExp: isHero ? 8200 : 1200,
      attrs: makeAttrList(toInt(npcId) % 50),
      skills: skills,
      meridians: makeMeridians(isHero),
      friendliness: [],
      guildFriendliness: [{ guildId: 1, favor: 60 }],
      guildHonors: isHero ? [{ guildId: 1, honor: 1500 }] : [{ guildId: 1, honor: 300 }],
      jingMaiPoint: isHero ? 9 : 2,
      personalItems: [],
      equippedItems: [],
      avatarName: { str: isHero ? "Hero_WuDang" : "Hero_Companion", enc: "latin1" },
      walkState: { ints: [0, 0, 0], name: { str: "None", enc: "latin1" }, bools: [0, 0, 0], byte: 0 },
      itemUsedCount: isHero ? [{ itemId: 100, count: 3 }] : [],
      sceneBuffs: [],
      formationIndex: 0,
      jingMaiExts: [0, 0, 0, 0],
      unlockedAvatars: [],
      sideBarOrderIndex: isHero ? 0 : 1
    };
    allNpcIds.forEach(function (otherId) {
      if (toInt(otherId) !== toInt(npcId)) {
        npc.friendliness.push({ npcId: toInt(otherId), favor: 70 });
      }
    });
    return npc;
  }

  function makeBaseDemoDoc(classNameStr, props, items, npcs) {
    return {
      saveVersion: 12,
      magic: "GVAS",
      saveGameVersion: 2,
      packageFileVersion: 522,
      engineVersion: {
        major: 4,
        minor: 26,
        patch: 2,
        changelist: 0,
        branch: { str: "++UE4+Release-4.26", enc: "latin1" }
      },
      customVersionFormat: 3,
      customVersions: [],
      className: { str: classNameStr, enc: "latin1" },
      preField: 0,
      props: props,
      postZero: 0,
      items: items,
      npcs: npcs
    };
  }

  function createDemoDoc() {
    var npcIds = [0, 17012, 12011, 12010, 11509];
    var doc = makeBaseDemoDoc(
      SLOT_CLASS,
      [],
      [
        makeItem(1, 100, 5, 0),
        makeItem(2, 101, 3, 0),
        makeItem(3, 1000, 1, 0),
        makeItem(4, 1003, 1, 0),
        makeItem(5, 10002, 10, 0),
        makeItem(6, 10018, 20, 0)
      ],
      npcIds.map(function (id) {
        return makeDemoNpc(id, npcIds, id === 0);
      })
    );

    doc.props.push(strProp("MapName", "LV_WuDang_P"));
    doc.props.push(intProp("SaveGameTime", 18420));
    doc.props.push(intProp("Money", 12500));
    doc.props.push(enumProp("TurnMode", "ETurnMode", "ETurnMode::RealTime"));
    doc.props.push(arrayPropInt("TeamInfos", [0, 17012, 12011, 12010, 11509]));
    doc.props.push(arrayPropInt("FightTeamInfos", [0, 17012, 12011, 12010]));
    doc.props.push(intProp("SelectedMountId", 1));
    doc.props.push(mapMountProp([makeMountEntry(1)]));
    doc.props.push(arrayPropInt("AlchemyRecipes", [100, 101]));
    doc.props.push(arrayPropInt("CookingRecipes", [100, 101]));
    doc.props.push(arrayPropInt("FusionRecipes", [1000, 1001]));
    doc.props.push(arrayPropInt("CanTransMapIds", [101, 102]));
    doc.props.push(intProp("CurrentTrackingQuestId", 0));
    doc.props.push(intProp("CurrentTrackingPrimeQuestId", 0));
    doc.props.push(noneProp());
    return doc;
  }

  function createDemoConfigDoc() {
    return makeBaseDemoDoc(
      CONFIG_CLASS,
      [
        intProp("Score", 3500),
        setPropInt("InheritIds", [1, 4]),
        setPropInt("PictorialBookIds", [100, 101, 102]),
        setPropInt("SkillIds", [100, 101, 102, 105]),
        setPropInt("ItemIds", [100, 101, 1000]),
        setPropInt("EnterTeamNPCIDs", [0, 17012, 12011]),
        setPropInt("EndingIds", [213]),
        noneProp()
      ],
      [],
      []
    );
  }

  function createDemoSavBytesSync(catalog, codec) {
    catalog = catalog || Catalog;
    codec = codec || Codec;
    return codec.encodeSavSync(createDemoDoc(catalog));
  }

  function createDemoSavBytes(catalog, codec) {
    catalog = catalog || Catalog;
    codec = codec || Codec;
    return codec.encodeSav(createDemoDoc(catalog));
  }

  function createDemoConfigSavBytesSync(catalog, codec) {
    catalog = catalog || Catalog;
    codec = codec || Codec;
    return codec.encodeSavSync(createDemoConfigDoc());
  }

  function createDemoConfigSavBytes(catalog, codec) {
    catalog = catalog || Catalog;
    codec = codec || Codec;
    return codec.encodeSav(createDemoConfigDoc());
  }

  function formatPlayTime(totalSeconds) {
    var sec = Math.max(0, toInt(totalSeconds));
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    return h + "시간 " + m + "분 " + s + "초";
  }

  function itemName(catalog, item) {
    if (!item) return "";
    return catalog.getItemName(item.tableId) || "";
  }

  function itemView(catalog, item, index) {
    var meta = catalog.getItem(item.tableId) || {};
    return {
      index: typeof index === "number" ? index : -1,
      guid: item.guid,
      guidKey: item.guid ? String(item.guid[0]) : "",
      tableId: toInt(item.tableId),
      name: itemName(catalog, item) || ("물품 " + item.tableId),
      bucket: Number(meta.bucket || 0),
      bucketName: meta.bucketName || "기타",
      stackable: !!meta.stackable,
      desc: meta.desc || "",
      count: toInt(item.count),
      flag44: toInt(item.flag44)
    };
  }

  function attrName(catalog, id) {
    return catalog.getAttrName(id) || ("능력치 " + id);
  }

  function attrGroup(catalog, id) {
    var attr = catalog.getAttr(id);
    return (attr && attr.group) || ATTR_GROUP_MAP[id] || "기타 능력";
  }

  function attrFormat(catalog, id) {
    var attr = catalog.getAttr(id);
    return (attr && attr.format) || "%d";
  }

  function makeSession(codec, catalog) {
    codec = codec || Codec;
    catalog = catalog || Catalog;
    var state = {
      doc: null,
      bytes: null,
      meta: null,
      dirty: false
    };

    function markDirty() {
      state.dirty = true;
    }

    function requireDoc() {
      if (!state.doc) throw new Error("세이브 데이터가 로드되지 않았습니다.");
      return state.doc;
    }

    function requireSlot() {
      var doc = requireDoc();
      if (isConfigDoc(doc)) throw new Error("일반 슬롯 세이브에서만 사용할 수 있는 기능입니다.");
      return doc;
    }

    function loadDoc(doc, meta) {
      state.doc = doc;
      state.meta = meta || {};
      state.bytes = null;
      state.dirty = false;
      return session;
    }

    function loadBytesSync(bytes, meta) {
      var doc = codec.decodeSavSync(bytes);
      state.doc = doc;
      state.bytes = bytes;
      state.meta = meta || {};
      state.dirty = false;
      return session;
    }

    function loadBytes(bytes, meta) {
      return codec.decodeSav(bytes).then(function (doc) {
        state.doc = doc;
        state.bytes = bytes;
        state.meta = meta || {};
        state.dirty = false;
        return session;
      });
    }

    function exportBytesSync() {
      var doc = requireDoc();
      var bytes = codec.encodeSavSync(doc);
      state.bytes = bytes;
      return bytes;
    }

    function exportBytes() {
      var doc = requireDoc();
      return codec.encodeSav(doc).then(function (bytes) {
        state.bytes = bytes;
        return bytes;
      });
    }

    function getDoc() { return state.doc; }
    function getMeta() { return state.meta || {}; }
    function isLoaded() { return !!state.doc; }
    function isConfigSave() { return isConfigDoc(state.doc); }
    function isDirty() { return state.dirty; }
    function markClean() { state.dirty = false; return session; }

    function getFavorTowardHero(doc, npc) {
      if (toInt(npc.npcId) === 0) return { favorWithHero: 100, signedFavorWithHero: 100 };
      var favor = 0;
      var list = Array.isArray(npc.friendliness) ? npc.friendliness : [];
      var found = null;
      for (var i = 0; i < list.length; i += 1) {
        if (toInt(list[i].npcId) === 0) { found = list[i]; break; }
      }
      if (!found) {
        var hero = findNpc(doc, 0);
        var heroList = hero && Array.isArray(hero.friendliness) ? hero.friendliness : [];
        for (var j = 0; j < heroList.length; j += 1) {
          if (toInt(heroList[j].npcId) === toInt(npc.npcId)) { found = heroList[j]; break; }
        }
      }
      if (found) favor = toInt(found.favor);
      var signedFavorWithHero = favor > 127 ? favor - 256 : favor;
      return {
        favorWithHero: clamp(signedFavorWithHero, MIN_FAVOR, MAX_FAVOR),
        signedFavorWithHero: signedFavorWithHero
      };
    }

    function getSummary() {
      var doc = requireDoc();
      var opaqueMeta = typeof codec.inspectOpaqueProps === "function"
        ? codec.inspectOpaqueProps(doc)
        : { items: [], totalBytes: 0, presentCount: 0, readOnly: true, preserved: true };
      var summary;
      if (isConfigDoc(doc)) {
        var inheritIds = (findProp(doc, "InheritIds") || {}).val || [];
        var pictorialIds = (findProp(doc, "PictorialBookIds") || {}).val || [];
        var skillIds = (findProp(doc, "SkillIds") || {}).val || [];
        var itemIds = (findProp(doc, "ItemIds") || {}).val || [];
        var cfgTeamIds = (findProp(doc, "EnterTeamNPCIDs") || {}).val || [];
        var endingIds = (findProp(doc, "EndingIds") || {}).val || [];
        var saveList = (findProp(doc, "SaveGameList") || {}).val || [];
        var slotSummaries = (Array.isArray(saveList) ? saveList : []).map(function (list, index) {
          var mapRaw = "";
          var timeVal = 0;
          var difficultyRaw = "";
          var versionVal = 0;
          (list || []).forEach(function (entry) {
            if (!entry) return;
            if (entry.name === "MapName") mapRaw = entry.val;
            if (entry.name === "SaveGameTime") timeVal = toInt(entry.val);
            if (entry.name === "DifficultyMode") difficultyRaw = entry.val;
            if (entry.name === "Version") versionVal = toInt(entry.val);
          });
          return {
            index: index,
            version: versionVal,
            mapCode: mapRaw,
            mapNameKo: catalog.getMapName(mapRaw) || mapRaw,
            saveGameTime: timeVal,
            playTimeText: formatPlayTime(timeVal),
            difficultyRaw: difficultyRaw,
            difficultyKo: catalog.getDifficultyName(difficultyRaw) || difficultyRaw
          };
        });
        summary = {
          saveTypeLabel: "전역 환경·전승 세이브",
          isConfig: true,
          saveVersion: doc.saveVersion,
          score: toInt(propVal(doc, "Score", 0)),
          inheritIds: inheritIds.slice(),
          inheritNames: inheritIds.map(function (id) { return catalog.getInheritName(id) || ("전승 " + id); }),
          pictorialCount: pictorialIds.length,
          skillBookCount: skillIds.length,
          itemBookCount: itemIds.length,
          teamBookCount: cfgTeamIds.length,
          endingCount: endingIds.length,
          slotSummaries: slotSummaries,
          opaqueProps: opaqueMeta.items,
          opaqueTotalBytes: opaqueMeta.totalBytes,
          opaquePresentCount: opaqueMeta.presentCount,
          opaqueReadOnly: true
        };
        return summary;
      }

      var mapCode = String(propVal(doc, "MapName", ""));
      var saveGameTime = toInt(propVal(doc, "SaveGameTime", 0));
      var turnModeRaw = String(propVal(doc, "TurnMode", ""));
      var money = toInt(propVal(doc, "Money", 0));
      var selectedMountId = toInt(propVal(doc, "SelectedMountId", 0));
      var mountProp = findProp(doc, "MountIds");
      var mountEntries = mountProp && Array.isArray(mountProp.entries) ? mountProp.entries : [];
      var unlockedMountIds = mountEntries.map(function (entry) { return toInt(entry.key); });
      var teamIds = (propVal(doc, "TeamInfos", []) || []).map(toInt);
      var fightTeamIds = (propVal(doc, "FightTeamInfos", []) || []).map(toInt);
      var hero = findNpc(doc, 0);
      var heroSummary = null;
      if (hero) {
        var pillUsedCount = 0;
        (Array.isArray(hero.itemUsedCount) ? hero.itemUsedCount : []).forEach(function (e) {
          if (e) pillUsedCount += toInt(e.count);
        });
        var heroAttr = function (id) {
          return Math.round(attrValue(findAttr(hero, id)));
        };
        heroSummary = {
          npcId: 0,
          name: catalog.getNpcName(0) || "우문일",
          skillExp: toInt(hero.skillExp),
          jingMaiPoint: toInt(hero.jingMaiPoint),
          addNeiGongLimit: toInt(hero.addNeiGongLimit),
          skillCount: Array.isArray(hero.skills) ? hero.skills.length : 0,
          meridianCount: Array.isArray(hero.meridians) ? hero.meridians.length : 0,
          itemUsedCount: Array.isArray(hero.itemUsedCount) ? hero.itemUsedCount.length : 0,
          pillUsedCount: pillUsedCount,
          hp: heroAttr(1),
          maxHp: heroAttr(2),
          mp: heroAttr(3),
          maxMp: heroAttr(4),
          realm: heroAttr(5),
          str: heroAttr(6),
          bone: heroAttr(7),
          agi: heroAttr(8),
          atk: heroAttr(9),
          def: heroAttr(11),
          inner: heroAttr(42),
          stamina: heroAttr(44),
          maxStamina: heroAttr(45)
        };
      }
      return {
        saveTypeLabel: "일반 슬롯 세이브",
        isConfig: false,
        saveVersion: doc.saveVersion,
        mapCode: mapCode,
        mapNameKo: catalog.getMapName(mapCode) || mapCode,
        saveGameTime: saveGameTime,
        playTimeText: formatPlayTime(saveGameTime),
        turnModeRaw: turnModeRaw,
        turnModeKo: catalog.getTurnModeName(turnModeRaw) || turnModeRaw,
        money: money,
        selectedMountId: selectedMountId,
        selectedMountName: catalog.getMountName(selectedMountId) || "",
        unlockedMountIds: unlockedMountIds,
        unlockedMountCount: unlockedMountIds.length,
        teamIds: teamIds,
        teamNames: teamIds.map(function (id) { return catalog.getNpcName(id) || ("인물 " + id); }),
        fightTeamIds: fightTeamIds,
        bagItemCount: Array.isArray(doc.items) ? doc.items.length : 0,
        npcCount: Array.isArray(doc.npcs) ? doc.npcs.length : 0,
        recipeCounts: {
          alchemy: (propVal(doc, "AlchemyRecipes", []) || []).length,
          cooking: (propVal(doc, "CookingRecipes", []) || []).length,
          fusion: (propVal(doc, "FusionRecipes", []) || []).length
        },
        opaqueProps: opaqueMeta.items,
        opaqueTotalBytes: opaqueMeta.totalBytes,
        opaquePresentCount: opaqueMeta.presentCount,
        opaqueReadOnly: true,
        hero: heroSummary
      };
    }

    function listEditableCharacters(query) {
      var doc = requireDoc();
      if (isConfigDoc(doc)) return [];
      var q = query == null ? "" : String(query).trim().toLowerCase();
      var result = [];
      var seen = {};
      var teamIds = (propVal(doc, "TeamInfos", []) || []).map(toInt);
      var fightTeamIds = (propVal(doc, "FightTeamInfos", []) || []).map(toInt);
      function add(npcId, isHero, isParty, order) {
        var id = toInt(npcId);
        if (seen[id]) return;
        var npc = findNpc(doc, id);
        if (!npc) return;
        seen[id] = true;
        var name = catalog.getNpcName(id) || ("인물 " + id);
        if (q && String(id).indexOf(q) < 0 && name.toLowerCase().indexOf(q) < 0) return;
        var fav = getFavorTowardHero(doc, npc);
        result.push({
          npcId: id,
          name: name,
          tag: isHero ? "주인공" : isParty ? "동료" : "인물",
          isHero: !!isHero,
          isParty: !!isParty,
          isFightParty: fightTeamIds.indexOf(id) >= 0,
          favorWithHero: fav.favorWithHero,
          signedFavorWithHero: fav.signedFavorWithHero,
          order: order
        });
      }
      add(0, true, true, 0);
      teamIds.forEach(function (id, index) {
        if (id !== 0) add(id, false, true, index + 1);
      });
      var npcs = Array.isArray(doc.npcs) ? doc.npcs : [];
      npcs.forEach(function (npc) {
        if (npc) add(npc.npcId, toInt(npc.npcId) === 0, teamIds.indexOf(toInt(npc.npcId)) >= 0, 1000 + toInt(npc.npcId));
      });
      return result;
    }

    function getCharacterDetail(npcId) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc) return null;
      var thisId = toInt(npc.npcId);
      var teamIds = (propVal(doc, "TeamInfos", []) || []).map(toInt);
      var fightTeamIds = (propVal(doc, "FightTeamInfos", []) || []).map(toInt);
      var isHero = thisId === 0;
      var isParty = isHero || teamIds.indexOf(thisId) >= 0;
      var isFightParty = fightTeamIds.indexOf(thisId) >= 0;
      var attrs = [];
      for (var aid = 1; aid <= 69; aid += 1) {
        var attrEntry = findAttr(npc, aid);
        attrs.push({
          id: aid,
          name: attrName(catalog, aid),
          group: attrGroup(catalog, aid),
          format: attrFormat(catalog, aid),
          val: attrEntry ? attrValue(attrEntry) : 0
        });
      }
      var skills = (Array.isArray(npc.skills) ? npc.skills : []).map(function (skill) {
        var meta = catalog.getSkill(skill.skillId) || {};
        return {
          skillId: toInt(skill.skillId),
          name: catalog.getSkillName(skill.skillId) || ("무공 " + skill.skillId),
          category: meta.category || meta.group || meta.typeName || "",
          desc: meta.desc || meta.description || "",
          level: toInt(skill.level),
          slotIndex: toInt(skill.slotIndex)
        };
      });
      var meridians = (Array.isArray(npc.meridians) ? npc.meridians : []).map(function (m) {
        var id = toInt(m.id != null ? m.id : m.key);
        var meta = catalog.getMeridian(id) || {};
        return {
          id: id,
          name: catalog.getMeridianName(id) || ("경락 " + id),
          desc: meta.desc || meta.description || "",
          level: toInt(m.level),
          maxLevel: toInt(meta.maxLevel != null ? meta.maxLevel : 3),
          unlocked: toInt(m.unlocked),
          active: toInt(m.active)
        };
      });
      var guildHonors = (Array.isArray(npc.guildHonors) ? npc.guildHonors : []).map(function (g) {
        return {
          guildId: toInt(g.guildId),
          name: catalog.getGuildName(g.guildId) || ("문파 " + g.guildId),
          honor: toInt(g.honor)
        };
      });
      var equippedItems = (Array.isArray(npc.equippedItems) ? npc.equippedItems : []).map(function (item, idx) {
        return itemView(catalog, item, idx);
      });
      var itemUsedCount = (Array.isArray(npc.itemUsedCount) ? npc.itemUsedCount : []).map(function (entry) {
        return {
          itemId: toInt(entry.itemId),
          name: catalog.getItemName(entry.itemId) || ("아이템 " + entry.itemId),
          count: toInt(entry.count)
        };
      });
      var friendliness = (Array.isArray(npc.friendliness) ? npc.friendliness : []).map(function (entry) {
        var raw = toInt(entry.favor);
        var signedFavor = raw > 127 ? raw - 256 : raw;
        return {
          npcId: toInt(entry.npcId),
          name: catalog.getNpcName(entry.npcId) || ("인물 " + entry.npcId),
          favor: clamp(signedFavor, MIN_FAVOR, MAX_FAVOR),
          signedFavor: signedFavor
        };
      });
      var guildFriendliness = (Array.isArray(npc.guildFriendliness) ? npc.guildFriendliness : []).map(function (entry) {
        var raw = toInt(entry.favor);
        var signedFavor = raw > 127 ? raw - 256 : raw;
        return {
          guildId: toInt(entry.guildId),
          name: catalog.getGuildName(entry.guildId) || ("문파 " + entry.guildId),
          favor: clamp(signedFavor, MIN_FAVOR, MAX_FAVOR),
          signedFavor: signedFavor
        };
      });
      var personalItems = (Array.isArray(npc.personalItems) ? npc.personalItems : []).map(function (item, idx) {
        return itemView(catalog, item, idx);
      });
      var favorTowardHero = getFavorTowardHero(doc, npc);
      return {
        npcId: thisId,
        name: catalog.getNpcName(thisId) || ("인물 " + thisId),
        addNeiGongLimit: toInt(npc.addNeiGongLimit),
        skillExp: toInt(npc.skillExp),
        jingMaiPoint: toInt(npc.jingMaiPoint),
        attrs: attrs,
        skills: skills,
        meridians: meridians,
        guildHonors: guildHonors,
        equippedItems: equippedItems,
        itemUsedCount: itemUsedCount,
        friendliness: friendliness,
        guildFriendliness: guildFriendliness,
        personalItems: personalItems,
        isHero: isHero,
        isParty: isParty,
        isFightParty: isFightParty,
        favorWithHero: favorTowardHero.favorWithHero,
        signedFavorWithHero: favorTowardHero.signedFavorWithHero
      };
    }

    function setMoney(amount) {
      var doc = requireSlot();
      var prop = ensureProp(doc, "Money", function () { return intProp("Money", 0); });
      prop.val = clamp(amount, 0, MAX_INT32);
      markDirty();
      return true;
    }

    function setTurnMode(mode) {
      var doc = requireSlot();
      var raw = String(mode || "");
      if (raw === "RealTime" || raw === "TurnBased") raw = "ETurnMode::" + raw;
      if (raw !== "ETurnMode::RealTime" && raw !== "ETurnMode::TurnBased") return false;
      var prop = ensureProp(doc, "TurnMode", function () {
        return enumProp("TurnMode", "ETurnMode", "ETurnMode::RealTime");
      });
      prop.val = raw;
      prop.valEnc = "latin1";
      markDirty();
      return true;
    }

    function setSelectedMount(mountId) {
      var doc = requireSlot();
      var id = clamp(mountId, 0, 10);
      var prop = ensureProp(doc, "SelectedMountId", function () { return intProp("SelectedMountId", 1); });
      prop.val = id;
      var mp = ensureProp(doc, "MountIds", function () {
        return mapMountProp([]);
      });
      if (!Array.isArray(mp.entries)) mp.entries = [];
      var exists = mp.entries.some(function (entry) { return toInt(entry.key) === id; });
      if (!exists && id > 0) mp.entries.push(makeMountEntry(id));
      markDirty();
      return true;
    }

    function unlockAllMounts() {
      var doc = requireSlot();
      var mp = ensureProp(doc, "MountIds", function () { return mapMountProp([]); });
      var existing = {};
      if (!Array.isArray(mp.entries)) mp.entries = [];
      mp.entries.forEach(function (entry) { existing[toInt(entry.key)] = true; });
      for (var id = 1; id <= 10; id += 1) {
        if (!existing[id]) mp.entries.push(makeMountEntry(id));
      }
      markDirty();
      return true;
    }

    function unlockAllRecipes() {
      var doc = requireSlot();
      var alchemy = catalog.recipes && catalog.recipes.alchemy ? catalog.recipes.alchemy : {};
      var cooking = catalog.recipes && catalog.recipes.cooking ? catalog.recipes.cooking : {};
      var fusion = catalog.recipes && catalog.recipes.fusion ? catalog.recipes.fusion : {};
      function idsOf(obj) {
        return Object.keys(obj || {}).map(toInt).filter(function (id) { return id > 0; }).sort(function (a, b) { return a - b; });
      }
      var alchemyProp = ensureProp(doc, "AlchemyRecipes", function () { return arrayPropInt("AlchemyRecipes", []); });
      var cookingProp = ensureProp(doc, "CookingRecipes", function () { return arrayPropInt("CookingRecipes", []); });
      var fusionProp = ensureProp(doc, "FusionRecipes", function () { return arrayPropInt("FusionRecipes", []); });
      var alchemyIds = idsOf(alchemy);
      var cookingIds = idsOf(cooking);
      var fusionIds = idsOf(fusion);
      function mergeUnlocked(existing, unlocked) {
        var out = Array.isArray(existing) ? existing.map(toInt) : [];
        unlocked.forEach(function (id) {
          if (out.indexOf(id) === -1) out.push(id);
        });
        return out.sort(function (a, b) { return a - b; });
      }
      alchemyProp.val = mergeUnlocked(alchemyProp.val, alchemyIds);
      cookingProp.val = mergeUnlocked(cookingProp.val, cookingIds);
      fusionProp.val = mergeUnlocked(fusionProp.val, fusionIds);
      markDirty();
      return true;
    }

    function setNpcResources(npcId, fieldsOrAddNeiGong, skillExp, jingMaiPoint) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc) return false;
      if (fieldsOrAddNeiGong != null && typeof fieldsOrAddNeiGong === "object" && !Array.isArray(fieldsOrAddNeiGong)) {
        if (fieldsOrAddNeiGong.addNeiGongLimit != null) npc.addNeiGongLimit = clamp(fieldsOrAddNeiGong.addNeiGongLimit, 0, MAX_INT32);
        if (fieldsOrAddNeiGong.skillExp != null) npc.skillExp = clamp(fieldsOrAddNeiGong.skillExp, 0, MAX_INT32);
        if (fieldsOrAddNeiGong.jingMaiPoint != null) npc.jingMaiPoint = clamp(fieldsOrAddNeiGong.jingMaiPoint, 0, MAX_INT32);
      } else {
        if (fieldsOrAddNeiGong != null) npc.addNeiGongLimit = clamp(fieldsOrAddNeiGong, 0, MAX_INT32);
        if (skillExp != null) npc.skillExp = clamp(skillExp, 0, MAX_INT32);
        if (jingMaiPoint != null) npc.jingMaiPoint = clamp(jingMaiPoint, 0, MAX_INT32);
      }
      markDirty();
      return true;
    }

    function setNpcAttr(npcId, attrId, val) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      var id = toInt(attrId);
      if (!npc || id < 1 || id > 69) return false;
      var entry = ensureAttr(npc, id);
      setAttrEntry(entry, Number(val) || 0);
      markDirty();
      return true;
    }

    function setCompanionFavor(npcId, targetOrFavor, maybeFavor) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      var targetNpcId = maybeFavor === undefined ? 0 : targetOrFavor;
      var favor = maybeFavor === undefined ? targetOrFavor : maybeFavor;
      var target = findNpc(doc, targetNpcId);
      var value = clamp(favor, MIN_FAVOR, MAX_FAVOR);
      if (!npc || !target) return false;
      function setFavor(owner, otherId) {
        owner.friendliness = Array.isArray(owner.friendliness) ? owner.friendliness : [];
        var entry = null;
        for (var i = 0; i < owner.friendliness.length; i += 1) {
          if (toInt(owner.friendliness[i].npcId) === toInt(otherId)) {
            entry = owner.friendliness[i];
            break;
          }
        }
        if (!entry) {
          entry = { npcId: toInt(otherId), favor: value };
          owner.friendliness.push(entry);
        }
        entry.favor = value;
      }
      setFavor(npc, targetNpcId);
      setFavor(target, npcId);
      markDirty();
      return true;
    }

    function setGuildFavor(npcId, guildId, favor) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc) return false;
      var gid = toInt(guildId);
      var value = clamp(favor, MIN_FAVOR, MAX_FAVOR);
      npc.guildFriendliness = Array.isArray(npc.guildFriendliness) ? npc.guildFriendliness : [];
      var entry = null;
      for (var i = 0; i < npc.guildFriendliness.length; i += 1) {
        if (toInt(npc.guildFriendliness[i].guildId) === gid) {
          entry = npc.guildFriendliness[i];
          break;
        }
      }
      if (!entry) {
        entry = { guildId: gid, favor: value };
        npc.guildFriendliness.push(entry);
      }
      entry.favor = value;
      markDirty();
      return true;
    }

    function setGuildHonor(npcId, guildId, honor) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc) return false;
      var gid = toInt(guildId);
      npc.guildHonors = Array.isArray(npc.guildHonors) ? npc.guildHonors : [];
      var entry = null;
      for (var i = 0; i < npc.guildHonors.length; i += 1) {
        if (toInt(npc.guildHonors[i].guildId) === gid) {
          entry = npc.guildHonors[i];
          break;
        }
      }
      if (!entry) {
        entry = { guildId: gid, honor: 0 };
        npc.guildHonors.push(entry);
      }
      entry.honor = clamp(honor, 0, MAX_INT32);
      markDirty();
      return true;
    }

    function setSkillLevel(npcId, skillId, level) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc || !Array.isArray(npc.skills)) return false;
      var sid = toInt(skillId);
      var lv = clamp(level, 0, MAX_SKILL_LEVEL);
      for (var i = 0; i < npc.skills.length; i += 1) {
        if (toInt(npc.skills[i].skillId) === sid) {
          npc.skills[i].level = lv;
          markDirty();
          return true;
        }
      }
      return false;
    }

    function addSkill(npcId, skillId, level, slotIndex) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc) return false;
      var sid = toInt(skillId);
      if (sid <= 0 || sid === 8 || !catalog.getSkill(sid)) return false;
      npc.skills = Array.isArray(npc.skills) ? npc.skills : [];
      var exists = npc.skills.some(function (s) { return toInt(s.skillId) === sid; });
      if (exists) return false;
      npc.skills.push({
        skillId: sid,
        level: clamp(level == null ? 1 : level, 1, MAX_SKILL_LEVEL),
        slotIndex: slotIndex == null ? -1 : toInt(slotIndex),
        activeA: 1,
        activeB: 0
      });
      markDirty();
      return true;
    }

    function removeSkill(npcId, skillId) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc || !Array.isArray(npc.skills)) return false;
      var sid = toInt(skillId);
      for (var i = 0; i < npc.skills.length; i += 1) {
        if (toInt(npc.skills[i].skillId) === sid) {
          if (toInt(npc.skills[i].slotIndex) !== -1) return false;
          npc.skills.splice(i, 1);
          markDirty();
          return true;
        }
      }
      return false;
    }

    function unlockAllMeridians(npcId) {
      var doc = requireDoc();
      var npc = findNpc(doc, npcId);
      if (!npc) return false;
      npc.meridians = Array.isArray(npc.meridians) ? npc.meridians : [];
      var ids = Object.keys(catalog.meridians || {}).map(function (k) { return toInt(k); }).filter(function (id) { return id > 0; }).sort(function (a, b) { return a - b; });
      ids.forEach(function (id) {
        var maxLv = toInt((catalog.getMeridian(id) || {}).maxLevel || 0);
        var found = false;
        for (var i = 0; i < npc.meridians.length; i += 1) {
          if (toInt(npc.meridians[i].id != null ? npc.meridians[i].id : npc.meridians[i].key) === id) {
            npc.meridians[i].key = id;
            npc.meridians[i].id = id;
            npc.meridians[i].level = Math.max(toInt(npc.meridians[i].level), maxLv);
            npc.meridians[i].unlocked = 1;
            npc.meridians[i].active = 1;
            found = true;
            break;
          }
        }
        if (!found) {
          npc.meridians.push({ key: id, id: id, level: maxLv, unlocked: 1, active: 1 });
        }
      });
      if (!Array.isArray(npc.jingMaiExts)) npc.jingMaiExts = [0, 0, 0, 0];
      npc.jingMaiPoint = Math.max(toInt(npc.jingMaiPoint), 9999);
      markDirty();
      return true;
    }

    function resetPillLimits(npcId) {
      var doc = requireSlot();
      if (npcId != null) {
        var npc = findNpc(doc, npcId);
        if (!npc) return false;
        npc.itemUsedCount = [];
      } else {
        (Array.isArray(doc.npcs) ? doc.npcs : []).forEach(function (npc) {
          if (npc) npc.itemUsedCount = [];
        });
      }
      markDirty();
      return true;
    }

    function listBagItems() {
      var doc = requireSlot();
      return (Array.isArray(doc.items) ? doc.items : []).map(function (item, idx) {
        return itemView(catalog, item, idx);
      });
    }

    function setBagItemCount(indexOrGuid, count) {
      var doc = requireSlot();
      var items = Array.isArray(doc.items) ? doc.items : [];
      var target = null;
      if (typeof indexOrGuid === "number" && indexOrGuid >= 0 && indexOrGuid < items.length) {
        target = items[indexOrGuid];
      } else if (typeof indexOrGuid === "string") {
        target = items.find(function (item) {
          return item.guid && String(item.guid[0]) === indexOrGuid;
        });
      }
      if (!target) return false;
      var meta = catalog.getItem(target.tableId) || {};
      var bucket = Number(meta.bucket);
      var next = clamp(count, 1, bucket === 2 ? 1 : MAX_BAG_COUNT);
      target.count = next;
      markDirty();
      return true;
    }

    function addBagItem(tableId, count) {
      var doc = requireSlot();
      var itemMeta = catalog.getItem(tableId) || {};
      if (Number(itemMeta.bucket) === 0 || !!itemMeta.debug) return false;
      var tid = toInt(tableId);
      if (!tid) return false;
      var nextCount = clamp(count == null ? 1 : count, 1, Number(itemMeta.bucket) === 2 ? 1 : MAX_BAG_COUNT);
      doc.items = Array.isArray(doc.items) ? doc.items : [];
      if (itemMeta.stackable) {
        for (var i = 0; i < doc.items.length; i += 1) {
          if (toInt(doc.items[i].tableId) === tid && toInt(doc.items[i].flag44) === 0) {
            doc.items[i].count = clamp(toInt(doc.items[i].count) + nextCount, 1, MAX_BAG_COUNT);
            markDirty();
            return true;
          }
        }
      }
      var seed = 1;
      doc.items.forEach(function (item) {
        if (item.guid && Number(item.guid[0]) >= seed) seed = Number(item.guid[0]) + 1;
      });
      doc.items.push(makeItem(seed || 1, tid, nextCount, 0));
      markDirty();
      return true;
    }

    function removeBagItem(indexOrGuid) {
      var doc = requireSlot();
      var items = Array.isArray(doc.items) ? doc.items : [];
      var idx = -1;
      if (typeof indexOrGuid === "number" && indexOrGuid >= 0 && indexOrGuid < items.length) {
        idx = indexOrGuid;
      } else if (typeof indexOrGuid === "string") {
        for (var i = 0; i < items.length; i += 1) {
          if (items[i].guid && String(items[i].guid[0]) === indexOrGuid) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) return false;
      if (toInt(items[idx].flag44) !== 0) return false;
      items.splice(idx, 1);
      markDirty();
      return true;
    }

    function listAddableItems(query) {
      var q = query == null ? "" : String(query).trim().toLowerCase();
      var ids = Object.keys(catalog.items || {}).map(toInt).sort(function (a, b) {
        return a - b;
      });
      var out = [];
      for (var i = 0; i < ids.length; i += 1) {
        var id = ids[i];
        var meta = catalog.getItem(id) || {};
        if (Number(meta.bucket) === 0 || !!meta.debug) continue;
        var name = catalog.getItemName(id) || ("아이템 " + id);
        if (q && String(id).indexOf(q) < 0 && name.toLowerCase().indexOf(q) < 0) continue;
        out.push({
          id: id,
          name: name,
          bucket: Number(meta.bucket),
          bucketName: meta.bucketName || "기타",
          stackable: !!meta.stackable,
          desc: meta.desc || ""
        });
      }
      return out;
    }

    function listAddableSkills(query) {
      var q = query == null ? "" : String(query).trim().toLowerCase();
      var ids = Object.keys(catalog.skills || {}).map(toInt).sort(function (a, b) {
        return a - b;
      });
      var out = [];
      for (var i = 0; i < ids.length; i += 1) {
        var id = ids[i];
        if (id === 8) continue;
        var meta = catalog.getSkill(id) || {};
        var name = catalog.getSkillName(id) || ("무공 " + id);
        if (q && String(id).indexOf(q) < 0 && name.toLowerCase().indexOf(q) < 0) continue;
        out.push({
          id: id,
          name: name,
          category: meta.category || "",
          desc: meta.desc || ""
        });
      }
      return out;
    }

    function setConfigScore(score) {
      var doc = requireDoc();
      if (!isConfigDoc(doc)) return false;
      var prop = ensureProp(doc, "Score", function () { return intProp("Score", 0); });
      prop.val = clamp(score, 0, MAX_INT32);
      markDirty();
      return true;
    }

    function toggleInherit(inheritId, enabled) {
      var doc = requireDoc();
      if (!isConfigDoc(doc)) return false;
      var id = toInt(inheritId);
      if (id < 1 || id > 9) return false;
      var prop = ensureProp(doc, "InheritIds", function () { return setPropInt("InheritIds", []); });
      var values = Array.isArray(prop.val) ? prop.val.map(toInt) : [];
      var idx = values.indexOf(id);
      if (enabled) {
        if (idx < 0) values.push(id);
      } else if (idx >= 0) {
        values.splice(idx, 1);
      }
      prop.val = values;
      markDirty();
      return true;
    }

    function unlockAllInherits() {
      var doc = requireDoc();
      if (!isConfigDoc(doc)) return false;
      var prop = ensureProp(doc, "InheritIds", function () { return setPropInt("InheritIds", []); });
      var existing = Array.isArray(prop.val) ? prop.val.map(toInt) : [];
      var values = [1, 2, 3, 4, 5];
      if (existing.indexOf(6) >= 0) values.push(6);
      values.push(7, 8, 9);
      prop.val = values.filter(function (value, index, arr) {
        return arr.indexOf(value) === index;
      });
      markDirty();
      return true;
    }

    function applyPreset(presetId) {
      var preset = PRESET_MAP[presetId];
      if (!preset) return false;
      var doc = requireDoc();
      if (preset.target === "config" && !isConfigDoc(doc)) return false;
      if (preset.target === "slot" && isConfigDoc(doc)) return false;
      if (presetId === "wealth_max") {
        setMoney(9999999);
        var wealthHero = findNpc(doc, 0);
        if (wealthHero) {
          wealthHero.skillExp = Math.max(toInt(wealthHero.skillExp), 999999);
          wealthHero.jingMaiPoint = Math.max(toInt(wealthHero.jingMaiPoint), 99999);
        }
        markDirty();
        return true;
      }
      if (presetId === "hero_cultivation") {
        var hero = findNpc(doc, 0);
        if (!hero) return false;
        var targets = { 1: 9999, 2: 9999, 3: 9999, 4: 9999, 6: 500, 7: 500, 8: 500, 9: 1500, 11: 1500, 42: 2000, 44: 999, 45: 999 };
        Object.keys(targets).forEach(function (key) {
          var id = toInt(key);
          var entry = ensureAttr(hero, id);
          setAttrEntry(entry, Math.max(attrValue(entry), targets[id]));
        });
        hero.addNeiGongLimit = Math.max(toInt(hero.addNeiGongLimit), 9999);
        markDirty();
        return true;
      }
      if (presetId === "party_favor_max") {
        var teamIds = (propVal(doc, "TeamInfos", []) || []).map(toInt);
        for (var i = 0; i < teamIds.length; i += 1) {
          if (teamIds[i] !== 0) setCompanionFavor(teamIds[i], 0, MAX_FAVOR);
          for (var j = 0; j < teamIds.length; j += 1) {
            if (teamIds[i] !== teamIds[j]) setCompanionFavor(teamIds[i], teamIds[j], MAX_FAVOR);
          }
        }
        return true;
      }
      if (presetId === "skills_lv10") {
        var skillTeamIds = (propVal(doc, "TeamInfos", []) || []).map(toInt);
        var ids = [0].concat(skillTeamIds);
        ids.forEach(function (id) {
          var npc = findNpc(doc, id);
          if (!npc) return;
          (Array.isArray(npc.skills) ? npc.skills : []).forEach(function (skill) {
            skill.level = MAX_SKILL_LEVEL;
          });
        });
        markDirty();
        return true;
      }
      if (presetId === "unlock_mounts_recipes") {
        unlockAllMounts();
        unlockAllRecipes();
        return true;
      }
      if (presetId === "reset_pill_limits") {
        return resetPillLimits();
      }
      if (presetId === "config_score_max") {
        setConfigScore(99999);
        unlockAllInherits();
        return true;
      }
      return false;
    }

    var PROP_LABELS_KO = {
      Money: "보유 금전",
      MapName: "현재 지역",
      MapCode: "지역 코드",
      SaveGameTime: "플레이 시간",
      TurnMode: "전투 방식",
      SelectedMountId: "장착 탈것",
      MountIds: "탈것 목록",
      TeamInfos: "파티 편성",
      FightTeamInfos: "전투 대열",
      Quests: "임무 기록",
      JHGatherSpecs: "채집 정보",
      WorldWalkNPCInfos: "강호 행인 정보",
      MonsterNPCInfos: "적대 세력 정보",
      AlchemyRecipes: "연단 도안",
      CookRecipes: "요리 도안",
      CookingRecipes: "요리 도안",
      ForgeRecipes: "단조 도안",
      FusionRecipes: "단조 도안",
      CanTransMapIds: "이동 가능 거점",
      CurrentTrackingQuestId: "추적 중인 임무",
      CurrentTrackingPrimeQuestId: "추적 중인 주요 임무",
      Score: "전승 점수",
      InheritIds: "전승 특전",
      PictorialBookIds: "인물 도감",
      SkillIds: "무공 도감",
      ItemIds: "물품 도감",
      EnterTeamNPCIDs: "동료 영입 도감",
      EndingIds: "결말 도감"
    };

    function validate() {
      var errors = [];
      var warnings = [];
      var doc = state.doc;
      if (!doc) {
        return { valid: false, errors: ["세이브 데이터가 로드되지 않았습니다."], warnings: [] };
      }
      if (doc.magic !== "GVAS") errors.push("세이브 헤더 식별값이 올바르지 않습니다.");
      if (toInt(doc.saveVersion) < 1 || toInt(doc.saveVersion) > 30) errors.push("세이브 버전이 올바르지 않습니다.");
      if (!doc.className || (doc.className.str !== SLOT_CLASS && doc.className.str !== CONFIG_CLASS)) {
        errors.push("세이브 클래스 이름이 올바르지 않습니다.");
      }
      if (!Array.isArray(doc.props)) {
        errors.push("속성 목록이 배열이 아닙니다.");
      } else if (!doc.props.some(function (p) { return p && p.name === "None"; })) {
        errors.push("속성 목록 끝에 종료 항목이 없습니다.");
      }
      var seen = {};
      (Array.isArray(doc.props) ? doc.props : []).forEach(function (prop, idx) {
        if (!prop || !prop.name || prop.name === "None") return;
        var propLabel = PROP_LABELS_KO[prop.name] || ("내부 속성 #" + (idx + 1));
        if (seen[prop.name]) warnings.push("중복 속성이 있습니다: " + propLabel);
        seen[prop.name] = true;
        if (prop.val === undefined && prop.entries === undefined && prop.opaque === undefined && prop.items === undefined) {
          warnings.push("속성 값이 비어 있습니다: " + propLabel);
        }
      });
      var npcs = Array.isArray(doc.npcs) ? doc.npcs : [];
      var npcIds = {};
      npcs.forEach(function (npc) {
        var id = toInt(npc.npcId);
        if (npcIds[id]) warnings.push("중복 인물 번호가 있습니다: " + id);
        npcIds[id] = true;
        if (!Array.isArray(npc.attrs)) warnings.push("인물 " + id + "의 능력치 배열이 없습니다.");
        (Array.isArray(npc.attrs) ? npc.attrs : []).forEach(function (a) {
          if (!a || a.id < 1 || a.id > 69) warnings.push("인물 " + id + "에 잘못된 능력치 번호가 있습니다.");
        });
        (Array.isArray(npc.friendliness) ? npc.friendliness : []).forEach(function (f) {
          if (toInt(f.favor) < 0 || toInt(f.favor) > 255) {
            errors.push("인물 " + id + "의 호감도가 범위를 벗어났습니다.");
          }
        });
        (Array.isArray(npc.skills) ? npc.skills : []).forEach(function (s) {
          if (toInt(s.level) < 0 || toInt(s.level) > 20) {
            errors.push("인물 " + id + "의 무공 레벨이 범위를 벗어났습니다.");
          }
        });
      });
      if (!isConfigDoc(doc)) {
        var turn = String(propVal(doc, "TurnMode", ""));
        if (turn && turn !== "ETurnMode::RealTime" && turn !== "ETurnMode::TurnBased") {
          warnings.push("턴 모드 값이 알 수 없는 형식입니다.");
        }
        (Array.isArray(doc.items) ? doc.items : []).forEach(function (item) {
          if (toInt(item.count) < 1 || toInt(item.count) > MAX_INT32) {
            errors.push("가방 아이템 수량이 범위를 벗어났습니다.");
          }
          if (!item.guid || item.guid.length !== 4 || toInt(item.guid[0]) === 0) {
            warnings.push("가방 아이템 고유 번호가 올바르지 않습니다.");
          }
        });
      }
      return { valid: errors.length === 0, errors: errors, warnings: warnings };
    }

    var session = {
      loadBytes: loadBytes,
      loadBytesSync: loadBytesSync,
      loadDoc: loadDoc,
      exportBytes: exportBytes,
      exportBytesSync: exportBytesSync,
      isLoaded: isLoaded,
      isConfigSave: isConfigSave,
      isDirty: isDirty,
      markClean: markClean,
      getDoc: getDoc,
      getMeta: getMeta,
      getSummary: getSummary,
      listEditableCharacters: listEditableCharacters,
      getCharacterDetail: getCharacterDetail,
      setMoney: setMoney,
      setTurnMode: setTurnMode,
      setSelectedMount: setSelectedMount,
      unlockAllMounts: unlockAllMounts,
      unlockAllRecipes: unlockAllRecipes,
      setNpcResources: setNpcResources,
      setNpcAttr: setNpcAttr,
      setCompanionFavor: setCompanionFavor,
      setGuildFavor: setGuildFavor,
      setGuildHonor: setGuildHonor,
      setSkillLevel: setSkillLevel,
      addSkill: addSkill,
      removeSkill: removeSkill,
      unlockAllMeridians: unlockAllMeridians,
      resetPillLimits: resetPillLimits,
      listBagItems: listBagItems,
      setBagItemCount: setBagItemCount,
      addBagItem: addBagItem,
      removeBagItem: removeBagItem,
      listAddableItems: listAddableItems,
      listAddableSkills: listAddableSkills,
      setConfigScore: setConfigScore,
      toggleInherit: toggleInherit,
      unlockAllInherits: unlockAllInherits,
      applyPreset: applyPreset,
      validate: validate
    };
    return session;
  }

  return {
    PRESETS: PRESETS,
    SLOT_CLASS: SLOT_CLASS,
    CONFIG_CLASS: SLOT_CLASS === CONFIG_CLASS ? "" : CONFIG_CLASS,
    formatPlayTime: formatPlayTime,
    makeSession: makeSession,
    createSession: makeSession,
    createDemoDoc: createDemoDoc,
    createDemoConfigDoc: createDemoConfigDoc,
    createDemoSavBytesSync: createDemoSavBytesSync,
    createDemoSavBytes: createDemoSavBytes,
    createDemoConfigSavBytesSync: createDemoConfigSavBytesSync,
    createDemoConfigSavBytes: createDemoConfigSavBytes
  };
}));
