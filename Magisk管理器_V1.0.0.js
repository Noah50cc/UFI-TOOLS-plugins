//<script>
/*
 * Magisk 管理器 v1.0.0
 * 适用于：飞猫 U20 / 中兴 F50 等 UFI-TOOLS 高级后台（192.168.x.1:2333）
 * 功能：检测 Root / Magisk 状态，管理 Magisk 模块（启用/禁用/卸载），重启设备
 * 安装：UFI-TOOLS 页面 → 插件功能 → 增加插件 → 新建空文本插件 → 粘贴本文件全部内容 → 保存 → 刷新页面
 * 原理：通过 UFI-TOOLS 后端的 /api/root_shell 接口以 root 身份执行 shell 命令
 */
(function () {
  'use strict';

  var TITLE = 'Magisk管理器';
  var VERSION = '1.0.1';
  var BTN_ID = 'kn_magisk_mgr_main_btn';
  var MODAL_ID = 'kn_magisk_mgr_modal';
  var STYLE_ID = 'kn_magisk_mgr_style';

  function getBaseURL() {
    try { if (typeof KANO_baseURL !== 'undefined' && KANO_baseURL) return String(KANO_baseURL).replace(/\/$/, ''); } catch (e) {}
    return '/api';
  }

  function toast(msg, type) {
    if (typeof createToast === 'function') { createToast(msg, type || 'pink'); return; }
    console.log('[Magisk管理器]', msg);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function shellQuote(v) {
    return "'" + String(v == null ? '' : v).replace(/'/g, "'\\''") + "'";
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

  function postRootShellApi(command) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctrl) timer = setTimeout(function () { ctrl.abort(); }, 20000);
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

  // 通过后端 root_shell 接口执行命令，返回纯文本输出（多路兜底 + 20 秒超时）
  function runRoot(cmd) {
    var attempts = [function () { return postRootShellApi(cmd); }];
    if (typeof runRootShellCommand === 'function') attempts.push(function () { return runRootShellCommand(cmd); });
    if (typeof runShellWithRoot === 'function') attempts.push(function () { return runShellWithRoot(cmd); });
    try {
      if (window.KanoShell && typeof window.KanoShell.run === 'function') attempts.push(function () { return window.KanoShell.run(cmd); });
      if (window.KanoShell && typeof window.KanoShell.exec === 'function') attempts.push(function () { return window.KanoShell.exec(cmd); });
      if (typeof window.runShell === 'function') attempts.push(function () { return window.runShell(cmd); });
      if (typeof window.execShell === 'function') attempts.push(function () { return window.execShell(cmd); });
    } catch (e) {}
    var chain = Promise.reject(new Error('start'));
    attempts.forEach(function (fn) {
      chain = chain.catch(function () { return Promise.resolve().then(fn); });
    });
    return chain.then(shellText);
  }

  // 模块名白名单，防止命令注入
  function safeMod(name) {
    name = String(name || '');
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) throw new Error('非法模块名');
    return name;
  }

  var CMD_STATUS = [
    'echo "---ROOT---"; id -u',
    'echo "---MAGISK---"; magisk -v 2>/dev/null || echo "N/A"',
    'echo "---MAGISKBIN---"; command -v magisk || echo "N/A"',
    'echo "---SELINUX---"; getenforce 2>/dev/null || echo "N/A"',
    'echo "---MODDIR---"; ls -d /data/adb/modules 2>/dev/null || echo "N/A"'
  ].join('; ');

  var CMD_MODULES = [
    'for d in /data/adb/modules/*/; do',
    '  [ -d "$d" ] || continue;',
    '  n=$(basename "$d");',
    '  if [ -f "$d/remove" ]; then st="remove_pending";',
    '  elif [ -f "$d/disable" ]; then st="disabled"; else st="enabled"; fi;',
    '  id=$(grep -m1 "^id=" "$d/module.prop" 2>/dev/null | cut -d= -f2-);',
    '  name=$(grep -m1 "^name=" "$d/module.prop" 2>/dev/null | cut -d= -f2-);',
    '  ver=$(grep -m1 "^version=" "$d/module.prop" 2>/dev/null | cut -d= -f2-);',
    '  author=$(grep -m1 "^author=" "$d/module.prop" 2>/dev/null | cut -d= -f2-);',
    '  desc=$(grep -m1 "^description=" "$d/module.prop" 2>/dev/null | cut -d= -f2-);',
    '  echo "$n|$st|$id|$name|$ver|$author|$desc";',
    'done'
  ].join(' ');

  function parseStatus(text) {
    var out = { root: false, magisk: '', magiskBin: '', selinux: '', moddir: false };
    var sec = '', lines = String(text).split('\n');
    lines.forEach(function (ln) {
      ln = ln.trim();
      if (ln === '---ROOT---') sec = 'root';
      else if (ln === '---MAGISK---') sec = 'magisk';
      else if (ln === '---MAGISKBIN---') sec = 'bin';
      else if (ln === '---SELINUX---') sec = 'selinux';
      else if (ln === '---MODDIR---') sec = 'moddir';
      else if (ln) {
        if (sec === 'root') out.root = (ln === '0');
        else if (sec === 'magisk') out.magisk = ln;
        else if (sec === 'bin') out.magiskBin = ln;
        else if (sec === 'selinux') out.selinux = ln;
        else if (sec === 'moddir') out.moddir = (ln.indexOf('/data/adb/modules') === 0);
      }
    });
    return out;
  }

  function parseModules(text) {
    var mods = [];
    String(text).split('\n').forEach(function (ln) {
      ln = ln.trim();
      if (!ln || ln.indexOf('|') < 0) return;
      var p = ln.split('|');
      mods.push({
        dir: p[0] || '', state: p[1] || 'enabled',
        id: p[2] || '', name: p[3] || p[0] || '',
        version: p[4] || '', author: p[5] || '', desc: p[6] || ''
      });
    });
    return mods;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '#' + MODAL_ID + '{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);}',
      '#' + MODAL_ID + ' .mm-box{width:min(680px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#141a26;border:1px solid #2a3448;border-radius:14px;color:#e8eef7;box-shadow:0 18px 60px rgba(0,0,0,.5);overflow:hidden;}',
      '#' + MODAL_ID + ' .mm-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid #2a3448;}',
      '#' + MODAL_ID + ' .mm-title{font-size:16px;font-weight:800;}',
      '#' + MODAL_ID + ' .mm-ver{font-size:11px;color:#8b98ad;margin-left:8px;font-weight:400;}',
      '#' + MODAL_ID + ' .mm-close{background:#243046;border:1px solid #33415c;color:#e8eef7;border-radius:8px;padding:6px 14px;cursor:pointer;}',
      '#' + MODAL_ID + ' .mm-body{padding:16px 18px;overflow-y:auto;}',
      '#' + MODAL_ID + ' .mm-sec{font-size:13px;font-weight:800;color:#9fb2cc;margin:14px 0 8px;}',
      '#' + MODAL_ID + ' .mm-sec:first-child{margin-top:0;}',
      '#' + MODAL_ID + ' .mm-kv{display:grid;grid-template-columns:110px 1fr;gap:6px 10px;font-size:13px;}',
      '#' + MODAL_ID + ' .mm-kv b{color:#8b98ad;font-weight:600;}',
      '#' + MODAL_ID + ' .mm-ok{color:#4ade80;font-weight:700;}',
      '#' + MODAL_ID + ' .mm-bad{color:#f87171;font-weight:700;}',
      '#' + MODAL_ID + ' .mm-warn{color:#fbbf24;}',
      '#' + MODAL_ID + ' .mm-mod{border:1px solid #2a3448;border-radius:10px;padding:12px;margin-bottom:10px;background:#182032;}',
      '#' + MODAL_ID + ' .mm-mod-top{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
      '#' + MODAL_ID + ' .mm-mod-name{font-size:14px;font-weight:700;}',
      '#' + MODAL_ID + ' .mm-mod-id{font-size:11px;color:#8b98ad;margin-top:2px;}',
      '#' + MODAL_ID + ' .mm-mod-desc{font-size:12px;color:#a9b8cf;margin-top:6px;}',
      '#' + MODAL_ID + ' .mm-badge{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:700;}',
      '#' + MODAL_ID + ' .mm-badge.on{background:rgba(74,222,128,.15);color:#4ade80;}',
      '#' + MODAL_ID + ' .mm-badge.off{background:rgba(248,113,113,.15);color:#f87171;}',
      '#' + MODAL_ID + ' .mm-badge.rm{background:rgba(251,191,36,.15);color:#fbbf24;}',
      '#' + MODAL_ID + ' .mm-actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;}',
      '#' + MODAL_ID + ' .mm-btn{background:#243046;border:1px solid #33415c;color:#e8eef7;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;}',
      '#' + MODAL_ID + ' .mm-btn:hover{background:#2e3c58;}',
      '#' + MODAL_ID + ' .mm-btn.danger{border-color:#7f2d2d;color:#fca5a5;}',
      '#' + MODAL_ID + ' .mm-btn:disabled{opacity:.45;cursor:not-allowed;}',
      '#' + MODAL_ID + ' .mm-foot{display:flex;gap:8px;padding:12px 18px;border-top:1px solid #2a3448;}',
      '#' + MODAL_ID + ' .mm-empty{color:#8b98ad;font-size:13px;padding:18px;text-align:center;}',
      '#' + MODAL_ID + ' .mm-loading{color:#8b98ad;font-size:13px;padding:18px;text-align:center;}'
    ].join('\n');
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  var state = { status: null, modules: [], busy: false, error: '' };

  function badgeFor(m) {
    if (m.state === 'remove_pending') return '<span class="mm-badge rm">重启后卸载</span>';
    if (m.state === 'disabled') return '<span class="mm-badge off">已禁用</span>';
    return '<span class="mm-badge on">已启用</span>';
  }

  function renderBody() {
    var body = document.querySelector('#' + MODAL_ID + ' .mm-body');
    if (!body) return;
    var html = '';
    html += '<div class="mm-sec">设备状态</div>';
    if (!state.status) {
      if (state.error) {
        html += '<div class="mm-empty" style="color:#f87171">读取失败：' + esc(state.error) + '<br>请确认 UFI-TOOLS 已登录，然后点下方「刷新」重试。</div>';
      } else {
        html += '<div class="mm-loading">读取中…</div>';
      }
    } else {
      var s = state.status;
      html += '<div class="mm-kv">';
      html += '<b>Root 权限</b><span class="' + (s.root ? 'mm-ok' : 'mm-bad') + '">' + (s.root ? '已获取' : '未获取') + '</span>';
      html += '<b>Magisk 版本</b><span>' + esc(s.magisk && s.magisk !== 'N/A' ? s.magisk : '未安装') + '</span>';
      html += '<b>SELinux</b><span>' + esc(s.selinux || '--') + '</span>';
      html += '<b>模块目录</b><span class="' + (s.moddir ? 'mm-ok' : 'mm-warn') + '">' + (s.moddir ? '/data/adb/modules' : '不存在') + '</span>';
      html += '</div>';
      if (!s.root) {
        html += '<div class="mm-empty">未检测到 root 权限，请先按 U20-F50 教程完成 root 后再使用本插件。</div>';
      } else if (!s.magisk || s.magisk === 'N/A') {
        html += '<div class="mm-empty">已 root 但未检测到 Magisk。如需完整 Magisk 功能，请刷入 Magisk 后再管理模块。</div>';
      }
    }
    html += '<div class="mm-sec">Magisk 模块（' + state.modules.length + '）</div>';
    if (state.modules.length === 0) {
      html += '<div class="mm-empty">暂无模块，或模块目录不可读。</div>';
    } else {
      state.modules.forEach(function (m) {
        var canToggle = m.state !== 'remove_pending';
        html += '<div class="mm-mod">';
        html += '<div class="mm-mod-top"><div><div class="mm-mod-name">' + esc(m.name) + '</div>';
        html += '<div class="mm-mod-id">' + esc(m.id || m.dir) + (m.version ? ' · v' + esc(m.version) : '') + (m.author ? ' · ' + esc(m.author) : '') + '</div></div>';
        html += badgeFor(m) + '</div>';
        if (m.desc) html += '<div class="mm-mod-desc">' + esc(m.desc) + '</div>';
        html += '<div class="mm-actions">';
        if (canToggle) {
          if (m.state === 'disabled') html += '<button class="mm-btn" data-act="enable" data-mod="' + esc(m.dir) + '">启用</button>';
          else html += '<button class="mm-btn" data-act="disable" data-mod="' + esc(m.dir) + '">禁用</button>';
          html += '<button class="mm-btn danger" data-act="uninstall" data-mod="' + esc(m.dir) + '">卸载（重启生效）</button>';
        } else {
          html += '<button class="mm-btn" data-act="cancel_uninstall" data-mod="' + esc(m.dir) + '">取消卸载</button>';
        }
        html += '</div></div>';
      });
    }
    body.innerHTML = html;
  }

  function refresh() {
    if (state.busy) return;
    state.busy = true;
    state.error = '';
    renderBody();
    runRoot(CMD_STATUS).then(function (t) {
      state.status = parseStatus(t);
      if (!state.status.root && !state.status.magiskBin) throw new Error('shell 返回为空，接口可能不可用');
      return runRoot(CMD_MODULES);
    }).then(function (t) {
      state.modules = parseModules(t);
    }).catch(function (e) {
      state.error = e.message || String(e);
      toast('读取失败：' + state.error, 'red');
      state.status = null;
      state.modules = [];
    }).finally(function () {
      state.busy = false;
      renderBody();
    });
  }

  function doAction(act, modDir) {
    var mod;
    try { mod = safeMod(modDir); } catch (e) { toast(e.message, 'red'); return; }
    var cmd = '';
    if (act === 'enable') cmd = 'rm -f /data/adb/modules/' + shellQuote(mod) + '/disable && echo OK';
    else if (act === 'disable') cmd = 'touch /data/adb/modules/' + shellQuote(mod) + '/disable && echo OK';
    else if (act === 'uninstall') cmd = 'touch /data/adb/modules/' + shellQuote(mod) + '/remove && echo OK';
    else if (act === 'cancel_uninstall') cmd = 'rm -f /data/adb/modules/' + shellQuote(mod) + '/remove && echo OK';
    else return;
    if ((act === 'uninstall') && !confirm('确定卸载模块「' + mod + '」吗？重启后生效。')) return;
    state.busy = true;
    runRoot(cmd).then(function () {
      toast('操作成功，刷新列表…', 'green');
      state.busy = false;
      refresh();
    }).catch(function (e) {
      state.busy = false;
      toast('操作失败：' + e.message, 'red');
    });
  }

  function doReboot() {
    if (!confirm('确定重启设备吗？禁用的模块变更需要重启生效。')) return;
    runRoot('reboot').catch(function () {});
    toast('已发送重启命令，设备正在重启…', 'green');
  }

  function openModal() {
    injectStyle();
    document.getElementById(MODAL_ID)?.remove();
    var modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.innerHTML =
      '<div class="mm-box">' +
        '<div class="mm-head"><div><span class="mm-title">' + TITLE + '</span><span class="mm-ver">v' + VERSION + '</span></div>' +
        '<button class="mm-close" data-close>关闭</button></div>' +
        '<div class="mm-body"><div class="mm-loading">读取中…</div></div>' +
        '<div class="mm-foot">' +
          '<button class="mm-btn" data-act="refresh">刷新</button>' +
          '<button class="mm-btn danger" data-act="reboot">重启设备</button>' +
        '</div>' +
      '</div>';
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
      var c = e.target.closest('[data-close]');
      if (c) { closeModal(); return; }
      var b = e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'refresh') { refresh(); return; }
      if (act === 'reboot') { doReboot(); return; }
      doAction(act, b.getAttribute('data-mod'));
    });
    document.body.appendChild(modal);
    document.addEventListener('keydown', escHandler);
    refresh();
  }

  function escHandler(e) {
    if (e.key === 'Escape') closeModal();
  }

  function closeModal() {
    document.getElementById(MODAL_ID)?.remove();
    document.removeEventListener('keydown', escHandler);
  }

  // 主入口：在页面操作区添加按钮
  document.getElementById(BTN_ID)?.remove();
  var mainBtn = document.createElement('button');
  mainBtn.id = BTN_ID;
  mainBtn.textContent = TITLE;
  mainBtn.onclick = openModal;
  var host = document.querySelector('.actions-buttons') || document.querySelector('.collapse_box') || document.body;
  host.appendChild(mainBtn);

  window.KanoMagiskMgr = { version: VERSION, open: openModal, close: closeModal, refresh: refresh };
})();
//</script>
