/* =========================================================
   迷你 C / C++ 解释器（纯静态站判题用）
   提供同步 API：runC(code, stdin) => { ok, out, err, warnings }
   支持 C 语言基础语法与过程式 C++（cout / cin / bool）。
   词法 → 递归下降 + 优先级解析 → 树遍历解释执行。
   无任何依赖，浏览器 / Node 均可运行。
   ========================================================= */
(function () {
  "use strict";

  var MAX_STEPS = 2000000;   // 步数上限
  var MAX_OUTPUT = 65536;    // 输出字符上限
  var MAX_DEPTH = 10000;     // 递归深度上限
  var MAX_ARRAY = 1000000;   // 单个数组元素总数上限（防止页面卡死）
  /* ---------------- 错误对象 ---------------- */
  function CRunError(line, msg, raw) { this.line = line || 0;
    this.msg = msg || "运行错误"; this.raw = !!raw;
  }
  function err(line, msg) { return new CRunError(line, msg, false); }
  function rawErr(msg) { return new CRunError(0, msg, true); }
  /* =========================================================
     一、预处理
     - 去掉 // 与块注释，保留换行（保证行号不变）
     - #include 忽略；#define NAME 值 做简单文本替换
     ========================================================= */
  function stripComments(src) { var out = [], i = 0, n = src.length, st = 0;
    while (i < n) { var c = src.charAt(i), d = src.charAt(i + 1);
      if (st === 0) {
        if (c === "/" && d === "/") { st = 1; i += 2; out.push(" "); }
        else if (c === "/" && d === "*") { st = 2; i += 2; out.push(" "); }
        else if (c === '"') { st = 3; out.push(c); i++; }
        else if (c === "'") { st = 4; out.push(c); i++; }
        else { out.push(c); i++; }
      } else if (st === 1) {
        if (c === "\n") { st = 0; out.push("\n"); }
        i++;
      } else if (st === 2) {
        if (c === "*" && d === "/") { st = 0; i += 2; }
        else { if (c === "\n") out.push("\n"); i++; }
      } else if (st === 3) { out.push(c); i++;
        if (c === "\\" && i < n) { out.push(src.charAt(i)); i++; }
        else if (c === '"') st = 0;
      } else { out.push(c); i++;
        if (c === "\\" && i < n) { out.push(src.charAt(i)); i++; }
        else if (c === "'") st = 0;
      }
    }
    return out.join("");
  }
  // 在字符串 / 字符常量之外做宏名替换
  function expandMacros(line, macros, depth) { if (!line || !/\S/.test(line)) return line;
    if (depth > 20) return line; var out = "", i = 0, n = line.length, st = 0; while (i < n) { var c = line.charAt(i);
      if (st === 0) {
        if (c === '"') { st = 1; out += c; i++; }
        else if (c === "'") { st = 2; out += c; i++; }
        else if (/[A-Za-z_]/.test(c)) { var j = i + 1;
          while (j < n && /[A-Za-z0-9_]/.test(line.charAt(j))) j++; var w = line.slice(i, j);
          if (Object.prototype.hasOwnProperty.call(macros, w)) out += expandMacros(macros[w], macros, depth + 1);
          else out += w; i = j;
        } else { out += c; i++; }
      } else if (st === 1) { out += c; i++;
        if (c === "\\" && i < n) { out += line.charAt(i); i++; }
        else if (c === '"') st = 0;
      } else { out += c; i++;
        if (c === "\\" && i < n) { out += line.charAt(i); i++; }
        else if (c === "'") st = 0;
      }
    }
    return out;
  }
  function preprocess(src) { src = String(src == null ? "" : src).replace(/\r\n?/g, "\n");
    var lines = stripComments(src).split("\n"); var out = [], macros = Object.create(null); macros.NULL = "0";
    for (var li = 0; li < lines.length; li++) { var line = lines[li];
      var m = /^\s*#\s*([A-Za-z_]\w*)(.*)$/.exec(line); if (m) { var dir = m[1], rest = m[2];
        if (dir === "define") { if (/^\s+[A-Za-z_]\w*\s*\(/.test(rest)) { throw err(li + 1, "暂不支持带参数的宏");
          }
          var d = /^\s+([A-Za-z_]\w*)(?:\s+(.*))?$/.exec(rest);
          if (d) macros[d[1]] = (d[2] == null ? "" : d[2]).replace(/\\\s*$/, "").trim();
        } else if (dir === "undef") { var u = /^\s+([A-Za-z_]\w*)/.exec(rest);
          if (u) delete macros[u[1]];
        }
        out.push(""); // 指令行置空，保留行号
      } else { out.push(expandMacros(line, macros, 0));
      }
    }
    return out.join("\n");
  }
  /* =========================================================
     二、词法分析
     ========================================================= */
  var KEYWORDS = ("int long short char float double void bool const signed unsigned " +
    "if else while for do break continue return switch case default sizeof " +
    "struct class union enum typedef goto static extern using namespace true false " +
    "new delete template operator public private protected virtual try catch throw this " +
    "auto register volatile inline").split(" ");
  var KW = Object.create(null); (function () { for (var i = 0; i < KEYWORDS.length; i++) KW[KEYWORDS[i]] = true;
  })(); var TYPEKW = Object.create(null);
  ["int", "long", "short", "char", "float", "double", "void", "bool",
    "const", "signed", "unsigned", "static", "extern", "register", "volatile"].forEach(function (k) {
    TYPEKW[k] = true;
  });
  var OPS = ["<<=", ">>=", "++", "--", "+=", "-=", "*=", "/=", "%=", "==", "!=",
    "<=", ">=", "&&", "||", "<<", ">>", "&=", "|=", "^=", "::", "->"];
  var SINGLE_OPS = "+-*/%=<>!&|^~?:;,.()[]{}"; function readEscape(src, i) { i++;
    var c = src.charAt(i);
    var map = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "0": 0, "\\": 92, "'": 39, '"': 34, "?": 63 };
    if (Object.prototype.hasOwnProperty.call(map, c)) return { code: map[c], next: i + 1 };
    if (c === "x") { var j = i + 1, hex = "";
      while (hex.length < 2 && /[0-9a-fA-F]/.test(src.charAt(j))) { hex += src.charAt(j); j++; }
      if (!hex) return { code: 120, next: i + 1 }; return { code: parseInt(hex, 16), next: j };
    }
    if (/[0-7]/.test(c)) { var k = i, oct = "";
      while (oct.length < 3 && /[0-7]/.test(src.charAt(k))) { oct += src.charAt(k); k++; }
      return { code: parseInt(oct, 8), next: k };
    }
    return { code: c.charCodeAt(0), next: i + 1 };
  }
  function readQuoted(src, start, line) { var quote = src.charAt(start), i = start + 1, out = "";
    while (i < src.length) { var c = src.charAt(i);
      if (c === "\\") { var e = readEscape(src, i);
        out += String.fromCharCode(e.code); i = e.next;
      } else if (c === quote) { return { s: out, next: i + 1 };
      } else if (c === "\n") { throw err(line, "字符串或字符常量缺少结束引号"); } else { out += c; i++;
      }
    }
    throw err(line, "字符串或字符常量缺少结束引号");
  }
  function lex(src) { var toks = [], i = 0, n = src.length, line = 1;
    while (i < n) { var c = src.charAt(i);
      if (c === "\n") { line++; i++; continue; }
      if (c === " " || c === "\t" || c === "\r") { i++; continue; }
      // 数字
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src.charAt(i + 1)))) { var start = i, isF = false, base = 10;
        if (c === "0" && (src.charAt(i + 1) === "x" || src.charAt(i + 1) === "X")) { i += 2; base = 16;
          while (/[0-9a-fA-F]/.test(src.charAt(i))) i++; if (i === start + 2) throw err(line, "无效的十六进制数字");
        } else if (c === "0" && (src.charAt(i + 1) === "b" || src.charAt(i + 1) === "B")) { i += 2; base = 2;
          while (/[01]/.test(src.charAt(i))) i++;
        } else { while (/[0-9]/.test(src.charAt(i))) i++;
          if (src.charAt(i) === ".") { isF = true; i++;
            while (/[0-9]/.test(src.charAt(i))) i++;
          }
          if (src.charAt(i) === "e" || src.charAt(i) === "E") { isF = true; i++;
            if (src.charAt(i) === "+" || src.charAt(i) === "-") i++; while (/[0-9]/.test(src.charAt(i))) i++;
          }
          if (!isF && src.charAt(start) === "0" && i - start > 1) base = 8;
        }
        var core = src.slice(start, i), j = i;
        while (/[uUlLfF]/.test(src.charAt(j))) { if (src.charAt(j) === "f" || src.charAt(j) === "F") isF = true;
          j++;
        }
        var val; if (isF) val = parseFloat(core); else if (base === 16) val = parseInt(core.slice(2), 16);
        else if (base === 2) val = parseInt(core.slice(2), 2); else val = parseInt(core, base);
        if (isNaN(val)) throw err(line, "无效的数字 “" + core + "”");
        toks.push({ type: "num", n: val, f: isF, line: line }); i = j; continue;
      }
      // 标识符 / 关键字
      if (/[A-Za-z_]/.test(c)) { var s0 = i;
        while (i < n && /[A-Za-z0-9_]/.test(src.charAt(i))) i++; var word = src.slice(s0, i);
        toks.push({ type: KW[word] ? "kw" : "id", v: word, line: line }); continue;
      }
      // 字符串 / 字符
      if (c === '"') { var rs = readQuoted(src, i, line);
        toks.push({ type: "str", s: rs.s, line: line }); i = rs.next; continue;
      }
      if (c === "'") { var rc = readQuoted(src, i, line);
        if (!rc.s.length) throw err(line, "字符常量不能为空"); if (rc.s.length > 1) throw err(line, "字符常量只能包含一个字符");
        toks.push({ type: "chr", n: rc.s.charCodeAt(0), line: line }); i = rc.next; continue;
      }
      // 运算符
      var op = null;
      for (var oi = 0; oi < OPS.length; oi++) {
        if (src.substr(i, OPS[oi].length) === OPS[oi]) { op = OPS[oi]; break; }
      }
      if (!op && SINGLE_OPS.indexOf(c) >= 0) op = c; if (op) { toks.push({ type: "op", v: op, line: line });
        i += op.length; continue;
      }
      throw err(line, "无法识别的字符 “" + c + "”");
    }
    toks.push({ type: "eof", v: "", line: line }); return toks;
  }
  /* =========================================================
     三、类型描述（静态推导，用于整除 / 浮点判断）
     p 表示还需要几次下标/解引用才到标量
     ========================================================= */
  function T(b, p) { return { b: b, p: p || 0 }; }
  var INT = T("int"), CHAR = T("char"), DOUBLE = T("double"), FLOAT = T("float");
  var VOID = T("void"), BOOL = T("bool"), LONG = T("long"), SHORT = T("short"); var STR = T("char", 1);
  function isFloatT(t) { return !!t && t.p === 0 && (t.b === "double" || t.b === "float"); }
  function isIntT(t) { return !!t && t.p === 0 && (t.b === "int" || t.b === "char" || t.b === "bool" || t.b === "long" || t.b === "short"); }
  function ptrT(t) { return T(t.b, t.p + 1); }
  function derefT(t) { return t.p > 0 ? T(t.b, t.p - 1) : t; }
  function promoteT(a, b) { return (isFloatT(a) || isFloatT(b)) ? DOUBLE : INT; }
  function sizeOfType(t) { if (t.p > 0) return 8;
    switch (t.b) { case "char": case "bool": return 1;
      case "short": return 2; case "float": case "int": return 4;
      case "double": case "long": return 8; default: return 4;
    }
  }
  /* =========================================================
     四、语法分析
     ========================================================= */
  var UNSUP_KW = {
    struct: "struct", class: "class", union: "union", enum: "enum",
    typedef: "typedef", goto: "goto", template: "template", namespace: "namespace",
    new: "new", delete: "delete", operator: "operator"
  };
  var UNSUP_CALL = {
    malloc: "动态内存分配（malloc/free）", calloc: "动态内存分配（malloc/free）",
    realloc: "动态内存分配（malloc/free）", free: "动态内存分配（malloc/free）",
    fopen: "文件操作", fclose: "文件操作", fscanf: "文件操作", fprintf: "文件操作",
    fgets: "文件操作", fputs: "文件操作", fread: "文件操作", fwrite: "文件操作",
    scanf_s: "scanf_s"
  }; function Parser(toks) { this.toks = toks;
    this.i = 0;
    this.scopes = [Object.create(null)]; // 变量类型表，栈顶为当前作用域
    this.funcs = Object.create(null); this.funcDefs = []; this.prescan = collectFuncReturns(toks);
  }
  Parser.prototype.peek = function (k) { var idx = this.i + (k || 0);
    return idx < this.toks.length ? this.toks[idx] : this.toks[this.toks.length - 1];
  }; Parser.prototype.next = function () { return this.toks[this.i++]; };
  Parser.prototype.isOp = function (v, k) { var t = this.peek(k);
    return t.type === "op" && t.v === v;
  }; Parser.prototype.isKw = function (v, k) { var t = this.peek(k);
    return t.type === "kw" && t.v === v;
  }; Parser.prototype.expectOp = function (v) { var t = this.peek();
    if (t.type !== "op" || t.v !== v) throw err(t.line, "此处需要 “" + v + "”"); return this.next();
  }; Parser.prototype.expectKw = function (v) { var t = this.peek();
    if (t.type !== "kw" || t.v !== v) throw err(t.line, "此处需要 “" + v + "”"); return this.next();
  }; Parser.prototype.expectId = function () { var t = this.peek();
    if (t.type !== "id") throw err(t.line, "此处需要标识符"); return this.next();
  }; Parser.prototype.typeStart = function (k) { var t = this.peek(k);
    return t.type === "kw" && TYPEKW[t.v] === true;
  }; Parser.prototype.declare = function (name, type, isArr, line) { var cur = this.scopes[this.scopes.length - 1];
    if (cur[name] && cur[name].line !== -1) throw err(line, "变量 " + name + " 重复定义");
    cur[name] = { t: type, arr: !!isArr, line: line || 0 };
  };
  Parser.prototype.lookup = function (name) {
    for (var i = this.scopes.length - 1; i >= 0; i--) { if (this.scopes[i][name]) return this.scopes[i][name];
    }
    return null;
  };
  // 预扫描顶层函数返回类型，便于函数定义之前调用（C 需要原型，这里更宽松）
  function collectFuncReturns(toks) { var map = Object.create(null), depth = 0, i = 0;
    for (; i < toks.length; i++) { var t = toks[i];
      if (t.type === "op" && t.v === "{") { depth++; continue; }
      if (t.type === "op" && t.v === "}") { depth--; continue; }
      if (depth !== 0) continue; if (t.type !== "kw" || !TYPEKW[t.v]) continue;
      var j = i + 1, base = "int", sawBase = false;
      while (j < toks.length && toks[j].type === "kw" && (TYPEKW[toks[j].v] || toks[j].v === "long")) {
        var v = toks[j].v;
        if (v === "int" || v === "char" || v === "float" || v === "double" || v === "void" || v === "bool") {
          base = v; sawBase = true;
        } else if (v === "long") { base = "long"; sawBase = true; }
        else if (v === "short") { base = "short"; sawBase = true; }
        j++;
      }
      if (!sawBase) { i = j - 1; continue; }
      while (j < toks.length && toks[j].type === "op" && toks[j].v === "*") j++;
      if (toks[j] && toks[j].type === "id" && toks[j + 1] &&
        toks[j + 1].type === "op" && toks[j + 1].v === "(") {
        var k = j + 1, d = 0, end = -1; for (; k < toks.length; k++) { if (toks[k].v === "(") d++;
          else if (toks[k].v === ")") { d--; if (d === 0) { end = k; break; } }
        }
        if (end > 0 && toks[end + 1] && (toks[end + 1].v === "{" || toks[end + 1].v === ";")) {
          map[toks[j].v] = T(base, 0); i = end;
        }
      }
    }
    return map;
  }
  /* ---------- 类型与声明 ---------- */
  Parser.prototype.parseType = function () { var base = null, saw = false, isConst = false;
    for (;;) { var t = this.peek();
      if (t.type !== "kw") break; var v = t.v;
      if (v === "const") { this.next(); isConst = true; continue; }
      if (v === "static" || v === "extern" || v === "register" || v === "volatile" || v === "signed") {
        this.next(); continue;
      }
      if (v === "unsigned") { this.next(); saw = true; if (!base) base = "int"; continue; }
      if (v === "short") { this.next(); saw = true; if (!base) base = "short"; continue; }
      if (v === "long") { this.next(); saw = true; if (base !== "double") base = "long"; continue; }
      if (v === "int" || v === "char" || v === "float" || v === "double" || v === "void" || v === "bool") {
        this.next(); saw = true;
        if (base === "long" || base === "short") { if (v === "double") base = "double"; }
        else base = v; continue;
      }
      break;
    }
    if (!base) { if (saw) base = "int"; else return null; }
    while (this.isKw("const")) { this.next(); isConst = true; }
    var p = 0; while (this.isOp("*")) { this.next(); p++;
      while (this.isKw("const")) { this.next(); isConst = true; }
    }
    var ty = T(base, p); ty.c = isConst; return ty;
  }; function paramKey(sig) { var s = "", i;
    for (i = 0; i < sig.params.length; i++) { var p = sig.params[i];
      s += (p.type.b || "int") + "/" + (p.type.p || 0) + "/" + (p.ref ? 1 : 0) + ";";
    }
    return s;
  }
  function typeScore(pt, at) { if (!pt) return 0;
    if (pt.p > 0) { if (at && at.p > 0) return 3;
      if (at && at.p === 0 && (at.b === "int" || at.b === "char" || at.b === "long" || at.b === "bool")) return 1;
      return -1;
    }
    if (!at || at.p > 0) return -1;
    if (pt.b === at.b) return 3;
    var pf = (pt.b === "double" || pt.b === "float"), af = (at.b === "double" || at.b === "float");
    if (pf === af) return 2;
    return 1;
  }
  function constEval(n, parser) { if (!n) return null;
    var a, b; switch (n.type) { case "Num": return n.value;
      case "Id": { if (!parser) return null; var info = parser.lookup(n.name);
        return info && info.constVal != null ? info.constVal : null;
      }
      case "Unary":
        a = constEval(n.expr, parser); if (a == null) return null; if (n.op === "-") return -a;
        if (n.op === "+") return a; if (n.op === "~") return ~a; if (n.op === "!") return a ? 0 : 1; return null;
      case "Binary":
        a = constEval(n.l, parser); b = constEval(n.r, parser); if (a == null || b == null) return null;
        switch (n.op) { case "+": return a + b;
          case "-": return a - b; case "*": return a * b;
          case "/": return b === 0 ? null : (isFloatT(n.t) ? a / b : Math.trunc(a / b));
          case "%": return b === 0 ? null : a % b; case "<<": return a << b;
          case ">>": return a >> b; case "&": return a & b; case "|": return a | b; case "^": return a ^ b;
        }
        return null;
      case "Cond":
        a = constEval(n.c, parser); return a == null ? null : (a ? constEval(n.a, parser) : constEval(n.b, parser));
      case "Cast": return constEval(n.expr, parser); case "Sizeof": return n.value;
    }
    return null;
  }
  Parser.prototype.parseInitList = function () { var line = this.expectOp("{").line;
    var items = []; while (!this.isOp("}")) { if (this.peek().type === "eof") throw err(line, "初始化列表没有结束的 }");
      items.push(this.isOp("{") ? this.parseInitList() : this.parseAssign()); if (this.isOp(",")) this.next();
      else break;
    }
    this.expectOp("}"); return { type: "InitList", items: items, line: line };
  }; Parser.prototype.parseDeclItems = function (ty) { var items = [];
    for (;;) { var p = ty.p, line = this.peek().line;
      while (this.isOp("*")) { this.next(); p++; }
      var isRef = false; if (this.isOp("&")) { this.next(); isRef = true; }
      if (this.isOp("(")) throw err(this.peek().line, "暂不支持函数指针"); var nameTok = this.expectId(); var dims = [];
      while (this.isOp("[")) { this.next();
        if (this.isOp("]")) { dims.push(null); this.next(); }
        else { var e = this.parseAssign();
          var v = constEval(e, this); if (v == null) throw err(e.line, "暂不支持变长数组，数组长度必须是常量");
          if (v <= 0) throw err(e.line, "数组长度必须是正整数"); dims.push(v); this.expectOp("]");
        }
      }
      var full = T(ty.b, p + dims.length); var isArr = dims.length > 0; var init = null;
      if (isRef && isArr) throw err(line, "暂不支持引用数组");
      if (this.isOp("=")) { this.next();
        init = this.isOp("{") ? this.parseInitList() : this.parseAssign();
      }
      if (isRef) {
        if (!init) throw err(line, "引用变量必须初始化");
        if (!ty.c && !isLvalue(init)) throw err(init.line, "非 const 引用必须绑定到变量");
      }
      if (isArr && dims[0] == null) {
        if (init && init.type === "Str" && (ty.b === "char")) dims[0] = init.s.length + 1;
        else if (init && init.type === "InitList") dims[0] = init.items.length; else throw err(line, "数组长度不能为空");
      }
      var total = 1;
      for (var di = 0; di < dims.length; di++) { if (dims[di] == null) throw err(line, "多维数组只有第一维可以省略长度");
        total *= dims[di];
      }
      if (total > MAX_ARRAY) throw err(line, "数组过大，最多支持 " + MAX_ARRAY + " 个元素");
      this.declare(nameTok.v, full, isArr, line);
      if (ty.c && !isArr && init) { var cv = constEval(init, this);
        if (cv != null) this.scopes[this.scopes.length - 1][nameTok.v].constVal = cv;
      }
      items.push({ name: nameTok.v, type: full, et: T(ty.b, p), dims: dims, init: init, line: line, ref: isRef, ro: ty.c });
      if (this.isOp(",")) { this.next(); continue; }
      break;
    }
    return items;
  }; Parser.prototype.parseDecl = function (needSemi) { var line = this.peek().line;
    var ty = this.parseType(); if (!ty) throw err(line, "此处需要类型名");
    var items = this.parseDeclItems(ty); if (needSemi !== false) this.expectOp(";");
    return { type: "Decl", dtype: ty, items: items, line: line };
  };
  /* ---------- 顶层 ---------- */
  Parser.prototype.parseProgram = function () { var globals = [];
    while (this.peek().type !== "eof") { var tk = this.peek();
      if (tk.type === "op" && tk.v === ";") { this.next(); continue; }
      if (tk.type === "kw" && tk.v === "using") { this.next();
        this.expectKw("namespace"); this.expectId(); this.expectOp(";"); continue;
      }
      this.checkUnsupported(tk);
      if (tk.type === "id" && (tk.v === "string" || tk.v === "vector")) {
        throw err(tk.line, "暂不支持 " + tk.v + "，请改用 char 数组或普通数组");
      }
      if (tk.type === "id" && tk.v === "std" && this.isOp("::", 1)) {
        throw err(tk.line, "暂不支持用 std:: 声明变量，本站判题只支持 C 语言基础语法");
      }
      if (!this.typeStart()) throw err(tk.line, "无法识别的顶层语句"); var line = tk.line, ty = this.parseType();
      if (this.isOp("(")) throw err(this.peek().line, "暂不支持函数指针"); var n1 = this.peek(), n2 = this.peek(1);
      if (n1.type === "id" && n2.type === "op" && n2.v === "(") {
        this.next(); // 吃掉函数名
        this.parseFunction(ty, n1, line);
      } else { var items = this.parseDeclItems(ty);
        this.expectOp(";"); globals.push({ type: "Decl", dtype: ty, items: items, line: line });
      }
    }
    return { globals: globals, funcs: this.funcDefs };
  };
  Parser.prototype.checkUnsupported = function (tk) {
    if (tk.type === "kw" && UNSUP_KW[tk.v]) { var name = UNSUP_KW[tk.v];
      throw err(tk.line, "暂不支持 " + name + "，本站判题只支持 C 语言基础语法");
    }
  }; Parser.prototype.parseFunction = function (ret, nameTok, line) { var name = nameTok.v;
    var sig = { name: name, ret: ret, params: [], body: null, line: line };
    this.expectOp("(");
    if (!this.isOp(")")) {
      if (this.isKw("void") && this.peek(1).type === "op" && this.peek(1).v === ")") { this.next();
      } else { for (;;) { var pt = this.parseType();
          if (!pt) throw err(this.peek().line, "函数参数缺少类型"); var p = pt.p;
          while (this.isOp("*")) { this.next(); p++; }
          var isRef = false; if (this.isOp("&")) { this.next(); isRef = true; }
          var pn = null; if (this.peek().type === "id") pn = this.next().v; while (this.isOp("[")) { this.next();
            while (!this.isOp("]")) this.next(); this.next(); p++;
          }
          sig.params.push({ name: pn, type: T(pt.b, p), ref: isRef, ro: pt.c, line: this.peek().line });
          if (this.isOp(",")) { this.next(); continue; }
          break;
        }
      }
    }
    this.expectOp(")");
    var list = this.funcs[name];
    if (!list) { list = []; this.funcs[name] = list; }
    var same = null, si;
    for (si = 0; si < list.length; si++) {
      if (paramKey(list[si]) === paramKey(sig)) { same = list[si]; break; }
    }
    if (this.isOp(";")) {
      this.next();
      if (!same) list.push(sig);
      return;
    }
    if (!this.isOp("{")) throw err(this.peek().line, "函数定义缺少函数体");
    if (same) {
      if (same.body) throw err(line, "函数 " + name + " 重复定义");
      var fresh = sig; sig = same;
      for (var pi = 0; pi < sig.params.length; pi++) {
        if (!sig.params[pi].name) sig.params[pi].name = fresh.params[pi].name;
        sig.params[pi].ro = fresh.params[pi].ro;
      }
      sig.ret = ret;
    } else list.push(sig);
    for (var i = 0; i < sig.params.length; i++) { if (!sig.params[i].name) throw err(line, "函数 " + name + " 的参数缺少名字");
    }
    this.scopes.push(Object.create(null));
    for (i = 0; i < sig.params.length; i++) { this.declare(sig.params[i].name, sig.params[i].type, false, line);
      if (sig.params[i].ro) this.scopes[this.scopes.length - 1][sig.params[i].name].ro = true;
    }
    sig.body = this.parseBlock(); this.scopes.pop(); this.funcDefs.push(sig);
  };
  /* ---------- 语句 ---------- */
  Parser.prototype.parseBlock = function () { var line = this.expectOp("{").line;
    this.scopes.push(Object.create(null)); var stmts = [];
    while (!this.isOp("}")) { if (this.peek().type === "eof") throw err(line, "代码块缺少结束的 }");
      stmts.push(this.parseStmt());
    }
    this.expectOp("}"); this.scopes.pop(); return { type: "Block", stmts: stmts, line: line };
  }; Parser.prototype.parseStmt = function () { var tk = this.peek();
    if (tk.type === "op" && tk.v === "{") return this.parseBlock();
    if (tk.type === "op" && tk.v === ";") { this.next(); return { type: "Empty", line: tk.line }; }
    this.checkUnsupported(tk); if (tk.type === "kw") { switch (tk.v) { case "if": return this.parseIf();
        case "while": return this.parseWhile(); case "do": return this.parseDo();
        case "for": return this.parseFor(); case "switch": return this.parseSwitch();
        case "break": this.next(); this.expectOp(";"); return { type: "Break", line: tk.line };
        case "continue": this.next(); this.expectOp(";"); return { type: "Continue", line: tk.line };
        case "return": return this.parseReturn();
        case "using":
          this.next(); this.expectKw("namespace"); this.expectId(); this.expectOp(";");
          return { type: "Empty", line: tk.line };
      }
    }
    if (tk.type === "id" && (tk.v === "string" || tk.v === "vector")) { var n2 = this.peek(1);
      if (n2.type === "id" || (n2.type === "op" && (n2.v === "*" || n2.v === "<"))) {
        throw err(tk.line, "暂不支持 " + tk.v + "，请改用 char 数组或普通数组");
      }
    }
    if (tk.type === "id" && tk.v === "std" && this.isOp("::", 1)) { var n3 = this.peek(2);
      if (n3.type === "id" && (n3.v === "string" || n3.v === "vector")) {
        throw err(tk.line, "暂不支持 " + n3.v + "，请改用 char 数组或普通数组");
      }
    }
    if (this.typeStart()) return this.parseDecl(true); if (this.isCoutStart()) return this.parseCout();
    if (this.isCinStart()) return this.parseCin(); var e = this.parseExpression();
    this.expectOp(";"); return { type: "ExprStmt", expr: e, line: tk.line };
  }; Parser.prototype.parseIf = function () { var line = this.expectKw("if").line;
    this.expectOp("("); var cond = this.parseExpression();
    this.expectOp(")"); var then = this.parseStmt(), els = null;
    if (this.isKw("else")) { this.next(); els = this.parseStmt(); }
    return { type: "If", cond: cond, then: then, els: els, line: line };
  }; Parser.prototype.parseWhile = function () { var line = this.expectKw("while").line;
    this.expectOp("("); var cond = this.parseExpression(); this.expectOp(")"); var body = this.parseStmt();
    return { type: "While", cond: cond, body: body, line: line };
  }; Parser.prototype.parseDo = function () { var line = this.expectKw("do").line;
    var body = this.parseStmt(); this.expectKw("while"); this.expectOp("("); var cond = this.parseExpression();
    this.expectOp(")"); this.expectOp(";"); return { type: "Do", cond: cond, body: body, line: line };
  }; Parser.prototype.parseFor = function () { var line = this.expectKw("for").line;
    this.expectOp("("); this.scopes.push(Object.create(null));
    var init = null, cond = null, upd = null; if (this.isOp(";")) this.next();
    else if (this.typeStart()) init = this.parseDecl(true); else { var il = this.peek().line;
      init = { type: "ExprStmt", expr: this.parseExpression(), line: il }; this.expectOp(";");
    }
    if (!this.isOp(";")) cond = this.parseExpression(); this.expectOp(";");
    if (!this.isOp(")")) upd = this.parseExpression(); this.expectOp(")");
    var body = this.parseStmt(); this.scopes.pop();
    return { type: "For", init: init, cond: cond, upd: upd, body: body, line: line };
  }; Parser.prototype.parseSwitch = function () { var line = this.expectKw("switch").line;
    this.expectOp("("); var expr = this.parseExpression(); this.expectOp(")"); this.expectOp("{");
    this.scopes.push(Object.create(null)); var cases = [], cur = null;
    while (!this.isOp("}")) { if (this.peek().type === "eof") throw err(line, "switch 缺少结束的 }");
      if (this.isKw("case")) { var cl = this.next().line;
        var ce = this.parseAssign(); var cv = constEval(ce, this);
        if (cv == null) throw err(ce.line, "case 后面必须是常量"); this.expectOp(":");
        cur = { val: cv, isDefault: false, stmts: [], line: cl }; cases.push(cur);
      } else if (this.isKw("default")) { var dl = this.next().line;
        this.expectOp(":"); cur = { val: null, isDefault: true, stmts: [], line: dl }; cases.push(cur);
      } else { if (!cur) { cur = { val: null, isDefault: false, isDummy: true, stmts: [], line: this.peek().line };
          cases.push(cur);
        }
        cur.stmts.push(this.parseStmt());
      }
    }
    this.expectOp("}"); this.scopes.pop(); return { type: "Switch", expr: expr, cases: cases, line: line };
  }; Parser.prototype.parseReturn = function () { var line = this.expectKw("return").line;
    var e = null; if (!this.isOp(";")) e = this.parseExpression();
    this.expectOp(";"); return { type: "Return", expr: e, line: line };
  };
  /* ---------- C++ 输入输出 ---------- */
  Parser.prototype.isCoutStart = function () { var t = this.peek();
    if (t.type !== "id") return false; if (t.v === "cout") return true;
    if (t.v === "std" && this.isOp("::", 1)) { var u = this.peek(2);
      return u.type === "id" && u.v === "cout";
    }
    return false;
  }; Parser.prototype.isCinStart = function () { var t = this.peek();
    if (t.type !== "id") return false; if (t.v === "cin") return true;
    if (t.v === "std" && this.isOp("::", 1)) { var u = this.peek(2);
      return u.type === "id" && u.v === "cin";
    }
    return false;
  }; Parser.prototype.skipStdPrefix = function (name) { var t = this.peek();
    if (t.type === "id" && t.v === "std" && this.isOp("::", 1)) { this.next(); this.next(); }
    var n = this.next(); if (n.type !== "id" || n.v !== name) throw err(n.line, "此处需要 " + name);
  }; Parser.prototype.parseCout = function () { var line = this.peek().line;
    this.skipStdPrefix("cout"); var parts = []; while (this.isOp("<<")) { this.next();
      var t = this.peek();
      if (t.type === "id" && t.v === "endl") { this.next(); parts.push({ kind: "endl" }); continue; }
      if (t.type === "id" && t.v === "fixed") { this.next(); parts.push({ kind: "fixed" }); continue; }
      if (t.type === "id" && t.v === "scientific") { this.next(); parts.push({ kind: "scientific" }); continue; }
      if (t.type === "id" && t.v === "boolalpha") { this.next(); parts.push({ kind: "boolalpha" }); continue; }
      if (t.type === "id" && t.v === "setprecision") { this.next(); this.expectOp("(");
        var pe = this.parseExpression(); this.expectOp(")"); parts.push({ kind: "prec", expr: pe }); continue;
      }
      if (t.type === "id" && t.v === "setw") { this.next(); this.expectOp("(");
        var we = this.parseExpression(); this.expectOp(")"); parts.push({ kind: "width", expr: we }); continue;
      }
      if (t.type === "id" && t.v === "std" && this.isOp("::", 1)) { var u = this.peek(2);
        if (u.type === "id" && u.v === "endl") { this.next(); this.next(); this.next(); parts.push({ kind: "endl" }); continue; }
      }
      // 只解析到 + - 层，避免把链式 << 当成移位
      parts.push({ kind: "expr", expr: this.parseBinary(8) });
    }
    this.expectOp(";"); if (!parts.length) throw err(line, "cout 后面缺少 <<");
    return { type: "CppOut", parts: parts, line: line };
  }; Parser.prototype.parseCin = function () { var line = this.peek().line;
    this.skipStdPrefix("cin"); var parts = []; while (this.isOp(">>")) { this.next();
      parts.push(this.parseUnary());
    }
    this.expectOp(";"); if (!parts.length) throw err(line, "cin 后面缺少 >>");
    return { type: "CppIn", parts: parts, line: line };
  };
  /* ---------- 表达式 ---------- */
  var BINLEVELS = [
    ["||"], ["&&"], ["|"], ["^"], ["&"],
    ["==", "!="], ["<", ">", "<=", ">="], ["<<", ">>"], ["+", "-"], ["*", "/", "%"]
  ]; Parser.prototype.parseExpression = function () { var line = this.peek().line;
    var e = this.parseAssign(); while (this.isOp(",")) { this.next();
      var r = this.parseAssign(); e = { type: "Comma", l: e, r: r, line: line, t: r.t };
    }
    return e;
  };
  function isAssignOp(v) {
    return v === "=" || v === "+=" || v === "-=" || v === "*=" || v === "/=" ||
      v === "%=" || v === "&=" || v === "|=" || v === "^=" || v === "<<=" || v === ">>=";
  }
  Parser.prototype.parseAssign = function () { var left = this.parseTernary();
    var t = this.peek(); if (t.type === "op" && isAssignOp(t.v)) { this.next();
      if (!isLvalue(left)) throw err(left.line, "赋值号左边必须是变量"); var right = this.parseAssign();
      return { type: "Assign", op: t.v, l: left, r: right, line: left.line, t: left.t };
    }
    return left;
  }; function isLvalue(n) { if (!n) return false;
    if (n.type === "Id") return n.arr !== true; if (n.type === "Index") return true;
    if (n.type === "Unary" && n.op === "*") return true; return false;
  }
  Parser.prototype.parseTernary = function () { var c = this.parseBinary(0), line = c.line;
    if (this.isOp("?")) { this.next();
      var a = this.parseAssign(); this.expectOp(":");
      var b = this.parseAssign(); return { type: "Cond", c: c, a: a, b: b, line: line, t: promoteT(a.t, b.t) };
    }
    return c;
  }; Parser.prototype.parseBinary = function (level) { if (level >= BINLEVELS.length) return this.parseUnary();
    var left = this.parseBinary(level + 1); for (;;) { var t = this.peek();
      if (t.type !== "op" || BINLEVELS[level].indexOf(t.v) < 0) break; this.next();
      var right = this.parseBinary(level + 1); left = makeBinary(t.v, left, right, t.line);
    }
    return left;
  }; function makeBinary(op, l, r, line) { var t;
    if (op === "+" || op === "-") { if (l.t.p > 0 && isIntT(r.t)) t = l.t;
      else if (op === "+" && r.t.p > 0 && isIntT(l.t)) t = r.t; else if (l.t.p > 0 && r.t.p > 0) t = INT;
      else t = promoteT(l.t, r.t);
    } else if (op === "==" || op === "!=" || op === "<" || op === ">" ||
      op === "<=" || op === ">=" || op === "&&" || op === "||") {
      t = INT;
    } else if (op === "<<" || op === ">>" || op === "&" || op === "|" || op === "^") { t = INT;
    } else { t = promoteT(l.t, r.t);
    }
    return { type: "Binary", op: op, l: l, r: r, line: line, t: t };
  }
  Parser.prototype.parseUnary = function () { var tk = this.peek();
    if (tk.type === "kw" && tk.v === "sizeof") return this.parseSizeof();
    if (tk.type === "op") {
      if (tk.v === "++" || tk.v === "--" || tk.v === "+" || tk.v === "-" ||
        tk.v === "!" || tk.v === "~" || tk.v === "*" || tk.v === "&") {
        this.next(); var e = this.parseUnary(); var t = e.t; if (tk.v === "&") t = ptrT(e.t);
        else if (tk.v === "*") { if (e.t.p === 0) throw err(tk.line, "不能解引用非指针");
          t = derefT(e.t);
        } else if (tk.v === "!" || tk.v === "~") t = INT;
        if ((tk.v === "++" || tk.v === "--") && !isLvalue(e)) { throw err(tk.line, "++/-- 需要变量");
        }
        return { type: tk.v === "++" || tk.v === "--" ? "Pre" : "Unary", op: tk.v, expr: e, line: tk.line, t: t };
      }
      if (tk.v === "(" && this.typeStart(1)) { this.next();
        var ty = this.parseType(); this.expectOp(")");
        var ce = this.parseUnary(); return { type: "Cast", to: ty, expr: ce, line: tk.line, t: ty };
      }
    }
    return this.parsePostfix();
  }; Parser.prototype.parseSizeof = function () { var line = this.expectKw("sizeof").line;
    if (this.isOp("(") && this.typeStart(1)) { this.next();
      var ty = this.parseType(); this.expectOp(")");
      return { type: "Sizeof", value: sizeOfType(ty), t: INT, line: line };
    }
    var e = this.parseUnary(); return { type: "Sizeof", value: sizeOfType(e.t), t: INT, line: line };
  }; Parser.prototype.parsePostfix = function () { var e = this.parsePrimary();
    for (;;) { if (this.isOp("[")) { this.next();
        var idx = this.parseExpression(); this.expectOp("]");
        e = { type: "Index", base: e, index: idx, line: e.line, t: derefT(e.t) };
      } else if (this.isOp("(")) { e = this.parseCall(e);
      } else if (this.isOp("++") || this.isOp("--")) { var op = this.next().v;
        if (!isLvalue(e)) throw err(e.line, "++/-- 需要变量");
        e = { type: "Post", op: op, expr: e, line: e.line, t: e.t };
      } else break;
    }
    return e;
  }; Parser.prototype.parseCall = function (callee) { if (callee.type !== "Id") throw err(callee.line, "暂不支持函数指针");
    var name = callee.name, line = callee.line; this.expectOp("("); var args = [];
    if (!this.isOp(")")) { for (;;) { args.push(this.parseAssign());
        if (this.isOp(",")) { this.next(); continue; }
        break;
      }
    }
    this.expectOp(")"); if (UNSUP_CALL[name]) throw err(line, "暂不支持 " + UNSUP_CALL[name] + "，本站判题只支持 C 语言基础语法");
    var argTypes = [], ti;
    for (ti = 0; ti < args.length; ti++) argTypes.push(args[ti].t || INT);
    var sig = this.pickOverload(name, argTypes), ret = INT;
    if (sig) ret = sig.ret; else if (this.prescan[name]) ret = this.prescan[name];
    return { type: "Call", name: name, args: args, line: line, sig: sig, t: ret };
  };
  Parser.prototype.pickOverload = function (name, argTypes) {
    var list = this.funcs[name], best = null, bestScore = -1, k, i;
    if (!list) return null;
    for (k = 0; k < list.length; k++) {
      var sig = list[k];
      if (sig.params.length !== argTypes.length) continue;
      var sc = 0, ok = true;
      for (i = 0; i < argTypes.length; i++) {
        var s = typeScore(sig.params[i].type, argTypes[i]);
        if (s < 0) { ok = false; break; }
        sc += s;
      }
      if (ok && sc > bestScore) { best = sig; bestScore = sc; }
    }
    return best;
  }; Parser.prototype.parsePrimary = function () { var tk = this.next();
    if (tk.type === "num") return { type: "Num", value: tk.n, t: tk.f ? DOUBLE : INT, line: tk.line };
    if (tk.type === "chr") return { type: "Num", value: tk.n, t: CHAR, line: tk.line };
    if (tk.type === "str") return { type: "Str", s: tk.s, t: STR, line: tk.line };
    if (tk.type === "id") { if (tk.v === "std" && this.isOp("::")) { this.next();
        var id = this.expectId(); tk = { type: "id", v: id.v, line: id.line };
      }
      var info = this.lookup(tk.v);
      return { type: "Id", name: tk.v, t: info ? info.t : INT, arr: info ? info.arr : false, line: tk.line };
    }
    if (tk.type === "kw") {
      if (tk.v === "true" || tk.v === "false") {
        return { type: "Num", value: tk.v === "true" ? 1 : 0, t: BOOL, line: tk.line };
      }
      if (UNSUP_KW[tk.v]) this.checkUnsupported(tk); throw err(tk.line, "表达式里不能使用关键字 “" + tk.v + "”");
    }
    if (tk.type === "op" && tk.v === "(") { var e = this.parseExpression();
      this.expectOp(")"); return e;
    }
    throw err(tk.line, "表达式不完整");
  };
  /* =========================================================
     五、运行时数据
     ========================================================= */
  function Cell(t, v) { this.t = t; this.v = v; this.arr = null; }
  function Arr(et, dims, line) { this.et = et;
    this.dims = dims; this.line = line || 0; var len = 1, i; for (i = 0; i < dims.length; i++) len *= dims[i];
    this.len = len; var stride = new Array(dims.length), acc = 1;
    for (i = dims.length - 1; i >= 0; i--) { stride[i] = acc; acc *= dims[i]; }
    this.stride = stride; this.data = new Array(len); for (i = 0; i < len; i++) this.data[i] = 0;
  }
  function Scope(parent) { this.vars = Object.create(null); this.parent = parent; }
  Scope.prototype.find = function (name) { var s = this;
    while (s) { if (s.vars[name] !== undefined) return s.vars[name];
      s = s.parent;
    }
    return null;
  };
  function isPtrVal(v) { return !!v && typeof v === "object" && v.__p === 1; }
  function isNullPtr(v) { return v === 0 || v === null || v === undefined; }
  function isRefVal(v) {
    return !!v && typeof v === "object" && (v.k === "cell" || v.k === "elem" || v.k === "arr" || v.k === "str" || v.k === "oob" || v.k === "ptr" || v.k === "ro");
  }
  function toInt(v) { if (typeof v === "number") return v < 0 ? Math.ceil(v) : Math.floor(v);
    if (typeof v === "boolean") return v ? 1 : 0; if (typeof v === "string") return v.length ? v.charCodeAt(0) : 0;
    if (isPtrVal(v)) return 0; return v ? 1 : 0;
  }
  function toNum(v) { if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "string") { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
    if (isPtrVal(v)) return 0; return v ? 1 : 0;
  }
  function truthy(v) { if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0; if (isPtrVal(v)) return true; return !!v;
  }
  function coerceValue(t, v) { if (!t || t.p > 0) return v;
    if (t.b === "double" || t.b === "float") return toNum(v); if (t.b === "char") return toInt(v) & 0xFF;
    if (t.b === "bool") return toInt(v) ? 1 : 0; if (t.b === "void") return v; return toInt(v);
  }
  function samePtr(a, b) { if (a === b) return true;
    if (!isPtrVal(a) || !isPtrVal(b)) return false;
    if (a.arr && b.arr) return a.arr === b.arr && (a.off || 0) === (b.off || 0);
    if (a.cell && b.cell) return a.cell === b.cell && (a.off || 0) === (b.off || 0);
    if (a.str != null && b.str != null) return a.str === b.str && (a.off || 0) === (b.off || 0); return false;
  }
  function eqVal(a, b) { if (isPtrVal(a) || isPtrVal(b)) { if (isPtrVal(a) && isPtrVal(b)) return samePtr(a, b);
      return false;
    }
    if (typeof a === "string" || typeof b === "string") {
      if (typeof a === "string" && typeof b === "string") return a === b; return false;
    }
    return toNum(a) === toNum(b);
  }
  function readCString(v) { if (typeof v === "string") return v;
    if (isPtrVal(v)) { if (v.str != null) return v.str.slice(v.off || 0);
      if (v.arr) { var s = "", start = v.off || 0;
        for (var i = start; i < v.arr.data.length; i++) { var c = toInt(v.arr.data[i]);
          if (c === 0) break; s += String.fromCharCode(c & 0xFFFF);
        }
        return s;
      }
      if (v.cell) { var cv = v.cell.v;
        if (typeof cv === "string") return cv; return String.fromCharCode(toInt(cv) & 0xFFFF);
      }
    }
    return String(v == null ? "" : v);
  }
  /* =========================================================
     六、解释器
     ========================================================= */
  function Interp(prog, stdin) { this.prog = prog;
    this.global = new Scope(null); this.funcs = Object.create(null); var i;
    for (i = 0; i < prog.funcs.length; i++) { var fn = prog.funcs[i];
      (this.funcs[fn.name] || (this.funcs[fn.name] = [])).push(fn);
    }
    this.input = new Input(stdin); this.steps = 0; this.out = ""; this.depth = 0; this.warnings = []; this.line = 0;
  }
  Interp.prototype.tick = function () { if (++this.steps > MAX_STEPS) throw rawErr("程序运行超时，可能存在死循环"); };
  Interp.prototype.warn = function (line, msg) {
    if (this.warnings.length < 50) this.warnings.push("第 " + line + " 行：" + msg);
  }; Interp.prototype.write = function (s) { if (!s) return;
    this.out += s; if (this.out.length > MAX_OUTPUT) throw rawErr("输出内容过多，程序可能陷入了死循环");
  }; Interp.prototype.run = function () { var i;
    for (i = 0; i < this.prog.globals.length; i++) this.exec(this.prog.globals[i], this.global);
    var mainList = this.funcs["main"], main = mainList ? mainList[0] : null;
    if (!main || !main.body) throw err(1, "未找到 main 函数");
    this.call(main, [], main.line);
  }; Interp.prototype.call = function (fn, args, line, argRefs) { if (this.depth >= MAX_DEPTH) throw rawErr("递归层数过深");
    this.depth++; var sc = new Scope(this.global), i;
    for (i = 0; i < fn.params.length; i++) { var p = fn.params[i];
      var v = i < args.length ? args[i] : 0, ref = argRefs ? argRefs[i] : null;
      if (p.ref) {
        if (ref) { var rc = new Cell(p.type, 0); rc.ref = ref; rc.ro = !!p.ro; sc.vars[p.name] = rc; }
        else if (p.ro) { var tmp = new Cell(p.type, coerceValue(p.type, v));
          sc.vars[p.name] = { t: p.type, v: 0, arr: null, ref: { k: "cell", cell: tmp }, ro: true };
        } else throw err(line || fn.line, "非 const 引用参数需要传入变量");
      } else sc.vars[p.name] = new Cell(p.type, coerceValue(p.type, v));
    }
    var sig = this.exec(fn.body, sc); this.depth--;
    if (sig) { if (sig.k === "return") return coerceValue(fn.ret, sig.v);
      throw err(line || fn.line, "break / continue 只能出现在循环或 switch 中");
    }
    return 0;
  };
  /* ---------- 语句执行 ---------- */
  var BREAK = { k: "break" }, CONTINUE = { k: "continue" }; Interp.prototype.exec = function (n, scope) { this.tick();
    switch (n.type) { case "Block": { var bs = new Scope(scope);
        for (var i = 0; i < n.stmts.length; i++) { var s = this.exec(n.stmts[i], bs);
          if (s) return s;
        }
        return null;
      }
      case "Empty": return null; case "Decl": this.execDecl(n, scope); return null;
      case "ExprStmt": this.eval(n.expr, scope); return null;
      case "If":
        if (truthy(this.eval(n.cond, scope))) return this.exec(n.then, scope);
        if (n.els) return this.exec(n.els, scope); return null;
      case "While": { while (truthy(this.eval(n.cond, scope))) { var ws = this.exec(n.body, scope);
          if (ws) { if (ws.k === "break") return null;
            if (ws.k !== "continue") return ws;
          }
        }
        return null;
      }
      case "Do": { do { var ds = this.exec(n.body, scope);
          if (ds) { if (ds.k === "break") return null;
            if (ds.k !== "continue") return ds;
          }
        } while (truthy(this.eval(n.cond, scope))); return null;
      }
      case "For": { var fs = new Scope(scope);
        if (n.init) this.exec(n.init, fs);
        while (!n.cond || truthy(this.eval(n.cond, fs))) { var sig = this.exec(n.body, fs);
          if (sig) { if (sig.k === "break") break;
            if (sig.k !== "continue") return sig;
          }
          if (n.upd) this.eval(n.upd, fs);
        }
        return null;
      }
      case "Switch": return this.execSwitch(n, scope); case "Break": return BREAK; case "Continue": return CONTINUE;
      case "Return":
        return { k: "return", v: n.expr ? this.eval(n.expr, scope) : 0 };
      case "CppOut": this.execCout(n, scope); return null; case "CppIn": this.execCin(n, scope); return null;
      default: throw err(n.line, "内部错误：未知语句 " + n.type);
    }
  }; Interp.prototype.execSwitch = function (n, scope) { var val = toInt(this.eval(n.expr, scope));
    var start = -1, def = -1, i, j; for (i = 0; i < n.cases.length; i++) { var c = n.cases[i];
      if (c.isDefault) def = i; else if (!c.isDummy && toInt(c.val) === val && start < 0) start = i;
    }
    if (start < 0) start = def; if (start < 0) return null; var ss = new Scope(scope);
    for (i = start; i < n.cases.length; i++) {
      for (j = 0; j < n.cases[i].stmts.length; j++) { var s = this.exec(n.cases[i].stmts[j], ss);
        if (s) { if (s.k === "break") return null;
          return s;
        }
      }
    }
    return null;
  }; Interp.prototype.execDecl = function (n, scope) { for (var i = 0; i < n.items.length; i++) { var it = n.items[i];
      if (it.ref) {
        var ref;
        if (it.ro && !isLvalue(it.init)) {
          var tmp = new Cell(it.type, coerceValue(it.type, this.eval(it.init, scope)));
          ref = { k: "cell", cell: tmp };
        } else ref = this.evalRef(it.init, scope);
        var rc = new Cell(it.type, 0); rc.ref = ref; rc.ro = !!it.ro;
        scope.vars[it.name] = rc;
      } else if (it.dims && it.dims.length) { var arr = new Arr(it.et, it.dims, it.line);
        var cell = new Cell(T("array", 0), 0); cell.arr = arr;
        scope.vars[it.name] = cell; if (it.init) this.initArray(arr, it.init, 0, 0, scope);
      } else { var v = it.init ? this.eval(it.init, scope) : (isFloatT(it.type) ? 0 : 0);
        scope.vars[it.name] = new Cell(it.type, coerceValue(it.type, v));
      }
    }
  };
  Interp.prototype.storeElem = function (arr, idx, v, line) {
    if (idx < 0 || idx >= arr.data.length) { this.warn(line, "数组下标越界，写入被忽略");
      return;
    }
    arr.data[idx] = coerceValue(arr.et, v);
  }; Interp.prototype.storeString = function (arr, idx, s, line) { var i;
    for (i = 0; i < s.length; i++) {
      if (idx + i < 0 || idx + i >= arr.data.length) { this.warn(line, "字符串超出数组长度，多余部分被忽略");
        break;
      }
      arr.data[idx + i] = s.charCodeAt(i) & 0xFF;
    }
    if (idx + i >= 0 && idx + i < arr.data.length) arr.data[idx + i] = 0;
  }; Interp.prototype.initArray = function (arr, node, level, baseOff, scope) { if (level >= arr.dims.length) return;
    var stride = arr.stride[level], i; if (node.type === "InitList") { var items = node.items, hasList = false;
      for (i = 0; i < items.length; i++) {
        if (items[i].type === "InitList") { hasList = true; break; }
        if (arr.et.b === "char" && items[i].type === "Str" && level < arr.dims.length - 1) { hasList = true; break; }
      }
      if (hasList) { for (i = 0; i < items.length && i < arr.dims[level]; i++) { var off = baseOff + i * stride;
          if (items[i].type === "InitList") this.initArray(arr, items[i], level + 1, off, scope);
          else if (items[i].type === "Str") this.storeString(arr, off, items[i].s, items[i].line);
          else this.storeElem(arr, off, this.eval(items[i], scope), items[i].line);
        }
      } else { for (i = 0; i < items.length; i++) { var idx = baseOff + i;
          if (idx >= arr.data.length) break;
          if (items[i].type === "Str") this.storeString(arr, idx, items[i].s, items[i].line);
          else this.storeElem(arr, idx, this.eval(items[i], scope), items[i].line);
        }
      }
    } else if (node.type === "Str") { this.storeString(arr, baseOff, node.s, node.line);
    } else { this.storeElem(arr, baseOff, this.eval(node, scope), node.line);
    }
  };
  /* ---------- 表达式求值 ---------- */
  Interp.prototype.eval = function (n, scope) { this.tick();
    switch (n.type) { case "Num": return n.value;
      case "Str": return n.s; case "Id": { var c = scope.find(n.name);
        if (!c) throw err(n.line, "变量 " + n.name + " 未定义"); if (c.arr) return { __p: 1, arr: c.arr, off: 0, dim: 0 };
        if (c.ref) return this.refGet(c.ref);
        return c.v;
      }
      case "Comma": this.eval(n.l, scope); return this.eval(n.r, scope);
      case "Assign": return this.evalAssign(n, scope); case "Binary": return this.evalBinary(n, scope);
      case "Unary": return this.evalUnary(n, scope);
      case "Pre":
      case "Post": return this.evalIncDec(n, scope);
      case "Cond": return truthy(this.eval(n.c, scope)) ? this.eval(n.a, scope) : this.eval(n.b, scope);
      case "Cast": { var cv = this.eval(n.expr, scope);
        return n.to.p > 0 ? cv : coerceValue(n.to, cv);
      }
      case "Sizeof": return n.value; case "Call": return this.evalCall(n, scope);
      case "Index": { var r = this.indexOf(n, scope);
        return isRefVal(r) ? this.refGet(r) : r;
      }
      default: throw err(n.line, "内部错误：未知表达式 " + n.type);
    }
  }; Interp.prototype.evalUnary = function (n, scope) { if (n.op === "&") { var ref = this.evalRef(n.expr, scope);
      return this.ptrFromRef(ref);
    }
    var v = this.eval(n.expr, scope); switch (n.op) { case "*": { var dr = this.derefRef(v, n.line);
        return isRefVal(dr) ? this.refGet(dr) : dr;
      }
      case "-": return isPtrVal(v) ? v : -toNum(v); case "+": return toNum(v);
      case "!": return truthy(v) ? 0 : 1; case "~": return ~toInt(v);
    }
    throw err(n.line, "内部错误：未知一元运算 " + n.op);
  }; Interp.prototype.evalIncDec = function (n, scope) { var ref = this.evalRef(n.expr, scope);
    var old = this.refGet(ref), nv; if (isPtrVal(old)) { nv = this.ptrAdd(old, n.op === "++" ? 1 : -1, n.line);
    } else if (typeof old === "string") { nv = { __p: 1, str: old, off: n.op === "++" ? 1 : -1 };
    } else { nv = toNum(old) + (n.op === "++" ? 1 : -1);
    }
    this.refSet(ref, nv, n.line); return n.type === "Post" ? old : this.refGet(ref);
  }; Interp.prototype.evalAssign = function (n, scope) { var ref = this.evalRef(n.l, scope);
    var val; if (n.op === "=") { val = this.eval(n.r, scope); } else { var cur = this.refGet(ref);
      var rhs = this.eval(n.r, scope); var baseOp = n.op.slice(0, n.op.length - 1);
      val = this.binop(baseOp, cur, rhs, n);
    }
    this.refSet(ref, val, n.line); return this.refGet(ref);
  };
  Interp.prototype.evalBinary = function (n, scope) {
    if (n.op === "&&") { if (!truthy(this.eval(n.l, scope))) return 0;
      return truthy(this.eval(n.r, scope)) ? 1 : 0;
    }
    if (n.op === "||") { if (truthy(this.eval(n.l, scope))) return 1;
      return truthy(this.eval(n.r, scope)) ? 1 : 0;
    }
    var a = this.eval(n.l, scope); var b = this.eval(n.r, scope); return this.binop(n.op, a, b, n);
  }; Interp.prototype.binop = function (op, a, b, n) { var line = n.line;
    switch (op) {
      case "+":
        if (isPtrVal(a) || typeof a === "string") {
          if (isPtrVal(b) || typeof b === "string") throw err(line, "两个指针不能相加");
          return this.ptrAdd(a, toInt(b), line);
        }
        if (isPtrVal(b) || typeof b === "string") return this.ptrAdd(b, toInt(a), line); return toNum(a) + toNum(b);
      case "-":
        if (isPtrVal(a) || typeof a === "string") {
          if (isPtrVal(b) || typeof b === "string") {
            if (isPtrVal(a) && isPtrVal(b) && a.arr === b.arr) return (a.off || 0) - (b.off || 0); return 0;
          }
          return this.ptrAdd(a, -toInt(b), line);
        }
        return toNum(a) - toNum(b);
      case "*": return toNum(a) * toNum(b); case "/": { var x = toNum(a), y = toNum(b);
        if (y === 0) throw err(line, "除数不能为零"); return isFloatT(n.t) ? x / y : Math.trunc(x / y);
      }
      case "%": { var m = toInt(a), k = toInt(b);
        if (k === 0) throw err(line, "除数不能为零"); return m % k;
      }
      case "<<": return toInt(a) << (toInt(b) & 31); case ">>": return toInt(a) >> (toInt(b) & 31);
      case "&": return toInt(a) & toInt(b); case "|": return toInt(a) | toInt(b);
      case "^": return toInt(a) ^ toInt(b); case "==": return eqVal(a, b) ? 1 : 0;
      case "!=": return eqVal(a, b) ? 0 : 1; case "<": return cmpVal(a, b) < 0 ? 1 : 0;
      case ">": return cmpVal(a, b) > 0 ? 1 : 0; case "<=": return cmpVal(a, b) <= 0 ? 1 : 0;
      case ">=": return cmpVal(a, b) >= 0 ? 1 : 0;
    }
    throw err(line, "内部错误：未知运算符 " + op);
  };
  function cmpVal(a, b) {
    if (isPtrVal(a) && isPtrVal(b)) { if (a.arr && b.arr && a.arr === b.arr) return (a.off || 0) - (b.off || 0);
      return 0;
    }
    if (typeof a === "string" && typeof b === "string") return a < b ? -1 : (a > b ? 1 : 0);
    return toNum(a) - toNum(b);
  }
  Interp.prototype.ptrAdd = function (p, n, line) { if (typeof p === "string") return { __p: 1, str: p, off: n };
    if (!isPtrVal(p)) throw err(line, "指针运算需要指针");
    if (p.str != null) return { __p: 1, str: p.str, off: (p.off || 0) + n };
    if (p.arr) { var d = p.dim || 0, st = p.arr.stride[d];
      if (st == null) throw err(line, "数组维度使用错误"); return { __p: 1, arr: p.arr, off: (p.off || 0) + n * st, dim: d };
    }
    if (p.cell) return { __p: 1, cell: p.cell, off: (p.off || 0) + n }; return p;
  }; Interp.prototype.derefRef = function (p, line) { if (isNullPtr(p)) throw err(line, "空指针解引用");
    if (typeof p === "string") return { k: "str", s: p, i: 0 }; if (!isPtrVal(p)) throw err(line, "不能解引用非指针");
    if (p.str != null) return { k: "str", s: p.str, i: p.off || 0 }; if (p.arr) { var d = p.dim || 0;
      if (d < p.arr.dims.length - 1) return { __p: 1, arr: p.arr, off: p.off || 0, dim: d + 1 };
      return { k: "elem", arr: p.arr, i: p.off || 0 };
    }
    if (p.cell) { if ((p.off || 0) === 0) return { k: "cell", cell: p.cell };
      return { k: "oob" };
    }
    return { k: "oob" };
  }; Interp.prototype.indexOf = function (n, scope) { var base = this.eval(n.base, scope);
    var idx = toInt(this.eval(n.index, scope));
    if (isPtrVal(base)) { if (base.arr) { var d = base.dim || 0, st = base.arr.stride[d];
        if (st == null) throw err(n.line, "数组维度使用错误"); var off = (base.off || 0) + idx * st, nd = d + 1;
        if (nd >= base.arr.dims.length) return { k: "elem", arr: base.arr, i: off };
        return { __p: 1, arr: base.arr, off: off, dim: nd };
      }
      if (base.cell) return idx === 0 ? { k: "cell", cell: base.cell } : { k: "oob" };
      if (base.str != null) return { k: "str", s: base.str, i: (base.off || 0) + idx }; return { k: "oob" };
    }
    if (typeof base === "string") return { k: "str", s: base, i: idx }; throw err(n.line, "只能对数组或指针使用下标");
  }; Interp.prototype.evalRef = function (n, scope) { if (n.type === "Id") { var c = scope.find(n.name);
      if (!c) throw err(n.line, "变量 " + n.name + " 未定义"); if (c.arr) return { k: "arr", cell: c };
      if (c.ref) return c.ro ? { k: "ro", ref: c.ref } : c.ref;
      return { k: "cell", cell: c };
    }
    if (n.type === "Index") { var r = this.indexOf(n, scope);
      if (isRefVal(r)) { if (r.k === "ptr") return r;
        return r;
      }
      return { k: "ptr", p: r };
    }
    if (n.type === "Unary" && n.op === "*") { var dr = this.derefRef(this.eval(n.expr, scope), n.line);
      return isRefVal(dr) ? dr : { k: "ptr", p: dr };
    }
    throw err(n.line, "此处需要变量");
  }; Interp.prototype.refGet = function (r) { switch (r.k) { case "cell": return r.cell.v;
      case "elem": { var i = r.i;
        if (i < 0 || i >= r.arr.data.length) { this.warn(r.arr.line || 0, "数组下标越界，读取返回 0"); return 0; }
        return r.arr.data[i];
      }
      case "str": { if (r.i < 0 || r.i >= r.s.length) return 0;
        return r.s.charCodeAt(r.i);
      }
      case "arr": return { __p: 1, arr: r.cell.arr, off: 0, dim: 0 }; case "ptr": return r.p; case "oob": return 0;
      case "ro": return this.refGet(r.ref);
    }
    return 0;
  };
  Interp.prototype.refSet = function (r, v, line) {
    switch (r.k) { case "cell": r.cell.v = coerceValue(r.cell.t, v); return;
      case "elem": {
        if (r.i < 0 || r.i >= r.arr.data.length) { this.warn(line, "数组下标越界，写入被忽略"); return; }
        r.arr.data[r.i] = coerceValue(r.arr.et, v); return;
      }
      case "str": this.warn(line, "字符串常量不能修改"); return; case "arr": throw err(line, "数组名不能被整体赋值");
      case "ptr": if (r.p && r.p.cell) { r.p.cell.v = coerceValue(r.p.cell.t, v); return; } this.warn(line, "无效的指针赋值"); return;
      case "oob": this.warn(line, "数组下标越界，写入被忽略"); return;
      case "ro": throw err(line, "不能修改 const 引用");
    }
  }; Interp.prototype.ptrFromRef = function (r) { if (r.k === "cell") return { __p: 1, cell: r.cell, off: 0 };
    if (r.k === "elem") return { __p: 1, arr: r.arr, off: r.i, dim: r.arr.dims.length - 1 };
    if (r.k === "arr") return { __p: 1, arr: r.cell.arr, off: 0, dim: 0 };
    if (r.k === "str") return { __p: 1, str: r.s, off: r.i }; if (r.k === "ptr") return r.p;
    if (r.k === "ro") return this.ptrFromRef(r.ref);
    return 0;
  };
  /* ---------- 函数调用与内建 ---------- */
  Interp.prototype.evalCall = function (n, scope) { var infos = [], args = [], i;
    for (i = 0; i < n.args.length; i++) {
      var node = n.args[i], info = { ref: null, val: null };
      if (isLvalue(node)) {
        info.ref = this.evalRef(node, scope);
        info.val = this.refGet(info.ref);
      } else info.val = this.eval(node, scope);
      infos.push(info); args.push(info.val);
    }
    if (n.name === "printf") { if (!args.length) throw err(n.line, "printf 缺少格式字符串");
      var text = cFormat(String(args[0]), args.slice(1), n.line, this); this.write(text); return text.length;
    }
    if (n.name === "scanf") { if (!args.length) throw err(n.line, "scanf 缺少格式字符串");
      return doScanf(String(args[0]), args.slice(1), this, n.line);
    }
    if (n.name === "putchar") { this.write(String.fromCharCode(toInt(args[0]) & 0xFFFF));
      return toInt(args[0]);
    }
    if (n.name === "getchar") return this.input.readCharCode();
    var fn = this.pickRuntime(n, args);
    if (!fn) {
      if (!this.funcs[n.name]) throw err(n.line, "函数 " + n.name + " 未定义");
      throw err(n.line, "函数 " + n.name + " 没有匹配参数的重载");
    }
    var refs = [];
    for (i = 0; i < fn.params.length; i++) refs.push(infos[i] ? infos[i].ref : null);
    return this.call(fn, args, n.line, refs);
  };
  Interp.prototype.pickRuntime = function (n, vals) {
    var list = this.funcs[n.name];
    if (!list) return null;
    if (n.sig && list.indexOf(n.sig) >= 0) return n.sig;
    if (list.length === 1) return list[0];
    var best = null, bestScore = -1, k, i;
    for (k = 0; k < list.length; k++) {
      var sig = list[k];
      if (sig.params.length !== vals.length) continue;
      var sc = 0, ok = true;
      for (i = 0; i < vals.length; i++) {
        var p = sig.params[i], v = vals[i], s;
        if (p.type.p > 0) s = (isPtrVal(v) || typeof v === "string") ? 3 : (toNum(v) === 0 ? 1 : -1);
        else if (isFloatT(p.type)) s = (typeof v === "number" && !Number.isInteger(v)) ? 3 : 1;
        else s = (typeof v === "number" && Number.isInteger(v)) ? 3 : 1;
        if (s < 0) { ok = false; break; }
        sc += s;
      }
      if (ok && sc > bestScore) { best = sig; bestScore = sc; }
    }
    return best;
  };
  /* =========================================================
     七、printf / scanf
     ========================================================= */
  function padStr(s, width, flags, numeric) { if (!width || s.length >= width) return s;
    var pad = width - s.length; var left = flags.indexOf("-") >= 0;
    var zero = flags.indexOf("0") >= 0 && !left && numeric; if (left) return s + new Array(pad + 1).join(" ");
    if (zero) {
      if (s.charAt(0) === "-" || s.charAt(0) === "+") {
        return s.charAt(0) + new Array(pad + 1).join("0") + s.slice(1);
      }
      return new Array(pad + 1).join("0") + s;
    }
    return new Array(pad + 1).join(" ") + s;
  }
  function addSign(s, neg, flags) { if (neg) return "-" + s;
    if (flags.indexOf("+") >= 0) return "+" + s; if (flags.indexOf(" ") >= 0) return " " + s; return s;
  }
  function cFormat(fmt, args, line, interp) { var out = "", ai = 0, i;
    for (i = 0; i < fmt.length; i++) { var ch = fmt.charAt(i);
      if (ch !== "%") { out += ch; continue; }
      if (fmt.charAt(i + 1) === "%") { out += "%"; i++; continue; }
      var j = i + 1, flags = "";
      while (j < fmt.length && "-+ 0#".indexOf(fmt.charAt(j)) >= 0) { flags += fmt.charAt(j); j++; }
      if (fmt.charAt(j) === "*") throw err(line, "printf 暂不支持 * 动态宽度"); var widthStr = "";
      while (j < fmt.length && /[0-9]/.test(fmt.charAt(j))) { widthStr += fmt.charAt(j); j++; }
      var prec = -1; if (fmt.charAt(j) === ".") { j++;
        var ps = "";
        while (j < fmt.length && /[0-9]/.test(fmt.charAt(j))) { ps += fmt.charAt(j); j++; }
        prec = ps ? parseInt(ps, 10) : 0;
      }
      while (j < fmt.length && "lhLqjzt".indexOf(fmt.charAt(j)) >= 0) j++; var conv = fmt.charAt(j); j++; i = j - 1;
      var width = widthStr ? parseInt(widthStr, 10) : 0; var arg = ai < args.length ? args[ai++] : 0;
      var s, num = 0, neg = false;
      switch (conv) {
        case "d":
        case "i":
          num = toInt(arg); neg = num < 0;
          s = addSign(String(neg ? -num : num), neg, flags); out += padStr(s, width, flags, true); break;
        case "u":
          num = toInt(arg); if (num < 0) num = num >>> 0; s = String(num); out += padStr(s, width, flags, true);
          break;
        case "f":
        case "F": { var fv = toNum(arg), fs;
          if (isNaN(fv)) fs = "nan"; else if (!isFinite(fv)) fs = (fv < 0 ? "-inf" : "inf");
          else fs = fv.toFixed(prec < 0 ? 6 : prec); neg = fs.charAt(0) === "-";
          fs = addSign(neg ? fs.slice(1) : fs, neg, flags); out += padStr(fs, width, flags, true); break;
        }
        case "e":
        case "E": { var ev = toNum(arg), es;
          if (!isFinite(ev)) es = (ev < 0 ? "-inf" : "inf"); else { es = ev.toExponential(prec < 0 ? 6 : prec);
            es = es.replace(/e([+-])(\d)$/, "e$10$2"); if (conv === "E") es = es.toUpperCase();
          }
          neg = es.charAt(0) === "-"; es = addSign(neg ? es.slice(1) : es, neg, flags);
          out += padStr(es, width, flags, true); break;
        }
        case "g":
        case "G": { var gv = toNum(arg), gs;
          if (!isFinite(gv)) gs = (gv < 0 ? "-inf" : "inf");
          else { gs = gv.toPrecision(prec < 0 ? 6 : (prec === 0 ? 1 : prec));
            if (gs.indexOf("e") < 0) gs = gs.replace(/0+$/, "").replace(/\.$/, "");
            if (conv === "G") gs = gs.toUpperCase();
          }
          out += padStr(gs, width, flags, false); break;
        }
        case "c":
          s = String.fromCharCode(toInt(arg) & 0xFFFF); out += padStr(s, width, flags, false); break;
        case "s":
          s = readCString(arg); if (prec >= 0) s = s.slice(0, prec); out += padStr(s, width, flags, false); break;
        case "x":
        case "X":
        case "o": { var uv = toInt(arg);
          if (uv < 0) uv = uv >>> 0; s = uv.toString(conv === "o" ? 8 : 16);
          if (conv === "X") s = s.toUpperCase(); out += padStr(s, width, flags, true); break;
        }
        case "p":
          s = "0x" + (toInt(arg) >>> 0).toString(16); out += padStr(s, width, flags, true); break;
        default:
          throw err(line, "printf 暂不支持格式符 %" + conv);
      }
    }
    return out;
  }
  function Input(s) { this.s = s || ""; this.i = 0; }
  Input.prototype.eof = function () { return this.i >= this.s.length; };
  Input.prototype.peek = function () { return this.i < this.s.length ? this.s.charAt(this.i) : ""; };
  Input.prototype.skipWS = function () { while (this.i < this.s.length && /\s/.test(this.s.charAt(this.i))) this.i++;
  }; Input.prototype.readInt = function () { this.skipWS();
    var m = /^[+-]?\d+/.exec(this.s.slice(this.i)); if (!m) return null;
    this.i += m[0].length; return parseInt(m[0], 10);
  }; Input.prototype.readFloat = function () { this.skipWS();
    var m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(this.s.slice(this.i)); if (!m) return null;
    this.i += m[0].length; return parseFloat(m[0]);
  }; Input.prototype.readWord = function (max) { this.skipWS();
    var start = this.i;
    while (this.i < this.s.length && !/\s/.test(this.s.charAt(this.i))) { if (max && this.i - start >= max) break;
      this.i++;
    }
    return this.i > start ? this.s.slice(start, this.i) : null;
  }; Input.prototype.readChar = function () { if (this.i >= this.s.length) return null;
    return this.s.charAt(this.i++);
  }; Input.prototype.readCharCode = function () { var c = this.readChar();
    return c == null ? -1 : c.charCodeAt(0);
  };
  function writePtrValue(interp, ptr, v, line) {
    if (isPtrVal(ptr)) {
      if (ptr.cell) { ptr.cell.v = coerceValue(ptr.cell.t, v); return; }
      if (ptr.arr) { var i = ptr.off || 0;
        if (i < 0 || i >= ptr.arr.data.length) { interp.warn(line, "数组下标越界，scanf 写入被忽略"); return; }
        ptr.arr.data[i] = coerceValue(ptr.arr.et, v); return;
      }
      if (ptr.str != null) { interp.warn(line, "字符串常量不能修改"); return; }
    }
    throw err(line, "scanf 需要一个地址参数，例如 &x");
  }
  function writePtrString(interp, ptr, s, line) { if (isPtrVal(ptr)) { if (ptr.arr) { var start = ptr.off || 0;
        if (start < 0 || start >= ptr.arr.data.length) { interp.warn(line, "数组下标越界，scanf 写入被忽略");
          return;
        }
        var i;
        for (i = 0; i < s.length && start + i < ptr.arr.data.length - 1; i++) {
          ptr.arr.data[start + i] = s.charCodeAt(i) & 0xFF;
        }
        ptr.arr.data[start + i] = 0; return;
      }
      if (ptr.cell) { ptr.cell.v = coerceValue(ptr.cell.t, s.charCodeAt(0)); return; }
      if (ptr.str != null) { interp.warn(line, "字符串常量不能修改"); return; }
    }
    throw err(line, "scanf 的 %s 需要字符数组或字符指针");
  }
  function doScanf(fmt, args, interp, line) { var input = interp.input, count = 0, ai = 0, i;
    for (i = 0; i < fmt.length; i++) { var ch = fmt.charAt(i);
      if (ch === " " || ch === "\t" || ch === "\n") { input.skipWS(); continue; }
      if (ch !== "%") { if (input.peek() === ch) input.i++;
        else break; continue;
      }
      i++; if (fmt.charAt(i) === "%") { if (input.peek() === "%") input.i++;
        else break; continue;
      }
      var width = 0;
      while (i < fmt.length && /[0-9]/.test(fmt.charAt(i))) { width = width * 10 + parseInt(fmt.charAt(i), 10); i++; }
      while (i < fmt.length && "lhL".indexOf(fmt.charAt(i)) >= 0) i++; var conv = fmt.charAt(i);
      var ptr = ai < args.length ? args[ai++] : null;
      if (conv === "d" || conv === "i" || conv === "u") { var iv = input.readInt();
        if (iv == null) break; writePtrValue(interp, ptr, iv, line); count++;
      } else if (conv === "f" || conv === "e" || conv === "g") { var fv = input.readFloat();
        if (fv == null) break; writePtrValue(interp, ptr, fv, line); count++;
      } else if (conv === "c") { var cv = input.readChar();
        if (cv == null) break; writePtrValue(interp, ptr, cv.charCodeAt(0), line); count++;
      } else if (conv === "s") { var w = input.readWord(width || 0);
        if (w == null) break; writePtrString(interp, ptr, w, line); count++;
      } else { throw err(line, "scanf 暂不支持格式符 %" + conv);
      }
    }
    return count;
  }
  /* =========================================================
     八、C++ cout / cin
     ========================================================= */
  Interp.prototype.execCout = function (n, scope) {
    var mode = { fixed: false, scientific: false, prec: -1, width: 0, boolalpha: false };
    for (var i = 0; i < n.parts.length; i++) { var p = n.parts[i];
      if (p.kind === "endl") { this.write("\n"); continue; }
      if (p.kind === "fixed") { mode.fixed = true; continue; }
      if (p.kind === "scientific") { mode.scientific = true; continue; }
      if (p.kind === "boolalpha") { mode.boolalpha = true; continue; }
      if (p.kind === "prec") { mode.prec = toInt(this.eval(p.expr, scope)); continue; }
      if (p.kind === "width") { mode.width = toInt(this.eval(p.expr, scope)); continue; }
      var v = this.eval(p.expr, scope); var s = this.coutText(v, p.expr.t, mode);
      if (mode.width > s.length) s = new Array(mode.width - s.length + 1).join(" ") + s; this.write(s);
      mode.width = 0;
    }
  };
  Interp.prototype.coutText = function (v, t, mode) {
    if (t && t.b === "bool" && mode.boolalpha) return truthy(v) ? "true" : "false";
    if (typeof v === "string") return v;
    if (isPtrVal(v)) { if (v.str != null || (v.arr && v.arr.et.b === "char")) return readCString(v);
      return "0";
    }
    if (t && t.p === 0 && t.b === "char") return String.fromCharCode(toInt(v) & 0xFFFF);
    if (t && isFloatT(t)) return coutDouble(toNum(v), mode); return String(toInt(v));
  }; function coutDouble(v, mode) { if (isNaN(v)) return "nan";
    if (!isFinite(v)) return v < 0 ? "-inf" : "inf"; if (mode.fixed) return v.toFixed(mode.prec < 0 ? 6 : mode.prec);
    if (mode.scientific) { var s = v.toExponential(mode.prec < 0 ? 6 : mode.prec);
      return s.replace(/e([+-])(\d)$/, "e$10$2");
    }
    if (v === 0) return "0"; var out = v.toPrecision(mode.prec > 0 ? mode.prec : 6);
    if (out.indexOf("e") < 0 && out.indexOf(".") >= 0) { out = out.replace(/0+$/, "").replace(/\.$/, "");
    }
    return out;
  }
  Interp.prototype.execCin = function (n, scope) {
    for (var i = 0; i < n.parts.length; i++) { var target = n.parts[i], cell = null;
      if (target.type === "Id") cell = scope.find(target.name);
      if (cell && cell.arr) { var w = this.input.readWord(0);
        if (w == null) continue; writePtrString(this, { __p: 1, arr: cell.arr, off: 0, dim: 0 }, w, n.line); continue;
      }
      var ref = this.evalRef(target, scope); var t = target.t || INT; if (t.p > 0) { var pv = this.refGet(ref);
        var ws = this.input.readWord(0); if (ws == null) continue; writePtrString(this, pv, ws, n.line); continue;
      }
      if (t.b === "char") { this.input.skipWS();
        var c = this.input.readChar(); if (c == null) continue; this.refSet(ref, c.charCodeAt(0), n.line);
      } else if (isFloatT(t)) { var d = this.input.readFloat();
        if (d == null) continue; this.refSet(ref, d, n.line);
      } else { var iv = this.input.readInt();
        if (iv == null) continue; this.refSet(ref, iv, n.line);
      }
    }
  };
  /* =========================================================
     九、对外入口
     ========================================================= */
  function runC(code, stdin) { var interp = null;
    try { var toks = lex(preprocess(code));
      var prog = new Parser(toks).parseProgram(); interp = new Interp(prog, stdin == null ? "" : String(stdin));
      interp.run(); return { ok: true, out: interp.out, err: "", warnings: interp.warnings.slice() };
    } catch (e) { var out = interp ? interp.out : "";
      var warnings = interp ? interp.warnings.slice() : []; var msg;
      if (e instanceof CRunError) { msg = e.raw ? e.msg : ("第 " + e.line + " 行：" + e.msg);
      } else if (e instanceof RangeError) { msg = interp ? "递归层数过深" : "代码嵌套过深，无法解析"; } else if (e && e.message) { msg = "解释器内部错误：" + e.message;
      } else { msg = "解释器内部错误";
      }
      return { ok: false, out: out, err: msg, warnings: warnings };
    }
  }
  if (typeof window !== "undefined") window.runC = runC;
  if (typeof module !== "undefined" && module.exports) module.exports = { runC: runC };
})();
