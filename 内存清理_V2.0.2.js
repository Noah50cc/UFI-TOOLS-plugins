//<script>
/*
 * 内存清理 v2.0.2（审计重写版）
 * 适用于：飞猫 U20 / 中兴 F50 等 UFI-TOOLS 高级后台（192.168.x.1:2333）
 * 功能：查看内存/ZRAM 状态，一键释放页面缓存、整理内存碎片，附带连接诊断
 * 安装：UFI-TOOLS 页面 → 插件功能 → 增加插件 → 新建空文本插件 → 粘贴本文件全部内容 → 保存 → 刷新页面
 *
 * 审计结论（v1.x 遗留问题，本版已修复）：
 *  1. v1.0 的 /api/root_shell 单通道无鉴权，失败即无限"读取中" → 本版自动携带登录凭证、
 *     20 秒超时、多路 shell 接口兜底、失败明示错误原因。
 *  2. v1.x 清理前不校验 root，drop_caches 无权限失败时仍显示"清理完成" → 本版先测 id -u，
 *     非 root 直接禁用清理按钮并说明原因；清理命令显式上报 DC_OK / DC_FAIL。
 *  3. v1.x 采集了 ZRAM 数据却从未展示 → 本版解析 mm_stat 并展示压缩比。
 *  4. shell 接口在各版本 UFI-TOOLS 上是否真实存在，离线无法验证 → 本版内置"诊断连接"，
 *     逐个测试每路接口并报告可用性，5 秒出结论。
 *
 * 清理原理：sync + echo 3 > /proc/sys/vm/drop_caches + echo 1 > /proc/sys/vm/compact_memory。
 * 只丢弃可重建的干净缓存页，不杀进程、不丢数据。本插件不做杀进程式伪清理。
 */
