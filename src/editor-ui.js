(function () {
  "use strict";

  var Core = window.WanderingSwordEditorCore;
  var Codec = window.WanderingSwordCodec;
  var Catalog = window.WanderingSwordCatalog;
  var session = Core.createSession(Codec, Catalog);

  var uiState = {
    busy: false,
    fileName: "0.sav",
    activeTab: "tab-overview",
    selectedNpcId: 0,
    attrGroupFilter: "전체",
    bagQuery: "",
    loopbackAvailable: false,
    loopbackToken: "",
    loopbackSha256: "",
    nativeAvailable: false,
    nativeSession: null,
    nativePath: null,
    pickerMode: null,
    pickerSelectedId: null
  };

  var nativeSeq = 0;
  var nativePending = new Map();
  var pickerResolve = null;
  var confirmResolve = null;
  var dialogsBound = false;
  var tabsBound = false;

  function el(id) {
    return document.getElementById(id);
  }

  function escHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function uint8ToBase64(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var chunkSize = 0x8000;
    var parts = [];
    for (var i = 0; i < view.length; i += chunkSize) {
      var part = view.subarray(i, Math.min(i + chunkSize, view.length));
      var text = "";
      for (var j = 0; j < part.length; j += 1) text += String.fromCharCode(part[j]);
      parts.push(text);
    }
    return btoa(parts.join(""));
  }

  function base64ToUint8(b64) {
    var binary = atob(String(b64 || ""));
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }

  function setStatus(msg, isError) {
    var banner = el("status-banner");
    if (!banner) return;
    banner.textContent = String(msg || "");
    banner.classList.toggle("is-error", !!isError);
    banner.setAttribute("role", isError ? "alert" : "status");
  }

  function setBusy(flag) {
    uiState.busy = !!flag;
    document.body.classList.toggle("is-busy", uiState.busy);
    var banner = el("status-banner");
    if (banner) banner.setAttribute("aria-busy", uiState.busy ? "true" : "false");
    syncTopBadges();
  }

  function syncTopBadges() {
    var loaded = session.isLoaded();
    var dirty = loaded && session.isDirty();
    var verdict = loaded ? session.validate() : { valid: false, errors: [] };
    var modeBadge = el("mode-badge");
    var dirtyBadge = el("dirty-badge");
    var validBadge = el("valid-badge");
    if (modeBadge) {
      modeBadge.textContent = uiState.nativeAvailable
        ? "데스크톱 앱 모드"
        : uiState.loopbackAvailable
          ? "로컬 서버 모드"
          : "오프라인 브라우저 모드";
    }
    if (dirtyBadge) {
      dirtyBadge.textContent = loaded ? (dirty ? "수정됨 (미저장)" : "변경 없음") : "비어 있음";
      dirtyBadge.classList.toggle("is-dirty", !!dirty);
    }
    if (validBadge) {
      validBadge.textContent = !loaded ? "검증 대기" : verdict.valid ? "검증 통과" : "검증 오류 " + verdict.errors.length + "건";
      validBadge.classList.toggle("is-error", loaded && !verdict.valid);
    }
  }

  function loadSessionBytes(bytes, fileName) {
    var name = fileName || uiState.fileName || "0.sav";
    return session.loadBytes(bytes, { filename: name }).then(function () {
      uiState.fileName = name;
      uiState.selectedNpcId = 0;
      renderAll();
    });
  }

  function exportSessionBytes() {
    return session.exportBytes();
  }

  function downloadBlob(bytes, fileName) {
    var blob = new Blob([bytes], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fileName || "0.sav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function initThemeToggle() {
    var select = el("theme-select");
    if (!select) return;
    var saved = null;
    try { saved = localStorage.getItem("ws-theme"); } catch (err) { saved = null; }
    var initial = saved === "light" || saved === "dark" ? saved : "system";
    select.value = initial;

    function applyTheme(mode) {
      var meta = document.querySelector('meta[name="color-scheme"]');
      var content = mode === "light" ? "light" : mode === "dark" ? "dark" : "light dark";
      if (meta) meta.setAttribute("content", content);
      document.documentElement.setAttribute("data-theme", mode === "system" ? "자동" : mode === "dark" ? "어두움" : "밝음");
    }

    function persistTheme(mode) {
      try {
        if (mode === "system") {
          localStorage.removeItem("ws-theme");
          return;
        }
        var osDark = !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        if ((mode === "dark") === osDark) localStorage.removeItem("ws-theme");
        else localStorage.setItem("ws-theme", mode);
      } catch (err) {
        /* 저장소 접근이 제한된 환경에서도 현재 화면 테마는 즉시 반영합니다. */
      }
    }

    applyTheme(initial);
    select.addEventListener("change", function () {
      var mode = select.value;
      if (mode !== "light" && mode !== "dark") mode = "system";
      persistTheme(mode);
      applyTheme(mode);
      setStatus("화면 테마를 변경했습니다.", false);
    });

    if (window.matchMedia) {
      var mq = window.matchMedia("(prefers-color-scheme: dark)");
      var onChange = function () {
        if (select.value === "system") applyTheme("system");
      };
      if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
      else if (typeof mq.addListener === "function") mq.addListener(onChange);
    }
  }

  function activateTab(tabId, moveFocus) {
    var tab = el(tabId);
    if (!tab) return;
    var panelId = tab.getAttribute("aria-controls") || ("panel-" + tabId.replace(/^tab-/, ""));
    document.querySelectorAll('[role="tab"]').forEach(function (node) {
      var selected = node.id === tabId;
      node.setAttribute("aria-selected", selected ? "true" : "false");
      node.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[role="tabpanel"]').forEach(function (panel) {
      if (panel.id === panelId) panel.removeAttribute("hidden");
      else panel.setAttribute("hidden", "until-found");
    });
    uiState.activeTab = tabId;
    if (moveFocus) tab.focus();
  }

  function initTabs() {
    if (tabsBound) return;
    tabsBound = true;
    document.querySelectorAll('[role="tablist"]').forEach(function (tablist) {
      tablist.addEventListener("keydown", function (ev) {
        var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
        var current = tabs.indexOf(document.activeElement);
        if (current < 0) return;
        var next = current;
        if (ev.key === "ArrowRight") next = (current + 1) % tabs.length;
        else if (ev.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
        else if (ev.key === "Home") next = 0;
        else if (ev.key === "End") next = tabs.length - 1;
        else return;
        ev.preventDefault();
        activateTab(tabs[next].id, true);
      });
    });
    document.querySelectorAll('[role="tab"]').forEach(function (tab) {
      tab.addEventListener("click", function () { activateTab(tab.id, false); });
    });
    document.querySelectorAll('[role="tabpanel"]').forEach(function (panel) {
      panel.addEventListener("beforematch", function () {
        var tab = document.querySelector('[role="tab"][aria-controls="' + panel.id + '"]') ||
          document.getElementById("tab-" + panel.id.replace(/^panel-/, ""));
        if (tab) activateTab(tab.id, false);
      });
    });
    var active = document.querySelector('[role="tab"][aria-selected="true"]') || document.querySelector('[role="tab"]');
    if (active) activateTab(active.id, false);
  }

  function ensureDialogInfrastructure() {
    if (dialogsBound) return;
    dialogsBound = true;

    var confirmDialog = el("confirm-dialog");
    if (confirmDialog) {
      confirmDialog.addEventListener("close", function () {
        var ok = confirmDialog.returnValue === "ok";
        confirmDialog.returnValue = "";
        if (confirmResolve) {
          var done = confirmResolve;
          confirmResolve = null;
          done(ok);
        }
      });
      confirmDialog.addEventListener("click", function (ev) {
        if (ev.target === confirmDialog) confirmDialog.close("cancel");
      });
      var cancelBtn = el("confirm-cancel-btn");
      var okBtn = el("confirm-ok-btn");
      if (cancelBtn) cancelBtn.addEventListener("click", function () { confirmDialog.close("cancel"); });
      if (okBtn) okBtn.addEventListener("click", function () { confirmDialog.close("ok"); });
    }

    var pickerDialog = el("picker-dialog");
    if (pickerDialog) {
      pickerDialog.addEventListener("close", function () {
        var ok = pickerDialog.returnValue === "ok";
        var countVal = Math.max(1, Math.trunc(Number((el("picker-count-input") || {}).value) || 1));
        var result = ok && uiState.pickerSelectedId != null
          ? { id: uiState.pickerSelectedId, count: countVal }
          : null;
        pickerDialog.returnValue = "";
        uiState.pickerMode = null;
        if (pickerResolve) {
          var done = pickerResolve;
          pickerResolve = null;
          done(result);
        }
      });
      pickerDialog.addEventListener("click", function (ev) {
        if (ev.target === pickerDialog) pickerDialog.close("cancel");
      });
      var pickerSearch = el("picker-search-input");
      if (pickerSearch) {
        pickerSearch.addEventListener("input", function () {
          renderPickerItems(pickerSearch.value);
        });
      }
      var pickerList = el("picker-list");
      if (pickerList) {
        pickerList.addEventListener("click", function (ev) {
          var item = ev.target.closest("[data-picker-id]");
          if (!item) return;
          pickerList.querySelectorAll("[data-picker-id]").forEach(function (node) {
            node.classList.remove("is-selected");
            node.setAttribute("aria-selected", "false");
          });
          item.classList.add("is-selected");
          item.setAttribute("aria-selected", "true");
          uiState.pickerSelectedId = Number(item.getAttribute("data-picker-id"));
        });
      }
      var pickerCancel = el("picker-cancel-btn");
      var pickerAdd = el("picker-add-btn");
      if (pickerCancel) pickerCancel.addEventListener("click", function () { pickerDialog.close("cancel"); });
      if (pickerAdd) {
        pickerAdd.addEventListener("click", function () {
          if (uiState.pickerSelectedId == null) {
            setStatus("추가할 항목을 목록에서 먼저 선택하세요.", true);
            return;
          }
          pickerDialog.close("ok");
        });
      }
    }
  }

  function confirmModal(title, message) {
    return new Promise(function (resolve) {
      var dialog = el("confirm-dialog");
      if (!dialog) {
        resolve(false);
        return;
      }
      ensureDialogInfrastructure();
      var titleNode = el("confirm-dialog-title");
      var messageNode = el("confirm-dialog-message");
      if (titleNode) titleNode.textContent = title || "작업 확인";
      if (messageNode) messageNode.textContent = message || "";
      dialog.returnValue = "";
      confirmResolve = resolve;
      if (typeof dialog.showModal === "function") dialog.showModal();
      else resolve(!!window.confirm(message || title || ""));
    });
  }

  function renderPickerItems(query) {
    var list = el("picker-list");
    if (!list) return;
    var q = String(query || "").trim();
    var items = [];
    if (session.isLoaded()) {
      items = uiState.pickerMode === "skill"
        ? session.listAddableSkills(q)
        : session.listAddableItems(q);
    }
    var shown = items.slice(0, 120);
    list.innerHTML = shown.map(function (item) {
      var sub = item.category || item.bucketName || "";
      var label = item.name + " (번호 " + item.id + (sub ? " · " + sub : "") + ")";
      var selected = uiState.pickerSelectedId === item.id;
      return '<li role="presentation"><button type="button" role="option" aria-selected="' +
        (selected ? "true" : "false") + '" class="picker-item' + (selected ? " is-selected" : "") +
        '" data-picker-id="' + escHtml(String(item.id)) + '">' + escHtml(label) + "</button></li>";
    }).join("");
  }

  function openPickerModal(mode) {
    return new Promise(function (resolve) {
      var dialog = el("picker-dialog");
      if (!dialog) {
        resolve(null);
        return;
      }
      ensureDialogInfrastructure();
      uiState.pickerMode = mode === "skill" ? "skill" : "item";
      uiState.pickerSelectedId = null;
      pickerResolve = resolve;
      var title = el("picker-dialog-title");
      var countLabel = el("picker-count-label");
      var countInput = el("picker-count-input");
      var search = el("picker-search-input");
      if (title) title.textContent = uiState.pickerMode === "skill" ? "무공 추가" : "가방 물품 추가";
      if (countLabel) countLabel.textContent = uiState.pickerMode === "skill" ? "습득 등급 (1~10)" : "추가 수량";
      if (countInput) {
        countInput.max = uiState.pickerMode === "skill" ? "10" : "99999999";
        countInput.value = uiState.pickerMode === "skill" ? "10" : "1";
      }
      if (search) search.value = "";
      dialog.returnValue = "";
      renderPickerItems("");
      if (typeof dialog.showModal === "function") dialog.showModal();
    });
  }

  function loadDemoSave() {
    setBusy(true);
    return Core.createDemoSavBytes().then(function (bytes) {
      return loadSessionBytes(bytes, "체험판_0.sav");
    }).then(function () {
      setStatus("체험판 세이브를 불러왔습니다.", false);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "체험판 세이브를 불러오지 못했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function openBrowserFile(file) {
    if (!file) return Promise.resolve();
    setBusy(true);
    return file.arrayBuffer().then(function (buf) {
      return loadSessionBytes(new Uint8Array(buf), file.name || "0.sav");
    }).then(function () {
      setStatus("세이브 파일을 불러왔습니다: " + uiState.fileName, false);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "세이브 파일을 불러오지 못했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function downloadModifiedSave() {
    if (!session.isLoaded()) {
      setStatus("먼저 세이브 파일을 불러오세요.", true);
      return Promise.resolve();
    }
    var verdict = session.validate();
    if (!verdict.valid) {
      setStatus("검증 오류가 있어 다운로드할 수 없습니다.", true);
      return Promise.resolve();
    }
    setBusy(true);
    return exportSessionBytes().then(function (bytes) {
      downloadBlob(bytes, uiState.fileName || "0.sav");
      setStatus("수정본 세이브 파일을 내려받았습니다: " + uiState.fileName, false);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "수정본 세이브 파일을 생성하지 못했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function probeLoopback() {
    var meta = document.querySelector('meta[name="ws-loopback-token"]');
    uiState.loopbackToken = meta ? (meta.getAttribute("content") || "") : "";
    if (!uiState.loopbackToken) {
      uiState.loopbackAvailable = false;
      return Promise.resolve(false);
    }
    return fetch("/api/status", {
      headers: { "Accept": "application/json", "X-WS-Token": uiState.loopbackToken },
      cache: "no-store"
    }).then(function (res) {
      if (!res.ok) throw new Error("상태 확인 실패");
      return res.json();
    }).then(function (data) {
      if (!data || !data.ok) throw new Error("상태 응답 오류");
      uiState.loopbackAvailable = true;
      var files = Array.isArray(data.files) ? data.files : [];
      var select = el("loopback-file-select");
      if (select) {
        select.innerHTML = "";
        files.forEach(function (f) {
          var opt = document.createElement("option");
          opt.value = f;
          opt.textContent = f;
          select.appendChild(opt);
        });
      }
      var bar = el("loopback-bar");
      if (bar) bar.hidden = false;
      syncTopBadges();
      if (!uiState.nativeAvailable && files.length > 0) {
        var targetName = data.defaultFile || files[0];
        if (select) select.value = targetName;
        return openLoopbackSelected().then(function () { return true; });
      }
      return true;
    }).catch(function () {
      uiState.loopbackAvailable = false;
      syncTopBadges();
      return false;
    });
  }

  function openLoopbackSelected() {
    var select = el("loopback-file-select");
    var name = select && select.value ? select.value : "";
    if (!name) {
      setStatus("열 세이브 파일을 선택하세요.", true);
      return Promise.resolve();
    }
    setBusy(true);
    return fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-WS-Token": uiState.loopbackToken },
      body: JSON.stringify({ file: name })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "로컬 서버 파일을 열지 못했습니다.");
        uiState.loopbackSha256 = data.sha256 || "";
        return loadSessionBytes(base64ToUint8(data.base64), data.file || name);
      });
    }).then(function () {
      setStatus("로컬 서버 세이브를 불러왔습니다: " + uiState.fileName, false);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "로컬 서버 파일을 열지 못했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function ensureCanSave() {
    if (!session.isLoaded()) {
      setStatus("먼저 세이브 파일을 불러오세요.", true);
      return false;
    }
    if (!session.validate().valid) {
      setStatus("검증 오류가 있어 저장할 수 없습니다.", true);
      return false;
    }
    setBusy(true);
    return true;
  }

  function saveLoopbackCurrent() {
    if (!ensureCanSave()) {
      return Promise.resolve();
    }
    return exportSessionBytes().then(function (bytes) {
      return fetch("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-WS-Token": uiState.loopbackToken },
        body: JSON.stringify({
          file: uiState.fileName || "0.sav",
          expectedSha256: uiState.loopbackSha256,
          base64: uint8ToBase64(bytes)
        })
      });
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || !data.ok) throw new Error((data && data.error) || "로컬 서버 저장에 실패했습니다.");
        uiState.loopbackSha256 = data.sha256 || uiState.loopbackSha256;
        session.markClean();
        syncTopBadges();
        setStatus("원본 백업 후 저장했습니다: " + (data.backupFile || uiState.fileName), false);
      });
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "로컬 서버 저장에 실패했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function sendNative(kind, extra) {
    if (!(window.chrome && window.chrome.webview)) {
      return Promise.reject(new Error("데스크톱 앱 연결을 사용할 수 없습니다."));
    }
    var id = "req-" + (++nativeSeq);
    return new Promise(function (resolve, reject) {
      nativePending.set(id, { resolve: resolve, reject: reject });
      var msg = { id: id, seq: nativeSeq, kind: kind };
      if (extra) {
        Object.keys(extra).forEach(function (k) { msg[k] = extra[k]; });
      }
      try {
        window.chrome.webview.postMessage(msg);
      } catch (err) {
        nativePending.delete(id);
        reject(err);
      }
    });
  }

  function applyNativeReply(reply) {
    if (reply && reply.base64) {
      uiState.nativeSession = reply.session || null;
      uiState.nativePath = reply.path || null;
      return loadSessionBytes(base64ToUint8(reply.base64), reply.fileName || reply.file || "0.sav").then(function () {
        setStatus("데스크톱 세이브를 불러왔습니다: " + uiState.fileName, false);
      });
    }
    if (reply && reply.demo) {
      return loadDemoSave();
    }
    return Promise.resolve();
  }

  function initNativeBridge() {
    if (!(window.chrome && window.chrome.webview)) {
      uiState.nativeAvailable = false;
      return;
    }
    uiState.nativeAvailable = true;
    var bar = el("native-bar");
    if (bar) bar.hidden = false;
    window.chrome.webview.addEventListener("message", function (ev) {
      var reply = ev && ev.data ? ev.data : {};
      if (typeof reply === "string") {
        try { reply = JSON.parse(reply); } catch (e) { reply = {}; }
      }
      var pending = reply.id ? nativePending.get(reply.id) : null;
      if (!pending) return;
      nativePending.delete(reply.id);
      if (reply.error) pending.reject(new Error(String(reply.error)));
      else pending.resolve(reply);
    });
    setBusy(true);
    sendNative("ready", {}).then(function (reply) {
      return applyNativeReply(reply);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "데스크톱 초기화에 실패했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function nativeOpen() {
    setBusy(true);
    return sendNative("open", {}).then(function (reply) {
      return applyNativeReply(reply);
    }).catch(function (err) {
      if (err && err.message !== "취소됨") {
        setStatus(err && err.message ? err.message : "데스크톱 세이브를 열지 못했습니다.", true);
      }
    }).then(function () {
      setBusy(false);
    });
  }

  function nativeSave() {
    if (!ensureCanSave()) {
      return Promise.resolve();
    }
    return exportSessionBytes().then(function (bytes) {
      return sendNative("save", {
        base64: uint8ToBase64(bytes),
        fileName: uiState.fileName || "0.sav",
        session: uiState.nativeSession
      });
    }).then(function (reply) {
      uiState.nativeSession = reply.session || uiState.nativeSession;
      uiState.nativePath = reply.path || uiState.nativePath;
      session.markClean();
      syncTopBadges();
      setStatus("원본 자동 백업 후 저장했습니다: " + (reply.backupFile || reply.path || uiState.fileName), false);
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : "데스크톱 저장에 실패했습니다.", true);
    }).then(function () {
      setBusy(false);
    });
  }

  function nativeSaveCopy() {
    if (!ensureCanSave()) {
      return Promise.resolve();
    }
    return exportSessionBytes().then(function (bytes) {
      return sendNative("save-copy", {
        base64: uint8ToBase64(bytes),
        fileName: uiState.fileName || "0.sav",
        session: uiState.nativeSession
      });
    }).then(function (reply) {
      if (reply && reply.path) {
        setStatus("사본을 저장했습니다: " + reply.path, false);
      }
    }).catch(function (err) {
      if (err && err.message !== "취소됨") {
        setStatus(err && err.message ? err.message : "사본 저장에 실패했습니다.", true);
      }
    }).then(function () {
      setBusy(false);
    });
  }

  function charSelectorHtml(chars) {
    var options = (chars || []).map(function (c) {
      var role = c.isHero ? "주인공" : c.isFightParty ? "출전 동료" : c.isParty ? "파티 동료" : "일반 인물";
      var selected = c.npcId === uiState.selectedNpcId ? " selected" : "";
      return '<option value="' + escHtml(String(c.npcId)) + '"' + selected + ">" +
        escHtml(c.name + " (" + role + ")") + "</option>";
    }).join("");
    return '<div class="field-row"><label>편집 대상 인물</label><select data-action="select-npc" aria-label="편집 대상 인물 선택">' +
      options + "</select></div>";
  }

  function renderPresetBar() {
    var root = el("preset-buttons");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = '<button type="button" class="btn" disabled>세이브를 먼저 불러오세요</button>';
      return;
    }
    var sum = session.getSummary();
    var target = sum.isConfig ? "config" : "slot";
    var presets = (Core.PRESETS || []).filter(function (p) { return p.target === target; });
    root.innerHTML = presets.map(function (p) {
      return '<button type="button" class="btn" data-action="apply-preset" data-preset-id="' +
        escHtml(p.id) + '" title="' + escHtml(p.desc || "") + '">' + escHtml(p.label) + "</button>";
    }).join("");
  }

  function renderOpaquePropsTable(opaqueProps, totalBytes, presentCount) {
    var items = Array.isArray(opaqueProps) ? opaqueProps : [];
    if (!items.length) return "";
    var rows = items.map(function (item) {
      var sizeText = item.present ? (Number(item.byteLength || 0).toLocaleString("ko-KR") + " B") : "0 B (미포함)";
      var statusText = item.status || (item.present ? "무손실 원형 보존 (읽기 전용)" : "미포함");
      return '<tr><th scope="row" data-label="속성명"><code>' + escHtml(item.name) + "</code></th>" +
        '<td data-label="설명">' + escHtml(item.labelKo || item.name) + "</td>" +
        '<td data-label="형식">' + escHtml(item.type || "-") + "</td>" +
        '<td data-label="바이트 크기">' + escHtml(sizeText) + "</td>" +
        '<td data-label="보존 상태">' + escHtml(statusText) + "</td></tr>";
    }).join("");
    return '<div class="table-wrapper" tabindex="0" role="region" aria-label="SaveManager OPAQUE_PROPS 원형 보존 영역 (읽기 전용)">' +
      "<table><caption>SaveManager GVAS OPAQUE_PROPS 원형 보존 메타 (읽기 전용 · 포함 " +
      escHtml(String(presentCount || 0)) + "종 · 총 " + escHtml(Number(totalBytes || 0).toLocaleString("ko-KR")) + " B)</caption>" +
      '<thead><tr><th scope="col">속성명</th><th scope="col">설명</th><th scope="col">형식</th><th scope="col">바이트 크기</th><th scope="col">보존 상태</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  function renderOverviewPanel() {
    var root = el("overview-root");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = "";
      return;
    }
    var sum = session.getSummary();
    if (sum.isConfig) {
      var cfgCards = [
        ["세이브 유형", sum.saveTypeLabel],
        ["전승 점수", sum.score.toLocaleString("ko-KR")],
        ["해금 전승", sum.inheritIds.length + "개"],
        ["도감 기록", sum.pictorialCount + "건"],
        ["무공 도감", sum.skillBookCount + "건"],
        ["물품 도감", sum.itemBookCount + "건"],
        ["동료 기록", sum.teamBookCount + "명"],
        ["결말 달성", sum.endingCount + "건"]
      ].map(function (pair) {
        return '<div class="stat-card"><span class="label">' + escHtml(pair[0]) +
          '</span><span class="value">' + escHtml(String(pair[1])) + "</span></div>";
      }).join("");
      var slotTable = sum.slotSummaries.length > 0
        ? '<div class="table-wrapper" tabindex="0" role="region" aria-label="저장 슬롯 요약 목록"><table><caption>저장 슬롯 요약</caption>' +
          '<thead><tr><th scope="col">슬롯</th><th scope="col">지역</th><th scope="col">플레이 시간</th><th scope="col">난이도</th></tr></thead><tbody>' +
          sum.slotSummaries.map(function (slot) {
            return '<tr><th scope="row" data-label="슬롯">슬롯 ' + escHtml(String(slot.index)) + "</th>" +
              '<td data-label="지역">' + escHtml(slot.mapNameKo || "-") + "</td>" +
              '<td data-label="플레이 시간">' + escHtml(slot.playTimeText || "-") + "</td>" +
              '<td data-label="난이도">' + escHtml(slot.difficultyKo || "-") + "</td></tr>";
          }).join("") + "</tbody></table></div>"
        : "";
      root.innerHTML = '<div class="card-grid">' + cfgCards + '</div><div class="field-grid"><div class="field-row">' +
        '<label for="input-config-score">전승 점수</label>' +
        '<input id="input-config-score" type="number" min="0" max="2147483647" data-action="set-config-score" value="' + escHtml(String(sum.score)) + '">' +
        "</div></div>" + slotTable;
      return;
    }

    var hero = sum.hero || null;
    var cards = [
      ["현재 지역", sum.mapNameKo || "-"],
      ["플레이 시간", sum.playTimeText || "-"],
      ["보유 금전", sum.money.toLocaleString("ko-KR")],
      ["전투 방식", sum.turnModeKo || "-"],
      ["장착 탈것", sum.selectedMountName || "미장착"],
      ["주인공 기혈", hero ? (hero.hp + " / " + hero.maxHp) : "-"],
      ["주인공 진기·내공", hero ? (hero.mp + " / " + hero.maxMp + " · 내공 " + hero.inner) : "-"],
      ["파티·가방", "동료 " + sum.teamIds.length + "명 · 물품 " + sum.bagItemCount + "개"]
    ].map(function (pair) {
      return '<div class="stat-card"><span class="label">' + escHtml(pair[0]) +
        '</span><span class="value">' + escHtml(String(pair[1])) + "</span></div>";
    }).join("");
    var realSel = sum.turnModeRaw === "ETurnMode::RealTime" ? " selected" : "";
    var turnSel = sum.turnModeRaw === "ETurnMode::TurnBased" ? " selected" : "";
    var opaqueHtml = renderOpaquePropsTable(sum.opaqueProps, sum.opaqueTotalBytes, sum.opaquePresentCount);
    root.innerHTML = '<div class="card-grid">' + cards + '</div><div class="field-grid">' +
      '<div class="field-row"><label for="input-money">보유 금전</label>' +
      '<input id="input-money" type="number" min="0" max="2147483647" data-action="set-money" value="' + escHtml(String(sum.money)) + '"></div>' +
      '<div class="field-row"><label for="select-turn-mode">전투 방식</label>' +
      '<select id="select-turn-mode" data-action="set-turn-mode">' +
      '<option value="ETurnMode::RealTime"' + realSel + '>실시간 전투</option>' +
      '<option value="ETurnMode::TurnBased"' + turnSel + '>턴제 전투</option></select></div>' +
      '<div class="field-row"><label>복용 기록 관리</label>' +
      '<button type="button" class="btn" data-action="reset-pill-limits">복용 제한 전체 초기화</button></div></div>' +
      opaqueHtml;
  }

  function renderStatsPanel() {
    var root = el("stats-root");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = "";
      return;
    }
    if (session.isConfigSave()) {
      root.innerHTML = "<p>전역 환경·전승 세이브에서는 인물 능력치를 편집하지 않습니다.</p>";
      return;
    }
    var chars = session.listEditableCharacters("");
    var detail = session.getCharacterDetail(uiState.selectedNpcId);
    if (!detail && chars.length > 0) {
      uiState.selectedNpcId = chars[0].npcId;
      detail = session.getCharacterDetail(uiState.selectedNpcId);
    }
    if (!detail) {
      root.innerHTML = "<p>편집 가능한 인물 정보가 없습니다.</p>";
      return;
    }
    var groupOpts = ["전체", "핵심 전투", "무기 수련", "생활 기예", "보조·배율"].map(function (g) {
      return '<option value="' + escHtml(g) + '"' + (uiState.attrGroupFilter === g ? " selected" : "") + ">" + escHtml(g) + "</option>";
    }).join("");
    var rows = detail.attrs
      .filter(function (a) { return uiState.attrGroupFilter === "전체" || a.group === uiState.attrGroupFilter; })
      .map(function (a) {
        var unit = String(a.format || "").indexOf("%%") >= 0 ? "백분율" : "수치";
        return '<tr><th scope="row" data-label="능력치">' + escHtml(a.name) + "</th>" +
          '<td data-label="분류">' + escHtml(a.group) + "</td>" +
          '<td data-label="단위">' + escHtml(unit) + "</td>" +
          '<td data-label="수치"><input type="number" step="any" data-action="set-attr" data-attr-id="' +
          escHtml(String(a.id)) + '" value="' + escHtml(String(Math.round(a.val * 1000) / 1000)) + '"></td></tr>';
      }).join("");
    root.innerHTML = '<div class="field-grid">' + charSelectorHtml(chars) +
      '<div class="field-row"><label for="stats-attr-group">능력치 분류</label>' +
      '<select id="stats-attr-group" data-action="filter-attr-group">' + groupOpts + "</select></div></div>" +
      '<div class="field-grid">' +
      '<div class="field-row"><label for="stats-skill-exp">무학 점수</label>' +
      '<input id="stats-skill-exp" type="number" min="0" max="2147483647" data-action="set-resource" data-field="skillExp" value="' + escHtml(String(detail.skillExp)) + '"></div>' +
      '<div class="field-row"><label for="stats-jing-mai-point">경맥 점수</label>' +
      '<input id="stats-jing-mai-point" type="number" min="0" max="2147483647" data-action="set-resource" data-field="jingMaiPoint" value="' + escHtml(String(detail.jingMaiPoint)) + '"></div>' +
      '<div class="field-row"><label for="stats-nei-gong-limit">심법 상한</label>' +
      '<input id="stats-nei-gong-limit" type="number" min="0" max="2147483647" data-action="set-resource" data-field="addNeiGongLimit" value="' + escHtml(String(detail.addNeiGongLimit)) + '"></div></div>' +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="인물 능력치 목록"><table><caption>인물 능력치 목록</caption>' +
      '<thead><tr><th scope="col">능력치</th><th scope="col">분류</th><th scope="col">단위</th><th scope="col">수치</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  function renderMartialPanel() {
    var root = el("martial-root");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = "";
      return;
    }
    if (session.isConfigSave()) {
      root.innerHTML = "<p>전역 환경·전승 세이브에서는 무공·경맥을 편집하지 않습니다.</p>";
      return;
    }
    var chars = session.listEditableCharacters("");
    var detail = session.getCharacterDetail(uiState.selectedNpcId);
    if (!detail) {
      root.innerHTML = "<p>편집 가능한 인물 정보가 없습니다.</p>";
      return;
    }
    var unlockedCount = detail.meridians.filter(function (m) { return m.unlocked > 0; }).length;
    var rows = detail.skills.map(function (s) {
      var equipText = s.slotIndex === -1 ? "미장착" : ("슬롯 " + (s.slotIndex + 1));
      return '<tr><th scope="row" data-label="무공명">' + escHtml(s.name) + "</th>" +
        '<td data-label="분류">' + escHtml(s.category || "-") + "</td>" +
        '<td data-label="등급"><input type="number" min="0" max="10" data-action="set-skill-level" data-skill-id="' +
        escHtml(String(s.skillId)) + '" value="' + escHtml(String(s.level)) + '"></td>' +
        '<td data-label="장착">' + escHtml(equipText) + "</td>" +
        '<td data-label="관리"><button type="button" class="btn" data-action="remove-skill" data-skill-id="' +
        escHtml(String(s.skillId)) + '"' + (s.slotIndex !== -1 ? " disabled" : "") + ">제거</button></td></tr>";
    }).join("");
    root.innerHTML = '<div class="field-grid">' + charSelectorHtml(chars) +
      '<div class="field-row"><label>무공·경맥 도구</label><div class="file-actions">' +
      '<button type="button" class="btn btn-primary" data-action="open-add-skill">무공 추가</button>' +
      '<button type="button" class="btn" data-action="unlock-meridians">경맥 전체 해금 + 경맥 점수 9,999</button></div></div></div>' +
      '<div class="stat-card"><span class="label">개통된 경맥·혈도</span><span class="value">' +
      escHtml(unlockedCount + " / " + Object.keys(Catalog.meridians || {}).length + "개 (보유 경맥 점수 " + detail.jingMaiPoint + ")") + "</span></div>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="습득 무공 목록"><table><caption>습득 무공 목록</caption>' +
      '<thead><tr><th scope="col">무공명</th><th scope="col">분류</th><th scope="col">등급</th><th scope="col">장착</th><th scope="col">관리</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  function renderBagPanel() {
    var root = el("bag-root");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = "";
      return;
    }
    if (session.isConfigSave()) {
      root.innerHTML = "<p>전역 환경·전승 세이브에서는 가방 물품을 편집하지 않습니다.</p>";
      return;
    }
    var q = String(uiState.bagQuery || "").trim().toLowerCase();
    var allItems = session.listBagItems().filter(function (item) {
      if (!q) return true;
      return String(item.name).toLowerCase().indexOf(q) >= 0 || String(item.tableId).indexOf(q) >= 0;
    });
    var shown = allItems.slice(0, 200);
    var rows = shown.map(function (item) {
      var maxVal = item.bucket === 2 ? "1" : "99999999";
      return '<tr><th scope="row" data-label="물품명">' + escHtml(item.name) + "</th>" +
        '<td data-label="분류">' + escHtml(item.bucketName) + "</td>" +
        '<td data-label="수량"><input type="number" min="1" max="' + maxVal + '" data-action="set-bag-count" data-bag-index="' +
        escHtml(String(item.index)) + '" value="' + escHtml(String(item.count)) + '"' + (item.bucket === 2 ? " disabled" : "") + "></td>" +
        '<td data-label="상태">' + (item.flag44 === 0 ? "가방 보관" : "장착 중") + "</td>" +
        '<td data-label="관리"><button type="button" class="btn" data-action="remove-bag-item" data-bag-index="' +
        escHtml(String(item.index)) + '"' + (item.flag44 !== 0 ? " disabled" : "") + ">삭제</button></td></tr>";
    }).join("");
    root.innerHTML = '<div class="field-grid"><div class="field-row"><label for="bag-search-input">가방 물품 검색</label>' +
      '<input id="bag-search-input" type="search" data-action="filter-bag" value="' + escHtml(uiState.bagQuery) + '" placeholder="물품 이름 또는 번호 검색"></div>' +
      '<div class="field-row"><label>물품 추가</label><button type="button" class="btn btn-primary" data-action="open-add-item">가방에 새 물품 추가</button></div></div>' +
      "<p>검색 결과 " + escHtml(String(allItems.length)) + "개" + (allItems.length > 200 ? " (상위 200개 표시)" : "") + "</p>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="가방 물품 목록"><table><caption>가방 물품 목록</caption>' +
      '<thead><tr><th scope="col">물품명</th><th scope="col">분류</th><th scope="col">수량</th><th scope="col">상태</th><th scope="col">관리</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div>";
  }

  function renderCompanionsPanel() {
    var root = el("companions-root");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = "";
      return;
    }
    if (session.isConfigSave()) {
      root.innerHTML = "<p>전역 환경·전승 세이브에서는 동료·문파 정보를 편집하지 않습니다.</p>";
      return;
    }
    var chars = session.listEditableCharacters("").filter(function (c) { return !c.isHero; });
    chars.sort(function (a, b) { return Number(b.isParty) - Number(a.isParty); });
    var shown = chars.slice(0, 100);
    var rows = shown.map(function (c) {
      var group = c.isFightParty ? "출전 동료" : c.isParty ? "파티 동료" : "일반 인물";
      return '<tr><th scope="row" data-label="인물명">' + escHtml(c.name) + "</th>" +
        '<td data-label="소속">' + escHtml(group) + "</td>" +
        '<td data-label="주인공 호감도"><input type="number" min="0" max="100" data-action="set-companion-favor" data-npc-id="' +
        escHtml(String(c.npcId)) + '" value="' + escHtml(String(c.favorWithHero)) + '"></td></tr>';
    }).join("");
    var heroDetail = session.getCharacterDetail(0);
    var honors = heroDetail ? (heroDetail.guildHonors || []) : [];
    var honorHtml = honors.length > 0
      ? '<h3>주인공 문파 공헌도</h3><div class="table-wrapper" tabindex="0" role="region" aria-label="주인공 문파 공헌도"><table><caption>주인공 문파 공헌도</caption>' +
        '<thead><tr><th scope="col">문파명</th><th scope="col">공헌도</th></tr></thead><tbody>' +
        honors.map(function (g) {
          return '<tr><th scope="row" data-label="문파명">' + escHtml(g.name) + "</th>" +
            '<td data-label="공헌도"><input type="number" min="0" max="2147483647" data-action="set-guild-honor" data-guild-id="' +
            escHtml(String(g.guildId)) + '" value="' + escHtml(String(g.honor)) + '"></td></tr>';
        }).join("") + "</tbody></table></div>"
      : "";
    root.innerHTML = "<p>등록 인물 " + escHtml(String(chars.length)) + "명" + (chars.length > 100 ? " (상위 100명 표시)" : "") + "</p>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="동료 호감도 목록"><table><caption>동료 호감도 목록</caption>' +
      '<thead><tr><th scope="col">인물명</th><th scope="col">소속</th><th scope="col">주인공 호감도</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table></div>" + honorHtml;
  }

  function renderWorldPanel() {
    var root = el("world-root");
    if (!root) return;
    if (!session.isLoaded()) {
      root.innerHTML = "";
      return;
    }
    var sum = session.getSummary();
    if (sum.isConfig) {
      var boxes = Object.keys(Catalog.inherits || {}).map(function (id) {
        var checked = sum.inheritIds.indexOf(Number(id)) >= 0 ? " checked" : "";
        return '<div class="field-row"><label><input type="checkbox" data-action="toggle-inherit" data-inherit-id="' +
          escHtml(String(id)) + '"' + checked + "> " + escHtml(Catalog.inherits[id]) + "</label></div>";
      }).join("");
      root.innerHTML = '<div class="field-grid"><div class="field-row"><label for="world-config-score">전승 점수</label>' +
        '<input id="world-config-score" type="number" min="0" max="2147483647" data-action="set-config-score" value="' + escHtml(String(sum.score)) + '"></div>' +
        '<div class="field-row"><label>일괄 해금</label><button type="button" class="btn btn-primary" data-action="unlock-all-inherits">추천 전승 전체 해금</button></div></div>' +
        "<h3>전승 특전 목록</h3><div class=\"field-grid\">" + boxes + "</div>";
      return;
    }
    var mountOpts = Object.keys(Catalog.mounts || {}).map(function (id) {
      var sel = String(sum.selectedMountId) === String(id) ? " selected" : "";
      return '<option value="' + escHtml(String(id)) + '"' + sel + ">" + escHtml(Catalog.mounts[id]) + "</option>";
    }).join("");
    var counts = sum.recipeCounts || {};
    root.innerHTML = '<div class="field-grid"><div class="field-row"><label for="select-mount">장착 탈것</label>' +
      '<select id="select-mount" data-action="set-mount">' + mountOpts + "</select></div>" +
      '<div class="field-row"><label>탈것 해금</label><button type="button" class="btn btn-primary" data-action="unlock-all-mounts">탈것 10종 전체 해금</button></div>' +
      '<div class="field-row"><label>제작 도안 해금</label><button type="button" class="btn" data-action="unlock-all-recipes">연단·요리·단조 도안 전체 해금</button></div></div>' +
      '<div class="card-grid">' +
      '<div class="stat-card"><span class="label">해금된 탈것</span><span class="value">' + escHtml(sum.unlockedMountCount + " / 10종") + "</span></div>" +
      '<div class="stat-card"><span class="label">연단 도안</span><span class="value">' + escHtml((counts.alchemy || 0) + "종") + "</span></div>" +
      '<div class="stat-card"><span class="label">요리 도안</span><span class="value">' + escHtml((counts.cooking || 0) + "종") + "</span></div>" +
      '<div class="stat-card"><span class="label">단조 도안</span><span class="value">' + escHtml((counts.fusion || 0) + "종") + "</span></div></div>";
  }

  function renderCodeAtlasBox() {
    var box = el("editorCodeAtlasBox");
    if (!box) return;
    var atlas = Catalog && (Catalog.codeAtlas || (typeof Catalog.getCodeAtlas === "function" && Catalog.getCodeAtlas()));
    if (!atlas) {
      box.innerHTML = "";
      return;
    }

    var bin = atlas.binary || {};
    var mmc = atlas.gasMmc || {};
    var attrSet = atlas.attributeSet || {};
    var diff = atlas.extraDifficultyBuff || {};
    var sm = atlas.saveManager || {};

    var combatRows = (mmc.combat || []).map(function (m) {
      return '<tr><th scope="row" data-label="클래스"><code>' + escHtml(m.id) + "</code></th>" +
        '<td data-label="분류">' + escHtml(m.category || "전투") + "</td>" +
        '<td data-label="역할">' + escHtml(m.nameKo + " — " + m.note) + "</td></tr>";
    }).join("");
    var lifeRows = (mmc.life || []).map(function (m) {
      return '<tr><th scope="row" data-label="클래스"><code>' + escHtml(m.id) + "</code></th>" +
        '<td data-label="분류">' + escHtml(m.category || "생활") + "</td>" +
        '<td data-label="역할">' + escHtml(m.nameKo + " — " + m.note) + "</td></tr>";
    }).join("");
    var specialRows = (mmc.special || []).map(function (m) {
      return '<tr><th scope="row" data-label="클래스"><code>' + escHtml(m.id) + "</code></th>" +
        '<td data-label="XREF">' + escHtml(m.xref || "-") + "</td>" +
        '<td data-label="역할">' + escHtml(m.nameKo + " — " + m.note) + "</td></tr>";
    }).join("");

    var attrRows = (attrSet.items || []).map(function (a) {
      return '<tr><th scope="row" data-label="속성"><code>' + escHtml(a.name) + "</code></th>" +
        '<td data-label="한국어">' + escHtml(a.nameKo || "-") + "</td>" +
        '<td data-label="XREF">' + escHtml(a.xref || "-") + "</td>" +
        '<td data-label="설명">' + escHtml(a.note || "-") + "</td></tr>";
    }).join("");

    var stageRows = (diff.stages || []).map(function (st) {
      return '<tr><th scope="row" data-label="단계">' + escHtml(String(st.tier)) + "단계</th>" +
        '<td data-label="테이블 행"><code>' + escHtml(st.rowName) + "</code></td>" +
        '<td data-label="적용 대상">' + escHtml(st.scope) + "</td>" +
        '<td data-label="보정 토큰">' + escHtml(st.tokens) + "</td></tr>";
    }).join("");

    var loadedOpaque = session.isLoaded() ? session.getSummary().opaqueProps : null;
    var loadedByName = {};
    if (Array.isArray(loadedOpaque)) {
      loadedOpaque.forEach(function (op) {
        if (op && op.name) loadedByName[op.name] = op;
      });
    }
    var smRows = (sm.OPAQUE_PROPS || []).map(function (op) {
      var live = loadedByName[op.name];
      var liveText = live
        ? (live.present ? (Number(live.byteLength || 0).toLocaleString("ko-KR") + " B (보존)") : "0 B (미포함)")
        : "세이브 로드 대기";
      return '<tr><th scope="row" data-label="속성"><code>' + escHtml(op.name) + "</code></th>" +
        '<td data-label="설명">' + escHtml(op.labelKo) + "</td>" +
        '<td data-label="형식">' + escHtml(op.types) + "</td>" +
        '<td data-label="현재 크기">' + escHtml(liveText) + "</td>" +
        '<td data-label="보존 정책">' + escHtml(op.policy) + "</td></tr>";
    }).join("");

    var enumChips = (diff.EExtraBuffType || []).map(function (t) {
      return '<span class="atlas-chip"><code>' + escHtml(t) + "</code></span>";
    }).join("");
    var tokenChips = (diff.modifierTokens || []).map(function (tok) {
      return '<span class="atlas-chip"><code>' + escHtml(tok) + "</code></span>";
    }).join("");

    box.innerHTML =
      "<h3>REA 역공학 코드·수식 아틀라스</h3>" +
      '<p class="atlas-note">실측 바이너리: <code>' + escHtml(bin.executable || "JH-Win64-Shipping.exe") +
      "</code> · <code>" + escHtml(bin.engine || "UE4.26.2") + "</code> · <code>" +
      escHtml(bin.abilitySystem || "UE4 GAS") + "</code></p>" +
      "<h4>1. UE4 GAS MMC (전투 8종 · 생활 6종 · 특수·퍼센트 5종)</h4>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="UE4 GAS MMC 전투 및 생활 목록">' +
      "<table><caption>전투 MMC 8종 및 생활 MMC 6종</caption>" +
      '<thead><tr><th scope="col">클래스</th><th scope="col">분류</th><th scope="col">역할</th></tr></thead>' +
      "<tbody>" + combatRows + lifeRows + "</tbody></table></div>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="UE4 GAS 특수 및 버프 보정 MMC 목록">' +
      "<table><caption>특수·버프 퍼센트 보정 MMC (XREF 실측)</caption>" +
      '<thead><tr><th scope="col">클래스</th><th scope="col">바이너리 XREF</th><th scope="col">역할</th></tr></thead>' +
      "<tbody>" + specialRows + "</tbody></table></div>" +
      "<h4>2. JHAttributeSet 핵심 전투 속성 (XREF 실측)</h4>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="JHAttributeSet 속성 목록">' +
      "<table><caption>" + escHtml(attrSet.className || "JHAttributeSet") + "</caption>" +
      '<thead><tr><th scope="col">속성</th><th scope="col">한국어</th><th scope="col">XREF</th><th scope="col">설명</th></tr></thead>' +
      "<tbody>" + attrRows + "</tbody></table></div>" +
      "<h4>3. 고난도 추가 버프 (ExtraDifficultyBuff 1~10단계)</h4>" +
      '<p class="atlas-note">열거형 <code>' + escHtml(diff.enumType || "EExtraBuffType") +
      "</code> · 필드: <code>" + escHtml((diff.fields || []).join(", ")) + "</code></p>" +
      '<div class="atlas-chip-row">' + enumChips + tokenChips + "</div>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="ExtraDifficultyBuff 1~10단계 구조">' +
      "<table><caption>ExtraDifficultyBuff 1~10단계</caption>" +
      '<thead><tr><th scope="col">단계</th><th scope="col">행</th><th scope="col">대상 유형</th><th scope="col">보정 토큰</th></tr></thead>' +
      "<tbody>" + stageRows + "</tbody></table></div>" +
      "<h4>4. SaveManager GVAS OPAQUE_PROPS 무손실 보존 구조</h4>" +
      '<p class="atlas-note"><code>' + escHtml(sm.source || "SaveManager.cpp / UE4 GVAS") + "</code> · 클래스: <code>" +
      escHtml((sm.classes || []).join(", ")) + "</code> · " + escHtml(sm.compression || "") + "</p>" +
      '<div class="table-wrapper" tabindex="0" role="region" aria-label="SaveManager OPAQUE_PROPS 보존 구조">' +
      "<table><caption>SaveManager OPAQUE_PROPS 보존 대상 4종</caption>" +
      '<thead><tr><th scope="col">속성</th><th scope="col">설명</th><th scope="col">형식</th><th scope="col">현재 세이브 크기</th><th scope="col">보존 정책</th></tr></thead>' +
      "<tbody>" + smRows + "</tbody></table></div>";
  }

  function renderAll() {
    renderPresetBar();
    renderOverviewPanel();
    renderCodeAtlasBox();
    renderStatsPanel();
    renderMartialPanel();
    renderBagPanel();
    renderCompanionsPanel();
    renderWorldPanel();
    syncTopBadges();
  }

  function bindRootEvents() {
    var browserOpen = el("btn-browser-open");
    var fileInput = el("file-input");
    var loadDemo = el("btn-load-demo");
    var browserDownload = el("btn-browser-download");
    var loopbackOpen = el("btn-loopback-open");
    var loopbackSave = el("btn-loopback-save");
    var nativeOpenBtn = el("btn-native-open");
    var nativeSaveBtn = el("btn-native-save");
    var nativeSaveCopyBtn = el("btn-native-save-copy");

    if (browserOpen && fileInput) {
      browserOpen.addEventListener("click", function () { fileInput.click(); });
    }
    if (fileInput) {
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        if (file) openBrowserFile(file);
        fileInput.value = "";
      });
    }
    if (loadDemo) loadDemo.addEventListener("click", loadDemoSave);
    if (browserDownload) browserDownload.addEventListener("click", downloadModifiedSave);
    if (loopbackOpen) loopbackOpen.addEventListener("click", openLoopbackSelected);
    if (loopbackSave) loopbackSave.addEventListener("click", saveLoopbackCurrent);
    if (nativeOpenBtn) nativeOpenBtn.addEventListener("click", nativeOpen);
    if (nativeSaveBtn) nativeSaveBtn.addEventListener("click", nativeSave);
    if (nativeSaveCopyBtn) nativeSaveCopyBtn.addEventListener("click", nativeSaveCopy);

    document.addEventListener("click", function (ev) {
      var target = ev.target.closest("[data-action]");
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (action === "apply-preset") {
        var presetId = target.getAttribute("data-preset-id");
        confirmModal("빠른 프리셋 적용", "선택한 프리셋을 현재 세이브에 적용할까요?").then(function (ok) {
          if (ok && session.applyPreset(presetId)) {
            renderAll();
            setStatus("빠른 프리셋을 적용했습니다.", false);
          }
        });
      } else if (action === "reset-pill-limits") {
        confirmModal("복용 제한 초기화", "모든 인물의 영단·음식 복용 횟수 제한 기록을 초기화할까요?").then(function (ok) {
          if (ok && session.resetPillLimits()) {
            renderAll();
            setStatus("복용 횟수 제한 기록을 초기화했습니다.", false);
          }
        });
      } else if (action === "open-add-skill") {
        openPickerModal("skill").then(function (res) {
          if (res && res.id != null) {
            if (session.addSkill(uiState.selectedNpcId, res.id, res.count)) {
              renderAll();
              setStatus("선택한 무공을 습득 목록에 추가했습니다.", false);
            } else {
              setStatus("이미 습득한 무공이거나 추가할 수 없는 항목입니다.", true);
            }
          }
        });
      } else if (action === "remove-skill") {
        if (session.removeSkill(uiState.selectedNpcId, Number(target.getAttribute("data-skill-id")))) {
          renderAll();
          setStatus("습득 무공을 제거했습니다.", false);
        }
      } else if (action === "unlock-meridians") {
        if (session.unlockAllMeridians(uiState.selectedNpcId)) {
          renderAll();
          setStatus("경맥·혈도를 모두 개통하고 경맥 점수를 부여했습니다.", false);
        }
      } else if (action === "open-add-item") {
        openPickerModal("item").then(function (res) {
          if (res && res.id != null) {
            if (session.addBagItem(res.id, res.count)) {
              renderAll();
              setStatus("가방에 물품을 추가했습니다.", false);
            }
          }
        });
      } else if (action === "remove-bag-item") {
        if (session.removeBagItem(Number(target.getAttribute("data-bag-index")))) {
          renderAll();
          setStatus("가방에서 물품을 삭제했습니다.", false);
        }
      } else if (action === "unlock-all-mounts") {
        session.unlockAllMounts();
        renderAll();
        setStatus("탈것 10종을 모두 해금했습니다.", false);
      } else if (action === "unlock-all-recipes") {
        session.unlockAllRecipes();
        renderAll();
        setStatus("연단·요리·단조 도안을 모두 해금했습니다.", false);
      } else if (action === "unlock-all-inherits") {
        session.unlockAllInherits();
        renderAll();
        setStatus("추천 전승 특전을 모두 해금했습니다.", false);
      }
    });

    document.addEventListener("input", function (ev) {
      var target = ev.target.closest('[data-action="filter-bag"]');
      if (!target) return;
      uiState.bagQuery = target.value;
      var pos = target.selectionStart;
      renderBagPanel();
      var next = document.querySelector('[data-action="filter-bag"]');
      if (next) {
        next.focus();
        if (pos != null) next.setSelectionRange(pos, pos);
      }
    });

    document.addEventListener("change", function (ev) {
      var target = ev.target.closest("[data-action]");
      if (!target) return;
      var action = target.getAttribute("data-action");
      var changed = true;
      if (action === "select-npc") {
        uiState.selectedNpcId = Number(target.value) || 0;
        renderStatsPanel();
        renderMartialPanel();
        return;
      } else if (action === "filter-attr-group") {
        uiState.attrGroupFilter = target.value;
        renderStatsPanel();
        return;
      } else if (action === "set-money") {
        session.setMoney(Number(target.value));
      } else if (action === "set-turn-mode") {
        session.setTurnMode(target.value);
      } else if (action === "set-config-score") {
        session.setConfigScore(Number(target.value));
      } else if (action === "set-resource") {
        var field = target.getAttribute("data-field");
        var obj = {};
        obj[field] = Number(target.value);
        session.setNpcResources(uiState.selectedNpcId, obj);
      } else if (action === "set-attr") {
        session.setNpcAttr(uiState.selectedNpcId, Number(target.getAttribute("data-attr-id")), Number(target.value));
      } else if (action === "set-skill-level") {
        session.setSkillLevel(uiState.selectedNpcId, Number(target.getAttribute("data-skill-id")), Number(target.value));
      } else if (action === "set-bag-count") {
        session.setBagItemCount(Number(target.getAttribute("data-bag-index")), Number(target.value));
      } else if (action === "set-companion-favor") {
        session.setCompanionFavor(Number(target.getAttribute("data-npc-id")), Number(target.value));
      } else if (action === "set-guild-honor") {
        session.setGuildHonor(0, Number(target.getAttribute("data-guild-id")), Number(target.value));
      } else if (action === "set-mount") {
        session.setSelectedMount(Number(target.value));
        renderWorldPanel();
      } else if (action === "toggle-inherit") {
        session.toggleInherit(Number(target.getAttribute("data-inherit-id")), !!target.checked);
      } else {
        changed = false;
      }
      if (changed) {
        renderOverviewPanel();
        syncTopBadges();
      }
    });
  }

  window.hasUnsavedChanges = function () {
    return !!(session.isLoaded() && session.isDirty());
  };

  window.addEventListener("beforeunload", function (ev) {
    if (!window.hasUnsavedChanges()) return;
    ev.preventDefault();
    ev.returnValue = "저장하지 않은 변경 사항이 있습니다.";
    return ev.returnValue;
  });

  window.WanderingSwordEditorUI = {
    isBusy: function () { return uiState.busy; },
    getNativeSession: function () { return uiState.nativeSession; },
    getSession: function () { return session; },
    renderAll: function () { renderAll(); },
    applyPresetDirect: function (id) {
      if (session.applyPreset(id)) {
        renderAll();
        setStatus("빠른 프리셋을 적용했습니다.", false);
        return true;
      }
      return false;
    },
    exportBase64: function () {
      return exportSessionBytes().then(uint8ToBase64);
    }
  };

  function boot() {
    initThemeToggle();
    initTabs();
    ensureDialogInfrastructure();
    bindRootEvents();
    renderAll();
    initNativeBridge();
    if (!uiState.nativeAvailable) probeLoopback();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
