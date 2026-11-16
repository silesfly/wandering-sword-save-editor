(function (root, factory) {
  if (typeof define === "function" && define.amd) {
    define([], factory);
  } else if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    var api = factory();
    root.WanderingSwordCodec = api;
    root.GvasCodec = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : (typeof self !== "undefined" ? self : this), function () {
  "use strict";

  var ERR_BAD_SAV = "유효한 일검풍운결 세이브 파일이 아닙니다.";
  var ERR_TRUNCATED = "세이브 파일이 손상되었거나 잘렸습니다.";
  var ERR_CLASS = "지원하지 않는 세이브 클래스입니다.";
  var ERR_VERSION = "지원하지 않는 세이브 버전입니다.";
  var ERR_TRAILING = "세이브 데이터 뒤에 알 수 없는 바이트가 남아 있습니다.";
  var ERR_OPAQUE_TYPE = "지원하지 않는 압축 보존 속성 형식입니다.";
  var ERR_ARRAY_TYPE = "지원하지 않는 배열 속성 형식입니다.";
  var ERR_SET_TYPE = "지원하지 않는 집합 속성 형식입니다.";
  var ERR_MAP_TYPE = "지원하지 않는 맵 속성 형식입니다.";
  var ERR_PROP_TYPE = "지원하지 않는 속성 형식입니다.";
  var ERR_ZLIB = "동기 압축 라이브러리를 사용할 수 없는 실행 환경입니다.";
  var ERR_STREAM = "브라우저 압축 스트림을 사용할 수 없습니다.";
  var ERR_SIZE_LIMIT = "세이브 데이터 크기가 허용 범위를 벗어났습니다.";

  var MAX_SAVE_BYTES = 64 * 1024 * 1024;
  var MAGIC_GVAS = [0x47, 0x56, 0x41, 0x53];

  var OPAQUE_PROPS = {
    "Quests": true,
    "JHGatherSpecs": true,
    "WorldWalkNPCInfos": true,
    "MonsterNPCInfos": true
  };

  var OPAQUE_PROP_ORDER = [
    "Quests",
    "JHGatherSpecs",
    "WorldWalkNPCInfos",
    "MonsterNPCInfos"
  ];

  var OPAQUE_PROP_LABELS_KO = {
    "Quests": "임무 진행도",
    "JHGatherSpecs": "채집 상태",
    "WorldWalkNPCInfos": "강호 행인 배치",
    "MonsterNPCInfos": "적대 몬스터 배치"
  };

  function isArrayLikeBytes(v) {
    return v && typeof v === "object" && typeof v.byteLength === "number";
  }

  function asUint8Array(v) {
    if (v instanceof Uint8Array) {
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    }
    if (typeof ArrayBuffer !== "undefined" && v instanceof ArrayBuffer) {
      return new Uint8Array(v);
    }
    if (v && typeof v === "object" && v.buffer && typeof v.byteLength === "number") {
      return new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
    }
    if (Array.isArray(v)) {
      return new Uint8Array(v);
    }
    throw new Error("바이트 배열이 필요합니다.");
  }

  function copyBytes(src) {
    var out = new Uint8Array(src.byteLength);
    out.set(src);
    return out;
  }

  function concatBytes(chunks) {
    var total = 0;
    var i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].byteLength;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], off);
      off += chunks[i].byteLength;
    }
    return out;
  }

  function isAscii(str) {
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) >= 0x80) return false;
    }
    return true;
  }

  function isLatin1(str) {
    for (var i = 0; i < str.length; i++) {
      if (str.charCodeAt(i) > 0xff) return false;
    }
    return true;
  }

  function toNumber(v) {
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "number") return v;
    if (v && typeof v === "object" && v.lo !== undefined && v.hi !== undefined) {
      if (typeof BigInt === "function") {
        var n = (BigInt(v.hi | 0) << 32n) | BigInt(v.lo >>> 0);
        return Number(BigInt.asIntN(64, n));
      }
      return Number(v.hi) * 4294967296 + (v.lo >>> 0);
    }
    return Number(v);
  }

  function toBigInt64(v) {
    if (typeof BigInt !== "function") {
      throw new Error("이 환경에서는 64비트 정수를 지원하지 않습니다.");
    }
    if (typeof v === "bigint") return BigInt.asIntN(64, v);
    if (typeof v === "number") {
      if (!isFinite(v)) throw new Error("유효하지 않은 64비트 정수입니다.");
      return BigInt.asIntN(64, BigInt(Math.trunc(v)));
    }
    if (v && typeof v === "object" && v.lo !== undefined && v.hi !== undefined) {
      var n = (BigInt(v.hi | 0) << 32n) | BigInt(v.lo >>> 0);
      return BigInt.asIntN(64, n);
    }
    return BigInt.asIntN(64, BigInt(v));
  }

  function BinReader(bytes) {
    this.bytes = asUint8Array(bytes);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = 0;
    this.length = this.bytes.byteLength;
  }

  BinReader.prototype.rem = function () {
    return this.length - this.pos;
  };

  BinReader.prototype.need = function (n) {
    if (n < 0 || this.pos + n > this.length) {
      throw new Error(ERR_TRUNCATED);
    }
  };

  BinReader.prototype.skip = function (n) {
    this.need(n);
    this.pos += n;
  };

  BinReader.prototype.u8 = function () {
    this.need(1);
    var v = this.dv.getUint8(this.pos);
    this.pos += 1;
    return v;
  };

  BinReader.prototype.i8 = function () {
    this.need(1);
    var v = this.dv.getInt8(this.pos);
    this.pos += 1;
    return v;
  };

  BinReader.prototype.u16 = function () {
    this.need(2);
    var v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  };

  BinReader.prototype.i16 = function () {
    this.need(2);
    var v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  };

  BinReader.prototype.u32 = function () {
    this.need(4);
    var v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  };

  BinReader.prototype.i32 = function () {
    this.need(4);
    var v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  };

  BinReader.prototype.f32 = function () {
    this.need(4);
    var v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  };

  BinReader.prototype.f64 = function () {
    this.need(8);
    var v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  };

  BinReader.prototype.i64 = function () {
    this.need(8);
    var v = this.dv.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  };

  BinReader.prototype.u64 = function () {
    this.need(8);
    var v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  };

  BinReader.prototype.f32Raw = function () {
    this.need(4);
    var bits = this.dv.getUint32(this.pos, true);
    var val = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return { val: val, origVal: val, bits: bits };
  };

  BinReader.prototype.bytesCopy = function (n) {
    this.need(n);
    var out = new Uint8Array(n);
    out.set(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return out;
  };

  BinReader.prototype.bytesView = function (n) {
    this.need(n);
    var out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  };

  BinReader.prototype.fstr = function () {
    var n = this.i32();

    if (n === 0) {
      return { str: "", enc: "empty" };
    }

    if (n > 0) {
      this.need(n);
      var start = this.pos;
      var end = start + n;
      if (this.bytes[end - 1] !== 0) {
        throw new Error("문자열 종료 바이트가 올바르지 않습니다.");
      }
      var chars = [];
      for (var i = start; i < end - 1; i++) {
        chars.push(String.fromCharCode(this.bytes[i]));
      }
      this.pos = end;
      return { str: chars.join(""), enc: "latin1" };
    }

    var count = -n;
    if (count <= 0) {
      throw new Error("문자열 길이가 올바르지 않습니다.");
    }
    var byteLen = count * 2;
    this.need(byteLen);
    var s = this.pos;
    var e = s + byteLen;
    if (this.bytes[e - 2] !== 0 || this.bytes[e - 1] !== 0) {
      throw new Error("유니코드 문자열 종료 바이트가 올바르지 않습니다.");
    }
    var units = [];
    for (var j = s; j < e - 2; j += 2) {
      units.push(String.fromCharCode(this.bytes[j] | (this.bytes[j + 1] << 8)));
    }
    this.pos = e;
    return { str: units.join(""), enc: "utf16" };
  };

  function BinWriter(initialCapacity) {
    var cap = initialCapacity && initialCapacity > 0 ? initialCapacity : 1024;
    this.buf = new Uint8Array(cap);
    this.dv = new DataView(this.buf.buffer);
    this.len = 0;
  }

  BinWriter.prototype.ensure = function (extra) {
    var needed = this.len + extra;
    if (needed <= this.buf.byteLength) return;
    var cap = this.buf.byteLength || 1;
    while (cap < needed) cap *= 2;
    var next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.dv = new DataView(this.buf.buffer);
  };

  BinWriter.prototype.u8 = function (v) {
    this.ensure(1);
    this.dv.setUint8(this.len, v & 0xff);
    this.len += 1;
    return this;
  };

  BinWriter.prototype.i8 = function (v) {
    this.ensure(1);
    this.dv.setInt8(this.len, v);
    this.len += 1;
    return this;
  };

  BinWriter.prototype.u16 = function (v) {
    this.ensure(2);
    this.dv.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
    return this;
  };

  BinWriter.prototype.i16 = function (v) {
    this.ensure(2);
    this.dv.setInt16(this.len, v, true);
    this.len += 2;
    return this;
  };

  BinWriter.prototype.u32 = function (v) {
    this.ensure(4);
    this.dv.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  };

  BinWriter.prototype.i32 = function (v) {
    this.ensure(4);
    this.dv.setInt32(this.len, v | 0, true);
    this.len += 4;
    return this;
  };

  BinWriter.prototype.f32 = function (v) {
    this.ensure(4);
    this.dv.setFloat32(this.len, v, true);
    this.len += 4;
    return this;
  };

  BinWriter.prototype.f64 = function (v) {
    this.ensure(8);
    this.dv.setFloat64(this.len, v, true);
    this.len += 8;
    return this;
  };

  BinWriter.prototype.i64 = function (v) {
    this.ensure(8);
    this.dv.setBigInt64(this.len, toBigInt64(v), true);
    this.len += 8;
    return this;
  };

  BinWriter.prototype.u64 = function (v) {
    this.ensure(8);
    var bv;
    if (typeof v === "bigint") {
      bv = BigInt.asUintN(64, v);
    } else if (v && typeof v === "object" && v.lo !== undefined && v.hi !== undefined) {
      bv = BigInt.asUintN(64, (BigInt(v.hi | 0) << 32n) | BigInt(v.lo >>> 0));
    } else {
      bv = BigInt.asUintN(64, BigInt(v));
    }
    this.dv.setBigUint64(this.len, bv, true);
    this.len += 8;
    return this;
  };

  BinWriter.prototype.bytes = function (arr) {
    var b = asUint8Array(arr);
    this.ensure(b.byteLength);
    this.buf.set(b, this.len);
    this.len += b.byteLength;
    return this;
  };

  BinWriter.prototype.f32Raw = function (obj) {
    if (obj && typeof obj === "object") {
      if (obj.bits !== undefined && obj.val === obj.origVal) {
        return this.u32(obj.bits);
      }
      return this.f32(obj.val);
    }
    return this.f32(obj);
  };

  BinWriter.prototype.fstr = function (str, enc) {
    str = str == null ? "" : String(str);

    if (str === "" && (!enc || enc === "empty")) {
      return this.i32(0);
    }

    if (enc === "latin1" || (!enc && isAscii(str))) {
      var latinOk = enc === "latin1" ? isLatin1(str) : isAscii(str);
      if (latinOk) {
        this.i32(str.length + 1);
        for (var i = 0; i < str.length; i++) {
          this.u8(str.charCodeAt(i) & 0xff);
        }
        this.u8(0);
        return this;
      }
    }

    this.i32(-(str.length + 1));
    for (var j = 0; j < str.length; j++) {
      this.u16(str.charCodeAt(j));
    }
    this.u16(0);
    return this;
  };

  BinWriter.prototype.toBytes = function () {
    var out = new Uint8Array(this.len);
    out.set(this.buf.subarray(0, this.len));
    return out;
  };

  function fstrBytes(str, enc) {
    var w = new BinWriter(32);
    w.fstr(str, enc);
    return w.toBytes();
  }

  function writeFstrObject(w, obj) {
    if (obj && typeof obj === "object") {
      w.fstr(obj.str != null ? obj.str : "", obj.enc);
    } else {
      w.fstr(obj != null ? String(obj) : "");
    }
  }

  function readPropList(r) {
    var props = [];
    while (true) {
      var name = r.fstr();
      if (name.str === "None") {
        props.push({ name: "None", nameEnc: name.enc });
        break;
      }

      var type = r.fstr();
      var size = Number(r.i64());
      var prop = {
        name: name.str,
        nameEnc: name.enc,
        type: type.str,
        typeEnc: type.enc,
        size: size
      };

      var i;

      if (OPAQUE_PROPS[name.str] === true) {
        if (type.str === "ArrayProperty") {
          prop.elemType = r.fstr();
          prop.guidFlag = r.u8();
          prop.opaque = r.bytesCopy(size);
        } else if (type.str === "MapProperty") {
          prop.keyType = r.fstr();
          prop.valType = r.fstr();
          prop.guidFlag = r.u8();
          prop.opaque = r.bytesCopy(size);
        } else if (type.str === "StructProperty") {
          prop.structName = r.fstr();
          prop.structGuid = r.bytesCopy(16);
          prop.guidFlag = r.u8();
          prop.opaque = r.bytesCopy(size);
        } else {
          throw new Error(ERR_OPAQUE_TYPE);
        }
        props.push(prop);
        continue;
      }

      if (type.str === "IntProperty") {
        prop.guidFlag = r.u8();
        prop.val = r.i32();
      } else if (type.str === "UInt32Property") {
        prop.guidFlag = r.u8();
        prop.val = r.u32();
      } else if (type.str === "Int64Property") {
        prop.guidFlag = r.u8();
        prop.val = r.i64();
      } else if (type.str === "FloatProperty") {
        prop.guidFlag = r.u8();
        prop.val = r.f32Raw();
      } else if (type.str === "BoolProperty") {
        prop.val = r.u8();
        prop.guidFlag = r.u8();
      } else if (type.str === "StrProperty" || type.str === "NameProperty") {
        prop.guidFlag = r.u8();
        var s = r.fstr();
        prop.val = s.str;
        prop.valEnc = s.enc;
      } else if (type.str === "ByteProperty") {
        prop.enumName = r.fstr();
        prop.guidFlag = r.u8();
        if (prop.enumName.str === "None") {
          prop.val = r.u8();
          prop.isByteEnum = false;
        } else {
          var bs = r.fstr();
          prop.val = bs.str;
          prop.valEnc = bs.enc;
          prop.isByteEnum = true;
        }
      } else if (type.str === "EnumProperty") {
        prop.enumName = r.fstr();
        prop.guidFlag = r.u8();
        var es = r.fstr();
        prop.val = es.str;
        prop.valEnc = es.enc;
      } else if (type.str === "StructProperty") {
        prop.structName = r.fstr();
        prop.structGuid = r.bytesCopy(16);
        prop.guidFlag = r.u8();
        prop.val = readStructBody(r, prop.structName.str);
      } else if (type.str === "ArrayProperty") {
        prop.elemType = r.fstr();
        prop.guidFlag = r.u8();
        prop.count = r.i32();
        if (prop.elemType.str === "ByteProperty") {
          prop.rawBytes = r.bytesCopy(prop.count);
          prop.val = prop.rawBytes;
        } else if (prop.elemType.str === "IntProperty") {
          prop.val = [];
          for (i = 0; i < prop.count; i++) prop.val.push(r.i32());
        } else if (prop.elemType.str === "StrProperty" || prop.elemType.str === "NameProperty") {
          prop.val = [];
          for (i = 0; i < prop.count; i++) prop.val.push(r.fstr());
        } else if (prop.elemType.str === "StructProperty") {
          prop.innerName = r.fstr();
          prop.innerType = r.fstr();
          prop.innerSize = Number(r.i64());
          prop.structName = r.fstr();
          prop.structGuid = r.bytesCopy(16);
          prop.innerGuidFlag = r.u8();
          prop.val = [];
          for (i = 0; i < prop.count; i++) {
            prop.val.push(readStructBody(r, prop.structName.str));
          }
        } else {
          throw new Error(ERR_ARRAY_TYPE);
        }
      } else if (type.str === "SetProperty") {
        prop.elemType = r.fstr();
        prop.guidFlag = r.u8();
        prop.removedCount = r.i32();
        prop.count = r.i32();
        prop.val = [];
        if (prop.elemType.str === "IntProperty") {
          for (i = 0; i < prop.count; i++) prop.val.push(r.i32());
        } else if (prop.elemType.str === "NameProperty" || prop.elemType.str === "StrProperty") {
          for (i = 0; i < prop.count; i++) prop.val.push(r.fstr());
        } else {
          throw new Error(ERR_SET_TYPE);
        }
      } else if (type.str === "MapProperty") {
        prop.keyType = r.fstr();
        prop.valType = r.fstr();
        prop.guidFlag = r.u8();
        prop.removedCount = r.i32();
        prop.count = r.i32();
        prop.entries = [];
        for (i = 0; i < prop.count; i++) {
          var key = readMapScalar(r, prop.keyType.str);
          var val = readMapScalar(r, prop.valType.str);
          prop.entries.push({ key: key, val: val });
        }
      } else {
        throw new Error(ERR_PROP_TYPE);
      }

      props.push(prop);
    }
    return props;
  }

  function writePropList(w, props) {
    for (var i = 0; i < props.length; i++) {
      var p = props[i];
      if (p.name === "None" && (p.type === undefined || p.type === null)) {
        w.fstr("None", p.nameEnc);
        continue;
      }
      writeProperty(w, p);
    }
  }

  function writeProperty(w, p) {
    w.fstr(p.name, p.nameEnc);
    w.fstr(p.type, p.typeEnc);

    if (OPAQUE_PROPS[p.name] === true) {
      var opaque = p.opaque || new Uint8Array(0);
      w.i64(opaque.byteLength);
      if (p.type === "ArrayProperty") {
        writeFstrObject(w, p.elemType);
        w.u8(p.guidFlag);
        w.bytes(opaque);
      } else if (p.type === "MapProperty") {
        writeFstrObject(w, p.keyType);
        writeFstrObject(w, p.valType);
        w.u8(p.guidFlag);
        w.bytes(opaque);
      } else if (p.type === "StructProperty") {
        writeFstrObject(w, p.structName);
        w.bytes(p.structGuid || new Uint8Array(16));
        w.u8(p.guidFlag);
        w.bytes(opaque);
      } else {
        throw new Error(ERR_OPAQUE_TYPE);
      }
      return;
    }

    if (p.type === "IntProperty") {
      w.i64(4);
      w.u8(p.guidFlag);
      w.i32(p.val);
      return;
    }

    if (p.type === "UInt32Property") {
      w.i64(4);
      w.u8(p.guidFlag);
      w.u32(p.val);
      return;
    }

    if (p.type === "Int64Property") {
      w.i64(8);
      w.u8(p.guidFlag);
      w.i64(p.val);
      return;
    }

    if (p.type === "FloatProperty") {
      w.i64(4);
      w.u8(p.guidFlag);
      w.f32Raw(p.val);
      return;
    }

    if (p.type === "BoolProperty") {
      w.i64(0);
      w.u8(p.val ? 1 : 0);
      w.u8(p.guidFlag);
      return;
    }

    if (p.type === "StrProperty" || p.type === "NameProperty") {
      var sp = fstrBytes(p.val != null ? String(p.val) : "", p.valEnc);
      w.i64(sp.byteLength);
      w.u8(p.guidFlag);
      w.bytes(sp);
      return;
    }

    if (p.type === "ByteProperty") {
      if (p.isByteEnum === false || (p.enumName && p.enumName.str === "None")) {
        w.i64(1);
        writeFstrObject(w, p.enumName || { str: "None", enc: "latin1" });
        w.u8(p.guidFlag);
        w.u8(p.val);
      } else {
        var bp = fstrBytes(p.val != null ? String(p.val) : "", p.valEnc);
        w.i64(bp.byteLength);
        writeFstrObject(w, p.enumName);
        w.u8(p.guidFlag);
        w.bytes(bp);
      }
      return;
    }

    if (p.type === "EnumProperty") {
      var ep = fstrBytes(p.val != null ? String(p.val) : "", p.valEnc);
      w.i64(ep.byteLength);
      writeFstrObject(w, p.enumName);
      w.u8(p.guidFlag);
      w.bytes(ep);
      return;
    }

    if (p.type === "StructProperty") {
      var body = structBodyBytes(p.structName ? p.structName.str : "", p.val);
      w.i64(body.byteLength);
      writeFstrObject(w, p.structName);
      w.bytes(p.structGuid || new Uint8Array(16));
      w.u8(p.guidFlag);
      w.bytes(body);
      return;
    }

    if (p.type === "ArrayProperty") {
      var payload = arrayPayloadBytes(p);
      w.i64(payload.byteLength);
      writeFstrObject(w, p.elemType);
      w.u8(p.guidFlag);
      w.bytes(payload);
      return;
    }

    if (p.type === "SetProperty") {
      var setPayload = setPayloadBytes(p);
      w.i64(setPayload.byteLength);
      writeFstrObject(w, p.elemType);
      w.u8(p.guidFlag);
      w.bytes(setPayload);
      return;
    }

    if (p.type === "MapProperty") {
      var mapPayload = mapPayloadBytes(p);
      w.i64(mapPayload.byteLength);
      writeFstrObject(w, p.keyType);
      writeFstrObject(w, p.valType);
      w.u8(p.guidFlag);
      w.bytes(mapPayload);
      return;
    }

    throw new Error(ERR_PROP_TYPE);
  }

  function readStructBody(r, sname) {
    if (sname === "Vector" || sname === "Rotator") {
      return [r.f32Raw(), r.f32Raw(), r.f32Raw()];
    }
    if (sname === "DateTime") {
      return r.i64();
    }
    if (sname === "Guid") {
      return r.bytesCopy(16);
    }
    if (sname === "IntPoint") {
      return [r.i32(), r.i32()];
    }
    return readPropList(r);
  }

  function writeStructBody(w, sname, val) {
    if (sname === "Vector" || sname === "Rotator") {
      w.f32Raw(val[0]);
      w.f32Raw(val[1]);
      w.f32Raw(val[2]);
      return;
    }
    if (sname === "DateTime") {
      w.i64(val);
      return;
    }
    if (sname === "Guid") {
      w.bytes(val);
      return;
    }
    if (sname === "IntPoint") {
      w.i32(val[0]);
      w.i32(val[1]);
      return;
    }
    writePropList(w, val);
  }

  function structBodyBytes(sname, val) {
    var w = new BinWriter(512);
    writeStructBody(w, sname, val);
    return w.toBytes();
  }

  function arrayPayloadBytes(p) {
    var w = new BinWriter(512);
    var elemType = p.elemType && p.elemType.str !== undefined ? p.elemType.str : p.elemType;
    var i;

    if (elemType === "ByteProperty") {
      var raw = p.rawBytes || (p.val instanceof Uint8Array ? p.val : new Uint8Array(0));
      w.i32(raw.byteLength);
      w.bytes(raw);
    } else if (elemType === "IntProperty") {
      var ints = p.val || [];
      w.i32(ints.length);
      for (i = 0; i < ints.length; i++) w.i32(ints[i]);
    } else if (elemType === "StrProperty" || elemType === "NameProperty") {
      var strs = p.val || [];
      w.i32(strs.length);
      for (i = 0; i < strs.length; i++) {
        if (strs[i] && typeof strs[i] === "object" && strs[i].str !== undefined) {
          w.fstr(strs[i].str, strs[i].enc);
        } else {
          w.fstr(strs[i] != null ? String(strs[i]) : "");
        }
      }
    } else if (elemType === "StructProperty") {
      var items = p.val || [];
      var structName = p.structName && p.structName.str !== undefined ? p.structName.str : (p.structName || "");
      var itemsW = new BinWriter(512);
      for (i = 0; i < items.length; i++) {
        writeStructBody(itemsW, structName, items[i]);
      }
      var itemsBytes = itemsW.toBytes();

      w.i32(items.length);
      writeFstrObject(w, p.innerName);
      writeFstrObject(w, p.innerType);
      w.i64(itemsBytes.byteLength);
      writeFstrObject(w, p.structName);
      w.bytes(p.structGuid || new Uint8Array(16));
      w.u8(p.innerGuidFlag);
      w.bytes(itemsBytes);
    } else {
      throw new Error(ERR_ARRAY_TYPE);
    }

    return w.toBytes();
  }

  function setPayloadBytes(p) {
    var w = new BinWriter(256);
    var elemType = p.elemType && p.elemType.str !== undefined ? p.elemType.str : p.elemType;
    var vals = p.val || [];
    w.i32(p.removedCount || 0);
    w.i32(vals.length);

    for (var i = 0; i < vals.length; i++) {
      if (elemType === "IntProperty") {
        w.i32(vals[i]);
      } else if (elemType === "NameProperty" || elemType === "StrProperty") {
        if (vals[i] && typeof vals[i] === "object" && vals[i].str !== undefined) {
          w.fstr(vals[i].str, vals[i].enc);
        } else {
          w.fstr(vals[i] != null ? String(vals[i]) : "");
        }
      } else {
        throw new Error(ERR_SET_TYPE);
      }
    }

    return w.toBytes();
  }

  function readMapScalar(r, type) {
    if (type === "IntProperty") return r.i32();
    if (type === "BoolProperty") return r.u8();
    if (type === "ByteProperty") return r.u8();
    if (type === "FloatProperty") return r.f32Raw();
    if (type === "StrProperty" || type === "NameProperty") return r.fstr();
    if (type === "StructProperty") return readPropList(r);
    throw new Error(ERR_MAP_TYPE);
  }

  function writeMapScalar(w, type, value) {
    if (type === "IntProperty") {
      w.i32(value);
      return;
    }
    if (type === "BoolProperty") {
      w.u8(value ? 1 : 0);
      return;
    }
    if (type === "ByteProperty") {
      w.u8(value);
      return;
    }
    if (type === "FloatProperty") {
      w.f32Raw(value);
      return;
    }
    if (type === "StrProperty" || type === "NameProperty") {
      if (value && typeof value === "object" && value.str !== undefined) {
        w.fstr(value.str, value.enc);
      } else {
        w.fstr(value != null ? String(value) : "");
      }
      return;
    }
    if (type === "StructProperty") {
      writePropList(w, value);
      return;
    }
    throw new Error(ERR_MAP_TYPE);
  }

  function mapPayloadBytes(p) {
    var w = new BinWriter(512);
    var keyType = p.keyType && p.keyType.str !== undefined ? p.keyType.str : p.keyType;
    var valType = p.valType && p.valType.str !== undefined ? p.valType.str : p.valType;
    var entries = p.entries || [];
    w.i32(p.removedCount || 0);
    w.i32(entries.length);
    for (var i = 0; i < entries.length; i++) {
      writeMapScalar(w, keyType, entries[i].key);
      writeMapScalar(w, valType, entries[i].val);
    }
    return w.toBytes();
  }

  function readItem(r, ver) {
    var it = {};
    it.guid = [r.i32(), r.i32(), r.i32(), r.i32()];
    it.tableId = r.i32();
    it.count = r.i32();
    it.flag44 = r.i32();

    var na = r.i32();
    it.affA = [];
    for (var i = 0; i < na; i++) {
      it.affA.push({ type: r.u8(), id: r.i32(), val: r.f32Raw() });
    }

    var nb = r.i32();
    it.affB = [];
    for (var j = 0; j < nb; j++) {
      it.affB.push({ type: r.u8(), id: r.i32(), val: r.f32Raw() });
    }

    it.f68 = ver >= 6 ? r.i32() : 0;
    it.flag45 = ver >= 9 ? r.i32() : 0;
    it.flag46 = ver >= 10 ? r.i32() : 0;
    return it;
  }

  function writeItem(w, it, ver) {
    w.i32(it.guid[0]);
    w.i32(it.guid[1]);
    w.i32(it.guid[2]);
    w.i32(it.guid[3]);
    w.i32(it.tableId);
    w.i32(it.count);
    w.i32(it.flag44);

    var affA = it.affA || [];
    w.i32(affA.length);
    for (var i = 0; i < affA.length; i++) {
      w.u8(affA[i].type);
      w.i32(affA[i].id);
      w.f32Raw(affA[i].val);
    }

    var affB = it.affB || [];
    w.i32(affB.length);
    for (var j = 0; j < affB.length; j++) {
      w.u8(affB[j].type);
      w.i32(affB[j].id);
      w.f32Raw(affB[j].val);
    }

    if (ver >= 6) w.i32(it.f68 || 0);
    if (ver >= 9) w.i32(it.flag45 || 0);
    if (ver >= 10) w.i32(it.flag46 || 0);
  }

  function readNpc(r, ver) {
    var n = {};
    n.npcId = r.i32();
    n.addNeiGongLimit = r.i32();
    n.skillExp = r.i32();

    var nAttr = r.i32();
    n.attrs = [];
    for (var i = 0; i < nAttr; i++) {
      n.attrs.push({ id: r.u8(), val: r.f32Raw() });
    }

    var nSkills = r.i32();
    n.skills = [];
    for (var j = 0; j < nSkills; j++) {
      n.skills.push({
        skillId: r.i32(),
        level: r.i32(),
        slotIndex: r.i32(),
        activeA: r.i32(),
        activeB: r.i32()
      });
    }

    var nMer = r.i32();
    n.meridians = [];
    for (var k = 0; k < nMer; k++) {
      n.meridians.push({
        key: r.i32(),
        id: r.i32(),
        level: r.i32(),
        unlocked: r.i32(),
        active: r.i32()
      });
    }

    var nFr = r.i32();
    n.friendliness = [];
    for (var m = 0; m < nFr; m++) {
      n.friendliness.push({ npcId: r.i32(), favor: r.u8() });
    }

    var nGf = r.i32();
    n.guildFriendliness = [];
    for (var q = 0; q < nGf; q++) {
      n.guildFriendliness.push({ guildId: r.i32(), favor: r.u8() });
    }

    var nGh = r.i32();
    n.guildHonors = [];
    for (var s = 0; s < nGh; s++) {
      n.guildHonors.push({ guildId: r.i32(), honor: r.i32() });
    }

    n.jingMaiPoint = r.i32();

    var n78 = r.i32();
    n.personalItems = [];
    for (var a = 0; a < n78; a++) {
      n.personalItems.push(readItem(r, ver));
    }

    var n90 = r.i32();
    n.equippedItems = [];
    for (var b = 0; b < n90; b++) {
      n.equippedItems.push(readItem(r, ver));
    }

    n.avatarName = r.fstr();

    n.walkState = {
      ints: [r.i32(), r.i32(), r.i32()],
      name: r.fstr(),
      bools: [r.i32(), r.i32(), r.i32()],
      byte: r.u8()
    };

    n.itemUsedCount = [];
    if (ver >= 2) {
      var nUsed = r.i32();
      for (var c = 0; c < nUsed; c++) {
        n.itemUsedCount.push({ itemId: r.i32(), count: r.i32() });
      }
    }

    n.sceneBuffs = [];
    if (ver >= 4) {
      var nBuff = r.i32();
      for (var d = 0; d < nBuff; d++) {
        n.sceneBuffs.push({ a: r.i32(), b: r.u8(), c: r.i32() });
      }
    }

    n.formationIndex = ver >= 11 ? r.i32() : 0;

    n.jingMaiExts = [];
    if (ver >= 12) {
      var nJm = r.i32();
      for (var e = 0; e < nJm; e++) n.jingMaiExts.push(r.i32());
    }

    n.unlockedAvatars = [];
    if (ver >= 13) {
      var nAv = r.i32();
      for (var f = 0; f < nAv; f++) n.unlockedAvatars.push(r.fstr());
    }

    n.sideBarOrderIndex = ver >= 14 ? r.i32() : 0;
    return n;
  }

  function writeNpc(w, n, ver) {
    w.i32(n.npcId);
    w.i32(n.addNeiGongLimit);
    w.i32(n.skillExp);

    var attrs = n.attrs || [];
    w.i32(attrs.length);
    for (var i = 0; i < attrs.length; i++) {
      w.u8(attrs[i].id);
      w.f32Raw(attrs[i].val);
    }

    var skills = n.skills || [];
    w.i32(skills.length);
    for (var j = 0; j < skills.length; j++) {
      w.i32(skills[j].skillId);
      w.i32(skills[j].level);
      w.i32(skills[j].slotIndex);
      w.i32(skills[j].activeA);
      w.i32(skills[j].activeB);
    }

    var mer = n.meridians || [];
    w.i32(mer.length);
    for (var k = 0; k < mer.length; k++) {
      w.i32(mer[k].key);
      w.i32(mer[k].id);
      w.i32(mer[k].level);
      w.i32(mer[k].unlocked);
      w.i32(mer[k].active);
    }

    var fr = n.friendliness || [];
    w.i32(fr.length);
    for (var m = 0; m < fr.length; m++) {
      w.i32(fr[m].npcId);
      w.u8(fr[m].favor);
    }

    var gf = n.guildFriendliness || [];
    w.i32(gf.length);
    for (var q = 0; q < gf.length; q++) {
      w.i32(gf[q].guildId);
      w.u8(gf[q].favor);
    }

    var gh = n.guildHonors || [];
    w.i32(gh.length);
    for (var s = 0; s < gh.length; s++) {
      w.i32(gh[s].guildId);
      w.i32(gh[s].honor);
    }

    w.i32(n.jingMaiPoint);

    var p78 = n.personalItems || [];
    w.i32(p78.length);
    for (var a = 0; a < p78.length; a++) writeItem(w, p78[a], ver);

    var p90 = n.equippedItems || [];
    w.i32(p90.length);
    for (var b = 0; b < p90.length; b++) writeItem(w, p90[b], ver);

    writeFstrObject(w, n.avatarName);

    var ws = n.walkState || {
      ints: [0, 0, 0],
      name: { str: "", enc: "empty" },
      bools: [0, 0, 0],
      byte: 0
    };
    var wints = ws.ints || [0, 0, 0];
    w.i32(wints[0]);
    w.i32(wints[1]);
    w.i32(wints[2]);
    writeFstrObject(w, ws.name);
    var wbools = ws.bools || [0, 0, 0];
    w.i32(wbools[0]);
    w.i32(wbools[1]);
    w.i32(wbools[2]);
    w.u8(ws.byte);

    if (ver >= 2) {
      var used = n.itemUsedCount || [];
      w.i32(used.length);
      for (var c = 0; c < used.length; c++) {
        w.i32(used[c].itemId);
        w.i32(used[c].count);
      }
    }

    if (ver >= 4) {
      var buffs = n.sceneBuffs || [];
      w.i32(buffs.length);
      for (var d = 0; d < buffs.length; d++) {
        w.i32(buffs[d].a);
        w.u8(buffs[d].b);
        w.i32(buffs[d].c);
      }
    }

    if (ver >= 11) w.i32(n.formationIndex || 0);

    if (ver >= 12) {
      var jm = n.jingMaiExts || [];
      w.i32(jm.length);
      for (var e = 0; e < jm.length; e++) w.i32(jm[e]);
    }

    if (ver >= 13) {
      var av = n.unlockedAvatars || [];
      w.i32(av.length);
      for (var f = 0; f < av.length; f++) writeFstrObject(w, av[f]);
    }

    if (ver >= 14) w.i32(n.sideBarOrderIndex || 0);
  }

  function decodeInner(innerBytes, saveVersion) {
    var r = new BinReader(innerBytes);

    r.need(4);
    var magic = r.bytesCopy(4);
    if (
      magic[0] !== MAGIC_GVAS[0] ||
      magic[1] !== MAGIC_GVAS[1] ||
      magic[2] !== MAGIC_GVAS[2] ||
      magic[3] !== MAGIC_GVAS[3]
    ) {
      throw new Error(ERR_BAD_SAV);
    }

    var doc = {
      saveVersion: saveVersion,
      magic: "GVAS",
      saveGameVersion: r.i32(),
      packageFileVersion: r.i32(),
      engineVersion: {
        major: r.u16(),
        minor: r.u16(),
        patch: r.u16(),
        changelist: r.u32(),
        branch: r.fstr()
      },
      customVersionFormat: r.i32(),
      customVersions: [],
      className: null,
      preField: null,
      props: [],
      postZero: 0,
      items: [],
      npcs: []
    };

    var cvCount = r.i32();
    for (var i = 0; i < cvCount; i++) {
      doc.customVersions.push({ guid: r.bytesCopy(16), ver: r.i32() });
    }

    doc.className = r.fstr();

    if (doc.className.str === "/Script/JH.JHSaveGame") {
      doc.preField = r.i32();
      doc.props = readPropList(r);
      doc.postZero = r.i32();

      var numItems = r.i32();
      doc.items = [];
      for (var j = 0; j < numItems; j++) doc.items.push(readItem(r, saveVersion));

      var numNpcs = r.i32();
      doc.npcs = [];
      for (var k = 0; k < numNpcs; k++) doc.npcs.push(readNpc(r, saveVersion));
    } else if (doc.className.str === "/Script/JH.JHSaveGameConfig") {
      doc.preField = null;
      doc.props = readPropList(r);
      doc.postZero = r.i32();
      doc.items = [];
      doc.npcs = [];
    } else {
      throw new Error(ERR_CLASS);
    }

    if (r.rem() !== 0) {
      throw new Error(ERR_TRAILING);
    }

    return doc;
  }

  function encodeInner(doc) {
    var w = new BinWriter(4096);
    var saveVersion = doc.saveVersion;
    if (!(saveVersion >= 1 && saveVersion <= 30)) {
      throw new Error(ERR_VERSION);
    }

    w.bytes(new Uint8Array(MAGIC_GVAS));
    w.i32(doc.saveGameVersion);
    w.i32(doc.packageFileVersion);

    var ev = doc.engineVersion || {
      major: 0,
      minor: 0,
      patch: 0,
      changelist: 0,
      branch: { str: "", enc: "empty" }
    };
    w.u16(ev.major);
    w.u16(ev.minor);
    w.u16(ev.patch);
    w.u32(ev.changelist);
    writeFstrObject(w, ev.branch);

    w.i32(doc.customVersionFormat);
    var cvs = doc.customVersions || [];
    w.i32(cvs.length);
    for (var i = 0; i < cvs.length; i++) {
      w.bytes(cvs[i].guid);
      w.i32(cvs[i].ver);
    }

    writeFstrObject(w, doc.className);

    if (doc.className && doc.className.str === "/Script/JH.JHSaveGame") {
      w.i32(doc.preField);
      writePropList(w, doc.props || []);
      w.i32(doc.postZero);

      var items = doc.items || [];
      w.i32(items.length);
      for (var j = 0; j < items.length; j++) writeItem(w, items[j], saveVersion);

      var npcs = doc.npcs || [];
      w.i32(npcs.length);
      for (var k = 0; k < npcs.length; k++) writeNpc(w, npcs[k], saveVersion);
    } else if (doc.className && doc.className.str === "/Script/JH.JHSaveGameConfig") {
      writePropList(w, doc.props || []);
      w.i32(doc.postZero);
    } else {
      throw new Error(ERR_CLASS);
    }

    return w.toBytes();
  }

  function getNodeZlib() {
    try {
      if (typeof require === "function") {
        return require("zlib");
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  function parseSavOuterHeader(savBytes) {
    var bytes = asUint8Array(savBytes);
    if (bytes.byteLength < 4) throw new Error(ERR_TRUNCATED);
    if (bytes.byteLength > MAX_SAVE_BYTES) throw new Error(ERR_SIZE_LIMIT);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var saveVersion = dv.getInt32(0, true);
    if (saveVersion < 1 || saveVersion > 30) throw new Error(ERR_VERSION);
    if (saveVersion <= 5) {
      return { bytes: bytes, saveVersion: saveVersion, compressed: false, uncompressedSize: bytes.byteLength - 4, compressedSize: 0 };
    }
    if (bytes.byteLength < 12) throw new Error(ERR_TRUNCATED);
    var uncompressedSize = dv.getInt32(4, true);
    var compressedSize = dv.getInt32(8, true);
    if (compressedSize < 0 || uncompressedSize <= 0 || 12 + compressedSize !== bytes.byteLength) {
      throw new Error(ERR_TRUNCATED);
    }
    if (uncompressedSize > MAX_SAVE_BYTES) {
      throw new Error(ERR_SIZE_LIMIT);
    }
    return { bytes: bytes, saveVersion: saveVersion, compressed: true, uncompressedSize: uncompressedSize, compressedSize: compressedSize };
  }

  function decodeSavSync(savBytes) {
    var hdr = parseSavOuterHeader(savBytes);
    var inner;
    if (hdr.compressed) {
      var zlib = getNodeZlib();
      if (!zlib) throw new Error(ERR_ZLIB);

      var zlibSlice = hdr.bytes.subarray(12, 12 + hdr.compressedSize);
      var res;
      try {
        res = zlib.inflateSync(zlibSlice, { info: true, maxOutputLength: MAX_SAVE_BYTES });
      } catch (e) {
        throw new Error("세이브 데이터 압축 해제에 실패했습니다.");
      }

      if (!res || !res.engine || res.engine.bytesWritten !== zlibSlice.byteLength) {
        throw new Error(ERR_TRAILING);
      }

      var inflated = res.buffer;
      inner = inflated instanceof Uint8Array ? inflated : new Uint8Array(inflated);
      inner = new Uint8Array(inner.buffer, inner.byteOffset, inner.byteLength);
      if (inner.byteLength !== hdr.uncompressedSize) {
        throw new Error("압축 해제된 크기가 세이브 헤더와 일치하지 않습니다.");
      }
    } else {
      inner = hdr.bytes.subarray(4);
    }

    return decodeInner(inner, hdr.saveVersion);
  }

  function encodeSavSync(doc) {
    var saveVersion = doc && doc.saveVersion;
    if (!(saveVersion >= 1 && saveVersion <= 30)) {
      throw new Error(ERR_VERSION);
    }

    var inner = encodeInner(doc);

    if (saveVersion > 5) {
      var zlib = getNodeZlib();
      if (!zlib) throw new Error(ERR_ZLIB);

      var compressed;
      try {
        compressed = zlib.deflateSync(inner);
      } catch (e) {
        throw new Error("세이브 데이터 압축에 실패했습니다.");
      }

      compressed = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
      compressed = new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength);

      var out = new Uint8Array(12 + compressed.byteLength);
      var dv = new DataView(out.buffer);
      dv.setInt32(0, saveVersion, true);
      dv.setInt32(4, inner.byteLength, true);
      dv.setInt32(8, compressed.byteLength, true);
      out.set(compressed, 12);
      return out;
    }

    var out2 = new Uint8Array(4 + inner.byteLength);
    new DataView(out2.buffer).setInt32(0, saveVersion, true);
    out2.set(inner, 4);
    return out2;
  }

  function collectReadableStream(stream, maxBytes) {
    if (!stream || !stream.getReader) {
      throw new Error(ERR_STREAM);
    }
    var reader = stream.getReader();
    var chunks = [];
    var total = 0;
    function readNext() {
      return reader.read().then(function (res) {
        if (res.done) {
          return concatBytes(chunks);
        }
        var value = res.value;
        var chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (maxBytes && total > maxBytes) {
          try { reader.cancel(); } catch (e) {}
          throw new Error(ERR_SIZE_LIMIT);
        }
        chunks.push(chunk);
        return readNext();
      });
    }
    return readNext();
  }

  function browserInflate(bytes) {
    if (typeof DecompressionStream !== "function") {
      return Promise.reject(new Error(ERR_STREAM));
    }
    var ds;
    try {
      ds = new DecompressionStream("deflate");
    } catch (e) {
      try {
        ds = new DecompressionStream("deflate-raw");
      } catch (e2) {
        return Promise.reject(new Error(ERR_STREAM));
      }
    }
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return collectReadableStream(stream, MAX_SAVE_BYTES);
  }


  function browserDeflate(bytes) {
    return Promise.resolve().then(function () {
      if (typeof CompressionStream !== "function") {
        throw new Error(ERR_STREAM);
      }
      var input = asUint8Array(bytes);
      var cs = new CompressionStream("deflate");
      var stream = new Blob([input]).stream().pipeThrough(cs);
      return collectReadableStream(stream, MAX_SAVE_BYTES);
    });
  }

  function decodeSav(savBytes) {
    return Promise.resolve().then(function () {
      if (getNodeZlib()) {
        return decodeSavSync(savBytes);
      }
      var hdr = parseSavOuterHeader(savBytes);
      if (!hdr.compressed) {
        return decodeInner(hdr.bytes.subarray(4), hdr.saveVersion);
      }
      return browserInflate(hdr.bytes.subarray(12, 12 + hdr.compressedSize)).then(function (inner) {
        inner = asUint8Array(inner);
        if (inner.byteLength !== hdr.uncompressedSize) {
          throw new Error("압축 해제된 크기가 세이브 헤더와 일치하지 않습니다.");
        }
        return decodeInner(inner, hdr.saveVersion);
      });
    });
  }

  function encodeSav(doc) {
    return Promise.resolve().then(function () {
      if (getNodeZlib()) {
        return encodeSavSync(doc);
      }
      var saveVersion = doc && doc.saveVersion;
      if (!(saveVersion >= 1 && saveVersion <= 30)) throw new Error(ERR_VERSION);
      var inner = asUint8Array(encodeInner(doc));
      if (saveVersion <= 5) {
        var plain = new Uint8Array(4 + inner.byteLength);
        new DataView(plain.buffer).setInt32(0, saveVersion, true);
        plain.set(inner, 4);
        return plain;
      }
      return browserDeflate(inner).then(function (compressed) {
        compressed = asUint8Array(compressed);
        var out = new Uint8Array(12 + compressed.byteLength);
        var dv = new DataView(out.buffer);
        dv.setInt32(0, saveVersion, true);
        dv.setInt32(4, inner.byteLength, true);
        dv.setInt32(8, compressed.byteLength, true);
        out.set(compressed, 12);
        return out;
      });
    });
  }

  function sha256Hex(inputBytes) {
    var bytes = asUint8Array(inputBytes);
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    var H = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
    var bitLength = bytes.byteLength * 8;
    var paddedBlocks = ((bytes.byteLength + 8) >> 6) + 1;
    var padded = new Uint8Array(paddedBlocks * 64);
    padded.set(bytes);
    padded[bytes.byteLength] = 0x80;
    var high = Math.floor(bitLength / 0x100000000);
    var low = bitLength >>> 0;
    var end = padded.length;
    padded[end - 8] = (high >>> 24) & 0xff;
    padded[end - 7] = (high >>> 16) & 0xff;
    padded[end - 6] = (high >>> 8) & 0xff;
    padded[end - 5] = high & 0xff;
    padded[end - 4] = (low >>> 24) & 0xff;
    padded[end - 3] = (low >>> 16) & 0xff;
    padded[end - 2] = (low >>> 8) & 0xff;
    padded[end - 1] = low & 0xff;
    var w = new Uint32Array(64);
    for (var offset = 0; offset < padded.length; offset += 64) {
      for (var i = 0; i < 16; i++) {
        var j = offset + i * 4;
        w[i] = ((padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3]) >>> 0;
      }
      for (i = 16; i < 64; i++) {
        var s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        var s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        var ch = ((e & f) ^ ((~e) & g)) >>> 0;
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        var maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var hex = "";
    for (var k = 0; k < 8; k++) hex += ("00000000" + (H[k] >>> 0).toString(16)).slice(-8);
    return hex;
  }

  function inspectOpaqueProps(doc) {
    var props = doc && Array.isArray(doc.props) ? doc.props : [];
    var byName = {};
    var i;
    for (i = 0; i < props.length; i += 1) {
      var p = props[i];
      if (p && p.name && (OPAQUE_PROPS[p.name] === true || p.opaque !== undefined)) {
        byName[p.name] = p;
      }
    }
    var names = OPAQUE_PROP_ORDER.slice();
    var extraKeys = Object.keys(byName);
    for (i = 0; i < extraKeys.length; i += 1) {
      if (names.indexOf(extraKeys[i]) < 0) names.push(extraKeys[i]);
    }
    var items = [];
    var totalBytes = 0;
    var presentCount = 0;
    for (i = 0; i < names.length; i += 1) {
      var name = names[i];
      var prop = byName[name] || null;
      var present = !!prop;
      var byteLength = 0;
      if (prop) {
        if (prop.opaque && typeof prop.opaque.byteLength === "number") {
          byteLength = prop.opaque.byteLength;
        } else if (typeof prop.size === "number" && prop.size >= 0) {
          byteLength = prop.size;
        }
        presentCount += 1;
        totalBytes += byteLength;
      }
      items.push({
        name: name,
        labelKo: OPAQUE_PROP_LABELS_KO[name] || name,
        type: prop ? prop.type : null,
        present: present,
        byteLength: byteLength,
        readOnly: true,
        preserved: true,
        status: present ? "무손실 원형 보존 (읽기 전용)" : "미포함"
      });
    }
    return {
      items: items,
      totalBytes: totalBytes,
      presentCount: presentCount,
      readOnly: true,
      preserved: true
    };
  }

  function inspect(doc) {
    var opaque = inspectOpaqueProps(doc);
    return {
      saveVersion: doc ? doc.saveVersion : null,
      className: doc && doc.className ? doc.className.str : null,
      opaqueProps: opaque.items,
      opaqueTotalBytes: opaque.totalBytes,
      opaquePresentCount: opaque.presentCount,
      readOnly: true,
      preserved: true
    };
  }

  return {
    OPAQUE_PROP_NAMES: OPAQUE_PROP_ORDER.slice(),
    decodeSavSync: decodeSavSync,
    encodeSavSync: encodeSavSync,
    decodeSav: decodeSav,
    encodeSav: encodeSav,
    decodeInner: decodeInner,
    encodeInner: encodeInner,
    inspectOpaqueProps: inspectOpaqueProps,
    inspect: inspect,
    sha256Hex: sha256Hex,
    toNumber: toNumber,
    BinReader: BinReader,
    BinWriter: BinWriter
  };
});