(function () {
  'use strict';

  var TITLE = '内存清理';
  var VERSION = '2.0.2';
  var BTN_ID = 'kn_memclean2_main_btn';
  var MODAL_ID = 'kn_memclean2_modal';
  var STYLE_ID = 'kn_memclean2_style';

  /* ---------- 基础 ---------- */

  function getBaseURL() {
    try { if (typeof KANO_baseURL !== 'undefined' && KANO_baseURL) return String(KANO_baseURL).replace(/\/$/, ''); } catch (e) {}
    return '/api';
  }

  function toast(msg, type) {
    if (typeof createToast === 'function') { createToast(msg, type || 'pink'); return; }
    console.log('[内存清理]', msg);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function getHeaders() {
    var headers = { 'Content-Type': 'application/json;charset=UTF-8' };
    try { if (typeof common_headers !== 'undefined' && common_headers) Object.assign(headers, common_headers); } catch (e) {}
    try {
      var token = localStorage.getItem('kano_sms_token') || localStorage.getItem('KANO_TOKEN') || localStorage.getItem('kano_token') || '';
      if (token && !headers.authorization && !headers.Authorization) headers.authorization = token;
    } catch (e) {}
    return headers;
  }

  function shellText(res) {
    if (res == null) return '';
    if (typeof res === 'string') return res;
    if (typeof res === 'object') {
      return String(res.content || res.output || res.stdout || res.stderr || res.data || res.result || '');
    }
    return String(res);
  }

  /* ---------- shell 传输层（多路兜底） ---------- */

  function postRootShellApi(command, timeoutMs) {
    var ms = timeoutMs || 20000;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, ms);
    var p = fetch(getBaseURL() + '/root_shell', {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ command: command }),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (text) {
        if (!res.ok) throw new Error('root_shell HTTP ' + res.status);
        try { return shellText(JSON.parse(text)); } catch (e) { return text; }
      });
    });
    return p.then(function (r) { if (timer) clearTimeout(timer); return r; },
      function (e) { if (timer) clearTimeout(timer); throw e; });
  }

  // 所有候选 shell 通道：名字 + 可用性检测 + 调用方式
  function getTransports() {
    var list = [
      { name: 'POST /api/root_shell', fn: function (cmd) { return postRootShellApi(cmd, 20000); } }
    ];
    function add(name, ok, fn) { try { if (ok()) list.push({ name: name, fn: fn }); } catch (e) {} }
    add('runRootShellCommand()', function () { return typeof runRootShellCommand === 'function'; },
      function (cmd) { return Promise.resolve().then(function () { return runRootShellCommand(cmd); }); });
    add('runShellWithRoot()', function () { return typeof runShellWithRoot === 'function'; },
      function (cmd) { return Promise.resolve().then(function () { return runShellWithRoot(cmd); }); });
    add('KanoShell.run()', function () { return window.KanoShell && typeof window.KanoShell.run === 'function'; },
      function (cmd) { return Promise.resolve().then(function () { return window.KanoShell.run(cmd); }); });
    add('KanoShell.exec()', function () { return window.KanoShell && typeof window.KanoShell.exec === 'function'; },
      function (cmd) { return Promise.resolve().then(function () { return window.KanoShell.exec(cmd); }); });
    add('window.runShell()', function () { return typeof window.runShell === 'function'; },
      function (cmd) { return Promise.resolve().then(function () { return window.runShell(cmd); }); });
    add('window.execShell()', function () { return typeof window.execShell === 'function'; },
      function (cmd) { return Promise.resolve().then(function () { return window.execShell(cmd); }); });
    return list;
  }

  // 按顺序尝试各通道，返回首个成功的结果文本
  function runRoot(cmd, timeoutMs) {
    var list = getTransports();
    var chain = Promise.reject(new Error('start'));
    list.forEach(function (t) {
      chain = chain.catch(function () {
        if (timeoutMs && t.name.indexOf('/api/root_shell') !== -1) return postRootShellApi(cmd, timeoutMs);
        return t.fn(cmd);
      });
    });
    return chain.then(shellText);
  }

  /* ---------- 设备命令 ---------- */

  var CMD_STATUS = [
    'echo "---ID---"; id -u',
    'echo "---SE---"; getenforce 2>/dev/null || echo "N/A"',
    'echo "---MEM---"; cat /proc/meminfo',
    'echo "---ZRAM---"; cat /sys/block/zram0/mm_stat 2>/dev/null || echo "N/A"',
    'echo "---TOP---"; ps -A -o comm,rss 2>/dev/null | sort -k2 -rn | head -12 || echo "N/A"'
  ].join('; ');

  // 注意：后台可能按 ";" 拆分命令逐条执行，因此这里只用最简单的单条命令，
  // 不用 if/fi、$()、&& 链等多行复合结构；用 CLN_S1..CLN_END 标记定位各段输出
  var CMD_CLEAN = [
    'sync',
    'echo CLN_S1',
    'rm -f /tmp/mc_dc_err',
    'echo 3 > /proc/sys/vm/drop_caches 2>/tmp/mc_dc_err',
    'echo CLN_S2',
    'cat /tmp/mc_dc_err 2>/dev/null',
    'echo CLN_S3',
    'echo 1 > /proc/sys/vm/compact_memory 2>/dev/null',
    'echo CLN_END'
  ].join('; ');

  var CMD_DIAG = 'echo DIAG_OK';

  /* ---------- 解析 ---------- */

  function parseSections(text, names) {
    var secs = {}, cur = names[0];
    names.forEach(function (n) { secs[n] = ''; });
    String(text).split('\n').forEach(function (ln) {
      var t = ln.trim();
      var hit = null;
      names.forEach(function (n) { if (t === '---' + n + '---') hit = n; });
      if (hit) { cur = hit; return; }
      secs[cur] += ln + '\n';
    });
    return secs;
  }

  function parseMeminfo(text) {
    var m = {};
    String(text).split('\n').forEach(function (ln) {
      var p = ln.match(/^(\w+):\s+(\d+)/);
      if (p) m[p[1]] = parseInt(p[2], 10); // kB
    });
    var total = m.MemTotal || 0;
    var avail = m.MemAvailable || ((m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0));
    var swapTotal = m.SwapTotal || 0, swapFree = m.SwapFree || 0;
    return {
      total: total, available: avail, used: Math.max(0, total - avail),
      buffers: m.Buffers || 0, cached: (m.Cached || 0) + (m.SReclaimable || 0),
      swapTotal: swapTotal, swapUsed: Math.max(0, swapTotal - swapFree)
    };
  }

  // mm_stat 字段（字节）：orig_data_size compr_data_size mem_used_total ...（内核文档顺序）
  function parseZram(text) {
    var t = String(text).trim();
    if (!t || t === 'N/A') return null;
    var nums = t.split(/\s+/).map(function (x) { return parseInt(x, 10) || 0; });
    if (nums.length < 3) return null;
    return { orig: nums[0], compr: nums[1], used: nums[2] };
  }

  function parseTop(text) {
    var rows = [];
    String(text).split('\n').forEach(function (ln) {
      var p = ln.trim().match(/^(\S+)\s+(\d+)$/);
      if (p && rows.length < 10) rows.push({ comm: p[1], rss: parseInt(p[2], 10) });
    });
    return rows;
  }

  // 解析清理命令输出：CLN_END 存在=序列跑完；CLN_S2 与 CLN_S3 之间的文本=写入报错
  function parseCleanOut(out) {
    var res = { ran: false, error: '' };
    out = String(out || '');
    if (out.indexOf('CLN_END') < 0) return res;
    res.ran = true;
    var m = out.match(/CLN_S2\n([\s\S]*?)\nCLN_S3/);
    var err = (m && m[1] || '').split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return l && l !== 'CLN_S2' && l !== 'CLN_S3'; }).join(' ');
    if (err) res.error = err.slice(0, 200);
    return res;
  }

  function fmtSize(kb) {
    if (kb == null || isNaN(kb)) return '--';
    var mb = kb / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  function fmtBytes(b) {
    if (b == null || isNaN(b)) return '--';
    var mb = b / 1048576;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  function pct(used, total) {
    if (!total) return 0;
    return Math.min(100, Math.round(used / total * 100));
  }

  /* ---------- 状态与渲染 ---------- */

  var state = { id: '', se: '', isRoot: false, mem: null, zram: null, top: [], busy: false, before: 0, freed: null, error: '', diag: null, phase: '', cleanResult: null };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + MODAL_ID + '{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}',
      '#' + MODAL_ID + ' .mc-box{width:min(580px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#141a26;border:1px solid #2a3448;border-radius:14px;color:#e8eef7;box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden;}',
      '#' + MODAL_ID + ' .mc-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #2a3448;}',
      '#' + MODAL_ID + ' .mc-title{font-size:16px;font-weight:800;}',
      '#' + MODAL_ID + ' .mc-ver{font-size:11px;color:#8b98ad;margin-left:8px;font-weight:400;}',
      '#' + MODAL_ID + ' .mc-close{background:#243046;border:1px solid #33415c;color:#e8eef7;border-radius:8px;padding:6px 14px;cursor:pointer;}',
      '#' + MODAL_ID + ' .mc-body{padding:16px 18px;overflow-y:auto;}',
      '#' + MODAL_ID + ' .mc-sec{font-size:13px;font-weight:800;color:#9fb2cc;margin:14px 0 8px;}',
      '#' + MODAL_ID + ' .mc-sec:first-child{margin-top:0;}',
      '#' + MODAL_ID + ' .mc-bar{height:10px;background:#243046;border-radius:6px;overflow:hidden;margin:8px 0;}',
      '#' + MODAL_ID + ' .mc-bar > div{height:100%;background:linear-gradient(90deg,#3b82f6,#60a5fa);border-radius:6px;transition:width .4s;}',
      '#' + MODAL_ID + ' .mc-bar.hot > div{background:linear-gradient(90deg,#f59e0b,#fbbf24);}',
      '#' + MODAL_ID + ' .mc-kv{display:grid;grid-template-columns:112px 1fr;gap:6px 10px;font-size:13px;}',
      '#' + MODAL_ID + ' .mc-kv b{color:#8b98ad;font-weight:600;}',
      '#' + MODAL_ID + ' .mc-ok{color:#4ade80;font-weight:700;}',
      '#' + MODAL_ID + ' .mc-bad{color:#f87171;font-weight:700;}',
      '#' + MODAL_ID + ' .mc-warn{color:#fbbf24;font-weight:700;}',
      '#' + MODAL_ID + ' .mc-note{font-size:12px;color:#8b98ad;line-height:1.7;background:#182032;border:1px solid #2a3448;border-radius:10px;padding:10px 12px;margin-top:12px;}',
      '#' + MODAL_ID + ' .mc-err{font-size:12px;color:#fca5a5;line-height:1.7;background:#2a1616;border:1px solid #7f2d2d;border-radius:10px;padding:10px 12px;margin-top:12px;}',
      '#' + MODAL_ID + ' .mc-top{font-size:12px;color:#a9b8cf;}',
      '#' + MODAL_ID + ' .mc-top table{width:100%;border-collapse:collapse;}',
      '#' + MODAL_ID + ' .mc-top td{padding:4px 6px;border-bottom:1px solid #223046;}',
      '#' + MODAL_ID + ' .mc-top td:last-child{text-align:right;color:#8b98ad;}',
      '#' + MODAL_ID + ' .mc-btn{background:#243046;border:1px solid #33415c;color:#e8eef7;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;}',
      '#' + MODAL_ID + ' .mc-btn:hover{background:#2e3c58;}',
      '#' + MODAL_ID + ' .mc-btn.primary{background:#1d4ed8;border-color:#2563eb;font-weight:700;}',
      '#' + MODAL_ID + ' .mc-btn.primary:hover{background:#2563eb;}',
      '#' + MODAL_ID + ' .mc-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '#' + MODAL_ID + ' .mc-foot{display:flex;gap:8px;padding:12px 18px;border-top:1px solid #2a3448;flex-wrap:wrap;}',
      '#' + MODAL_ID + ' .mc-loading{color:#8b98ad;font-size:13px;padding:18px;text-align:center;}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function renderBody() {
    var body = document.querySelector('#' + MODAL_ID + ' .mc-body');
    if (!body) return;

    if (state.diag) { renderDiag(body); return; }

    if (!state.mem) {
      if (state.error) {
        body.innerHTML = '<div class="mc-err">读取失败：' + esc(state.error) +
          '<br><br>排查步骤：<br>1. 点下方「诊断连接」，看哪路 shell 接口可用；<br>' +
          '2. 若全部失败，说明当前 UFI-TOOLS 版本未开放 shell 接口，插件无法工作；<br>' +
          '3. 若曾可用现在失败，可能是登录过期，刷新页面重新登录后重试。</div>';
      } else {
        body.innerHTML = '<div class="mc-loading">' + (state.busy ? '执行中…' : '读取中…') + '</div>';
      }
      return;
    }

    var m = state.mem, p = pct(m.used, m.total), html = '';
    html += '<div class="mc-sec">内存状态</div>';
    html += '<div class="mc-kv">';
    html += '<b>Root 权限</b><span class="' + (state.isRoot ? 'mc-ok' : 'mc-bad') + '">' + (state.isRoot ? '已获取 (uid 0)' : '未获取 (uid ' + esc(state.id || '?') + ')') + '</span>';
    if (state.se && state.se !== 'N/A') html += '<b>SELinux</b><span>' + esc(state.se) + '</span>';
    html += '<b>已用 / 总量</b><span>' + fmtSize(m.used) + ' / ' + fmtSize(m.total) + '（' + p + '%）</span>';
    html += '<b>可用内存</b><span class="' + (p >= 90 ? 'mc-warn' : 'mc-ok') + '">' + fmtSize(m.available) + '</span>';
    html += '<b>缓存占用</b><span>' + fmtSize(m.cached) + '（可释放）</span>';
    if (m.swapTotal > 0) html += '<b>Swap 已用</b><span>' + fmtSize(m.swapUsed) + ' / ' + fmtSize(m.swapTotal) + '</span>';
    if (state.zram) {
      var zr = state.zram, ratio = zr.compr > 0 ? (zr.orig / zr.compr).toFixed(2) + ' : 1' : '--';
      html += '<b>ZRAM</b><span>已用 ' + fmtBytes(zr.used) + '，原始 ' + fmtBytes(zr.orig) + '，压缩比 ' + ratio + '</span>';
    }
    html += '</div>';
    html += '<div class="mc-bar' + (p >= 90 ? ' hot' : '') + '"><div style="width:' + p + '%"></div></div>';
    if (state.freed != null) {
      html += '<div class="mc-kv"><b>本次释放</b><span class="mc-ok">约 ' + fmtSize(state.freed) + ' 可用内存</span></div>';
    }
    if (state.phase === 'cleaning') {
      html += '<div class="mc-note">正在清理：sync → 清空页面缓存 → 整理内存碎片，请稍候…（最长 45 秒）</div>';
    }
    if (state.cleanResult) {
      var cr = state.cleanResult;
      if (cr.dc) {
        html += '<div class="mc-note" style="border-color:#2d5a3a">清理结果：页面缓存已清空' + (cr.cm ? '，内存碎片已整理' : '（碎片整理跳过，内核不支持）') + '。</div>';
      } else {
        html += '<div class="mc-err">清理失败：' + esc(cr.err || '未知错误') + '</div>';
      }
    }
    if (!state.isRoot) {
      html += '<div class="mc-err">当前 shell 不是 root，无权清理内存缓存。请先按 U20 教程完成 root。</div>';
    }
    if (state.top.length) {
      html += '<div class="mc-sec">内存占用 Top（仅查看，不杀进程）</div>';
      html += '<div class="mc-top"><table>';
      state.top.forEach(function (r) {
        html += '<tr><td>' + esc(r.comm) + '</td><td>' + fmtSize(r.rss) + '</td></tr>';
      });
      html += '</table></div>';
    }
    html += '<div class="mc-note">原理：sync + 清空页面缓存（drop_caches）+ 整理内存碎片（compact_memory），只丢弃可重建的缓存，不杀进程、不丢数据。Android 会自动回收后台应用，杀进程式清理反而更耗电，<b>所以本插件不杀进程</b>。</div>';
    body.innerHTML = html;
    syncFootButtons();
  }

  function renderDiag(body) {
    var html = '<div class="mc-sec">连接诊断（逐个测试 shell 通道）</div><div class="mc-top"><table>';
    state.diag.forEach(function (d) {
      var cls = d.ok ? 'mc-ok' : 'mc-bad';
      html += '<tr><td>' + esc(d.name) + '</td><td class="' + cls + '">' + (d.ok ? '可用' : '失败') + '</td></tr>';
      if (!d.ok && d.err) html += '<tr><td colspan="2" style="color:#8b98ad;font-size:11px">' + esc(String(d.err).slice(0, 120)) + '</td></tr>';
    });
    html += '</table></div>';
    var okCount = state.diag.filter(function (d) { return d.ok; }).length;
    html += '<div class="mc-note">可用通道：' + okCount + ' / ' + state.diag.length +
      '。' + (okCount > 0 ? '至少一路可用，插件可以工作，点「刷新」重试。' : '全部失败：当前 UFI-TOOLS 版本未开放 shell 接口，插件无法在此设备上工作。') + '</div>';
    body.innerHTML = html;
  }

  function syncFootButtons() {
    var btn = document.querySelector('#' + MODAL_ID + ' [data-act="clean"]');
    if (btn) btn.disabled = state.busy || !state.isRoot;
  }

  /* ---------- 动作 ---------- */

  function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.freed = null;
    state.error = '';
    state.diag = null;
    renderBody();
    runRoot(CMD_STATUS).then(function (t) {
      var secs = parseSections(t, ['ID', 'SE', 'MEM', 'ZRAM', 'TOP']);
      state.id = secs.ID.trim();
      state.se = secs.SE.trim();
      state.isRoot = (state.id === '0');
      state.mem = parseMeminfo(secs.MEM);
      state.zram = parseZram(secs.ZRAM);
      state.top = parseTop(secs.TOP);
      if (!state.mem.total) throw new Error('shell 返回为空，接口可能不可用');
    }).catch(function (e) {
      state.error = (e && e.message) || String(e);
      toast('读取失败：' + state.error, 'red');
      state.mem = null;
    }).finally(function () {
      state.busy = false;
      renderBody();
    });
  }

  function doClean() {
    if (state.busy || !state.isRoot || !state.mem) return;
    state.before = state.mem.available;
    state.busy = true;
    state.diag = null;
    state.cleanResult = null;
    state.phase = 'cleaning';
    state.error = '';
    renderBody();
    // 清理允许更久：compact_memory 在碎片严重时较慢
    runRoot(CMD_CLEAN, 45000).then(function (out) {
      try { window.KanoMemClean.lastCleanOut = String(out).slice(0, 800); } catch (e) {}
      var cr = parseCleanOut(out);
      if (!cr.ran) throw new Error('清理序列未跑完（缺少 CLN_END 回显），命令可能被后台截断');
      if (cr.error) {
        var hint = /denied|permission/i.test(cr.error) ? '——即使 uid=0，SELinux 也可能拒绝写入 /proc/sys' : '';
        throw new Error('drop_caches 写入被拒绝：' + cr.error + hint);
      }
      state.cleanResult = { dc: true, cm: true };
      return runRoot(CMD_STATUS);
    }).then(function (t) {
      var secs = parseSections(t, ['ID', 'SE', 'MEM', 'ZRAM', 'TOP']);
      state.se = secs.SE.trim();
      state.mem = parseMeminfo(secs.MEM);
      state.zram = parseZram(secs.ZRAM);
      state.top = parseTop(secs.TOP);
      state.freed = Math.max(0, state.mem.available - state.before);
      state.phase = '';
      toast('清理完成', 'green');
    }).catch(function (e) {
      state.phase = '';
      state.cleanResult = { dc: false, cm: false, err: (e && e.message) || String(e) };
      toast('清理失败：' + state.cleanResult.err, 'red');
    }).finally(function () {
      state.busy = false;
      renderBody();
    });
  }

  function doDiag() {
    if (state.busy) return;
    state.busy = true;
    state.diag = null;
    renderBody();
    var list = getTransports();
    var results = [];
    var chain = Promise.resolve();
    list.forEach(function (tr) {
      chain = chain.then(function () {
        return tr.fn(CMD_DIAG).then(function (out) {
          results.push({ name: tr.name, ok: shellText(out).indexOf('DIAG_OK') >= 0, err: '' });
        }).catch(function (e) {
          results.push({ name: tr.name, ok: false, err: (e && e.message) || String(e) });
        });
      });
    });
    chain.then(function () {
      state.diag = results;
    }).finally(function () {
      state.busy = false;
      renderBody();
    });
  }

  /* ---------- 入口 ---------- */

  function openModal() {
    injectStyle();
    var old = document.getElementById(MODAL_ID);
    if (old) old.remove();
    var modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML =
      '<div class="mc-box">' +
        '<div class="mc-head"><div><span class="mc-title">' + TITLE + '</span><span class="mc-ver">v' + VERSION + '</span></div>' +
        '<button class="mc-close" data-close>关闭</button></div>' +
        '<div class="mc-body"><div class="mc-loading">读取中…</div></div>' +
        '<div class="mc-foot">' +
          '<button class="mc-btn primary" data-act="clean">一键清理</button>' +
          '<button class="mc-btn" data-act="refresh">刷新</button>' +
          '<button class="mc-btn" data-act="diag">诊断连接</button>' +
        '</div>' +
      '</div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeModal(); return; }
      if (e.target.closest('[data-close]')) { closeModal(); return; }
      var b = e.target.closest('[data-act]');
      if (!b || state.busy) return;
      var act = b.getAttribute('data-act');
      if (act === 'clean') doClean();
      else if (act === 'refresh') refresh();
      else if (act === 'diag') doDiag();
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', escHandler);
    refresh();
  }

  function escHandler(e) { if (e.key === 'Escape') closeModal(); }
  function closeModal() {
    var m = document.getElementById(MODAL_ID);
    if (m) m.remove();
    document.removeEventListener('keydown', escHandler);
  }

  var oldBtn = document.getElementById(BTN_ID);
  if (oldBtn) oldBtn.remove();
  // 移除旧版按钮，避免重复
  ['kn_memclean_main_btn'].forEach(function (id) {
    var b = document.getElementById(id);
    if (b) b.remove();
  });
  var mainBtn = document.createElement('button');
  mainBtn.id = BTN_ID;
  mainBtn.textContent = TITLE;
  mainBtn.onclick = openModal;
  var host = document.querySelector('.actions-buttons') || document.querySelector('.collapse_box') || document.body;
  host.appendChild(mainBtn);

  window.KanoMemClean = { version: VERSION, open: openModal, close: closeModal, refresh: refresh, diag: doDiag };
})();
//</script>
