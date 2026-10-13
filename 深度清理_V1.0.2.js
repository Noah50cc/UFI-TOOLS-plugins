//<script>
/*
 * 深度清理 v1.0.2
 * 适用于：飞猫 U20 / 中兴 F50 等 UFI-TOOLS 高级后台（192.168.x.1:2333）
 * 功能：应用缓存清理（pm trim-caches）、结束无用进程
 * 安装：UFI-TOOLS 页面 → 插件功能 → 增加插件 → 新建空文本插件 → 粘贴本文件全部内容 → 保存 → 刷新页面
 *
 * v1.0.2 起移除温度监测（温度功能已移至「温控降温」插件）。
 *
 * 安全设计：
 *  - 只列出应用 UID（u0_aXXX）进程，system/root 等系统进程不在候选内；
 *  - 关键进程名（system_server/zygote/surfaceflinger/netd/vold 等）硬性排除；
 *  - 通过 cmdline 自动识别 UFI-TOOLS 后台自身进程（kano/ufi 相关），绝对保护，永不列入候选；
 *  - PID 1 永不列入；动手前 confirm 二次确认，可逐个取消勾选；
 *  - shell 命令只用单条简单命令（后台可能按 ";" 拆分执行，不用 if/fi、$()、for）。
 */
(function () {
  'use strict';

  var TITLE = '深度清理';
  var VERSION = '1.0.2';
  var BTN_ID = 'kn_deepclean_main_btn';
  var MODAL_ID = 'kn_deepclean_modal';
  var STYLE_ID = 'kn_deepclean_style';

  /* ---------- 基础 ---------- */

  function getBaseURL() {
    try { if (typeof KANO_baseURL !== 'undefined' && KANO_baseURL) return String(KANO_baseURL).replace(/\/$/, ''); } catch (e) {}
    return '/api';
  }

  function toast(msg, type) {
    if (typeof createToast === 'function') { createToast(msg, type || 'pink'); return; }
    console.log('[深度清理]', msg);
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

  /* ---------- shell 传输层（多路兜底，与内存清理 v2.0.2 同源，已验证可用） ---------- */

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

  /* ---------- 设备命令（只用单条简单命令） ---------- */

  var CMD_STATUS = [
    'echo "---ID---"; id -u',
    'echo "---MEM---"; cat /proc/meminfo',
    'echo "---DF---"; df -k /data 2>/dev/null | tail -1',
    'echo "---PSA---"; ps -A -o pid,user,args,rss 2>/dev/null || echo NONE',
    'echo "---PSC---"; ps -A -o pid,user,comm,rss 2>/dev/null || echo NONE',
    'echo "---BACKEND---"; grep -aiH "kano\\|ufi\\|2333\\|minikano" /proc/[0-9]*/cmdline 2>/dev/null || echo NONE'
  ].join('; ');

  var CMD_TRIM = [
    'echo TRIM_S1',
    'df -k /data 2>/dev/null | tail -1',
    'echo TRIM_S2',
    'pm trim-caches 999G 2>&1',
    'echo TRIM_S3',
    'df -k /data 2>/dev/null | tail -1',
    'echo TRIM_END'
  ].join('; ');

  function buildKillCmd(pids) {
    return 'kill -9 ' + pids.join(' ') + '; echo KILL_END';
  }

  /* ---------- 解析 ---------- */

  function parseSections(text, names) {
    var secs = {}, cur = names[0];
    names.forEach(function (n) { secs[n] = ''; });
    String(text).split('\n').forEach(function (ln) {
      var t = ln.trim(), hit = null;
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
      if (p) m[p[1]] = parseInt(p[2], 10);
    });
    var total = m.MemTotal || 0;
    var avail = m.MemAvailable || ((m.MemFree || 0) + (m.Buffers || 0) + (m.Cached || 0));
    return { total: total, available: avail, used: Math.max(0, total - avail) };
  }

  function parseDf(text) {
    var lines = String(text).trim().split('\n');
    var p = (lines[lines.length - 1] || '').trim().split(/\s+/);
    if (p.length < 4 || !/^\d+$/.test(p[1])) return null;
    return { size: parseInt(p[1], 10), used: parseInt(p[2], 10), avail: parseInt(p[3], 10) };
  }

  // ps -A -o pid,user,args,rss：从右解析，args 中间可含空格
  function parsePs(text) {
    var rows = [];
    String(text).split('\n').forEach(function (ln) {
      var m = ln.match(/^\s*(\d+)\s+(\S+)\s+(.*?)\s+(\d+)\s*$/);
      if (m) rows.push({ pid: parseInt(m[1], 10), user: m[2], name: m[3].split(/\s+/)[0] || m[3], rss: parseInt(m[4], 10) });
    });
    return rows;
  }

  // 关键进程硬性排除（即使 UID 伪装也不杀）
  var CRITICAL = {
    system_server: 1, zygote: 1, zygote64: 1, usap_pool_primary: 1, usap_pool_secondary: 1,
    servicemanager: 1, hwservicemanager: 1, vndservicemanager: 1, surfaceflinger: 1,
    audioserver: 1, cameraserver: 1, drmserver: 1, mediadrmserver: 1, mediaextractor: 1,
    netd: 1, vold: 1, installd: 1, keystore: 1, keystore2: 1, gatekeeperd: 1,
    ueventd: 1, logd: 1, lmkd: 1, traced: 1, adbd: 1, init: 1, sh: 1, ps: 1, pm: 1
  };

  function killable(p) {
    if (!p || p.pid <= 1) return false;
    if (!/^u\d+_a\d+$/.test(p.user)) return false; // 只要应用 UID 进程
    if (state.backendPids && state.backendPids[p.pid]) return false; // 后台自身进程，绝对保护
    var nm = String(p.name || '');
    if (/kano|ufi/i.test(nm)) return false; // kano/ufi 相关进程名，绝对保护
    var base = nm.split('/').pop().split(':')[0].split('.')[0];
    if (CRITICAL[base]) return false;
    return true;
  }

  function fmtSize(kb) {
    if (kb == null || isNaN(kb)) return '--';
    var mb = kb / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : Math.round(mb) + ' MB';
  }

  /* ---------- 状态与渲染 ---------- */

  var state = {
    busy: false, isRoot: false, id: '', mem: null, df: null,
    procs: [], checked: {}, backendPids: {}, error: '', trimResult: '', phase: ''
  };

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + MODAL_ID + '{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}',
      '#' + MODAL_ID + ' .dc-box{width:min(620px,94vw);max-height:90vh;display:flex;flex-direction:column;background:#141a26;border:1px solid #2a3448;border-radius:14px;color:#e8eef7;box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden;}',
      '#' + MODAL_ID + ' .dc-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #2a3448;}',
      '#' + MODAL_ID + ' .dc-title{font-size:16px;font-weight:800;}',
      '#' + MODAL_ID + ' .dc-ver{font-size:11px;color:#8b98ad;margin-left:8px;font-weight:400;}',
      '#' + MODAL_ID + ' .dc-close{background:#243046;border:1px solid #33415c;color:#e8eef7;border-radius:8px;padding:6px 14px;cursor:pointer;}',
      '#' + MODAL_ID + ' .dc-body{padding:16px 18px;overflow-y:auto;}',
      '#' + MODAL_ID + ' .dc-sec{font-size:13px;font-weight:800;color:#9fb2cc;margin:14px 0 8px;display:flex;justify-content:space-between;align-items:center;}',
      '#' + MODAL_ID + ' .dc-sec:first-child{margin-top:0;}',
      '#' + MODAL_ID + ' .dc-kv{display:grid;grid-template-columns:112px 1fr;gap:6px 10px;font-size:13px;}',
      '#' + MODAL_ID + ' .dc-kv b{color:#8b98ad;font-weight:600;}',
      '#' + MODAL_ID + ' .dc-ok{color:#4ade80;font-weight:700;}',
      '#' + MODAL_ID + ' .dc-bad{color:#f87171;font-weight:700;}',
      '#' + MODAL_ID + ' .dc-warn{color:#fbbf24;font-weight:700;}',
      '#' + MODAL_ID + ' .dc-note{font-size:12px;color:#8b98ad;line-height:1.7;background:#182032;border:1px solid #2a3448;border-radius:10px;padding:10px 12px;margin-top:12px;}',
      '#' + MODAL_ID + ' .dc-err{font-size:12px;color:#fca5a5;line-height:1.7;background:#2a1616;border:1px solid #7f2d2d;border-radius:10px;padding:10px 12px;margin-top:12px;}',
      '#' + MODAL_ID + ' table.dc-t{width:100%;border-collapse:collapse;font-size:12px;color:#a9b8cf;}',
      '#' + MODAL_ID + ' table.dc-t td, #' + MODAL_ID + ' table.dc-t th{padding:5px 6px;border-bottom:1px solid #223046;text-align:left;}',
      '#' + MODAL_ID + ' table.dc-t th{color:#8b98ad;font-weight:600;font-size:11px;}',
      '#' + MODAL_ID + ' table.dc-t td.r, #' + MODAL_ID + ' table.dc-t th.r{text-align:right;}',
      '#' + MODAL_ID + ' .dc-proc-list{max-height:220px;overflow-y:auto;border:1px solid #2a3448;border-radius:10px;}',
      '#' + MODAL_ID + ' .dc-btn{background:#243046;border:1px solid #33415c;color:#e8eef7;border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;}',
      '#' + MODAL_ID + ' .dc-btn:hover{background:#2e3c58;}',
      '#' + MODAL_ID + ' .dc-btn.primary{background:#1d4ed8;border-color:#2563eb;font-weight:700;}',
      '#' + MODAL_ID + ' .dc-btn.primary:hover{background:#2563eb;}',
      '#' + MODAL_ID + ' .dc-btn.danger{border-color:#7f2d2d;color:#fca5a5;}',
      '#' + MODAL_ID + ' .dc-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '#' + MODAL_ID + ' .dc-foot{display:flex;gap:8px;padding:12px 18px;border-top:1px solid #2a3448;flex-wrap:wrap;}',
      '#' + MODAL_ID + ' .dc-loading{color:#8b98ad;font-size:13px;padding:18px;text-align:center;}',
      '#' + MODAL_ID + ' input[type=checkbox]{width:15px;height:15px;accent-color:#2563eb;}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function renderBody() {
    var body = document.querySelector('#' + MODAL_ID + ' .dc-body');
    if (!body) return;
    if (state.error) {
      body.innerHTML = '<div class="dc-err">读取失败：' + esc(state.error) +
        '<br><br>若内存清理插件可用而本插件失败，把报错截图发给开发者。</div>';
      return;
    }
    if (!state.mem) {
      body.innerHTML = '<div class="dc-loading">' + (state.busy ? '执行中…' : '读取中…') + '</div>';
      return;
    }
    var html = '', i;

    /* 缓存 */
    html += '<div class="dc-sec"><span>应用缓存清理</span></div>';
    html += '<div class="dc-kv">';
    html += '<b>Root 权限</b><span class="' + (state.isRoot ? 'dc-ok' : 'dc-bad') + '">' +
      (state.isRoot ? '已获取 (uid 0)' : '未获取') + '</span>';
    if (state.df) {
      var dpct = state.df.size ? Math.round(state.df.used / state.df.size * 100) : 0;
      html += '<b>/data 已用</b><span>' + fmtSize(state.df.used) + ' / ' + fmtSize(state.df.size) + '（' + dpct + '%）</span>';
    } else {
      html += '<b>/data</b><span>--</span>';
    }
    html += '</div>';
    html += '<div style="margin-top:8px;display:flex;gap:8px"><button class="dc-btn primary" data-act="trim" ' +
      (state.busy || !state.isRoot ? 'disabled' : '') + '>清理应用缓存</button></div>';
    if (state.trimResult) html += '<div class="dc-note">' + state.trimResult + '</div>';
    if (state.phase) html += '<div class="dc-note">' + esc(state.phase) + '</div>';

    /* 进程 */
    var cands = state.procs.filter(killable);
    var checkedCount = 0, checkedRss = 0;
    cands.forEach(function (p) { if (state.checked[p.pid]) { checkedCount++; checkedRss += p.rss; } });
    html += '<div class="dc-sec"><span>无用进程（' + cands.length + ' 个候选，仅应用进程）</span>' +
      '<label style="font-size:12px;color:#8b98ad;font-weight:400"><input type="checkbox" data-act="all" ' +
      (cands.length && checkedCount === cands.length ? 'checked' : '') + '> 全选</label></div>';
    if (!cands.length) {
      html += '<div class="dc-note">没有可结束的应用进程。</div>';
    } else {
      html += '<div class="dc-proc-list"><table class="dc-t"><tr><th></th><th>进程</th><th>UID</th><th class="r">内存</th></tr>';
      cands.forEach(function (p) {
        html += '<tr><td><input type="checkbox" data-pid="' + p.pid + '" ' + (state.checked[p.pid] ? 'checked' : '') + '></td>' +
          '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(p.name) + '">' + esc(p.name) + '</td>' +
          '<td>' + esc(p.user) + '</td><td class="r">' + fmtSize(p.rss) + '</td></tr>';
      });
      html += '</table></div>';
      html += '<div style="margin-top:8px"><button class="dc-btn danger" data-act="kill" ' +
        (state.busy || !checkedCount ? 'disabled' : '') + '>结束选中进程（' + checkedCount + ' 个，约 ' + fmtSize(checkedRss) + '）</button></div>';
    }
    html += '<div class="dc-note">只列出应用 UID（u0_aXXX）进程；system_server、zygote、surfaceflinger、netd、vold 等关键进程硬性排除；<b>UFI-TOOLS 后台自身进程（kano/ufi 相关）自动识别并绝对保护</b>，PID 1 永不列入。部分应用被结束后系统会自动拉起，释放效果是暂时的。</div>';

    body.innerHTML = html;
  }

  /* ---------- 动作 ---------- */

  function applyStatus(t) {
    var secs = parseSections(t, ['ID', 'MEM', 'DF', 'PSA', 'PSC', 'BACKEND']);
    state.id = secs.ID.trim();
    state.isRoot = (state.id === '0');
    // 先识别后台自身进程，加入绝对保护名单
    state.backendPids = {};
    String(secs.BACKEND).split('\n').forEach(function (ln) {
      var m = ln.match(/\/proc\/(\d+)\/cmdline:/);
      if (m) state.backendPids[parseInt(m[1], 10)] = true;
    });
    state.mem = parseMeminfo(secs.MEM);
    state.df = parseDf(secs.DF);
    var rows = parsePs(secs.PSA);
    if (!rows.length) rows = parsePs(secs.PSC); // args 不支持时回退到 comm
    state.procs = rows;
    // 新出现的候选默认勾选
    rows.forEach(function (p) {
      if (killable(p) && !(p.pid in state.checked)) state.checked[p.pid] = true;
    });
    if (!state.mem.total) throw new Error('shell 返回为空，接口可能不可用');
  }

  function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    renderBody();
    runRoot(CMD_STATUS).then(function (t) {
      applyStatus(t);
    }).catch(function (e) {
      state.error = (e && e.message) || String(e);
      toast('读取失败：' + state.error, 'red');
      state.mem = null;
    }).finally(function () {
      state.busy = false;
      renderBody();
    });
  }

  function doTrim() {
    if (state.busy || !state.isRoot) return;
    state.busy = true;
    state.phase = '正在清理应用缓存（pm trim-caches），请稍候…';
    state.trimResult = '';
    renderBody();
    var before = state.df;
    runRoot(CMD_TRIM, 60000).then(function (out) {
      try { window.KanoDeepClean.lastTrimOut = String(out).slice(0, 800); } catch (e) {}
      if (out.indexOf('TRIM_END') < 0) throw new Error('清理命令未跑完');
      var m = out.match(/TRIM_S1\n([\s\S]*?)\nTRIM_S2/);
      var m2 = out.match(/TRIM_S3\n([\s\S]*?)\nTRIM_END/);
      var dBefore = parseDf(m && m[1] || ''), dAfter = parseDf(m2 && m2[1] || '');
      var freed = (dBefore && dAfter) ? Math.max(0, dBefore.used - dAfter.used) : null;
      state.trimResult = '应用缓存清理完成' + (freed != null ? '，/data 释放约 ' + fmtSize(freed) : '') + '。';
      state.phase = '';
      toast('应用缓存清理完成', 'green');
      return runRoot(CMD_STATUS);
    }).then(function (t) {
      applyStatus(t);
    }).catch(function (e) {
      state.phase = '';
      state.trimResult = '';
      toast('清理失败：' + ((e && e.message) || String(e)), 'red');
    }).finally(function () {
      state.busy = false;
      renderBody();
    });
  }

  function doKill() {
    if (state.busy) return;
    var pids = Object.keys(state.checked).filter(function (pid) { return state.checked[pid]; })
      .map(function (x) { return parseInt(x, 10); })
      .filter(function (pid) { return pid > 1 && state.procs.some(function (p) { return p.pid === pid && killable(p); }); });
    if (!pids.length) { toast('没有选中的可结束进程', 'red'); return; }
    var rss = pids.reduce(function (s, pid) {
      var p = state.procs.filter(function (x) { return x.pid === pid; })[0];
      return s + (p ? p.rss : 0);
    }, 0);
    if (!confirm('确定结束 ' + pids.length + ' 个进程（约 ' + fmtSize(rss) + '）吗？\n部分应用会被系统自动拉起。')) return;
    state.busy = true;
    state.phase = '正在结束 ' + pids.length + ' 个进程…';
    renderBody();
    runRoot(buildKillCmd(pids), 30000).then(function (out) {
      if (out.indexOf('KILL_END') < 0) throw new Error('结束命令未跑完');
      toast('已结束 ' + pids.length + ' 个进程', 'green');
      state.phase = '';
      return runRoot(CMD_STATUS);
    }).then(function (t) {
      applyStatus(t);
    }).catch(function (e) {
      state.phase = '';
      toast('操作失败：' + ((e && e.message) || String(e)), 'red');
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
      '<div class="dc-box">' +
        '<div class="dc-head"><div><span class="dc-title">' + TITLE + '</span><span class="dc-ver">v' + VERSION + '</span></div>' +
        '<button class="dc-close" data-close>关闭</button></div>' +
        '<div class="dc-body"><div class="dc-loading">读取中…</div></div>' +
        '<div class="dc-foot">' +
          '<button class="dc-btn" data-act="refresh">刷新</button>' +
          '<button class="dc-close dc-btn" data-close style="margin-left:auto">关闭</button>' +
        '</div>' +
      '</div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) { closeModal(); return; }
      if (e.target.closest('[data-close]')) { closeModal(); return; }
      var box = e.target.closest('[data-act="all"]');
      if (box) {
        var on = box.checked;
        state.procs.forEach(function (p) { if (killable(p)) state.checked[p.pid] = on; });
        renderBody();
        return;
      }
      var cb = e.target.closest('input[data-pid]');
      if (cb) {
        state.checked[parseInt(cb.getAttribute('data-pid'), 10)] = cb.checked;
        renderBody();
        return;
      }
      var b = e.target.closest('[data-act]');
      if (!b || state.busy) return;
      var act = b.getAttribute('data-act');
      if (act === 'refresh') refresh();
      else if (act === 'trim') doTrim();
      else if (act === 'kill') doKill();
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
  var mainBtn = document.createElement('button');
  mainBtn.id = BTN_ID;
  mainBtn.textContent = TITLE;
  mainBtn.onclick = openModal;
  var host = document.querySelector('.actions-buttons') || document.querySelector('.collapse_box') || document.body;
  host.appendChild(mainBtn);

  window.KanoDeepClean = { version: VERSION, open: openModal, close: closeModal, refresh: refresh };
})();
//</script>
