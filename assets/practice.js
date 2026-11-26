/* =========================================================
   Hello Sekai · 在线判题
   浏览器内运行用户代码，多组测试点比对，进度存本地
   ========================================================= */
(function () {
  "use strict";

  var DATA = window.PRACTICE || { exercises: [], counts: {} };
  var EX = DATA.exercises || [];
  var BY_ID = {};
  EX.forEach(function (e) {
    BY_ID[e.id] = e;
  });

  var body = document.body;
  var root = body.getAttribute("data-root") || "";
  var PASS_KEY = "slc-passed";
  var CODE_KEY = "slc-code-";

  var listEl = document.getElementById("practice-list");
  var detailEl = document.getElementById("practice-detail");
  var filterGroup = document.getElementById("practice-filters");
  var searchInput = document.getElementById("practice-search");
  var doneEl = document.getElementById("ps-done");
  var totalEl = document.getElementById("ps-total");

  if (!listEl || !detailEl) return;

  var passed = readJSON(PASS_KEY, []);
  if (!Array.isArray(passed)) passed = [];
  var current = null;
  var activeLang = "all";
  var query = "";

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function isPassed(id) {
    return passed.indexOf(id) >= 0;
  }
  function markPassed(id, on) {
    var next = passed.filter(function (x) {
      return x !== id;
    });
    if (on) next.push(id);
    passed = next;
    writeJSON(PASS_KEY, passed);
    paintStats();
  }
  function paintStats() {
    if (doneEl) doneEl.textContent = String(passed.length);
    if (totalEl) totalEl.textContent = String(EX.length);
    Array.prototype.forEach.call(listEl.querySelectorAll(".ex-card"), function (card) {
      card.classList.toggle("is-passed", isPassed(card.getAttribute("data-id")));
    });
  }

  var LEVEL_NAME = { 1: "入门", 2: "基础", 3: "进阶", 4: "挑战" };
  var LANG_NAME = { c: "C", cpp: "C++", python: "Python" };
  var LANG_FILE = { c: "main.c", cpp: "main.cpp", python: "main.py" };

  /* ---------------- 过滤 ---------------- */
  function applyFilter() {
    var cards = listEl.querySelectorAll(".ex-card");
    var shown = 0;
    Array.prototype.forEach.call(cards, function (card) {
      var langOk = activeLang === "all" || card.getAttribute("data-lang") === activeLang;
      var hay = (card.getAttribute("data-title") || "") + " " + (card.getAttribute("data-tags") || "");
      var qOk = !query || hay.indexOf(query) >= 0;
      var ok = langOk && qOk;
      card.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    var empty = listEl.querySelector(".practice-empty");
    if (empty) empty.style.display = shown ? "none" : "block";
  }

  if (filterGroup) {
    filterGroup.addEventListener("click", function (e) {
      var btn = e.target.closest(".pill");
      if (!btn) return;
      activeLang = btn.getAttribute("data-lang");
      Array.prototype.forEach.call(filterGroup.querySelectorAll(".pill"), function (p) {
        p.classList.toggle("is-active", p === btn);
      });
      applyFilter();
    });
  }
  if (searchInput) {
    searchInput.addEventListener("input", function () {
      query = searchInput.value.trim().toLowerCase();
      applyFilter();
    });
  }

  /* ---------------- 详情 ---------------- */
  function renderDetail(ex) {
    current = ex;
    var lang = ex.lang || "c";
    var cases = ex.cases || [];
    var sample = cases[0] || { in: "", out: "" };
    var saved = readJSON(CODE_KEY + ex.id, null);

    detailEl.innerHTML =
      '<div class="pd-head">' +
      '<span class="pd-badge ex-lang-' + lang + '">' + (LANG_NAME[lang] || "C") + "</span>" +
      "<h2>" + esc(ex.title) + "</h2>" +
      '<span class="ex-level">' + (LEVEL_NAME[ex.level] || "") + " " +
      new Array((ex.level || 1) + 1).join("★") + "</span>" +
      "</div>" +
      '<p class="pd-desc">' + esc(ex.desc) + "</p>" +
      '<div class="pd-io">' +
      "<div><h4>输入格式</h4><pre>" + esc(ex.input_note) + "</pre></div>" +
      "<div><h4>输出格式</h4><pre>" + esc(ex.output_note) + "</pre></div>" +
      "<div><h4>输入样例</h4><pre>" + esc(sample["in"]) + "</pre></div>" +
      "<div><h4>输出样例</h4><pre>" + esc(sample["out"]) + "</pre></div>" +
      "</div>" +
      '<div class="pd-note">共 <b>' + cases.length + "</b> 组测试数据，全部通过才算过。" +
      (ex.chapter ? ' 相关教程：<b><a href="' + root + esc(ex.chapter) + '">点这里复习</a></b>' : "") +
      "</div>" +
      '<div class="pd-editor">' +
      '<div class="pd-editor-head"><span class="pd-file">' + (LANG_FILE[lang] || "main.c") + "</span>" +
      '<div class="pd-editor-btns">' +
      '<button class="pd-btn" id="pd-upload" type="button">上传文件</button>' +
      '<button class="pd-btn" id="pd-reset" type="button">重置模板</button>' +
      '<button class="pd-btn" id="pd-solution" type="button">参考答案</button>' +
      "</div></div>" +
      '<div class="editor-body">' +
      '<div class="ed-gutter" id="ed-gutter"></div>' +
      '<textarea class="ed-code" id="ed-code" spellcheck="false" autocomplete="off"></textarea>' +
      "</div></div>" +
      '<div class="pd-actions">' +
      '<button class="pd-run" id="pd-run" type="button">运行判题</button>' +
      '<span class="pd-status" id="pd-status">Ctrl + Enter 也可以运行</span>' +
      "</div>" +
      '<div class="pd-result" id="pd-result"></div>' +
      '<div class="pd-hint"><b>提示：</b>' + esc(ex.hint) + "</div>" +
      '<div class="pd-solution" id="pd-solution-box" hidden></div>' +
      '<input type="file" id="pd-file" accept=".c,.cpp,.cc,.py,.txt" hidden>';

    var ta = document.getElementById("ed-code");
    ta.value = saved != null ? saved : ex.starter || "";
    updateGutter(ta);
    ta.addEventListener("input", function () {
      updateGutter(ta);
      writeJSON(CODE_KEY + ex.id, ta.value);
      setStatus("代码已自动保存到本地");
    });
    ta.addEventListener("scroll", syncGutter);
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        insertText(ta, "    ");
      } else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        runJudge();
      }
    });

    document.getElementById("pd-reset").addEventListener("click", function () {
      ta.value = ex.starter || "";
      updateGutter(ta);
      writeJSON(CODE_KEY + ex.id, ta.value);
      setStatus("已重置为初始模板");
    });
    document.getElementById("pd-upload").addEventListener("click", function () {
      document.getElementById("pd-file").click();
    });
    document.getElementById("pd-file").addEventListener("change", function (ev) {
      var file = ev.target.files && ev.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        ta.value = String(reader.result || "");
        updateGutter(ta);
        writeJSON(CODE_KEY + ex.id, ta.value);
        setStatus("已载入 " + file.name);
      };
      reader.readAsText(file);
      ev.target.value = "";
    });
    document.getElementById("pd-solution").addEventListener("click", function () {
      var box = document.getElementById("pd-solution-box");
      if (!box.hidden) {
        box.hidden = true;
        this.textContent = "参考答案";
        return;
      }
      box.innerHTML = "<h4>参考答案（先自己写，卡住了再看）</h4><pre>" +
        esc(ex.solution || "") + "</pre>";
      box.hidden = false;
      this.textContent = "收起答案";
    });
    document.getElementById("pd-run").addEventListener("click", runJudge);

    /* 高亮当前题 */
    Array.prototype.forEach.call(listEl.querySelectorAll(".ex-card"), function (c) {
      c.classList.toggle("is-open", c.getAttribute("data-id") === ex.id);
    });

    if (window.innerWidth <= 1023) {
      detailEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function setStatus(text) {
    var el = document.getElementById("pd-status");
    if (el) el.textContent = text;
  }

  function updateGutter(ta) {
    var gutter = document.getElementById("ed-gutter");
    if (!gutter) return;
    var lines = ta.value.split("\n").length;
    var out = [];
    for (var i = 1; i <= lines; i++) out.push(i);
    gutter.innerHTML = out.join("<br>");
    syncGutter();
  }
  function syncGutter() {
    var ta = document.getElementById("ed-code");
    var gutter = document.getElementById("ed-gutter");
    if (ta && gutter) gutter.scrollTop = ta.scrollTop;
  }
  function insertText(ta, text) {
    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + text.length;
    updateGutter(ta);
    if (current) writeJSON(CODE_KEY + current.id, ta.value);
  }

  /* ---------------- 判题 ---------------- */
  function normalize(s) {
    return String(s == null ? "" : s)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map(function (line) {
        return line.replace(/[ \t]+$/, "");
      })
      .join("\n")
      .replace(/\n+$/, "");
  }

  function runnerFor(lang) {
    if (lang === "python") return window.runPy;
    return window.runC;
  }

  function runJudge() {
    if (!current) return;
    var lang = current.lang || "c";
    var runner = runnerFor(lang);
    var resultBox = document.getElementById("pd-result");
    var btn = document.getElementById("pd-run");
    var code = document.getElementById("ed-code").value;

    if (typeof runner !== "function") {
      resultBox.innerHTML =
        '<div class="pd-summary is-bad">判题引擎没有加载成功，刷新页面再试一次。</div>';
      return;
    }

    btn.disabled = true;
    setStatus("正在运行…");
    resultBox.innerHTML = "";

    var cases = current.cases || [];
    var rows = [];
    var allOk = true;

    // 用 setTimeout 让按钮状态先渲染，再跑同步解释器
    setTimeout(function () {
      for (var i = 0; i < cases.length; i++) {
        var c = cases[i];
        var res;
        try {
          res = runner(code, c["in"] || "");
        } catch (err) {
          res = { ok: false, out: "", err: "内部错误：" + (err && err.message) };
        }
        var expect = normalize(c.out);
        var actual = normalize(res.out);
        var ok = !!res.ok && actual === expect;
        if (!ok) allOk = false;
        rows.push(renderCase(i, c, res, expect, actual, ok));
      }

      var summary = allOk
        ? '<div class="pd-summary is-ok">全部 ' + cases.length + " 组测试通过，这题你过了。</div>"
        : '<div class="pd-summary is-bad">还没通过，看看下面的差异。</div>';
      resultBox.innerHTML = summary + rows.join("");
      setStatus(allOk ? "通过" : "未通过");
      btn.disabled = false;

      if (allOk) {
        markPassed(current.id, true);
        if (doneEl) doneEl.textContent = String(passed.length);
      }
    }, 30);
  }

  function renderCase(idx, c, res, expect, actual, ok) {
    var head =
      '<div class="case-head">' +
      (ok ? "✓" : "✕") + " 测试点 " + (idx + 1) +
      (ok ? " 通过" : res.ok ? " 输出不一致" : " 运行出错") +
      "</div>";
    var body;
    if (!res.ok) {
      body = '<div class="case-err">' + esc(res.err || "未知错误") + "</div>";
    } else if (ok) {
      body = "";
    } else {
      body =
        '<div class="case-body">' +
        "<div><h5>期望输出</h5><pre>" + esc(expect || "(空)") + "</pre></div>" +
        "<div><h5>你的输出</h5><pre>" + esc(actual || "(空)") + "</pre></div>" +
        "</div>";
    }
    var sample =
      ok
        ? ""
        : '<div class="case-body"><div><h5>该组输入</h5><pre>' +
          esc(c["in"] || "(空)") +
          "</pre></div><div><h5>提示</h5><pre>" +
          esc(res.ok ? diffHint(expect, actual) : "检查语法、变量名和分号") +
          "</pre></div></div>";
    return '<div class="case-row ' + (ok ? "is-ok" : "is-bad") + '">' + head + body + sample + "</div>";
  }

  function diffHint(expect, actual) {
    var a = expect.split("\n");
    var b = actual.split("\n");
    if (a.length !== b.length) {
      return "行数不同：期望 " + a.length + " 行，你输出了 " + b.length + " 行";
    }
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return "第 " + (i + 1) + " 行不一致：期望「" + a[i] + "」，你输出「" + b[i] + "」";
      }
    }
    return "末尾可能有多的空行或空格";
  }

  /* ---------------- 打开 / 路由 ---------------- */
  function openId(id) {
    var ex = BY_ID[id];
    if (!ex) return;
    renderDetail(ex);
  }

  listEl.addEventListener("click", function (e) {
    var card = e.target.closest(".ex-card");
    if (!card) return;
    e.preventDefault();
    var id = card.getAttribute("data-id");
    if (history.replaceState) history.replaceState(null, "", "#" + id);
    openId(id);
  });

  function fromHash() {
    var id = (location.hash || "").replace("#", "");
    if (id && BY_ID[id]) openId(id);
  }
  window.addEventListener("hashchange", fromHash);

  paintStats();
  applyFilter();
  fromHash();
})();
