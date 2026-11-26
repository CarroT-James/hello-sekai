/* =========================================================
   三行代码 · 前端交互
   主题切换 / 站内搜索 / 学习进度 / 目录联动 / 代码复制
   无任何第三方依赖，全部在本地运行
   ========================================================= */
(function () {
  "use strict";

  var body = document.body;
  var root = body.getAttribute("data-root") || "";
  var DATA = window.SLC || { pages: [], tracks: {} };
  var PAGES = DATA.pages || [];
  var THEME_KEY = "slc-theme";
  var PROG_KEY = "slc-progress";

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 隐私模式或 file:// 受限时静默降级 */
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- 主题 ---------------- */
  var themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var isDark = document.documentElement.getAttribute("data-theme") === "dark";
      var next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch (e) {}
    });
  }

  /* ---------------- 彩蛋：首页点品牌播放「ハローセカイ」 ---------------- */
  var brand = document.querySelector(".brand");
  if (brand && body.classList.contains("is-home")) {
    var eggAudio = null;
    var eggPlaying = false;
    brand.title = "点一下试试（再点一次停止）";
    brand.addEventListener("click", function (e) {
      e.preventDefault();
      if (!eggAudio) {
        eggAudio = new Audio(root + "assets/hello-sekai.ogg");
        eggAudio.preload = "auto";
        eggAudio.volume = 0.55;
        eggAudio.addEventListener("ended", function () {
          eggPlaying = false;
          brand.classList.remove("is-playing");
        });
      }
      if (eggPlaying) {
        eggAudio.pause();
        eggAudio.currentTime = 0;
        eggPlaying = false;
        brand.classList.remove("is-playing");
        return;
      }
      var p = eggAudio.play();
      if (p && typeof p.catch === "function") {
        p.catch(function () {
          brand.classList.add("is-blocked");
          setTimeout(function () {
            brand.classList.remove("is-blocked");
          }, 1800);
        });
      }
      eggPlaying = true;
      brand.classList.add("is-playing");
    });
  }

  /* ---------------- 壁纸视差（只在有背景的页面） ---------------- */
  var bgImg = document.getElementById("page-bg-img");
  if (bgImg && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      && window.matchMedia("(hover: hover)").matches) {
    var bgRaf = null;
    window.addEventListener("mousemove", function (e) {
      if (bgRaf) return;
      bgRaf = window.requestAnimationFrame(function () {
        var x = (e.clientX / window.innerWidth - 0.5) * 16;
        var y = (e.clientY / window.innerHeight - 0.5) * 12;
        bgImg.style.transform =
          "translate3d(" + x.toFixed(2) + "px," + y.toFixed(2) + "px,0)";
        bgRaf = null;
      });
    }, { passive: true });
  }

  /* ---------------- 背景版本切换（截图版 / 房间版） ---------------- */
  var bgSwitch = document.getElementById("bg-switch");
  if (bgSwitch) {
    var paintBgLabel = function (mode) {
      bgSwitch.title = mode === "room" ? "当前：房间版（点一下换截图版）" : "当前：截图版（点一下换房间版）";
      bgSwitch.setAttribute("aria-label", bgSwitch.title);
    };
    paintBgLabel(document.documentElement.getAttribute("data-bg") || "shot");
    bgSwitch.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-bg") === "room" ? "shot" : "room";
      document.documentElement.setAttribute("data-bg", cur);
      try {
        localStorage.setItem("slc-bg", cur);
      } catch (e) {}
      paintBgLabel(cur);
    });
  }

  /* ---------------- 移动端导航 ---------------- */
  var navToggle = document.getElementById("nav-toggle");
  var navLinks = document.getElementById("nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", function () {
      navLinks.classList.toggle("is-open");
    });
  }

  /* ---------------- 移动端章节目录抽屉 ---------------- */
  var tocFab = document.getElementById("toc-fab");
  var sidebar = document.getElementById("sidebar");
  if (tocFab && sidebar) {
    tocFab.addEventListener("click", function () {
      sidebar.classList.toggle("mobile-open");
    });
    sidebar.addEventListener("click", function (e) {
      if (e.target.closest("a")) sidebar.classList.remove("mobile-open");
    });
  }

  /* ---------------- 代码复制 ---------------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        resolve();
      } catch (err) {
        reject(err);
      }
      document.body.removeChild(ta);
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".code-copy"), function (btn) {
    btn.addEventListener("click", function () {
      var block = btn.closest(".code-block");
      var code = block && block.querySelector("code");
      if (!code) return;
      copyText(code.textContent).then(
        function () {
          btn.textContent = "已复制";
          btn.classList.add("is-copied");
          setTimeout(function () {
            btn.textContent = "复制";
            btn.classList.remove("is-copied");
          }, 1600);
        },
        function () {
          btn.textContent = "复制失败";
          setTimeout(function () {
            btn.textContent = "复制";
          }, 1600);
        }
      );
    });
  });

  /* ---------------- 学习进度 ---------------- */
  var done = readJSON(PROG_KEY, []);
  if (!Array.isArray(done)) done = [];

  function isDone(id) {
    return done.indexOf(id) >= 0;
  }

  function markDone(id, on) {
    var next = done.filter(function (x) {
      return x !== id;
    });
    if (on) next.push(id);
    done = next;
    writeJSON(PROG_KEY, done);
  }

  function paintProgress() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-id]"), function (el) {
      el.classList.toggle("is-done", isDone(el.getAttribute("data-id")));
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-scope]"), function (el) {
      var scope = el.getAttribute("data-scope");
      var list = PAGES.filter(function (p) {
        return (p.sc || []).indexOf(scope) >= 0;
      });
      if (!list.length) return;
      var n = list.filter(function (p) {
        return isDone(p.id);
      }).length;
      var bar = el.querySelector(".tp-bar i");
      if (bar) bar.style.width = Math.round((n / list.length) * 100) + "%";
      var txt = el.querySelector(".tp-text");
      if (txt) txt.textContent = n + " / " + list.length + " 已学完";
    });

    var btn = document.getElementById("done-btn");
    if (btn) {
      var on = isDone(btn.getAttribute("data-id"));
      btn.classList.toggle("is-done", on);
      var label = btn.querySelector(".done-label");
      if (label) label.textContent = on ? "已学完（点击取消）" : "标记为已学完";
    }
  }

  var doneBtn = document.getElementById("done-btn");
  if (doneBtn) {
    doneBtn.addEventListener("click", function () {
      var id = doneBtn.getAttribute("data-id");
      markDone(id, !isDone(id));
      paintProgress();
    });
  }

  paintProgress();

  /* ---------------- 站内搜索 ---------------- */
  var modal = document.getElementById("search-modal");
  var input = document.getElementById("search-input");
  var resultsBox = document.getElementById("search-results");
  var countEl = document.getElementById("search-count");
  var activeIdx = -1;
  var shown = [];

  function highlight(text, terms) {
    var safe = esc(text);
    terms.forEach(function (t) {
      if (!t) return;
      var re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      safe = safe.replace(re, function (m) {
        return "<mark>" + m + "</mark>";
      });
    });
    return safe;
  }

  function search(query) {
    var q = query.trim().toLowerCase();
    if (!q) return [];
    var terms = q.split(/\s+/).filter(Boolean);
    var scored = [];

    PAGES.forEach(function (p) {
      var title = (p.t || "").toLowerCase();
      var kw = (p.k || "").toLowerCase();
      var sum = (p.s || "").toLowerCase();
      var score = 0;
      var ok = true;

      terms.forEach(function (t) {
        var s = 0;
        if (title === t) s = 200;
        else if (title.indexOf(t) === 0) s = 150;
        else if (title.indexOf(t) >= 0) s = 110;
        else if (kw.indexOf(t) >= 0) s = 45;
        else if (sum.indexOf(t) >= 0) s = 25;
        if (!s) ok = false;
        score += s;
      });

      if (ok) scored.push({ p: p, score: score });
    });

    scored.sort(function (a, b) {
      return b.score - a.score;
    });
    return scored.slice(0, 14).map(function (x) {
      return x.p;
    });
  }

  function renderResults(query) {
    var terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = search(query);
    activeIdx = shown.length ? 0 : -1;

    if (!query.trim()) {
      resultsBox.innerHTML =
        '<div class="search-empty">输入关键词开始搜索，例如「指针」「scanf」「vector」</div>';
      if (countEl) countEl.textContent = "0";
      return;
    }

    if (!shown.length) {
      resultsBox.innerHTML = '<div class="search-empty">没有找到相关章节，换个词试试？</div>';
      if (countEl) countEl.textContent = "0";
      return;
    }

    resultsBox.innerHTML = shown
      .map(function (p, i) {
        return (
          '<a class="search-item' +
          (i === activeIdx ? " is-active" : "") +
          '" href="' +
          esc(root + p.u) +
          '">' +
          '<div class="si-top"><span class="si-track">' +
          esc(p.vol || p.tr) +
          '</span><span class="si-title">' +
          highlight(p.t, terms) +
          "</span></div>" +
          '<div class="si-sum">' +
          highlight(p.s || "", terms) +
          "</div></a>"
        );
      })
      .join("");

    if (countEl) countEl.textContent = String(shown.length);
  }

  function setActive(idx) {
    var items = resultsBox.querySelectorAll(".search-item");
    if (!items.length) return;
    activeIdx = (idx + items.length) % items.length;
    Array.prototype.forEach.call(items, function (el, i) {
      el.classList.toggle("is-active", i === activeIdx);
    });
    var cur = items[activeIdx];
    if (cur) cur.scrollIntoView({ block: "nearest" });
  }

  function openSearch() {
    if (!modal) return;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    input.value = "";
    renderResults("");
    setTimeout(function () {
      input.focus();
    }, 20);
  }

  function closeSearch() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
  }

  var openBtn = document.getElementById("search-open");
  if (openBtn) openBtn.addEventListener("click", openSearch);

  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-close")) closeSearch();
    });

    input.addEventListener("input", function () {
      renderResults(input.value);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive(activeIdx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(activeIdx - 1);
      } else if (e.key === "Enter") {
        var target = shown[activeIdx >= 0 ? activeIdx : 0];
        if (target) window.location.href = root + target.u;
      }
    });
  }

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (modal && modal.hidden) openSearch();
      else closeSearch();
      return;
    }
    if (e.key === "Escape" && modal && !modal.hidden) closeSearch();
  });

  /* ---------------- 滚动相关 ---------------- */
  var readBar = document.getElementById("read-bar");
  var backTop = document.getElementById("back-top");
  var isDoc = !!body.getAttribute("data-page");

  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc-link"));
  var headings = tocLinks
    .map(function (link) {
      var id = (link.getAttribute("href") || "").replace("#", "");
      var el = id ? document.getElementById(id) : null;
      return el ? { link: link, el: el } : null;
    })
    .filter(Boolean);

  function onScroll() {
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    var max = document.documentElement.scrollHeight - window.innerHeight;

    if (readBar) {
      var pct = isDoc && max > 0 ? Math.min(100, (y / max) * 100) : 0;
      readBar.style.width = pct + "%";
    }

    if (backTop) {
      backTop.classList.toggle("is-visible", y > 640);
    }

    if (headings.length) {
      var line = y + 130;
      var current = null;
      headings.forEach(function (h) {
        var top = h.el.getBoundingClientRect().top + y;
        if (top <= line) current = h;
      });
      headings.forEach(function (h) {
        h.link.classList.toggle("is-active", current ? h.link === current.link : false);
      });
    }
  }

  var ticking = false;
  window.addEventListener(
    "scroll",
    function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(function () {
        onScroll();
        ticking = false;
      });
    },
    { passive: true }
  );
  window.addEventListener("resize", onScroll);
  onScroll();

  if (backTop) {
    backTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  /* ---------------- 章节锚点复制链接 ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll(".prose h2[id], .prose h3[id]"), function (h) {
    var a = h.querySelector(".anchor");
    if (!a) return;
    a.addEventListener("click", function (e) {
      e.preventDefault();
      var url = window.location.href.split("#")[0] + "#" + h.id;
      copyText(url);
      a.textContent = "已复制";
      setTimeout(function () {
        a.textContent = "#";
      }, 1400);
    });
  });
})();
