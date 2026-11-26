/* assets/pyrun.js —— 浏览器内迷你 Python 3 解释器（纯静态站判题用）
 * 对外接口：runPy(code, stdin) -> {ok, out, err}
 * 支持：缩进块、赋值、int/float/str/bool/None、list/dict/tuple、字符串方法与切片、
 *      f-string、if/for/while、函数(默认参数)、lambda、sorted(key=)、math、print/input。
 * 安全：200 万步、65536 字符输出、10000 层递归上限；任何异常都不抛给页面。
 * 单文件、无依赖、同步执行、不使用 eval、不使用 ESM。
 */
(function (root) {
  'use strict';
  var MAX_STEPS = 2000000, MAX_OUTPUT = 65536, MAX_DEPTH = 10000, MAX_REPEAT = 1000000;
  var RT = null; // 本次运行的上下文（步数、输出、行号、stdin 等）
  // ===== 错误、控制流信号与安全护栏 =====
  function PyErr(m) { this.message = m; }
  function PyFloat(v) { this.v = v; } // 浮点包装：区分 2 与 2.0
  function PyRange(a, b, c) { this.start = a; this.stop = b; this.step = c; }
  var SIG_BREAK = { __sig: 'break' }, SIG_CONTINUE = { __sig: 'continue' }, BREAK_OUT = { __breakOut: true };
  function fail(m) { throw new PyErr('第 ' + RT.line + ' 行：' + m); }
  function failAt(l, m) { throw new PyErr('第 ' + l + ' 行：' + m); }
  function step() { if (++RT.steps > MAX_STEPS) throw new PyErr('程序运行超时，可能存在死循环'); }
  function emit(s) { RT.buf.push(s); RT.outLen += s.length; if (RT.outLen > MAX_OUTPUT) throw new PyErr('输出内容过多，程序可能陷入了死循环'); }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  // ===== 值模型、显示与比较 =====
  function isNumLike(v) { return typeof v === 'number' || typeof v === 'boolean' || v instanceof PyFloat; }
  function num(v) { if (typeof v === 'number') return v; if (typeof v === 'boolean') return v ? 1 : 0; if (v instanceof PyFloat) return v.v; fail('类型错误：' + typeName(v) + ' 不是数字'); }
  function toIntVal(v, what) {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number' && Math.floor(v) === v) return v;
    if (v instanceof PyFloat && Math.floor(v.v) === v.v) return v.v; // 宽容：3.0 可当下标
    fail(what + '必须是整数');
  }
  function typeName(v) {
    if (v === null || v === undefined) return 'NoneType';
    if (typeof v === 'boolean') return 'bool';
    if (typeof v === 'number') return 'int';
    if (v instanceof PyFloat) return 'float';
    if (typeof v === 'string') return 'str';
    if (Array.isArray(v)) return v.__tuple ? 'tuple' : 'list';
    if (v instanceof Map) return 'dict';
    if (v instanceof PyRange) return 'range';
    if (typeof v === 'function') return 'built-in function';
    if (v && v.__pyfunc) return 'function';
    if (v && v.__math) return 'module';
    return 'object';
  }
  function truthy(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v instanceof PyFloat) return v.v !== 0;
    if (typeof v === 'string' || Array.isArray(v)) return v.length > 0;
    if (v instanceof Map) return v.size > 0;
    if (v instanceof PyRange) return rangeLen(v) > 0;
    return true;
  }
  // 浮点按 Python 风格显示：整数补 .0，极大/极小数用科学计数法
  function fmtFloat(x) {
    if (x !== x) return 'nan';
    if (x === Infinity) return 'inf';
    if (x === -Infinity) return '-inf';
    if (x === 0) return 1 / x < 0 ? '-0.0' : '0.0';
    var ax = Math.abs(x), s;
    if (ax >= 1e16 || ax < 1e-4) s = x.toExponential().replace(/e([+\-])(\d)$/, 'e$10$2');
    else { s = String(x); if (s.indexOf('.') < 0 && s.indexOf('e') < 0) s += '.0'; }
    return s;
  }
  function quoteStr(s) {
    var q = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? '"' : "'", out = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === q) out += '\\' + q;
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else out += ch;
    }
    return q + out + q;
  }
  function pyRepr(v) { return typeof v === 'string' ? quoteStr(v) : pyStr(v); }
  function pyStr(v) {
    if (v === null || v === undefined) return 'None';
    if (typeof v === 'boolean') return v ? 'True' : 'False';
    if (typeof v === 'number') return String(v);
    if (v instanceof PyFloat) return fmtFloat(v.v);
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) { var it = []; for (var i = 0; i < v.length; i++) it.push(pyRepr(v[i])); if (v.__tuple) return '(' + it.join(', ') + (v.length === 1 ? ',)' : ')'); return '[' + it.join(', ') + ']'; }
    if (v instanceof Map) {
      var ps = [];
      v.forEach(function (val, key) { ps.push(pyRepr(key) + ': ' + pyRepr(val)); });
      return '{' + ps.join(', ') + '}';
    }
    if (v instanceof PyRange) {
      return v.step === 1 ? 'range(' + v.start + ', ' + v.stop + ')'
        : 'range(' + v.start + ', ' + v.stop + ', ' + v.step + ')';
    }
    if (v && v.__math) return "<module 'math'>";
    if (v && v.__pyfunc) return '<function ' + (v.node.name || '<lambda>') + '>';
    if (typeof v === 'function') return '<built-in function>';
    return String(v);
  }
  function mkTuple(items) { var a = items.slice(); a.__tuple = true; return a; }
  function pyEq(a, b) {
    if (a === b) return true;
    if (isNumLike(a) && isNumLike(b)) return num(a) === num(b);
    if (a === null || b === null) return false;
    if (typeof a === 'string' || typeof b === 'string') return false;
    if (Array.isArray(a) && Array.isArray(b)) { if (!!a.__tuple !== !!b.__tuple || a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (!pyEq(a[i], b[i])) return false; return true; }
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      var ok = true;
      a.forEach(function (val, key) { if (!ok) return; if (!b.has(key) || !pyEq(val, b.get(key))) ok = false; });
      return ok;
    }
    if (a instanceof PyRange && b instanceof PyRange) return a.start === b.start && a.stop === b.stop && a.step === b.step;
    return false;
  }
  function pyCompare(a, b) {
    if (isNumLike(a) && isNumLike(b)) { var x = num(a), y = num(b); return x < y ? -1 : (x > y ? 1 : 0); }
    if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : (a > b ? 1 : 0);
    if (Array.isArray(a) && Array.isArray(b) && !!a.__tuple === !!b.__tuple) {
      var n = Math.min(a.length, b.length);
      for (var i = 0; i < n; i++) { var c = pyCompare(a[i], b[i]); if (c !== 0) return c; }
      return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
    }
    fail('类型错误：' + typeName(a) + ' 和 ' + typeName(b) + ' 不能比较大小');
  }
  // ===== 词法分析：一行源码 -> token 列表 =====
  var OPS = ['**=', '//=', '<<=', '>>=', '**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
    ':=', '->', '<<', '>>', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ':', ',', '.', ';', '@'];
  var NUM_RE = /^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+\-]?\d+)?)/;
  var ID_RE = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*/;
  var STR_PREFIX_RE = /^([rRbBuUfF]{1,2})(['"])/;
  function decodeEscapes(raw, line) {
    var out = '', i = 0;
    while (i < raw.length) {
      var ch = raw.charAt(i);
      if (ch !== '\\') { out += ch; i++; continue; }
      var n = raw.charAt(i + 1);
      switch (n) {
        case 'n': out += '\n'; i += 2; break;
        case 't': out += '\t'; i += 2; break;
        case 'r': out += '\r'; i += 2; break;
        case 'b': out += '\b'; i += 2; break;
        case 'f': out += '\f'; i += 2; break;
        case 'v': out += '\v'; i += 2; break;
        case 'a': out += '\x07'; i += 2; break;
        case '0': out += '\0'; i += 2; break;
        case '\\': case "'": case '"': out += n; i += 2; break;
        case '\n': i += 2; break; // 字符串内续行
        case 'x': {
          var hx = raw.substr(i + 2, 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hx)) failAt(line, '非法的 \\x 转义');
          out += String.fromCharCode(parseInt(hx, 16)); i += 4; break;
        }
        case 'u': {
          var hu = raw.substr(i + 2, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hu)) failAt(line, '非法的 \\u 转义');
          out += String.fromCharCode(parseInt(hu, 16)); i += 6; break;
        }
        case undefined: out += '\\'; i++; break;
        default: out += '\\' + n; i += 2; break; // 未知转义原样保留
      }
    }
    return out;
  }
  function tokenize(text, line) {
    var toks = [], i = 0;
    while (i < text.length) {
      var ch = text.charAt(i);
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') { i++; continue; }
      if (ch === '#') break;
      var pre = STR_PREFIX_RE.exec(text.slice(i));
      if (ch === '"' || ch === "'" || pre) {
        var q = pre ? pre[2] : ch, pfx = pre ? pre[1].toLowerCase() : '';
        if (pre) i += pre[1].length; // 只跳过前缀字母，i 停在起始引号上
        var triple = text.substr(i, 3) === q + q + q;
        i += triple ? 3 : 1;
        var raw = '', closed = false;
        while (i < text.length) {
          if (triple && text.substr(i, 3) === q + q + q) { i += 3; closed = true; break; }
          var cch = text.charAt(i);
          if (cch === '\\') { raw += cch; if (i + 1 < text.length) raw += text.charAt(i + 1); i += 2; continue; }
          if (!triple && cch === q) { i++; closed = true; break; }
          raw += cch; i++;
        }
        if (!closed) failAt(line, '字符串没有闭合（缺少结尾引号）');
        toks.push({ t: 'str', v: pfx.indexOf('r') >= 0 ? raw : decodeEscapes(raw, line), f: pfx.indexOf('f') >= 0, line: line });
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text.charAt(i + 1)))) {
        var nm = NUM_RE.exec(text.slice(i)), ns = nm[0];
        i += ns.length;
        var nv = /^0[xX]/.test(ns) ? parseInt(ns, 16) : (/^0[bB]/.test(ns) ? parseInt(ns.slice(2), 2) : Number(ns));
        toks.push({ t: 'num', v: nv, isFloat: /[.eE]/.test(ns), line: line });
        continue;
      }
      var im = ID_RE.exec(text.slice(i));
      if (im) { i += im[0].length; toks.push({ t: 'name', v: im[0], line: line }); continue; }
      var matched = false;
      for (var k = 0; k < OPS.length; k++) {
        if (text.substr(i, OPS[k].length) === OPS[k]) {
          toks.push({ t: 'op', v: OPS[k], line: line }); i += OPS[k].length; matched = true; break;
        }
      }
      if (!matched) failAt(line, '无法识别的字符 "' + ch + '"');
    }
    return toks;
  }
  // ===== 预处理：去注释、展开 Tab、合并续行/三引号/括号内换行 =====
  function preprocess(src) {
    src = String(src).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    var out = [], buf = '', line = 1, phys = 1, i = 0, str = null, depth = 0;
    function push() { if (buf.trim() !== '') out.push({ text: buf, line: line }); buf = ''; }
    while (i < src.length) {
      var ch = src.charAt(i);
      if (str) {
        if (ch === '\\') {
          buf += ch;
          if (i + 1 < src.length) {
            buf += src.charAt(i + 1);
            if (src.charAt(i + 1) === '\n') phys++;
            i += 2;
          } else i++;
          continue;
        }
        if (str.length === 3) {
          if (src.substr(i, 3) === str) { buf += str; i += 3; str = null; continue; }
          buf += ch; if (ch === '\n') phys++; i++; continue;
        }
        if (ch === '\n') failAt(phys, '字符串没有闭合（缺少结尾引号）');
        buf += ch; if (ch === str) str = null; i++; continue;
      }
      if (ch === '#') { while (i < src.length && src.charAt(i) !== '\n') i++; continue; }
      if (ch === '\n') {
        if (depth > 0) { buf += ' '; phys++; i++; continue; } // 括号内隐式续行
        push(); phys++; line = phys; i++; continue;
      }
      if (ch === '"' || ch === "'") { str = src.substr(i, 3) === ch + ch + ch ? ch + ch + ch : ch; buf += str; i += str.length; continue; }
      if (ch === '\\' && src.charAt(i + 1) === '\n') { buf += ' '; phys++; i += 2; continue; }
      if ('([{'.indexOf(ch) >= 0) depth++;
      else if (')]}'.indexOf(ch) >= 0) depth = Math.max(0, depth - 1);
      buf += ch; i++;
    }
    if (str) failAt(phys, '字符串没有闭合（缺少结尾引号）');
    push();
    return out;
  }
  // ===== 语法分析 =====
  var AUG_OPS = { '+=': '+', '-=': '-', '*=': '*', '/=': '/', '//=': '//', '%=': '%', '**=': '**' };
  var RESERVED = {
    if: 1, elif: 1, else: 1, for: 1, while: 1, def: 1, return: 1, break: 1, continue: 1, pass: 1,
    in: 1, and: 1, or: 1, not: 1, lambda: 1, import: 1, from: 1, as: 1, class: 1, try: 1, except: 1,
    finally: 1, with: 1, yield: 1, global: 1, nonlocal: 1, del: 1, assert: 1, raise: 1, async: 1, await: 1,
    match: 1, is: 1
  };
  var UNSUPPORTED = {
    class: '暂不支持 class，本站判题只支持 Python 基础语法',
    try: '暂不支持 try/except 异常处理，本站判题只支持 Python 基础语法',
    except: '暂不支持 try/except 异常处理，本站判题只支持 Python 基础语法',
    finally: '暂不支持 try/except 异常处理，本站判题只支持 Python 基础语法',
    with: '暂不支持 with 语句，本站判题只支持 Python 基础语法',
    yield: '暂不支持生成器 yield，本站判题只支持 Python 基础语法',
    nonlocal: '暂不支持 nonlocal，本站判题只支持 Python 基础语法',
    async: '暂不支持异步语法 async/await', await: '暂不支持异步语法 async/await',
    match: '暂不支持 match 语句', del: '暂不支持 del 语句', assert: '暂不支持 assert 语句', raise: '暂不支持 raise 语句'
  };
  function syntax(c, msg) { failAt(c.line, '语法错误：' + msg); }
  function peek(c, k) { return c.toks[c.pos + (k || 0)]; }
  function isOp(c, v, k) { var t = peek(c, k); return !!t && t.t === 'op' && t.v === v; }
  function isKw(c, v) { var t = peek(c); return !!t && t.t === 'name' && t.v === v; }
  function acceptOp(c, v) { if (isOp(c, v)) { c.pos++; return true; } return false; }
  function acceptKw(c, v) { if (isKw(c, v)) { c.pos++; return true; } return false; }
  function expectOp(c, v) { if (!acceptOp(c, v)) syntax(c, '缺少 "' + v + '"'); }
  function expectKw(c, v) { if (!acceptKw(c, v)) syntax(c, '缺少 "' + v + '"'); }
  function expectName(c) { var t = peek(c); if (!t || t.t !== 'name') syntax(c, '这里应该是一个名字'); c.pos++; return t; }
  function atStmtEnd(c) { return c.pos >= c.toks.length || isOp(c, ';'); }
  // ---- 表达式：递归下降，按 Python 优先级 ----
  function parseTest(c) {
    var line = c.line, e = parseOr(c);
    if (isKw(c, 'if')) {
      c.pos++;
      var test = parseOr(c);
      expectKw(c, 'else');
      return { k: 'cond', test: test, a: e, b: parseTest(c), line: line };
    }
    return e;
  }
  function parseTestList(c) {
    var line = c.line, first = parseTest(c);
    if (!isOp(c, ',')) return first;
    var items = [first];
    while (acceptOp(c, ',')) {
      if (atStmtEnd(c) || isOp(c, ')') || isOp(c, ']') || isOp(c, '}')) break;
      items.push(parseTest(c));
    }
    return { k: 'tuple', items: items, line: line };
  }
  function parseOr(c) {
    var line = c.line, left = parseAnd(c);
    while (acceptKw(c, 'or')) left = { k: 'or', l: left, r: parseAnd(c), line: line };
    return left;
  }
  function parseAnd(c) {
    var line = c.line, left = parseNot(c);
    while (acceptKw(c, 'and')) left = { k: 'and', l: left, r: parseNot(c), line: line };
    return left;
  }
  function parseNot(c) {
    var line = c.line;
    if (acceptKw(c, 'not')) return { k: 'not', e: parseNot(c), line: line };
    return parseComparison(c);
  }
  function cmpToken(c) {
    if (isOp(c, '==')) { c.pos++; return '=='; }
    if (isOp(c, '!=')) { c.pos++; return '!='; }
    if (isOp(c, '<')) { c.pos++; return '<'; }
    if (isOp(c, '>')) { c.pos++; return '>'; }
    if (isOp(c, '<=')) { c.pos++; return '<='; }
    if (isOp(c, '>=')) { c.pos++; return '>='; }
    if (isKw(c, 'in')) { c.pos++; return 'in'; }
    if (isKw(c, 'not') && peek(c, 1) && peek(c, 1).v === 'in') { c.pos += 2; return 'not in'; }
    if (isKw(c, 'is')) { c.pos++; return acceptKw(c, 'not') ? 'is not' : 'is'; }
    return null;
  }
  function parseComparison(c) {
    var line = c.line, first = parseAdd(c), ops = [], parts = [first], op;
    while ((op = cmpToken(c))) { ops.push(op); parts.push(parseAdd(c)); }
    return ops.length ? { k: 'cmp', ops: ops, parts: parts, line: line } : first;
  }
  function parseAdd(c) {
    var line = c.line, left = parseMul(c);
    while (isOp(c, '+') || isOp(c, '-')) { var op = c.toks[c.pos++].v; left = { k: 'bin', op: op, l: left, r: parseMul(c), line: line }; }
    return left;
  }
  function parseMul(c) {
    var line = c.line, left = parseFactor(c);
    while (isOp(c, '*') || isOp(c, '/') || isOp(c, '//') || isOp(c, '%')) {
      var op = c.toks[c.pos++].v;
      left = { k: 'bin', op: op, l: left, r: parseFactor(c), line: line };
    }
    return left;
  }
  function parseFactor(c) {
    var line = c.line;
    if (isOp(c, '-')) { c.pos++; return { k: 'unary', op: '-', e: parseFactor(c), line: line }; }
    if (isOp(c, '+')) { c.pos++; return { k: 'unary', op: '+', e: parseFactor(c), line: line }; }
    return parsePower(c);
  }
  function parsePower(c) {
    var line = c.line, base = parsePostfix(c);
    if (isOp(c, '**')) { c.pos++; return { k: 'bin', op: '**', l: base, r: parseFactor(c), line: line }; }
    return base;
  }
  function parsePostfix(c) {
    var e = parseAtom(c);
    for (;;) {
      if (isOp(c, '(')) e = parseCall(c, e);
      else if (isOp(c, '[')) e = parseSubscript(c, e);
      else if (isOp(c, '.')) { c.pos++; var t = expectName(c); e = { k: 'attr', obj: e, name: t.v, line: t.line }; }
      else break;
    }
    return e;
  }
  function parseCall(c, callee) {
    var line = c.line;
    expectOp(c, '(');
    var args = [], kwargs = {};
    while (!isOp(c, ')')) {
      if (isOp(c, '*') || isOp(c, '**')) syntax(c, '暂不支持 *args / **kwargs 参数展开');
      var t = peek(c);
      if (t && t.t === 'name' && isOp(c, '=', 1) && !RESERVED[t.v]) {
        c.pos += 2;
        if (has(kwargs, t.v)) syntax(c, '关键字参数 ' + t.v + ' 重复');
        kwargs[t.v] = parseTest(c);
      } else args.push(parseTest(c));
      if (!acceptOp(c, ',')) break;
      if (isOp(c, ')')) break;
    }
    expectOp(c, ')');
    return { k: 'call', fn: callee, args: args, kwargs: kwargs, line: line };
  }
  function parseSubscript(c, obj) {
    var line = c.line;
    expectOp(c, '[');
    var lo = null, hi = null, st = null, isSlice = false;
    if (!isOp(c, ':')) lo = parseTest(c);
    if (isOp(c, ':')) {
      isSlice = true; c.pos++;
      if (!isOp(c, ']') && !isOp(c, ':')) hi = parseTest(c);
      if (isOp(c, ':')) { c.pos++; if (!isOp(c, ']')) st = parseTest(c); }
    }
    expectOp(c, ']');
    return isSlice ? { k: 'slice', obj: obj, lo: lo, hi: hi, step: st, line: line }
      : { k: 'index', obj: obj, idx: lo, line: line };
  }
  function parseAtom(c) {
    var t = peek(c);
    if (!t) syntax(c, '表达式不完整');
    var line = t.line;
    if (t.t === 'num') {
      c.pos++;
      return { k: 'num', v: t.isFloat ? new PyFloat(t.v) : t.v, line: line };
    }
    if (t.t === 'str') {
      var ss = [];
      while (peek(c) && peek(c).t === 'str') ss.push(c.toks[c.pos++]);
      if (ss.length === 1) return ss[0].f ? parseFString(ss[0].v, ss[0].line) : { k: 'str', v: ss[0].v, line: line };
      var parts = [], anyF = false;
      ss.forEach(function (tk) {
        if (tk.f) {
          anyF = true;
          var pn = parseFString(tk.v, tk.line);
          for (var q = 0; q < pn.parts.length; q++) parts.push(pn.parts[q]);
        } else parts.push(tk.v);
      });
      if (anyF) return { k: 'fstr', parts: parts, line: line };
      return { k: 'str', v: ss.map(function (x) { return x.v; }).join(''), line: line };
    }
    if (t.t === 'name') {
      if (t.v === 'True') { c.pos++; return { k: 'num', v: true, line: line }; }
      if (t.v === 'False') { c.pos++; return { k: 'num', v: false, line: line }; }
      if (t.v === 'None') { c.pos++; return { k: 'num', v: null, line: line }; }
      if (t.v === 'lambda') return parseLambda(c);
      if (RESERVED[t.v]) syntax(c, '这里不能使用关键字 "' + t.v + '"');
      c.pos++;
      return { k: 'name', id: t.v, line: line };
    }
    if (t.t === 'op' && t.v === '(') {
      c.pos++;
      if (acceptOp(c, ')')) return { k: 'tuple', items: [], line: line };
      var first = parseTest(c);
      if (isKw(c, 'for')) syntax(c, '暂不支持生成器表达式');
      if (isOp(c, ',')) {
        var items = [first];
        while (acceptOp(c, ',')) { if (isOp(c, ')')) break; items.push(parseTest(c)); }
        expectOp(c, ')');
        return { k: 'tuple', items: items, line: line };
      }
      expectOp(c, ')');
      return first;
    }
    if (t.t === 'op' && t.v === '[') {
      c.pos++;
      if (acceptOp(c, ']')) return { k: 'list', items: [], line: line };
      var elt = parseTest(c);
      if (isKw(c, 'for')) {
        c.pos++;
        var target = parseTargetList(c);
        expectKw(c, 'in');
        var iter = parseOr(c), cond = null;
        if (acceptKw(c, 'if')) cond = parseTest(c);
        if (isKw(c, 'for')) syntax(c, '暂不支持多重 for 的列表推导式');
        expectOp(c, ']');
        return { k: 'comp', elt: elt, target: target, iter: iter, cond: cond, line: line };
      }
      var litems = [elt];
      while (acceptOp(c, ',')) { if (isOp(c, ']')) break; litems.push(parseTest(c)); }
      expectOp(c, ']');
      return { k: 'list', items: litems, line: line };
    }
    if (t.t === 'op' && t.v === '{') {
      c.pos++;
      var pairs = [];
      if (!isOp(c, '}')) {
        for (;;) {
          var key = parseTest(c);
          if (!isOp(c, ':')) syntax(c, '暂不支持集合 set，字典要写成 {键: 值}');
          c.pos++;
          pairs.push({ key: key, val: parseTest(c) });
          if (!acceptOp(c, ',')) break;
          if (isOp(c, '}')) break;
        }
      }
      expectOp(c, '}');
      return { k: 'dict', pairs: pairs, line: line };
    }
    syntax(c, '无法解析的表达式');
  }
  function parseLambda(c) {
    var line = c.line, params = [];
    expectKw(c, 'lambda');
    while (!isOp(c, ':')) {
      if (isOp(c, '*') || isOp(c, '**')) syntax(c, '暂不支持 *args / **kwargs');
      var pn = expectName(c).v, def = null;
      if (acceptOp(c, '=')) def = parseTest(c);
      params.push({ name: pn, def: def });
      if (!acceptOp(c, ',')) break;
    }
    expectOp(c, ':');
    return { k: 'lambda', params: params, body: parseTest(c), line: line };
  }
  function parseTargetList(c) {
    var items = [parseTargetItem(c)];
    while (acceptOp(c, ',')) { if (isKw(c, 'in') || isOp(c, ')') || isOp(c, ']') || isOp(c, '=')) break; items.push(parseTargetItem(c)); }
    return items.length === 1 ? items[0] : { k: 'tuple', items: items, line: items[0].line };
  }
  function parseTargetItem(c) {
    var t = peek(c);
    if (!t) syntax(c, '缺少循环变量');
    var e;
    if (t.t === 'name') {
      if (RESERVED[t.v] && t.v !== 'True' && t.v !== 'False' && t.v !== 'None') syntax(c, '循环变量不能是关键字 "' + t.v + '"');
      c.pos++;
      e = { k: 'name', id: t.v, line: t.line };
    } else if (isOp(c, '(')) {
      c.pos++; e = parseTargetList(c); expectOp(c, ')');
    } else if (isOp(c, '[')) {
      c.pos++;
      var inner = parseTargetList(c);
      expectOp(c, ']');
      e = { k: 'listTarget', items: inner.k === 'tuple' ? inner.items : [inner], line: t.line };
    } else syntax(c, '循环变量必须是变量名');
    while (isOp(c, '[')) e = parseSubscript(c, e);
    return e;
  }
  // f-string：按 {表达式:格式} 切分，内部表达式再走完整词法/语法分析
  function parseFString(content, line) {
    var parts = [], lit = '', i = 0;
    while (i < content.length) {
      var ch = content.charAt(i);
      if (ch === '{') {
        if (content.charAt(i + 1) === '{') { lit += '{'; i += 2; continue; }
        if (lit) { parts.push(lit); lit = ''; }
        var depth = 0, j = i + 1, q = null, done = false;
        for (; j < content.length; j++) {
          var cj = content.charAt(j);
          if (q) {
            if (cj === '\\') { j++; continue; }
            if (cj === q) q = null;
            continue;
          }
          if (cj === '"' || cj === "'") { q = cj; continue; }
          if (cj === '(' || cj === '[' || cj === '{') depth++;
          else if (cj === ')' || cj === ']') depth--;
          else if (cj === '}') {
            if (depth === 0) { done = true; break; }
            depth--;
          }
        }
        if (!done) failAt(line, 'f-string 中的 "{" 没有闭合');
        var inner = content.slice(i + 1, j), exprText = inner, spec = '', conv = null, d2 = 0, q2 = null;
        for (var k = 0; k < inner.length; k++) {
          var ck = inner.charAt(k);
          if (q2) {
            if (ck === '\\') { k++; continue; }
            if (ck === q2) q2 = null;
            continue;
          }
          if (ck === '"' || ck === "'") { q2 = ck; continue; }
          if (ck === '(' || ck === '[' || ck === '{') d2++;
          else if (ck === ')' || ck === ']' || ck === '}') d2--;
          else if (d2 === 0 && ck === '!') {
            exprText = inner.slice(0, k);
            var cm = /^!([rsa])(:[\s\S]*)?$/.exec(inner.slice(k));
            if (!cm) failAt(line, 'f-string 的转换写法不正确');
            conv = cm[1]; spec = cm[2] ? cm[2].slice(1) : '';
            break;
          } else if (d2 === 0 && ck === ':') { exprText = inner.slice(0, k); spec = inner.slice(k + 1); break; }
        }
        if (!exprText.trim()) failAt(line, 'f-string 中的表达式不能为空');
        var toks = tokenize(exprText, line), cc = { toks: toks, pos: 0, line: line }, node = parseTest(cc);
        if (cc.pos < toks.length) failAt(line, 'f-string 中的表达式无法解析');
        parts.push({ expr: node, spec: spec, conv: conv });
        i = j + 1;
        continue;
      }
      if (ch === '}') {
        if (content.charAt(i + 1) === '}') { lit += '}'; i += 2; continue; }
        failAt(line, 'f-string 中单个 "}" 需要写成 "}}"，单个 "{" 需要写成 "{{"');
      }
      lit += ch; i++;
    }
    if (lit) parts.push(lit);
    return { k: 'fstr', parts: parts, line: line };
  }
  // ---- 语句解析：按缩进递归生成代码块 ----
  class Parser {
    constructor(lines) { this.lines = lines; this.i = 0; }
    parseProgram() { var body = this.parseBlock(0); if (this.i < this.lines.length) failAt(this.lines[this.i].line, '缩进错误：这一行的缩进层级不正确'); return body; }
    parseBlock(indent) {
      var stmts = [];
      while (this.i < this.lines.length) {
        var L = this.lines[this.i];
        if (L.indent < indent) break;
        if (L.indent > indent) failAt(L.line, '缩进错误：这里不应该缩进');
        this.i++;
        var c = { toks: L.tokens, pos: 0, line: L.line };
        this.statement(c, stmts, indent);
        if (c.pos < c.toks.length) { var t = c.toks[c.pos]; failAt(c.line, '语法错误：多余的内容 "' + (t.v === undefined ? t.t : t.v) + '"'); }
      }
      return stmts;
    }
    suite(c, indent) {
      if (c.pos < c.toks.length) {
        var body = [];
        for (;;) { body.push(this.simple(c)); if (!acceptOp(c, ';')) break; if (c.pos >= c.toks.length) break; }
        return body;
      }
      var next = this.lines[this.i];
      if (!next) failAt(c.line, '语法错误：冒号后面缺少缩进的代码块');
      if (next.indent <= indent) failAt(next.line, '缩进错误：冒号后面的代码块需要缩进');
      return this.parseBlock(next.indent);
    }
    statement(c, stmts, indent) {
      var t = c.toks[0];
      if (t && t.t === 'name') {
        switch (t.v) {
          case 'if': stmts.push(this.ifStmt(c, indent)); return;
          case 'elif': case 'else': failAt(t.line, '语法错误：' + t.v + ' 没有对应的 if'); break;
          case 'for': stmts.push(this.forStmt(c, indent)); return;
          case 'while': stmts.push(this.whileStmt(c, indent)); return;
          case 'def': stmts.push(this.defStmt(c, indent)); return;
          case 'class': case 'try': case 'except': case 'finally': case 'with':
          case 'yield': case 'async': case 'await': case 'nonlocal': case 'match':
            failAt(t.line, UNSUPPORTED[t.v]); break;
        }
      }
      if (t && t.t === 'op' && t.v === '@') failAt(t.line, '暂不支持装饰器 @，本站判题只支持 Python 基础语法');
      for (;;) { stmts.push(this.simple(c)); if (!acceptOp(c, ';')) break; if (c.pos >= c.toks.length) break; }
    }
    simple(c) {
      var line = c.line, t = peek(c), v = t && t.t === 'name' ? t.v : null;
      if (v === 'return') { c.pos++; return { k: 'return', value: atStmtEnd(c) ? null : parseTestList(c), line: line }; }
      if (v === 'break') { c.pos++; return { k: 'break', line: line }; }
      if (v === 'continue') { c.pos++; return { k: 'continue', line: line }; }
      if (v === 'pass') { c.pos++; return { k: 'pass', line: line }; }
      if (v === 'global') {
        c.pos++;
        while (peek(c) && peek(c).t === 'name') { c.pos++; if (!acceptOp(c, ',')) break; }
        return { k: 'pass', line: line };
      }
      if (v === 'import' || v === 'from') return this.importStmt(c);
      if (v && UNSUPPORTED[v]) failAt(line, UNSUPPORTED[v]);
      var first = parseTestList(c);
      if (isOp(c, '=')) {
        var parts = [first];
        while (acceptOp(c, '=')) parts.push(parseTestList(c));
        return { k: 'assign', targets: parts.slice(0, parts.length - 1), value: parts[parts.length - 1], line: line };
      }
      var nxt = peek(c), aug = nxt && nxt.t === 'op' ? AUG_OPS[nxt.v] : null;
      if (aug) {
        c.pos++;
        if (first.k !== 'name' && first.k !== 'index') failAt(line, '增强赋值的左边必须是变量或下标');
        return { k: 'aug', target: first, op: aug, value: parseTest(c), line: line };
      }
      return { k: 'expr', expr: first, line: line };
    }
    ifStmt(c, indent) {
      var line = c.line, clauses = [];
      expectKw(c, 'if');
      var test = parseTest(c);
      expectOp(c, ':');
      clauses.push({ test: test, body: this.suite(c, indent) });
      while (this.i < this.lines.length) {
        var L = this.lines[this.i];
        if (L.indent !== indent) break;
        var head = L.tokens[0];
        if (!head || head.t !== 'name') break;
        if (head.v === 'elif') {
          this.i++;
          var cc = { toks: L.tokens, pos: 1, line: L.line };
          var t2 = parseTest(cc);
          expectOp(cc, ':');
          clauses.push({ test: t2, body: this.suite(cc, indent) });
        } else if (head.v === 'else') {
          this.i++;
          var ce = { toks: L.tokens, pos: 1, line: L.line };
          expectOp(ce, ':');
          clauses.push({ test: null, body: this.suite(ce, indent) });
          break;
        } else break;
      }
      return { k: 'if', clauses: clauses, line: line };
    }
    whileStmt(c, indent) {
      var line = c.line;
      expectKw(c, 'while');
      var test = parseTest(c);
      expectOp(c, ':');
      return { k: 'while', test: test, body: this.suite(c, indent), line: line };
    }
    forStmt(c, indent) {
      var line = c.line;
      expectKw(c, 'for');
      var target = parseTargetList(c);
      expectKw(c, 'in');
      var iter = parseOr(c);
      expectOp(c, ':');
      return { k: 'for', target: target, iter: iter, body: this.suite(c, indent), line: line };
    }
    defStmt(c, indent) {
      var line = c.line;
      expectKw(c, 'def');
      var name = expectName(c).v;
      expectOp(c, '(');
      var params = [];
      while (!isOp(c, ')')) {
        if (isOp(c, '*') || isOp(c, '**')) syntax(c, '暂不支持 *args / **kwargs');
        var pn = expectName(c).v;
        if (isOp(c, ':')) { c.pos++; this.skipAnnotation(c, [',', ')', '=']); }
        var def = null;
        if (acceptOp(c, '=')) def = parseTest(c);
        params.push({ name: pn, def: def });
        if (!acceptOp(c, ',')) break;
      }
      expectOp(c, ')');
      if (isOp(c, '->')) { c.pos++; this.skipAnnotation(c, [':']); }
      expectOp(c, ':');
      return { k: 'def', name: name, params: params, body: this.suite(c, indent), line: line };
    }
    skipAnnotation(c, stops) {
      var depth = 0;
      while (c.pos < c.toks.length) {
        var t = c.toks[c.pos];
        if (t.t === 'op') {
          if ('([{'.indexOf(t.v) >= 0) depth++;
          else if (')]}'.indexOf(t.v) >= 0) { if (depth === 0) return; depth--; }
          else if (depth === 0 && stops.indexOf(t.v) >= 0) return;
        }
        c.pos++;
      }
    }
    importStmt(c) {
      var line = c.line;
      if (acceptKw(c, 'from')) {
        var mod = expectName(c).v;
        if (isOp(c, '.')) failAt(line, '暂不支持子模块导入');
        expectKw(c, 'import');
        if (acceptOp(c, '*')) return { k: 'import', from: mod, star: true, line: line };
        var names = [];
        for (;;) {
          var n = expectName(c).v, alias = n;
          if (acceptKw(c, 'as')) alias = expectName(c).v;
          names.push({ n: n, alias: alias });
          if (!acceptOp(c, ',')) break;
        }
        return { k: 'import', from: mod, names: names, line: line };
      }
      expectKw(c, 'import');
      var mods = [];
      for (;;) {
        var mn = expectName(c).v;
        if (isOp(c, '.')) failAt(line, '暂不支持子模块导入');
        var ma = mn;
        if (acceptKw(c, 'as')) ma = expectName(c).v;
        mods.push({ n: mn, alias: ma });
        if (!acceptOp(c, ',')) break;
      }
      return { k: 'import', mods: mods, line: line };
    }
  }
  // ===== 运行环境 =====
  class Env {
    constructor(parent) { this.vars = new Map(); this.parent = parent; }
    has(n) { return this.vars.has(n); }
    get(n) { return this.vars.get(n); }
    set(n, v) { this.vars.set(n, v); }
  }
  function lookup(n, env) {
    var e = env;
    while (e) { if (e.vars.has(n)) return e.vars.get(n); e = e.parent; }
    fail('变量 ' + n + ' 未定义');
  }
  // ===== 执行语句 =====
  function execBlock(stmts, env) { for (var i = 0; i < stmts.length; i++) execStmt(stmts[i], env); }
  function execStmt(s, env) {
    RT.line = s.line || RT.line;
    step();
    switch (s.k) {
      case 'pass': return;
      case 'expr': evalExpr(s.expr, env); return;
      case 'assign': { var v = evalExpr(s.value, env); for (var i = 0; i < s.targets.length; i++) assignTarget(s.targets[i], v, env); return; }
      case 'aug': { var cur = readTarget(s.target, env); assignTarget(s.target, binOp(s.op, cur, evalExpr(s.value, env)), env); return; }
      case 'if': {
        for (var j = 0; j < s.clauses.length; j++) {
          var cl = s.clauses[j];
          if (cl.test === null || truthy(evalExpr(cl.test, env))) { execBlock(cl.body, env); return; }
        }
        return;
      }
      case 'while': {
        RT.loopDepth++;
        try {
          while (truthy(evalExpr(s.test, env))) {
            try { execBlock(s.body, env); }
            catch (e) { if (e === SIG_CONTINUE) continue; if (e === SIG_BREAK) break; throw e; }
          }
        } finally { RT.loopDepth--; }
        return;
      }
      case 'for': {
        var iterVal = evalExpr(s.iter, env);
        RT.loopDepth++;
        try {
          forEachValue(iterVal, function (val) {
            assignTarget(s.target, val, env);
            try { execBlock(s.body, env); }
            catch (e) { if (e === SIG_CONTINUE) return; if (e === SIG_BREAK) throw BREAK_OUT; throw e; }
          });
        } catch (e) { if (e !== BREAK_OUT) throw e; }
        finally { RT.loopDepth--; }
        return;
      }
      case 'def': env.set(s.name, makeFunc(s, env)); return;
      case 'return': {
        if (RT.funcDepth === 0) fail('return 只能用在函数内部');
        throw { __sig: 'return', value: s.value === null ? null : evalExpr(s.value, env) };
      }
      case 'break': if (RT.loopDepth === 0) fail('break 只能用在循环内部'); throw SIG_BREAK;
      case 'continue': if (RT.loopDepth === 0) fail('continue 只能用在循环内部'); throw SIG_CONTINUE;
      case 'import': {
        if (s.from) {
          if (s.from !== 'math') fail('暂不支持导入模块 ' + s.from + '，本站只支持 math 模块');
          if (s.star) {
            ['pi', 'e', 'tau', 'sqrt', 'floor', 'ceil', 'pow', 'fabs'].forEach(function (n) { env.set(n, mathAttr(n)); });
            return;
          }
          for (var k = 0; k < s.names.length; k++) env.set(s.names[k].alias, mathAttr(s.names[k].n));
          return;
        }
        for (var m = 0; m < s.mods.length; m++) {
          if (s.mods[m].n !== 'math') fail('暂不支持导入模块 ' + s.mods[m].n + '，本站只支持 math 模块');
          env.set(s.mods[m].alias, { __math: true });
        }
        return;
      }
    }
    fail('暂时无法执行这条语句');
  }
  // ===== 求值表达式 =====
  function evalExpr(n, env) {
    step();
    if (n.line !== undefined) RT.line = n.line;
    switch (n.k) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'fstr': return evalFString(n, env);
      case 'name': return lookup(n.id, env);
      case 'list': { var li = []; for (var i = 0; i < n.items.length; i++) li.push(evalExpr(n.items[i], env)); return li; }
      case 'tuple': { var ti = []; for (var j = 0; j < n.items.length; j++) ti.push(evalExpr(n.items[j], env)); return mkTuple(ti); }
      case 'dict': { var m = new Map(); for (var k = 0; k < n.pairs.length; k++) m.set(dictKey(evalExpr(n.pairs[k].key, env)), evalExpr(n.pairs[k].val, env)); return m; }
      case 'unary': {
        var uv = evalExpr(n.e, env);
        if (!isNumLike(uv)) fail('类型错误：不能对 ' + typeName(uv) + ' 使用一元 "' + n.op + '"');
        if (n.op === '-') return uv instanceof PyFloat ? new PyFloat(-uv.v) : (-num(uv) || 0);
        return uv instanceof PyFloat ? new PyFloat(+uv.v) : (+num(uv) || 0);
      }
      case 'not': return !truthy(evalExpr(n.e, env));
      case 'and': { var la = evalExpr(n.l, env); return truthy(la) ? evalExpr(n.r, env) : la; }
      case 'or': { var lo = evalExpr(n.l, env); return truthy(lo) ? lo : evalExpr(n.r, env); }
      case 'bin': return binOp(n.op, evalExpr(n.l, env), evalExpr(n.r, env));
      case 'cmp': return evalCmp(n, env);
      case 'cond': return truthy(evalExpr(n.test, env)) ? evalExpr(n.a, env) : evalExpr(n.b, env);
      case 'call': {
        var fn = evalExpr(n.fn, env), args = [], kwargs = {};
        for (var a = 0; a < n.args.length; a++) args.push(evalExpr(n.args[a], env));
        for (var kw in n.kwargs) if (has(n.kwargs, kw)) kwargs[kw] = evalExpr(n.kwargs[kw], env);
        return callValue(fn, args, kwargs);
      }
      case 'attr': return getAttr(evalExpr(n.obj, env), n.name);
      case 'index': return getIndex(evalExpr(n.obj, env), evalExpr(n.idx, env));
      case 'slice': return sliceValue(
        evalExpr(n.obj, env),
        n.lo === null ? null : evalExpr(n.lo, env),
        n.hi === null ? null : evalExpr(n.hi, env),
        n.step === null ? null : evalExpr(n.step, env));
      case 'lambda': return makeFunc(n, env);
      case 'comp': {
        var iter = evalExpr(n.iter, env), child = new Env(env), out = [];
        forEachValue(iter, function (val) { assignTarget(n.target, val, child); if (n.cond && !truthy(evalExpr(n.cond, child))) return; out.push(evalExpr(n.elt, child)); });
        return out;
      }
    }
    fail('内部错误：未知的表达式类型 ' + n.k);
  }
  function evalCmp(n, env) {
    var left = evalExpr(n.parts[0], env);
    for (var i = 0; i < n.ops.length; i++) {
      var right = evalExpr(n.parts[i + 1], env), op = n.ops[i], ok;
      switch (op) {
        case '==': ok = pyEq(left, right); break;
        case '!=': ok = !pyEq(left, right); break;
        case '<': ok = pyCompare(left, right) < 0; break;
        case '>': ok = pyCompare(left, right) > 0; break;
        case '<=': ok = pyCompare(left, right) <= 0; break;
        case '>=': ok = pyCompare(left, right) >= 0; break;
        case 'in': ok = contains(right, left); break;
        case 'not in': ok = !contains(right, left); break;
        case 'is': ok = pyIs(left, right); break;
        case 'is not': ok = !pyIs(left, right); break;
        default: fail('内部错误：未知比较运算 ' + op);
      }
      if (!ok) return false;
      left = right;
    }
    return true;
  }
  function pyIs(a, b) { if (a === b) return true; return isNumLike(a) && isNumLike(b) ? num(a) === num(b) : false; }
  function contains(container, item) {
    if (typeof container === 'string') { if (typeof item !== 'string') fail('类型错误：字符串只能判断子串是否包含'); return container.indexOf(item) >= 0; }
    if (Array.isArray(container)) { for (var i = 0; i < container.length; i++) if (pyEq(container[i], item)) return true; return false; }
    if (container instanceof Map) return container.has(dictKey(item));
    if (container instanceof PyRange) {
      if (typeof item === 'boolean') item = item ? 1 : 0;
      if (typeof item !== 'number' || Math.floor(item) !== item) return false;
      if (container.step > 0) return item >= container.start && item < container.stop && (item - container.start) % container.step === 0;
      return item <= container.start && item > container.stop && (container.start - item) % (-container.step) === 0;
    }
    fail('类型错误：' + typeName(container) + ' 不支持 in 运算');
  }
  function arith(a, b, fn) { var fl = a instanceof PyFloat || b instanceof PyFloat, r = fn(num(a), num(b)); if (fl) return new PyFloat(r); if (!isFinite(r)) fail('数值溢出：结果超出本解释器支持的数值范围'); return Math.trunc(r); }
  function repeatText(s, n) { if (n < 0) return ''; if (n > MAX_REPEAT) fail('重复次数过大，超出本解释器限制'); return s.repeat(n); }
  function repeatList(a, n) {
    if (n < 0) return a.__tuple ? mkTuple([]) : [];
    if (n > MAX_REPEAT) fail('重复次数过大，超出本解释器限制');
    var out = [];
    for (var i = 0; i < n; i++) for (var j = 0; j < a.length; j++) out.push(a[j]);
    return a.__tuple ? mkTuple(out) : out;
  }
  function binOp(op, a, b) {
    var an = isNumLike(a), bn = isNumLike(b);
    switch (op) {
      case '+':
        if (an && bn) return arith(a, b, function (x, y) { return x + y; });
        if (typeof a === 'string' && typeof b === 'string') return a + b;
        if (Array.isArray(a) && Array.isArray(b) && !!a.__tuple === !!b.__tuple) { var cat = a.concat(b); return a.__tuple ? mkTuple(cat) : cat; }
        break;
      case '-':
        if (an && bn) return arith(a, b, function (x, y) { return x - y; });
        break;
      case '*':
        if (an && bn) return arith(a, b, function (x, y) { return x * y; });
        if (typeof a === 'string' && bn) return repeatText(a, repeatCount(b));
        if (typeof b === 'string' && an) return repeatText(b, repeatCount(a));
        if (Array.isArray(a) && bn) return repeatList(a, repeatCount(b));
        if (Array.isArray(b) && an) return repeatList(b, repeatCount(a));
        break;
      case '/':
        if (an && bn) { if (num(b) === 0) fail('除数不能为 0'); return new PyFloat(num(a) / num(b)); }
        break;
      case '//':
        if (an && bn) { var d = num(b); if (d === 0) fail('除数不能为 0'); var q = Math.floor(num(a) / d); return (a instanceof PyFloat || b instanceof PyFloat) ? new PyFloat(q) : q; }
        break;
      case '%':
        if (an && bn) {
          var md = num(b);
          if (md === 0) fail('取余运算的除数不能为 0');
          var r = num(a) % md;
          if (r !== 0 && (r < 0) !== (md < 0)) r += md;
          return (a instanceof PyFloat || b instanceof PyFloat) ? new PyFloat(r) : Math.trunc(r);
        }
        break;
      case '**':
        if (an && bn) {
          var base = num(a), exp = num(b), res = Math.pow(base, exp);
          if (!isFinite(res) && isFinite(base) && isFinite(exp)) fail('数值溢出：结果超出本解释器支持的数值范围（不支持超大整数）');
          return (a instanceof PyFloat || b instanceof PyFloat || exp < 0) ? new PyFloat(res) : Math.trunc(res);
        }
        break;
    }
    fail('类型错误：' + typeName(a) + ' 和 ' + typeName(b) + ' 不能进行 "' + op + '" 运算');
  }
  function repeatCount(v) { return toIntVal(v, '重复次数'); }
  // ===== 容器、下标与迭代 =====
  function dictKey(k) {
    if (typeof k === 'string' || typeof k === 'number') return k;
    if (typeof k === 'boolean') return k ? 1 : 0;
    if (k instanceof PyFloat) return k.v;
    if (k === null) return null;
    fail('字典的键只能是字符串或数字，不能是 ' + typeName(k));
  }
  function normIndex(idx, len, what) { var i = toIntVal(idx, '下标'); if (i < 0) i += len; if (i < 0 || i >= len) fail(what + '下标越界'); return i; }
  function getIndex(obj, idx) {
    if (typeof obj === 'string') return obj.charAt(normIndex(idx, obj.length, '字符串'));
    if (Array.isArray(obj)) return obj[normIndex(idx, obj.length, obj.__tuple ? 'tuple ' : '列表')];
    if (obj instanceof Map) { var k = dictKey(idx); if (!obj.has(k)) fail('字典中不存在键 ' + pyRepr(idx)); return obj.get(k); }
    if (obj instanceof PyRange) return obj.start + normIndex(idx, rangeLen(obj), 'range ') * obj.step;
    fail('类型 ' + typeName(obj) + ' 不支持下标访问');
  }
  function setIndex(obj, idx, v) {
    if (Array.isArray(obj)) { if (obj.__tuple) fail('tuple 是不可变类型，不能修改元素'); var i = toIntVal(idx, '下标'); if (i < 0) i += obj.length; if (i < 0 || i >= obj.length) fail('列表下标越界'); obj[i] = v; return; }
    if (obj instanceof Map) { obj.set(dictKey(idx), v); return; }
    if (typeof obj === 'string') fail('字符串是不可变类型，不能修改字符');
    fail('类型 ' + typeName(obj) + ' 不支持下标赋值');
  }
  function sliceValue(obj, lo, hi, st) {
    if (typeof obj !== 'string' && !Array.isArray(obj)) fail('类型 ' + typeName(obj) + ' 不支持切片');
    var len = obj.length, stepv = st === null ? 1 : toIntVal(st, '切片步长');
    if (stepv === 0) fail('切片步长不能为 0');
    var idxs = [], i;
    if (stepv > 0) {
      var a = lo === null ? 0 : normSlice(lo, len), b = hi === null ? len : normSlice(hi, len);
      for (i = a; i < b; i += stepv) idxs.push(i);
    } else { var a2 = lo === null ? len - 1 : normSliceNeg(lo, len), b2 = hi === null ? -1 : normSliceNeg(hi, len); for (i = a2; i > b2; i += stepv) idxs.push(i); }
    var out = [];
    for (var j = 0; j < idxs.length; j++) out.push(obj[idxs[j]]);
    if (typeof obj === 'string') return out.join('');
    return obj.__tuple ? mkTuple(out) : out;
  }
  function normSlice(v, len) { var i = toIntVal(v, '切片下标'); if (i < 0) i += len; return Math.max(0, Math.min(i, len)); }
  function normSliceNeg(v, len) { var i = toIntVal(v, '切片下标'); if (i < 0) i += len; return Math.max(-1, Math.min(i, len - 1)); }
  function rangeLen(r) { if (r.step > 0) return r.stop <= r.start ? 0 : Math.ceil((r.stop - r.start) / r.step); return r.stop >= r.start ? 0 : Math.ceil((r.start - r.stop) / (-r.step)); }
  function forEachValue(v, fn) {
    if (typeof v === 'string') { for (var i = 0; i < v.length; i++) { step(); fn(v.charAt(i)); } return; }
    if (Array.isArray(v)) { for (var j = 0; j < v.length; j++) { step(); fn(v[j]); } return; }
    if (v instanceof Map) {
      var keys = Array.from(v.keys());
      for (var k = 0; k < keys.length; k++) { step(); fn(keys[k]); }
      return;
    }
    if (v instanceof PyRange) {
      var n = rangeLen(v);
      for (var m = 0; m < n; m++) { step(); fn(v.start + m * v.step); }
      return;
    }
    fail('类型 ' + typeName(v) + ' 不可迭代');
  }
  function materialize(v) {
    var out = [];
    forEachValue(v, function (x) { out.push(x); });
    return out;
  }
  // ===== 赋值与函数调用 =====
  function assignTarget(t, v, env) {
    if (t.k === 'name') { env.set(t.id, v); return; }
    if (t.k === 'tuple' || t.k === 'listTarget') {
      var vals = materialize(v), targets = t.items;
      if (vals.length !== targets.length) fail('解包失败：需要 ' + targets.length + ' 个值，实际得到 ' + vals.length + ' 个');
      for (var i = 0; i < targets.length; i++) assignTarget(targets[i], vals[i], env);
      return;
    }
    if (t.k === 'index') { setIndex(evalExpr(t.obj, env), evalExpr(t.idx, env), v); return; }
    fail('赋值语句的左边不是合法的赋值目标');
  }
  function readTarget(t, env) { if (t.k === 'name') return lookup(t.id, env); if (t.k === 'index') return getIndex(evalExpr(t.obj, env), evalExpr(t.idx, env)); fail('增强赋值的左边必须是变量或下标'); }
  function makeFunc(node, env) {
    var defaults = [];
    for (var i = 0; i < node.params.length; i++) defaults.push(node.params[i].def ? evalExpr(node.params[i].def, env) : undefined);
    return { __pyfunc: true, node: node, closure: env, defaults: defaults };
  }
  function callValue(fn, args, kwargs) {
    if (typeof fn === 'function') { step(); return fn(args, kwargs || {}); }
    if (fn && fn.__pyfunc) return callUserFunc(fn, args, kwargs || {});
    fail('类型 ' + typeName(fn) + ' 的对象不可调用');
  }
  function bindParams(f, args, kwargs, env) {
    var params = f.node.params, name = f.node.name || '<lambda>';
    if (args.length > params.length) fail('函数 ' + name + ' 最多接受 ' + params.length + ' 个参数，实际传入 ' + args.length + ' 个');
    var used = {};
    for (var i = 0; i < args.length; i++) { env.set(params[i].name, args[i]); used[params[i].name] = true; }
    for (var k in kwargs) {
      if (!has(kwargs, k)) continue;
      var found = -1;
      for (var p = 0; p < params.length; p++) if (params[p].name === k) found = p;
      if (found < 0) fail('函数 ' + name + ' 没有参数 ' + k);
      if (used[k]) fail('参数 ' + k + ' 重复传入');
      env.set(k, kwargs[k]); used[k] = true;
    }
    for (var q = 0; q < params.length; q++) {
      if (!used[params[q].name]) { if (f.defaults[q] === undefined) fail('函数 ' + name + ' 缺少参数 ' + params[q].name); env.set(params[q].name, f.defaults[q]); }
    }
  }
  function callUserFunc(f, args, kwargs) {
    if (RT.depth >= MAX_DEPTH) throw new PyErr('递归层数过深');
    RT.depth++;
    var savedLoop = RT.loopDepth, savedLine = RT.line;
    RT.loopDepth = 0;
    RT.funcDepth++;
    try {
      var callEnv = new Env(f.closure);
      bindParams(f, args, kwargs, callEnv);
      if (f.node.k === 'lambda') return evalExpr(f.node.body, callEnv);
      try { execBlock(f.node.body, callEnv); }
      catch (e) { if (e && e.__sig === 'return') return e.value; throw e; }
      return null;
    } catch (e) {
      if (e instanceof RangeError) throw new PyErr('递归层数过深');
      throw e;
    } finally { RT.depth--; RT.funcDepth--; RT.loopDepth = savedLoop; RT.line = savedLine; }
  }
  // ===== 属性访问与容器方法 =====
  function getAttr(obj, name) {
    if (typeof obj === 'string') return strMethod(obj, name);
    if (Array.isArray(obj)) return obj.__tuple ? tupleMethod(obj, name) : listMethod(obj, name);
    if (obj instanceof Map) return dictMethod(obj, name);
    if (obj && obj.__math) return mathAttr(name);
    if (obj && obj.__pyfunc && name === '__name__') return obj.node.name || '<lambda>';
    if (obj === null) fail('None 没有属性 ' + name);
    if (obj instanceof PyRange) fail('range 对象没有属性 ' + name);
    if (obj instanceof PyFloat) fail('float 对象没有属性 ' + name);
    fail('类型 ' + typeName(obj) + ' 没有属性 ' + name);
  }
  function needArgs(args, n, name) { if (args.length < n) fail(name + ' 需要 ' + n + ' 个参数'); }
  function stripChars(s, chars, left, right) {
    if (chars === null || chars === undefined) { if (left && right) return s.trim(); if (left) return s.replace(/^\s+/, ''); return s.replace(/\s+$/, ''); }
    if (typeof chars !== 'string') fail('strip 的参数必须是字符串');
    var a = 0, b = s.length;
    if (left) while (a < b && chars.indexOf(s.charAt(a)) >= 0) a++;
    if (right) while (b > a && chars.indexOf(s.charAt(b - 1)) >= 0) b--;
    return s.slice(a, b);
  }
  function strMethod(s, name) {
    switch (name) {
      case 'upper': return function () { return s.toUpperCase(); };
      case 'lower': return function () { return s.toLowerCase(); };
      case 'strip': return function (a) { return stripChars(s, a[0], true, true); };
      case 'lstrip': return function (a) { return stripChars(s, a[0], true, false); };
      case 'rstrip': return function (a) { return stripChars(s, a[0], false, true); };
      case 'split': return function (a) {
        if (!a.length || a[0] === null) { var t = s.trim(); return t === '' ? [] : t.split(/\s+/); }
        if (typeof a[0] !== 'string') fail('split 的参数必须是字符串');
        if (a[0] === '') fail('split 的分隔符不能为空字符串');
        return s.split(a[0]);
      };
      case 'join': return function (a) {
        needArgs(a, 1, 'join');
        var items = materialize(a[0]);
        for (var i = 0; i < items.length; i++) if (typeof items[i] !== 'string') fail('join 的元素必须是字符串，实际是 ' + typeName(items[i]));
        return items.join(s);
      };
      case 'replace': return function (a) {
        needArgs(a, 2, 'replace');
        if (typeof a[0] !== 'string' || typeof a[1] !== 'string') fail('replace 的参数必须是字符串');
        var from = a[0], to = a[1], cnt = a.length > 2 ? toIntVal(a[2], 'replace 的次数') : -1;
        if (cnt < 0) return s.split(from).join(to);
        var out = '', idx = 0, n = 0;
        while (n < cnt) { var p = s.indexOf(from, idx); if (p < 0) break; out += s.slice(idx, p) + to; idx = p + from.length; n++; }
        return out + s.slice(idx);
      };
      case 'find': return function (a) {
        needArgs(a, 1, 'find');
        if (typeof a[0] !== 'string') fail('find 的参数必须是字符串');
        var start = a.length > 1 ? toIntVal(a[1], 'find 的起点') : 0;
        var end = a.length > 2 ? toIntVal(a[2], 'find 的终点') : s.length;
        if (start < 0) start = Math.max(0, s.length + start);
        if (end < 0) end = Math.max(0, s.length + end); else end = Math.min(end, s.length);
        var p = s.slice(start, end).indexOf(a[0]);
        return p < 0 ? -1 : p + start;
      };
      case 'count': return function (a) {
        needArgs(a, 1, 'count');
        if (typeof a[0] !== 'string') fail('count 的参数必须是字符串');
        if (a[0] === '') return s.length + 1;
        var c = 0, p = 0;
        for (;;) { var idx = s.indexOf(a[0], p); if (idx < 0) break; c++; p = idx + a[0].length; }
        return c;
      };
      case 'startswith': return function (a) {
        needArgs(a, 1, 'startswith');
        if (Array.isArray(a[0])) return a[0].some(function (x) { return typeof x === 'string' && s.startsWith(x); });
        if (typeof a[0] !== 'string') fail('startswith 的参数必须是字符串');
        return s.startsWith(a[0]);
      };
      case 'endswith': return function (a) {
        needArgs(a, 1, 'endswith');
        if (Array.isArray(a[0])) return a[0].some(function (x) { return typeof x === 'string' && s.endsWith(x); });
        if (typeof a[0] !== 'string') fail('endswith 的参数必须是字符串');
        return s.endsWith(a[0]);
      };
      case 'isdigit': return function () { return /^[0-9]+$/.test(s); };
      case 'isalpha': return function () { return /^[A-Za-z\u4e00-\u9fa5]+$/.test(s); };
      case 'isspace': return function () { return s.length > 0 && /^\s+$/.test(s); };
      case 'islower': return function () { return /[a-z]/.test(s) && s === s.toLowerCase(); };
      case 'isupper': return function () { return /[A-Z]/.test(s) && s === s.toUpperCase(); };
      case 'index': return function (a) { needArgs(a, 1, 'index'); var p = s.indexOf(a[0]); if (p < 0) fail('字符串中找不到子串 ' + pyRepr(a[0])); return p; };
    }
    fail('字符串没有方法 ' + name);
  }
  function listMethod(a, name) {
    switch (name) {
      case 'append': return function (args) { if (args.length !== 1) fail('append 需要 1 个参数'); a.push(args[0]); return null; };
      case 'extend': return function (args) { needArgs(args, 1, 'extend'); var items = materialize(args[0]); for (var i = 0; i < items.length; i++) a.push(items[i]); return null; };
      case 'insert': return function (args) { needArgs(args, 2, 'insert'); var i = toIntVal(args[0], 'insert 的位置'); if (i < 0) i = Math.max(0, a.length + i); if (i > a.length) i = a.length; a.splice(i, 0, args[1]); return null; };
      case 'pop': return function (args) {
        if (!a.length) fail('不能从空列表中 pop');
        var i = a.length - 1;
        if (args.length) { i = toIntVal(args[0], 'pop 的位置'); if (i < 0) i += a.length; }
        if (i < 0 || i >= a.length) fail('pop 的下标越界');
        return a.splice(i, 1)[0];
      };
      case 'sort': return function (args, kw) {
        var key = kw.key === undefined || kw.key === null ? null : kw.key;
        var rev = kw.reverse ? truthy(kw.reverse) : false;
        var sorted = sortArray(a, key, rev);
        a.length = 0;
        for (var i = 0; i < sorted.length; i++) a.push(sorted[i]);
        return null;
      };
      case 'reverse': return function () { a.reverse(); return null; };
      case 'index': return function (args) { needArgs(args, 1, 'index'); for (var i = 0; i < a.length; i++) if (pyEq(a[i], args[0])) return i; fail('列表中不存在该元素'); };
      case 'count': return function (args) { needArgs(args, 1, 'count'); var c = 0; for (var i = 0; i < a.length; i++) if (pyEq(a[i], args[0])) c++; return c; };
      case 'remove': return function (args) {
        needArgs(args, 1, 'remove');
        for (var i = 0; i < a.length; i++) if (pyEq(a[i], args[0])) { a.splice(i, 1); return null; }
        fail('列表中不存在要删除的元素');
      };
    }
    fail('列表没有方法 ' + name);
  }
  function tupleMethod(t, name) {
    switch (name) {
      case 'count': return function (args) { needArgs(args, 1, 'count'); var c = 0; for (var i = 0; i < t.length; i++) if (pyEq(t[i], args[0])) c++; return c; };
      case 'index': return function (args) { needArgs(args, 1, 'index'); for (var i = 0; i < t.length; i++) if (pyEq(t[i], args[0])) return i; fail('tuple 中不存在该元素'); };
    }
    fail('tuple 没有方法 ' + name);
  }
  function dictMethod(m, name) {
    switch (name) {
      case 'get': return function (args) { needArgs(args, 1, 'get'); var k = dictKey(args[0]); return m.has(k) ? m.get(k) : (args.length > 1 ? args[1] : null); };
      case 'keys': return function () { return Array.from(m.keys()); };
      case 'values': return function () { return Array.from(m.values()); };
      case 'items': return function () {
        var out = [];
        m.forEach(function (val, key) { out.push(mkTuple([key, val])); });
        return out;
      };
      case 'pop': return function (args) {
        needArgs(args, 1, 'pop');
        var k = dictKey(args[0]);
        if (!m.has(k)) { if (args.length > 1) return args[1]; fail('字典中不存在键 ' + pyRepr(args[0])); }
        var v = m.get(k);
        m.delete(k); return v;
      };
      case 'setdefault': return function (args) { needArgs(args, 1, 'setdefault'); var k = dictKey(args[0]); if (m.has(k)) return m.get(k); var dv = args.length > 1 ? args[1] : null; m.set(k, dv); return dv; };
    }
    fail('字典没有方法 ' + name);
  }
  function mathAttr(name) {
    switch (name) {
      case 'pi': return new PyFloat(Math.PI);
      case 'e': return new PyFloat(Math.E);
      case 'inf': return new PyFloat(Infinity);
      case 'sqrt': return function (args) { needArgs(args, 1, 'sqrt'); var x = num(args[0]); if (x < 0) fail('math.sqrt 的参数不能是负数'); return new PyFloat(Math.sqrt(x)); };
      case 'floor': return function (args) { needArgs(args, 1, 'floor'); return Math.floor(num(args[0])); };
      case 'ceil': return function (args) { needArgs(args, 1, 'ceil'); return Math.ceil(num(args[0])); };
      case 'fabs': return function (args) { needArgs(args, 1, 'fabs'); return new PyFloat(Math.abs(num(args[0]))); };
      case 'pow': return function (args) { needArgs(args, 2, 'pow'); return new PyFloat(Math.pow(num(args[0]), num(args[1]))); };
      case 'log': return function (args) { needArgs(args, 1, 'log'); return new PyFloat(args.length > 1 ? Math.log(num(args[0])) / Math.log(num(args[1])) : Math.log(num(args[0]))); };
    }
    fail('math 模块中没有 ' + name);
  }
  // ===== 内置函数 =====
  function biPrint(args, kw) {
    var sep = ' ', end = '\n';
    if (kw.sep !== undefined) { if (kw.sep === null) sep = ' '; else if (typeof kw.sep === 'string') sep = kw.sep; else fail('print 的 sep 参数必须是字符串'); }
    if (kw.end !== undefined) { if (kw.end === null) end = '\n'; else if (typeof kw.end === 'string') end = kw.end; else fail('print 的 end 参数必须是字符串'); }
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(pyStr(args[i]));
    emit(parts.join(sep) + end);
    return null;
  }
  function biInput(args) { if (args.length > 1) fail('input 最多接受 1 个参数'); if (args.length === 1) emit(pyStr(args[0])); if (RT.stdinPos >= RT.stdinLines.length) return ''; return RT.stdinLines[RT.stdinPos++]; }
  function biLen(args) {
    needArgs(args, 1, 'len');
    var v = args[0];
    if (typeof v === 'string') return v.length;
    if (Array.isArray(v)) return v.length;
    if (v instanceof Map) return v.size;
    if (v instanceof PyRange) return rangeLen(v);
    fail('len() 不支持类型 ' + typeName(v));
  }
  function biSum(args) {
    needArgs(args, 1, 'sum');
    var total = args.length > 1 ? args[1] : 0;
    forEachValue(args[0], function (v) { total = binOp('+', total, v); });
    return total;
  }
  function biMinMax(args, kw, wantMax) {
    var items;
    if (args.length === 1) items = materialize(args[0]);
    else if (args.length > 1) items = args;
    else fail((wantMax ? 'max' : 'min') + ' 需要参数');
    if (!items.length) fail((wantMax ? 'max' : 'min') + ' 的参数不能是空序列');
    var key = kw.key === undefined || kw.key === null ? null : kw.key;
    var best = items[0], bestK = key ? callValue(key, [best], {}) : best;
    for (var i = 1; i < items.length; i++) {
      var k = key ? callValue(key, [items[i]], {}) : items[i], c = pyCompare(k, bestK);
      if (wantMax ? c > 0 : c < 0) { best = items[i]; bestK = k; }
    }
    return best;
  }
  function biAbs(args) { needArgs(args, 1, 'abs'); if (!isNumLike(args[0])) fail('abs() 的参数必须是数字'); return args[0] instanceof PyFloat ? new PyFloat(Math.abs(args[0].v)) : Math.abs(num(args[0])); }
  function bankerRound(x) { var f = Math.floor(x), d = x - f; if (d < 0.5) return f; if (d > 0.5) return f + 1; return Math.abs(f % 2) === 0 ? f : f + 1; }
  function incDecimal(s) {
    var arr = s.split(''), i = arr.length - 1;
    while (i >= 0) {
      if (arr[i] === '9') { arr[i] = '0'; i--; }
      else { arr[i] = String.fromCharCode(arr[i].charCodeAt(0) + 1); return arr.join(''); }
    }
    return '1' + arr.join('');
  }
  // 按十进制语义做“四舍六入五成双”，避免 2.675 被算成 2.68
  function pyRoundDecimal(x, nd) {
    if (!isFinite(x) || x === 0) return x;
    var neg = x < 0, m = /^(\d)\.(\d+)e([+\-]?\d+)$/.exec(Math.abs(x).toExponential(25));
    if (!m) return Math.abs(x);
    var digits = m[1] + m[2], E = parseInt(m[3], 10), L = digits.length, k = E + 1 + nd, val;
    if (k < 0) val = 0;
    else if (k === 0) {
      var d0 = digits.charAt(0);
      val = (d0 > '5' || (d0 === '5' && /[1-9]/.test(digits.slice(1)))) ? Math.pow(10, -nd) : 0;
    } else if (k >= L) return x;
    else {
      var kept = digits.slice(0, k), rd = digits.charAt(k), rest = digits.slice(k + 1), up = false;
      if (rd > '5') up = true;
      else if (rd === '5') up = /[1-9]/.test(rest) || (parseInt(kept.charAt(k - 1), 10) % 2) === 1;
      if (up) kept = incDecimal(kept);
      val = Number(kept + 'e' + (-nd));
      if (!isFinite(val)) return x;
    }
    return neg ? -val : val;
  }
  function biRound(args) {
    needArgs(args, 1, 'round');
    if (!isNumLike(args[0])) fail('round() 的参数必须是数字');
    var isFloat = args[0] instanceof PyFloat, x = num(args[0]);
    if (args.length < 2) return bankerRound(x);
    var nd = toIntVal(args[1], 'round 的位数'), r = pyRoundDecimal(x, nd);
    return isFloat ? new PyFloat(r) : Math.trunc(r);
  }
  function biSorted(args, kw) { needArgs(args, 1, 'sorted'); var key = kw.key === undefined || kw.key === null ? null : kw.key; var rev = kw.reverse ? truthy(kw.reverse) : false; return sortArray(materialize(args[0]), key, rev); }
  function sortArray(arr, keyFn, reverse) {
    var dec = [];
    for (var i = 0; i < arr.length; i++) dec.push({ v: arr[i], i: i, k: keyFn ? callValue(keyFn, [arr[i]], {}) : arr[i] });
    dec.sort(function (a, b) {
      var c = pyCompare(a.k, b.k);
      if (c !== 0) return reverse ? -c : c;
      return a.i - b.i; // 稳定排序
    });
    var out = [];
    for (var j = 0; j < dec.length; j++) out.push(dec[j].v);
    return out;
  }
  function biRange(args) {
    if (args.length < 1 || args.length > 3) fail('range 需要 1~3 个参数');
    var ints = [];
    for (var i = 0; i < args.length; i++) ints.push(toIntVal(args[i], 'range 的参数'));
    var start = 0, stop, step = 1;
    if (ints.length === 1) stop = ints[0];
    else { start = ints[0]; stop = ints[1]; if (ints.length === 3) step = ints[2]; }
    if (step === 0) fail('range 的步长不能为 0');
    return new PyRange(start, stop, step);
  }
  function biEnumerate(args) {
    needArgs(args, 1, 'enumerate');
    var arr = materialize(args[0]), start = args.length > 1 ? toIntVal(args[1], 'enumerate 的起点') : 0, out = [];
    for (var i = 0; i < arr.length; i++) out.push(mkTuple([start + i, arr[i]]));
    return out;
  }
  function biZip(args) {
    if (!args.length) return [];
    var lists = [], min = Infinity;
    for (var i = 0; i < args.length; i++) { lists.push(materialize(args[i])); min = Math.min(min, lists[i].length); }
    var out = [];
    for (var j = 0; j < min; j++) { var t = []; for (var k = 0; k < lists.length; k++) t.push(lists[k][j]); out.push(mkTuple(t)); }
    return out;
  }
  function biInt(args) {
    if (!args.length) return 0;
    var v = args[0];
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Math.trunc(v);
    if (v instanceof PyFloat) return Math.trunc(v.v);
    if (typeof v === 'string') { var s = v.trim(); if (!/^[+\-]?\d+$/.test(s)) fail('无法把字符串 ' + pyRepr(v) + ' 转换成整数'); return parseInt(s, 10); }
    fail('int() 的参数类型不正确：' + typeName(v));
  }
  function biFloat(args) {
    if (!args.length) return new PyFloat(0);
    var v = args[0];
    if (typeof v === 'boolean') return new PyFloat(v ? 1 : 0);
    if (typeof v === 'number') return new PyFloat(v);
    if (v instanceof PyFloat) return new PyFloat(v.v);
    if (typeof v === 'string') { var s = v.trim(); if (!/^[+\-]?(\d+(\.\d*)?|\.\d+)([eE][+\-]?\d+)?$/.test(s)) fail('无法把字符串 ' + pyRepr(v) + ' 转换成小数'); return new PyFloat(Number(s)); }
    fail('float() 的参数类型不正确：' + typeName(v));
  }
  function biStr(args) { return !args.length ? '' : pyStr(args[0]); }
  function biBool(args) { return !args.length ? false : truthy(args[0]); }
  function biList(args) { return !args.length ? [] : materialize(args[0]); }
  function biTuple(args) { return mkTuple(!args.length ? [] : materialize(args[0])); }
  function makeGlobal() {
    var g = new Env(null);
    g.set('print', biPrint); g.set('input', biInput); g.set('len', biLen); g.set('sum', biSum);
    g.set('min', function (a, kw) { return biMinMax(a, kw, false); });
    g.set('max', function (a, kw) { return biMinMax(a, kw, true); });
    g.set('abs', biAbs); g.set('round', biRound); g.set('sorted', biSorted);
    g.set('int', biInt); g.set('float', biFloat); g.set('str', biStr); g.set('bool', biBool);
    g.set('list', biList); g.set('tuple', biTuple); g.set('range', biRange);
    g.set('enumerate', biEnumerate); g.set('zip', biZip);
    g.set('open', function () { fail('暂不支持文件操作 open，本站判题只支持 Python 基础语法'); });
    g.set('set', function () { fail('暂不支持集合 set，本站判题只支持 Python 基础语法'); });
    return g;
  }
  // ===== f-string 与格式说明符 =====
  function evalFString(n, env) {
    var out = '';
    for (var i = 0; i < n.parts.length; i++) {
      var p = n.parts[i];
      if (typeof p === 'string') { out += p; continue; }
      var v = evalExpr(p.expr, env);
      if (p.conv === 'r') v = pyRepr(v);
      else if (p.conv === 's') v = pyStr(v);
      out += p.spec ? formatValue(v, p.spec) : pyStr(v);
    }
    return out;
  }
  function expFormat(x, p, upper) { var s = x.toExponential(p).replace(/e([+\-])(\d)$/, 'e$10$2'); return upper ? s.toUpperCase() : s; }
  function gFormat(x, p) { if (x === 0) return '0'; var s = x.toPrecision(p); if (s.indexOf('e') < 0 && s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, ''); return s; }
  function insertCommas(s) {
    var m = /^([+\- ]?)(\d+)(\.\d*)?([eE][+\-]?\d+)?$/.exec(s);
    if (!m) return s;
    return m[1] + m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (m[3] || '') + (m[4] || '');
  }
  function formatValue(v, spec) {
    if (spec === '') return pyStr(v);
    var s = spec, fill = ' ', align = null, sign = '', zero = false;
    var width = 0, comma = false, prec = null, type = '';
    if (s.length && '<>=^'.indexOf(s.charAt(0)) >= 0) { align = s.charAt(0); s = s.slice(1); }
    else if (s.length > 1 && '<>=^'.indexOf(s.charAt(1)) >= 0) { fill = s.charAt(0); align = s.charAt(1); s = s.slice(2); }
    if (s.charAt(0) === '+' || s.charAt(0) === '-' || s.charAt(0) === ' ') { sign = s.charAt(0); s = s.slice(1); }
    if (s.length > 1 && s.charAt(0) === '0') { zero = true; s = s.slice(1); }
    var wm = /^\d+/.exec(s);
    if (wm) { width = parseInt(wm[0], 10); s = s.slice(wm[0].length); }
    if (s.charAt(0) === ',') { comma = true; s = s.slice(1); }
    if (s.charAt(0) === '.') { var pm = /^\.(\d+)/.exec(s); if (!pm) fail('格式说明不合法：' + spec); prec = parseInt(pm[1], 10); s = s.slice(pm[0].length); }
    if (/^[bcdeEfFgGnosxX%]$/.test(s)) { type = s; s = s.slice(1); }
    if (s !== '') fail('暂不支持的格式说明：' + spec);
    var body;
    if (typeof v === 'string') {
      body = v;
      if (prec !== null) body = body.slice(0, prec);
      if (type !== '' && type !== 's') fail('字符串不支持格式类型 "' + type + '"');
    } else if (v === null || v === undefined || typeof v === 'boolean') {
      if (type !== '') fail('该类型不支持格式类型 "' + type + '"');
      body = pyStr(v);
    } else if (isNumLike(v)) {
      var x = num(v);
      if (!isFinite(x)) body = pyStr(v);
      else {
        switch (type) {
          case '': body = (v instanceof PyFloat || prec !== null) ? (prec === null ? pyStr(v) : gFormat(x, prec)) : String(x); break;
          case 'd': body = String(Math.trunc(x)); break;
          case 'f': case 'F': body = x.toFixed(prec === null ? 6 : prec); break;
          case 'e': case 'E': body = expFormat(x, prec === null ? 6 : prec, type === 'E'); break;
          case 'g': case 'G':
            body = gFormat(x, prec === null ? 6 : prec);
            if (type === 'G') body = body.toUpperCase();
            break;
          case 'x': body = Math.trunc(x).toString(16); break;
          case 'X': body = Math.trunc(x).toString(16).toUpperCase(); break;
          case '%': body = (x * 100).toFixed(prec === null ? 6 : prec) + '%'; break;
          default: fail('暂不支持的格式类型 "' + type + '"');
        }
        if (body.charAt(0) !== '-' && sign === '+') body = '+' + body;
        else if (body.charAt(0) !== '-' && sign === ' ') body = ' ' + body;
        if (comma) body = insertCommas(body);
      }
    } else { if (type !== '') fail('该类型不支持格式类型 "' + type + '"'); body = pyStr(v); }
    if (width > body.length) {
      var pad = width - body.length, al = align || (typeof v === 'string' ? '<' : '>');
      if (zero && (al === '>' || al === '=')) {
        var zm = /^([+\- ]?)([\s\S]*)$/.exec(body);
        body = zm[1] + '0'.repeat(pad) + zm[2];
      } else if (al === '=') {
        var em = /^([+\- ]?)([\s\S]*)$/.exec(body);
        body = em[1] + fill.repeat(pad) + em[2];
      } else { var left = al === '>' ? pad : (al === '^' ? Math.floor(pad / 2) : 0); body = fill.repeat(left) + body + fill.repeat(pad - left); }
    }
    return body;
  }
  // ===== 统一入口 =====
  function describeError(e) {
    var line = RT ? RT.line : 1;
    if (e instanceof PyErr) return e.message;
    if (e instanceof RangeError) return '递归层数过深';
    if (e && e.__sig === 'return') return '第 ' + line + ' 行：return 只能用在函数内部';
    if (e && e.__sig) return '第 ' + line + ' 行：break/continue 只能用在循环内部';
    return '第 ' + line + ' 行：内部错误（' + (e && e.message ? e.message : String(e)) + '）';
  }
  function runPy(code, stdin) {
    var prev = RT;
    RT = { steps: 0, buf: [], outLen: 0, line: 1, depth: 0, funcDepth: 0, loopDepth: 0, stdinLines: [], stdinPos: 0 };
    try {
      if (stdin !== null && stdin !== undefined) RT.stdinLines = String(stdin).replace(/\r\n?/g, '\n').split('\n');
      var src = String(code === null || code === undefined ? '' : code);
      var logical = preprocess(src), parsed = [];
      for (var i = 0; i < logical.length; i++) { var L = logical[i], m = /^ */.exec(L.text); L.indent = m[0].length; L.tokens = tokenize(L.text.slice(L.indent), L.line); if (L.tokens.length) parsed.push(L); }
      execBlock(new Parser(parsed).parseProgram(), makeGlobal());
      return { ok: true, out: RT.buf.join(''), err: '' };
    } catch (e) {
      var msg;
      try { msg = describeError(e); } catch (e2) { msg = '第 1 行：内部错误'; }
      return { ok: false, out: RT.buf.join(''), err: msg };
    } finally { RT = prev; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { runPy: runPy };
  if (typeof window !== 'undefined') window.runPy = runPy;
  root.runPy = runPy;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));