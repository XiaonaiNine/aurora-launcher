/* ============================================================
   Aurora Launcher 界面逻辑（原生 ES Module，无框架）
   ============================================================ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  boot: null,
  config: null,
  installed: [],
  selected: null,
  jobs: new Map(),
  jobNodes: new Map(),
  remote: null,
  remoteFilter: 'release',
  remoteQuery: '',
  picked: null,
  preview: null,
  proc: null,
  consoleTab: 'game',
  sse: null,
};

/* ---------------- 工具 ---------------- */

const fmtBytes = (n) => {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 3);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const fmtSpeed = (n) => (n > 0 ? `${fmtBytes(n)}/s` : '—');
const fmtEta = (s) => {
  if (!s || !Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.ceil(s)} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${Math.ceil(s % 60)} 秒`;
  return `${Math.floor(s / 3600)} 时 ${Math.ceil((s % 3600) / 60)} 分`;
};
const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data;
}

/* ---------------- 提示条 ---------------- */

function toast(message, { title = '', type = 'ok', timeout = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<div class="ti"></div><div><strong>${esc(title || (type === 'error' ? '出错了' : '提示'))}</strong><span>${esc(message)}</span></div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, timeout);
}

function setGlobalStatus(text, kind = 'idle') {
  const dot = $('#global-status .dot');
  dot.className = `dot ${kind === 'busy' ? 'dot-busy' : kind === 'error' ? 'dot-err' : kind === 'ok' ? 'dot-ok' : 'dot-idle'}`;
  $('#global-status-text').textContent = text;
}

/* ---------------- 弹窗 ---------------- */

function openModal(id) {
  const m = $(id);
  m.classList.add('open');
  m.setAttribute('aria-hidden', 'false');
}
function closeModal(id) {
  const m = $(id);
  if (!m) return;
  m.classList.remove('open');
  m.setAttribute('aria-hidden', 'true');
}
function closeAllModals() {
  $$('.modal.open').forEach((m) => {
    m.classList.remove('open');
    m.setAttribute('aria-hidden', 'true');
  });
}

function confirmDialog(title, text) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title;
    $('#confirm-text').textContent = text;
    openModal('#modal-confirm');
    const ok = $('#confirm-ok');
    const handler = () => {
      ok.removeEventListener('click', handler);
      closeModal('#modal-confirm');
      resolve(true);
    };
    ok.addEventListener('click', handler);
    const modal = $('#modal-confirm');
    const onClose = (e) => {
      if (e.target.closest('[data-close]')) {
        modal.removeEventListener('click', onClose);
        resolve(false);
      }
    };
    modal.addEventListener('click', onClose);
  });
}

/* ---------------- 渲染：版本列表 ---------------- */

function renderVersions() {
  const list = $('#version-list');
  $('#version-count').textContent = state.installed.length;
  if (!state.installed.length) {
    list.innerHTML = `<div class="skeleton-note">还没有安装任何版本<br/>点击下方按钮下载一个</div>`;
    return;
  }
  list.innerHTML = state.installed
    .map((v) => {
      const typePill =
        v.type === 'release' ? 'pill-release' : v.type === 'snapshot' ? 'pill-snapshot' : 'pill-old';
      const typeLabel = v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : v.type;
      return `
      <div class="version-item ${v.id === state.selected ? 'active' : ''}" data-id="${esc(v.id)}">
        <div class="vi-top">
          <span class="vi-id">${esc(v.id)}</span>
          <span class="pill ${typePill}">${esc(typeLabel)}</span>
        </div>
        <div class="vi-foot">
          ${v.loader ? `<span class="pill pill-loader">${esc(v.loader)}</span>` : ''}
          <span class="vi-date">${esc(fmtDate(v.releaseTime))}</span>
        </div>
        <div class="vi-actions">
          <button class="icon-btn" data-act="verify" title="校验完整性">
            <svg viewBox="0 0 24 24" fill="none"><path d="M20 6L9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <button class="icon-btn danger" data-act="delete" title="删除版本">
            <svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>`;
    })
    .join('');

  $$('.version-item', list).forEach((el) => {
    el.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const id = el.dataset.id;
      if (act === 'verify') return startVerify(id);
      if (act === 'delete') return removeVersion(id);
      selectVersion(id);
    });
  });
}

function selectVersion(id) {
  state.selected = id;
  renderVersions();
  renderHero();
}

/* ---------------- 渲染：主区 ---------------- */

function selectedMeta() {
  return state.installed.find((v) => v.id === state.selected) || null;
}

function renderHero() {
  const v = selectedMeta();
  const title = $('#sel-version');
  const badges = $('#sel-badges');
  const meta = $('#sel-meta');
  const launch = $('#btn-launch');

  if (!v) {
    title.textContent = '未选择版本';
    badges.innerHTML = '';
    meta.innerHTML = '';
    launch.disabled = true;
    launch.classList.remove('busy');
    $('.launch-label', launch).textContent = '启动游戏';
    $('#launch-sub').textContent = '请先选择或安装一个版本';
    $('#stat-java').textContent = '—';
    $('#stat-mem').textContent = '—';
    renderDetail(null);
    return;
  }

  const running = state.proc && state.proc.versionId === v.id;
  title.textContent = v.id;
  badges.innerHTML = [
    `<span class="pill ${v.type === 'release' ? 'pill-release' : v.type === 'snapshot' ? 'pill-snapshot' : 'pill-old'}">${
      v.type === 'release' ? '正式版' : v.type === 'snapshot' ? '快照' : esc(v.type)
    }</span>`,
    v.loader ? `<span class="pill pill-loader">${esc(v.loader)}</span>` : '',
    v.hasJar ? '' : '<span class="pill pill-old">缺少本体</span>',
  ].join('');

  meta.innerHTML = `
    <div class="hs"><label>发布时间</label><strong>${esc(fmtDate(v.releaseTime))}</strong></div>
    <div class="hs"><label>需要 Java</label><strong>${v.javaVersion?.majorVersion ? `${v.javaVersion.majorVersion}` : '—'}</strong></div>
    <div class="hs"><label>占用空间</label><strong>${fmtBytes(v.size)}</strong></div>`;

  // 启动时实际会用的 Java：显式配置 > 本机匹配 > 自动下载运行时
  const need = v.javaVersion?.majorVersion;
  const javaList = state.boot?.java?.list || [];
  let javaText;
  if (state.config.javaPath) javaText = '自定义路径';
  else if (!need) javaText = javaList[0] ? `Java ${javaList[0].major}` : '未检测到';
  else if (javaList.some((j) => j.major === need)) javaText = `Java ${need}（本机）`;
  else if (state.config.autoDownloadJava) javaText = `Java ${need}（将自动下载）`;
  else javaText = `缺少 Java ${need}`;
  $('#stat-java').textContent = javaText;
  $('#stat-mem').textContent = `${(state.config.maxMemory / 1024).toFixed(1)} GB`;

  launch.disabled = false;
  if (running) {
    launch.classList.add('busy');
    $('.launch-label', launch).textContent = '停止游戏';
    $('#launch-sub').textContent = `运行中 · PID ${state.proc.pid ?? '—'}`;
  } else {
    launch.classList.remove('busy');
    $('.launch-label', launch).textContent = '启动游戏';
    $('#launch-sub').textContent = `离线账户 ${state.config.account.name} · ${state.config.width}×${state.config.height}${
      state.config.fullscreen ? ' · 全屏' : ''
    }`;
  }

  renderDetail(v);
}

function renderDetail(v) {
  const grid = $('#detail-grid');
  if (!v) {
    grid.innerHTML = `<div class="empty-state small" style="grid-column:1/-1"><p>选择左侧版本查看详情</p></div>`;
    return;
  }
  const need = v.javaVersion?.majorVersion;
  grid.innerHTML = `
    <div class="detail-cell"><label>安装位置</label><strong title="${esc(v.id)}"><code>versions/${esc(v.id)}</code></strong></div>
    <div class="detail-cell"><label>游戏本体</label><strong>${v.hasJar ? fmtBytes(v.jarSize) : '缺失'}</strong></div>
    <div class="detail-cell"><label>版本目录占用</label><strong>${fmtBytes(v.size)}</strong></div>
    <div class="detail-cell"><label>需要 Java</label><strong>${need ? `Java ${need}` : '版本未声明'}</strong></div>
    <div class="detail-cell" style="grid-column:1/-1"><label>主类</label><strong><code>${esc(v.mainClass || '—')}</code></strong></div>`;
}

/* ---------------- 渲染：下载中心 ---------------- */

const PHASES = [
  { key: 'resolve', label: '解析' },
  { key: 'client', label: '本体' },
  { key: 'assets', label: '资源' },
  { key: 'natives', label: '解压' },
  { key: 'finalize', label: '写入' },
];

const STATUS_TEXT = {
  running: '进行中',
  done: '已完成',
  error: '失败',
  paused: '已暂停',
  cancelled: '已取消',
  pending: '等待中',
};

function jobDom(job) {
  let node = state.jobNodes.get(job.id);
  if (node && node.root.isConnected) return node;

  const root = document.createElement('div');
  root.className = 'job-card';
  root.innerHTML = `
    <div class="job-top">
      <div class="job-title"><strong></strong><small></small></div>
      <span class="job-state"></span>
    </div>
    <div class="phase-steps">${PHASES.map(() => '<span></span>').join('')}</div>
    <div class="bar"><i></i></div>
    <div class="job-stats"><span class="js-left"></span><span class="js-right"></span></div>
    <div class="job-phase"><span class="spin"></span><span class="jp-text"></span></div>
    <div class="file-ticker"></div>
    <div class="job-error" style="display:none"></div>
    <div class="job-actions"></div>`;
  node = {
    root,
    title: $('.job-title strong', root),
    sub: $('.job-title small', root),
    stateEl: $('.job-state', root),
    steps: $$('.phase-steps span', root),
    bar: $('.bar', root),
    fill: $('.bar > i', root),
    left: $('.js-left', root),
    right: $('.js-right', root),
    phaseRow: $('.job-phase', root),
    phaseText: $('.jp-text', root),
    ticker: $('.file-ticker', root),
    errorBox: $('.job-error', root),
    actions: $('.job-actions', root),
  };
  state.jobNodes.set(job.id, node);
  $('#job-list').prepend(root);
  return node;
}

function renderJob(job) {
  const n = jobDom(job);
  const p = job.progress || {};
  const isVerify = job.type !== 'install';

  n.root.className = `job-card ${job.status}`;
  n.title.textContent = job.versionId;
  n.sub.textContent = isVerify ? (job.repair ? '校验并修复' : '完整性校验') : '安装新版本';
  n.stateEl.className = `job-state st-${job.status}`;
  n.stateEl.textContent = STATUS_TEXT[job.status] || job.status;

  // 阶段步骤条（校验任务没有分段，隐藏更干净）
  const showSteps = !isVerify;
  n.steps[0].parentElement.style.display = showSteps ? 'flex' : 'none';
  if (showSteps) {
    const idx = PHASES.findIndex((x) => x.key === job.phase);
    n.steps.forEach((s, i) => {
      s.className = i < idx ? 'on' : i === idx && job.status === 'running' ? 'cur' : i === idx ? 'on' : '';
    });
  }

  // 进度条
  const pct = job.status === 'done' ? 100 : Math.max(0, Math.min(100, p.percent || 0));
  n.fill.style.width = `${pct}%`;
  n.bar.className = `bar${job.status === 'error' ? ' error' : ''}${job.status === 'running' && !p.total ? ' indeterminate' : ''}`;

  const planTotals = job.plan?.totals;
  if (isVerify && job.status === 'running' && !p.total) {
    n.left.textContent = '扫描文件中…';
    n.right.textContent = '';
  } else if (p.total) {
    const handled = (p.completed || 0) + (p.skipped || 0) + (p.failed || 0);
    n.left.textContent = `${handled} / ${p.total} 个文件${p.skipped ? ` · 跳过 ${p.skipped}` : ''}${
      p.failed ? ` · 失败 ${p.failed}` : ''
    }`;
    n.right.textContent = `${pct.toFixed(1)}% · ${fmtBytes(p.bytesDone)} / ${fmtBytes(p.bytesTotal)}`;
  } else if (planTotals && job.status === 'running') {
    n.left.textContent = `${planTotals.count} 个文件待下载`;
    n.right.textContent = `共 ${fmtBytes(planTotals.bytes)}`;
  } else if (job.status === 'error' || job.status === 'cancelled') {
    n.left.textContent = '任务未开始';
    n.right.textContent = '';
  } else {
    n.left.textContent = '准备中…';
    n.right.textContent = '';
  }

  // 阶段说明
  if (job.status === 'running') {
    n.phaseRow.style.display = 'flex';
    n.phaseText.textContent = isVerify
      ? job.phase === 'repair'
        ? '正在修复损坏文件…'
        : '正在校验文件完整性…'
      : `${PHASES.find((x) => x.key === job.phase)?.label || '准备'}${p.speed ? ` · ${fmtSpeed(p.speed)} · 剩余 ${fmtEta(p.eta)}` : ''}`;
  } else if (job.status === 'paused') {
    n.phaseRow.style.display = 'flex';
    n.phaseText.textContent = `已暂停 · 已完成的文件不会被重复下载`;
  } else if (job.status === 'done') {
    n.phaseRow.style.display = 'flex';
    n.phaseText.textContent = isVerify
      ? job.result
        ? `校验完成：检查 ${job.result.checked} 个文件，损坏 ${job.result.broken} 个${job.result.repaired ? `，已修复 ${job.result.repaired} 个` : ''}`
        : '校验完成'
      : `安装完成 · 共 ${p.total || 0} 个文件`;
  } else {
    n.phaseRow.style.display = 'none';
  }

  // 正在下载的文件
  const files = p.files || [];
  n.ticker.style.display = files.length && job.status === 'running' ? 'flex' : 'none';
  if (files.length) {
    n.ticker.innerHTML = files
      .slice(0, 3)
      .map((f) => `<div>↓ ${esc(f.label)} · ${fmtBytes(f.received)}/${fmtBytes(f.size)}</div>`)
      .join('');
  }

  // 错误信息 + 修复入口
  if (job.status === 'error' && job.error) {
    n.errorBox.style.display = 'block';
    const failed = job.failedTasks?.length || 0;
    n.errorBox.innerHTML = `
      <div>${esc(job.error)}</div>
      ${failed ? `<div style="margin-top:4px;opacity:.8">失败示例：${esc(job.failedTasks.slice(0, 2).map((t) => t.label).join('、'))}</div>` : ''}
      <div class="fix">
        <button class="btn btn-sm" data-fix="retry">重试</button>
        <button class="btn btn-sm" data-fix="mirror">切换镜像重试</button>
        <button class="btn btn-sm btn-ghost" data-fix="detail">查看原因</button>
      </div>`;
    $$('[data-fix]', n.errorBox).forEach((b) =>
      b.addEventListener('click', async () => {
        const kind = b.dataset.fix;
        if (kind === 'retry') return resumeJob(job.id);
        if (kind === 'mirror') {
          await api('/api/config', { body: { mirror: 'bmclapi' } });
          state.config.mirror = 'bmclapi';
          toast('已切换到镜像源，正在重试', { title: '换源' });
          return resumeJob(job.id);
        }
        toast(job.error, { type: 'error', title: '失败原因', timeout: 8000 });
      })
    );
  } else {
    n.errorBox.style.display = 'none';
  }

  // 操作按钮
  const btns = [];
  if (job.status === 'running') {
    btns.push(`<button class="btn btn-sm btn-ghost" data-a="pause">暂停</button>`);
    btns.push(`<button class="btn btn-sm btn-ghost" data-a="cancel">取消</button>`);
  } else if (job.status === 'paused' || job.status === 'cancelled') {
    btns.push(`<button class="btn btn-sm btn-primary" data-a="resume">继续</button>`);
    btns.push(`<button class="btn btn-sm btn-ghost" data-a="cancel">取消</button>`);
  } else if (job.status === 'done') {
    btns.push(`<button class="btn btn-sm btn-ghost" data-a="dismiss">关闭</button>`);
  } else if (job.status === 'error') {
    btns.push(`<button class="btn btn-sm btn-ghost" data-a="dismiss">关闭</button>`);
  }
  n.actions.innerHTML = btns.join('');
  $$('[data-a]', n.actions).forEach((b) =>
    b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'pause') api(`/api/jobs/${job.id}/pause`, { method: 'POST' }).catch((e) => toast(e.message, { type: 'error' }));
      if (a === 'resume') resumeJob(job.id);
      if (a === 'cancel') api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch((e) => toast(e.message, { type: 'error' }));
      if (a === 'dismiss') {
        state.jobs.delete(job.id);
        state.jobNodes.get(job.id)?.root.remove();
        state.jobNodes.delete(job.id);
        updateJobsEmpty();
      }
    })
  );

  updateJobsEmpty();
}

function updateJobsEmpty() {
  const visible = $$('#job-list .job-card').length;
  $('#job-empty').style.display = visible ? 'none' : 'flex';
}

function renderAllJobs() {
  const list = [...state.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const j of list) renderJob(j);
  updateJobsEmpty();
}

async function resumeJob(id) {
  try {
    await api(`/api/jobs/${id}/resume`, { method: 'POST' });
    toast('已重新开始，已完成的文件会自动跳过', { title: '继续下载' });
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

/* ---------------- 账户 / 设置渲染 ---------------- */

/**
 * 账户界面的运行时状态。
 * 登录会话在服务端跑，这里只负责展示 + 轮询，关掉弹窗不会中断授权。
 */
const accUi = {
  tab: 'offline',
  session: null,
  poll: null,
  skin: null, // { uuid, dataUrl, w, h }
  reconfig: false, // 用户主动点了「更换应用 ID」
  finishedSessionId: null, // 已经做过收尾提示的会话，避免重复弹窗
};

const MSA_BUSY_STATES = ['starting', 'waiting', 'authorized', 'xbox', 'xsts', 'minecraft', 'entitlement', 'profile'];

function accIsBusy(session) {
  return Boolean(session && MSA_BUSY_STATES.includes(session.state));
}

function fmtRemain(ts) {
  const ms = Number(ts) - Date.now();
  if (!ts || ms <= 0) return '已过期';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${Math.max(1, min)} 分钟`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时`;
  return `${Math.floor(h / 24)} 天`;
}

function showEl(sel, visible) {
  const el = $(sel);
  if (el) el.hidden = !visible;
}

/**
 * 用皮肤贴图画头像。
 * 皮肤是 64×64（旧版 64×32），正面脸固定在第 8,8 开始的 8×8 区域，
 * 所以按「一个皮肤像素 = box/8 设备像素」换算尺寸和偏移即可精确裁切。
 */
function paintFace(el, skin) {
  if (!el) return;
  const letter = (el.dataset.letter || '?').slice(0, 1).toUpperCase();
  if (!skin?.dataUrl) {
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundPosition = '';
    el.textContent = letter;
    return;
  }
  const box = el.offsetWidth || 40;
  const k = box / 8;
  const h = skin.h || 64;
  el.textContent = '';
  el.style.backgroundImage = `url("${skin.dataUrl}")`;
  el.style.backgroundSize = `${64 * k}px ${h * k}px`;
  el.style.backgroundPosition = `${-8 * k}px ${-8 * k}px`;
}

async function applySkin() {
  const acc = state.config?.account || {};
  const chip = $('#account-avatar');
  const face = $('#acc-cur-face');
  const letter = (acc.name || '?').slice(0, 1);
  if (chip) chip.dataset.letter = letter;
  if (face) face.dataset.letter = letter;

  if (acc.mode !== 'microsoft' || !acc.hasSkin) {
    accUi.skin = null;
    paintFace(chip, null);
    paintFace(face, null);
    return;
  }
  if (accUi.skin?.uuid !== acc.uuid) {
    try {
      const r = await api('/api/auth/skin');
      accUi.skin = { uuid: acc.uuid, dataUrl: r?.dataUrl || null, w: r?.w, h: r?.h };
    } catch {
      accUi.skin = { uuid: acc.uuid, dataUrl: null };
    }
  }
  paintFace(chip, accUi.skin);
  paintFace(face, accUi.skin);
}

function setAccTab(tab) {
  accUi.tab = tab;
  $$('.seg-item').forEach((b) => b.classList.toggle('active', b.dataset.accTab === tab));
  $$('.acc-pane').forEach((p) => p.classList.toggle('active', p.dataset.accPane === tab));
}

function renderAccount() {
  const acc = state.config?.account || {};
  const premium = acc.mode === 'microsoft';

  // 顶栏账户卡
  $('#account-name').textContent = acc.name || '未登录';
  $('#account-mode').textContent = premium ? (acc.expired ? '正版 · 需刷新' : '微软正版') : '离线账户';

  // 弹窗内的当前身份
  $('#acc-cur-name').textContent = acc.name || '未登录';
  $('#acc-cur-sub').textContent = premium
    ? acc.expired
      ? '微软账户 · 令牌已过期'
      : `微软账户 · 令牌有效（剩余 ${fmtRemain(acc.expiresAt)}）`
    : `离线账户${acc.uuid ? ` · ${acc.uuid.slice(0, 8)}…` : ''}`;
  const badge = $('#acc-cur-badge');
  badge.textContent = premium ? (acc.expired ? '需刷新' : '正版') : '离线';
  badge.className = `pill ${premium ? (acc.expired ? 'pill-old' : 'pill-release') : 'pill-soft'}`;

  $('#acc-name').value = premium ? '' : acc.name || '';
  $('#acc-uuid').textContent = premium
    ? '已登录微软账户，无需再设置离线名称'
    : acc.uuid
      ? `离线 UUID：${acc.uuid}`
      : '';

  applySkin();
  renderMsaPane();
}

/** 微软面板的四种形态：未配置 / 可登录 / 授权中 / 已登录 */
function renderMsaPane() {
  const acc = state.config?.account || {};
  const hasId = Boolean(String(state.config?.msaClientId || '').trim());
  // 用户点了「更换」：即使服务端已经存过 ID，也先展示配置面板
  const needSetup = !hasId || accUi.reconfig;
  const session = accUi.session;
  const busy = accIsBusy(session);
  const premium = acc.mode === 'microsoft' || session?.state === 'done';

  showEl('#msa-setup', needSetup);
  showEl('#msa-ready', !needSetup && !busy && !premium);
  showEl('#msa-flow', !needSetup && busy);
  showEl('#msa-done', !needSetup && premium && !busy);

  if (hasId) {
    const id = String(state.config.msaClientId);
    $('#msa-client-shown').textContent = `${id.slice(0, 8)}…${id.slice(-4)}`;
    $('#msa-client-shown').title = id;
  }

  if (busy) {
    $('#msa-code').textContent = session.userCode || '········';
    $('#msa-flow-hint').textContent = session.hint || '正在等待授权…';
    $('#msa-timer').textContent = session.expiresAt
      ? `验证码剩余有效期 ${fmtRemain(session.expiresAt)}`
      : '';
  }

  if (!needSetup && !busy && !premium) {
    const hint = $('#msa-ready-hint');
    const failed = session && ['error', 'cancelled', 'expired'].includes(session.state);
    if (failed && session.error) {
      hint.textContent = session.error;
      hint.style.color = 'var(--danger)';
    } else if (failed) {
      hint.textContent = '登录已取消';
      hint.style.color = 'var(--text-3)';
    } else {
      hint.textContent = '将打开浏览器完成授权，期间可以继续使用启动器';
      hint.style.color = '';
    }
  }

  if (premium) {
    $('#msa-done-uuid').textContent = acc.uuid || '—';
    $('#msa-done-uuid').title = acc.uuid || '';
    $('#msa-done-exp').textContent = acc.expiresAt
      ? acc.expired
        ? '已过期，建议刷新'
        : `剩余 ${fmtRemain(acc.expiresAt)}`
      : '—';
  }
}

/* ---------------- 微软登录流程 ---------------- */

function stopAuthPolling() {
  if (accUi.poll) {
    clearInterval(accUi.poll);
    accUi.poll = null;
  }
}

function startAuthPolling() {
  stopAuthPolling();
  accUi.poll = setInterval(refreshAuthStatus, 1000);
}

async function refreshAuthStatus() {
  let snap;
  try {
    snap = await api('/api/auth/microsoft/status');
  } catch {
    return; // 网络抖动，下一轮再试
  }
  accUi.session = snap;
  renderMsaPane();

  if (accIsBusy(snap)) return;

  stopAuthPolling();
  // 同一个会话只处理一次收尾，否则每次打开弹窗都会重复提示"登录成功"
  if (accUi.finishedSessionId === snap.id) return;
  accUi.finishedSessionId = snap.id;

  if (snap.state === 'done') {
    // 账户写入配置有微小延迟，等一次 bootstrap 把新账户取回来
    await refreshBootstrap();
    accUi.session = { ...snap, state: 'done' };
    renderAccount();
    setAccTab('microsoft');
    toast(`已登录微软账户 ${state.config?.account?.name || ''}`, { title: '正版登录成功' });
  } else if (snap.state === 'error' && snap.error) {
    toast(snap.error, { type: 'error', title: '登录失败', timeout: 9000 });
  } else if (snap.state === 'expired') {
    toast('验证码已过期，请重新发起登录', { type: 'error' });
  }
}

async function startMsaLogin() {
  const btn = $('#btn-msa-login');
  btn.disabled = true;
  try {
    const snap = await api('/api/auth/microsoft/start');
    accUi.session = snap;
    renderMsaPane();
    if (accIsBusy(snap)) {
      startAuthPolling();
      setAccTab('microsoft');
    } else if (snap.state === 'error') {
      toast(snap.error, { type: 'error', title: '无法开始登录', timeout: 9000 });
    }
  } catch (e) {
    toast(e.message, { type: 'error', title: '无法开始登录', timeout: 9000 });
  } finally {
    btn.disabled = false;
  }
}

async function verifyMsaClientId(save) {
  const input = $('#msa-client-id');
  const hint = $('#msa-setup-hint');
  const id = input.value.trim();
  if (!id) {
    hint.textContent = '请先填入应用 ID';
    hint.style.color = 'var(--danger)';
    input.focus();
    return;
  }
  const buttons = [$('#btn-msa-verify'), $('#btn-msa-save')];
  buttons.forEach((b) => (b.disabled = true));
  hint.style.color = 'var(--text-3)';
  hint.textContent = '正在向微软校验…';
  try {
    if (save) {
      await api('/api/auth/microsoft/client-id', { body: { clientId: id } });
      state.config.msaClientId = id;
      accUi.session = null;
      accUi.reconfig = false;
      renderMsaPane();
      toast('应用 ID 已保存，可以登录了', { title: '配置完成' });
    } else {
      await api('/api/auth/microsoft/verify-client', { body: { clientId: id } });
      hint.style.color = 'var(--accent)';
      hint.textContent = '✓ 应用 ID 可用，点「验证并保存」即可开始登录';
    }
  } catch (e) {
    hint.style.color = 'var(--danger)';
    hint.textContent = e.message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function copyMsaCode() {
  const code = accUi.session?.userCode || $('#msa-code').textContent.trim();
  if (!code || code.includes('·')) return;
  try {
    await navigator.clipboard.writeText(code);
    toast(`验证码 ${code} 已复制`, { title: '已复制' });
  } catch {
    // 剪贴板不可用时退化为选中文本，用户手动 Ctrl+C
    const range = document.createRange();
    range.selectNodeContents($('#msa-code'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('已选中验证码，请按 Ctrl+C 复制');
  }
}

async function cancelMsaLogin() {
  try {
    await api('/api/auth/microsoft/cancel', { method: 'POST' });
  } catch {
    /* 取消失败不影响结果 */
  }
  accUi.session = await api('/api/auth/microsoft/status').catch(() => null);
  stopAuthPolling();
  renderMsaPane();
}

async function refreshMsaToken() {
  const btn = $('#btn-msa-refresh');
  btn.disabled = true;
  btn.textContent = '刷新中…';
  try {
    const acc = await api('/api/auth/refresh', { body: { force: true } });
    state.config.account = acc;
    renderAccount();
    toast('令牌已刷新', { title: '账户' });
  } catch (e) {
    toast(e.message, { type: 'error', title: '刷新失败', timeout: 9000 });
  } finally {
    btn.disabled = false;
    btn.textContent = '刷新令牌';
  }
}

async function logoutMsa() {
  const ok = await confirmDialog(
    '退出微软账户',
    '退出后会切换为离线账户，正版服务器将无法进入，皮肤也会恢复为默认。本地已下载的版本与存档不受影响。'
  );
  if (!ok) return;
  try {
    const acc = await api('/api/auth/logout', { method: 'POST' });
    state.config.account = acc;
    accUi.session = null;
    accUi.skin = null;
    renderAccount();
    setAccTab('offline');
    toast('已退出微软账户', { title: '账户' });
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

function openAccountModal() {
  const acc = state.config?.account;
  setAccTab(acc?.mode === 'microsoft' ? 'microsoft' : 'offline');
  renderAccount();
  openModal('#modal-account');
  // 弹窗重新打开时接上仍在进行的授权
  refreshAuthStatus().then(() => {
    if (accIsBusy(accUi.session)) startAuthPolling();
  });
}

function renderConfig() {
  const c = state.config;
  $('#root-path').textContent = c.rootDir;
  $('#root-path').title = c.rootDir;
  $('#version-total').textContent = `${state.installed.length} 个 · ${fmtBytes(
    state.installed.reduce((s, v) => s + (v.size || 0), 0)
  )}`;
  $('#mem-range').value = c.maxMemory;
  $('#mem-label').textContent = `${c.maxMemory} MB`;
  $('#win-width').value = c.width;
  $('#win-height').value = c.height;
  $('#fullscreen').checked = c.fullscreen;
  $('#jvm-args').value = c.extraJvmArgs || '';

  $('#set-root').value = c.rootDir;
  $('#set-java').value = c.javaPath || '';
  $('#set-autojava').checked = c.autoDownloadJava;
  $('#set-concurrency').value = c.concurrency;
  $('#set-mirror').value = c.mirror;
  $('#set-verify').value = c.verifyMode;
  $('#settings-path').textContent = c.rootDir;

  const list = state.boot?.java?.list || [];
  $('#java-list').innerHTML = list.length
    ? list
        .map(
          (j) =>
            `<div class="java-row ${c.javaPath === j.path ? 'sel' : ''}" data-path="${esc(j.path)}">
               <span class="jr-tag">Java ${j.major}</span>
               <span class="jr-path">${esc(j.path)}</span>
             </div>`
        )
        .join('')
    : '<div class="field-hint">未检测到 Java，启动时将自动下载 Mojang 运行时</div>';
  $$('#java-list .java-row').forEach((r) =>
    r.addEventListener('click', () => {
      $('#set-java').value = r.dataset.path;
      $$('#java-list .java-row').forEach((x) => x.classList.remove('sel'));
      r.classList.add('sel');
    })
  );
}

/* ---------------- 安装流程 ---------------- */

async function startInstall() {
  const id = state.picked;
  if (!id) return;
  try {
    $('#btn-start-install').disabled = true;
    const job = await api('/api/install', {
      body: {
        versionId: id,
        includeAssets: $('#opt-assets').checked,
        concurrency: state.config.concurrency,
        mirror: state.config.mirror,
      },
    });
    state.jobs.set(job.id, job);
    renderJob(job);
    closeModal('#modal-versions');
    setGlobalStatus(`正在下载 ${id}`, 'busy');
    toast(`已开始下载 ${id}`, { title: '下载任务已创建' });
  } catch (e) {
    toast(e.message, { type: 'error' });
  } finally {
    $('#btn-start-install').disabled = false;
  }
}

async function startVerify(id, repair = false) {
  try {
    const job = await api('/api/verify', { body: { versionId: id, repair } });
    state.jobs.set(job.id, job);
    renderJob(job);
    toast(`正在校验 ${id}`, { title: '校验任务已创建' });
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

async function removeVersion(id) {
  const ok = await confirmDialog('删除版本', `将删除 ${id} 的版本目录与 natives。运行库与资源为多版本共享，不会被删除。`);
  if (!ok) return;
  try {
    const r = await api(`/api/versions/${id}`, { method: 'DELETE' });
    toast(`已释放 ${fmtBytes(r.freed)}`, { title: `已删除 ${id}` });
    if (state.selected === id) state.selected = null;
    await refreshBootstrap();
    loadStorage();
  } catch (e) {
    toast(e.message, { type: 'error' });
  }
}

/* ---------------- 启动游戏 ---------------- */

async function doLaunch() {
  const v = selectedMeta();
  if (!v) return;

  if (state.proc) {
    try {
      await api(`/api/process/${state.proc.id}/kill`, { method: 'POST' });
      state.proc = null;
      renderHero();
      toast('已发送停止指令', { title: '停止游戏' });
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
    return;
  }

  const btn = $('#btn-launch');
  btn.disabled = true;
  $('.launch-label', btn).textContent = '准备启动…';
  $('#launch-sub').textContent = '正在检查 Java 与游戏文件';
  setGlobalStatus('正在启动…', 'busy');

  try {
    const r = await api('/api/launch', {
      body: {
        versionId: v.id,
        maxMemory: state.config.maxMemory,
        minMemory: state.config.minMemory,
        extraJvmArgs: state.config.extraJvmArgs,
        width: state.config.width,
        height: state.config.height,
        fullscreen: state.config.fullscreen,
      },
    });
    state.proc = { id: r.id, versionId: v.id, pid: r.pid };
    setGlobalStatus(`运行中 · ${v.id}`, 'ok');
    showConsole(true);
    toast('游戏已启动，日志见底部控制台', { title: v.id });
  } catch (e) {
    toast(e.message, { type: 'error', title: '启动失败', timeout: 9000 });
    setGlobalStatus('启动失败', 'error');
  } finally {
    btn.disabled = false;
    renderHero();
  }
}

/* ---------------- 控制台 ---------------- */

function showConsole(force) {
  const el = $('#console');
  if (force) el.classList.remove('collapsed');
}
function appendConsole(line, stream = 'stdout') {
  const body = $('#console-body');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  const span = document.createElement('span');
  span.className = stream === 'stderr' || stream === 'error' ? 'err' : stream === 'sys' ? 'sys' : '';
  span.textContent = `${line}\n`;
  body.appendChild(span);
  while (body.childNodes.length > 1200) body.removeChild(body.firstChild);
  if (atBottom) body.scrollTop = body.scrollHeight;
}
function clearConsole() {
  $('#console-body').innerHTML = '';
}

async function loadLauncherLogs() {
  try {
    const { logs } = await api('/api/logs?n=200');
    clearConsole();
    for (const l of logs) appendConsole(`[${l.time.slice(11, 19)}] ${l.level.toUpperCase().padEnd(5)} ${l.scope} ${l.msg}`);
  } catch {
    /* ignore */
  }
}

/* ---------------- SSE ---------------- */

function connectSSE() {
  if (state.sse) state.sse.close();
  const es = new EventSource('/api/stream');
  state.sse = es;

  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleEvent(msg);
  };
  es.onerror = () => {
    setGlobalStatus('连接中断，正在重连…', 'error');
  };
  es.onopen = () => {
    if (!state.proc) setGlobalStatus('就绪', 'ok');
  };
}

function handleEvent(msg) {
  const { type } = msg;

  // 账户相关事件：登录会话推进、令牌刷新、开关账户
  if (type === 'auth') {
    accUi.session = msg.session;
    if ($('#modal-account').classList.contains('open')) renderMsaPane();
    return;
  }
  if (type === 'account') {
    if (state.config) state.config.account = msg.account;
    renderAccount();
    applySkin();
    return;
  }
  if (type === 'auth-warning') {
    toast(msg.message, { type: 'error', title: '账户', timeout: 9000 });
    return;
  }

  if (type === 'progress' || type === 'phase' || type === 'plan') {
    const job = msg.job;
    if (!job) return;
    const prev = state.jobs.get(job.id);
    state.jobs.set(job.id, { ...prev, ...job });
    renderJob(state.jobs.get(job.id));
    if (type === 'phase' && job.status === 'running') {
      setGlobalStatus(`${job.versionId} · ${msg.label || ''}`, 'busy');
    }
    return;
  }

  if (type === 'file') return;

  if (['done', 'error', 'paused', 'cancelled', 'verified'].includes(type)) {
    const job = msg.job;
    if (!job) return;
    state.jobs.set(job.id, job);
    renderJob(job);
    if (type === 'done') {
      setGlobalStatus('就绪', 'ok');
      toast(job.type === 'install' ? `${job.versionId} 安装完成，可以启动了` : '校验完成', { title: '完成' });
      refreshBootstrap();
      loadStorage();
    }
    if (type === 'error') {
      setGlobalStatus('任务失败', 'error');
      toast(msg.message, { type: 'error', title: '下载失败', timeout: 8000 });
    }
    if (type === 'paused') setGlobalStatus('已暂停', 'idle');
    return;
  }

  if (type === 'game-log') {
    appendConsole(msg.line, msg.stream);
    return;
  }

  if (type === 'game-exit') {
    const code = msg.code;
    state.proc = null;
    renderHero();
    setGlobalStatus('就绪', 'ok');
    if (code === 0) toast('游戏已退出', { title: '正常退出' });
    else toast(`游戏异常退出（退出码 ${code}），请查看控制台日志`, { type: 'error', title: '进程退出', timeout: 8000 });
    return;
  }

  if (type === 'launch-phase') {
    setGlobalStatus(msg.label || '准备启动…', 'busy');
  }
}

/* ---------------- 版本选择弹窗 ---------------- */

async function openVersionPicker() {
  openModal('#modal-versions');
  if (!state.remote) {
    $('#manifest-hint').textContent = '正在获取版本清单…';
    try {
      const data = await api('/api/versions/remote');
      state.remote = data;
      $('#manifest-hint').textContent = data.stale
        ? '⚠ 网络不可用，展示的是本地缓存的版本清单'
        : `共 ${data.versions.length} 个版本 · 最新正式版 ${data.latest.release}`;
    } catch (e) {
      $('#manifest-hint').textContent = `获取失败：${e.message}`;
      return;
    }
  }
  renderRemoteList();
}

function renderRemoteList() {
  const list = $('#remote-list');
  const q = state.remoteQuery.trim().toLowerCase();
  const rows = (state.remote?.versions || []).filter((v) => {
    const typeOk = state.remoteFilter === 'release' ? v.type === 'release' : v.type === state.remoteFilter;
    const qOk = !q || v.id.toLowerCase().includes(q);
    return typeOk && qOk;
  });
  if (!rows.length) {
    list.innerHTML = `<div class="skeleton-note">没有匹配的版本</div>`;
    return;
  }
  const installedIds = new Set(state.installed.map((v) => v.id));
  list.innerHTML = rows
    .map(
      (v) => `
      <div class="ver-row ${state.picked === v.id ? 'active' : ''} ${installedIds.has(v.id) ? 'installed' : ''}" data-id="${esc(v.id)}">
        <span class="vr-id">${esc(v.id)}</span>
        <span class="vr-date">${esc(fmtDate(v.releaseTime))}</span>
      </div>`
    )
    .join('');
  $$('.ver-row', list).forEach((r) => r.addEventListener('click', () => pickVersion(r.dataset.id)));
}

async function pickVersion(id) {
  state.picked = id;
  renderRemoteList();
  const detail = $('#version-detail');
  detail.innerHTML = `<div class="empty-state small"><p>正在解析 ${esc(id)} …</p></div>`;
  $('#btn-start-install').disabled = true;

  try {
    const p = await api('/api/versions/preview', {
      body: { versionId: id, includeAssets: $('#opt-assets').checked },
    });
    state.preview = p;

    const kindLabel = { client: '游戏本体', library: '运行库', native: '本地库', assetIndex: '资源索引', asset: '游戏资源', logConfig: '日志配置' };
    const lines = p.breakdown
      .map((b) => `<div class="vd-line"><span>${kindLabel[b.kind] || b.kind}</span><b>${b.count} 个 · ${fmtBytes(b.bytes)}</b></div>`)
      .join('');

    detail.innerHTML = `
      <div>
        <div class="vd-title">${esc(p.versionId)}</div>
        <div class="badges" style="margin-top:6px">
          <span class="pill ${p.type === 'release' ? 'pill-release' : 'pill-snapshot'}">${p.type === 'release' ? '正式版' : esc(p.type)}</span>
          ${p.chain.length > 1 ? `<span class="pill pill-loader">继承 ${esc(p.chain.slice(0, -1).join(' → '))}</span>` : ''}
          ${p.alreadyInstalled ? '<span class="pill pill-release">已安装</span>' : ''}
        </div>
      </div>
      <div class="vd-grid">
        <div class="vd-cell"><label>发布时间</label><strong>${esc(fmtDate(p.releaseTime))}</strong></div>
        <div class="vd-cell"><label>需要 Java</label><strong>${p.javaVersion ? `${p.javaVersion.majorVersion} (${esc(p.javaVersion.component)})` : '未知'}</strong></div>
        <div class="vd-cell"><label>文件总数</label><strong>${p.totals.count} 个</strong></div>
        <div class="vd-cell"><label>需要空间</label><strong>${fmtBytes(p.totals.bytes)}</strong></div>
      </div>
      <div class="vd-breakdown">
        ${lines}
        <div class="vd-line vd-total"><span>合计</span><b>${fmtBytes(p.totals.bytes)}</b></div>
      </div>
      <div class="notice ${p.alreadyInstalled ? 'ok' : ''}">
        ${p.alreadyInstalled
          ? '该版本已安装。再次下载只会补齐缺失或损坏的文件，不会重复下载已有内容。'
          : `将安装到 <code>${esc(p.installDir)}</code>。下载中断可随时暂停，续传会按已下载的字节数继续。`}
      </div>
      <div class="field-hint">
        ${p.includeAssets ? `包含 ${p.assetCount} 个资源对象（音效 / 语言 / 贴图）。` : '⚠ 已关闭资源下载：游戏可以启动，但可能缺音效与语言文件。'}
        ${p.natives ? `<br/>当前平台需要 ${p.natives} 个 natives 库，安装时自动解压。` : ''}
      </div>`;

    $('#btn-start-install').disabled = false;
  } catch (e) {
    detail.innerHTML = `<div class="notice">解析失败：${esc(e.message)}</div>`;
  }
}

async function loadStorage() {
  try {
    const s = await api('/api/storage');
    const total = s.total || 1;
    const rows = [
      { k: '游戏版本', v: s.versions, c: 's1' },
      { k: '运行库', v: s.libraries, c: 's2' },
      { k: '游戏资源', v: s.assets, c: 's3' },
      { k: 'Java 运行时', v: s.runtime, c: 's4' },
    ];
    $('#storage-total').textContent = fmtBytes(s.total);
    $('#storage-bar').innerHTML = rows
      .filter((r) => r.v > 0)
      .map((r) => `<i class="${r.c}" style="width:${(r.v / total) * 100}%"></i>`)
      .join('');
    $('#storage-legend').innerHTML = rows
      .map(
        (r) =>
          `<div><em class="${r.c}" style="background:${
            { s1: '#12a06a', s2: '#2f8fbe', s3: '#8d7ad6', s4: '#d0a12a' }[r.c]
          }"></em>${r.k}<b>${fmtBytes(r.v)}</b></div>`
      )
      .join('');
  } catch {
    /* 存储统计失败不影响主流程 */
  }
}

/* ---------------- 数据刷新 ---------------- */

async function refreshBootstrap(keepSelected = true) {
  const boot = await api('/api/bootstrap');
  state.boot = boot;
  state.config = boot.config;
  state.installed = boot.installed;

  if (!keepSelected || !state.installed.find((v) => v.id === state.selected)) {
    state.selected = state.installed[0]?.id || null;
  }
  renderVersions();
  renderHero();
  renderConfig();
  renderAccount();

  const active = boot.jobs.filter((j) => j.status === 'running').length;
  if (active) setGlobalStatus(`${active} 个任务进行中`, 'busy');
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('#btn-download').addEventListener('click', openVersionPicker);
  $('#btn-settings').addEventListener('click', () => {
    renderConfig();
    openModal('#modal-settings');
  });
  $('#btn-account').addEventListener('click', openAccountModal);
  $('#btn-logs').addEventListener('click', () => {
    const el = $('#console');
    el.classList.toggle('collapsed');
    if (!el.classList.contains('collapsed') && state.consoleTab === 'launcher') loadLauncherLogs();
  });
  $('#console-toggle').addEventListener('click', () => {
    $('#console').classList.toggle('collapsed');
  });
  $('#btn-clear-console').addEventListener('click', clearConsole);
  $('#btn-clear-jobs').addEventListener('click', () => {
    for (const [id, job] of state.jobs) {
      if (['done', 'error', 'cancelled', 'paused'].includes(job.status)) {
        state.jobs.delete(id);
        state.jobNodes.get(id)?.root.remove();
        state.jobNodes.delete(id);
      }
    }
    updateJobsEmpty();
  });

  $('#version-tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    $$('#version-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    state.remoteFilter = tab.dataset.filter;
    renderRemoteList();
  });
  $('#version-search').addEventListener('input', (e) => {
    state.remoteQuery = e.target.value;
    renderRemoteList();
  });
  $('#opt-assets').addEventListener('change', () => {
    if (state.picked) pickVersion(state.picked);
  });
  $('#btn-start-install').addEventListener('click', startInstall);

  $('#btn-launch').addEventListener('click', doLaunch);
  $('#btn-verify').addEventListener('click', () => {
    if (state.selected) startVerify(state.selected);
  });
  $('#btn-open-dir').addEventListener('click', async () => {
    if (!state.selected) return;
    try {
      await api('/api/reveal', { body: { versionId: state.selected } });
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  });
  $('#btn-delete').addEventListener('click', () => {
    if (state.selected) removeVersion(state.selected);
  });

  // 关闭弹窗
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) {
      const modal = e.target.closest('.modal');
      if (modal) modal.classList.remove('open');
    }
    if (e.target.classList.contains('modal')) e.target.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllModals();
  });

  // 启动参数
  const patchConfig = async (patch) => {
    try {
      const data = await api('/api/config', { body: patch });
      state.config = data;
      return data;
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  };

  const memRange = $('#mem-range');
  memRange.addEventListener('input', () => {
    $('#mem-label').textContent = `${memRange.value} MB`;
  });
  memRange.addEventListener('change', async () => {
    await patchConfig({ maxMemory: Number(memRange.value) });
    renderHero();
  });
  $('#win-width').addEventListener('change', (e) => patchConfig({ width: Number(e.target.value) || 1280 }));
  $('#win-height').addEventListener('change', (e) => patchConfig({ height: Number(e.target.value) || 720 }));
  $('#fullscreen').addEventListener('change', (e) => patchConfig({ fullscreen: e.target.checked }));
  $('#jvm-args').addEventListener('change', (e) => patchConfig({ extraJvmArgs: e.target.value }));

  // 设置保存
  $('#btn-save-settings').addEventListener('click', async () => {
    try {
      await api('/api/config', {
        body: {
          javaPath: $('#set-java').value.trim(),
          autoDownloadJava: $('#set-autojava').checked,
          concurrency: Number($('#set-concurrency').value) || 8,
          mirror: $('#set-mirror').value,
          verifyMode: $('#set-verify').value,
        },
      });
      closeModal('#modal-settings');
      toast('设置已保存', { title: '成功' });
      await refreshBootstrap();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  });
  $('#btn-detect-java').addEventListener('click', async () => {
    try {
      const { list } = await api('/api/java/detect', { body: {} });
      state.boot.java.list = list;
      renderConfig();
      toast(`发现 ${list.length} 个 Java`, { title: '探测完成' });
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  });
  $('#btn-save-root').addEventListener('click', async () => {
    const dir = $('#set-root').value.trim();
    if (!dir) return;
    const ok = await confirmDialog('切换数据目录', `将把启动器的数据目录改为：\n${dir}\n\n已有的版本不会被自动迁移，需要在新目录重新下载或手动复制 versions / libraries / assets。`);
    if (!ok) return;
    try {
      await api('/api/config', { body: { rootDir: dir } });
      closeModal('#modal-settings');
      toast('数据目录已切换', { title: '成功' });
      state.remote = null;
      await refreshBootstrap(false);
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  });

  // 账户
  $$('.seg-item').forEach((btn) =>
    btn.addEventListener('click', () => setAccTab(btn.dataset.accTab))
  );

  $('#btn-offline-login').addEventListener('click', async () => {
    try {
      const acc = await api('/api/auth/offline', { body: { name: $('#acc-name').value } });
      state.config.account = acc;
      accUi.skin = null;
      accUi.session = null;
      renderAccount();
      renderHero();
      closeModal('#modal-account');
      toast(`已切换为离线账户 ${acc.name}`, { title: '账户' });
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  });

  $('#btn-msa-verify').addEventListener('click', () => verifyMsaClientId(false));
  $('#btn-msa-save').addEventListener('click', () => verifyMsaClientId(true));
  $('#msa-client-id').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verifyMsaClientId(true);
  });
  $('#btn-msa-login').addEventListener('click', startMsaLogin);
  $('#btn-msa-copy').addEventListener('click', copyMsaCode);
  $('#msa-code').addEventListener('click', copyMsaCode);
  $('#btn-msa-cancel').addEventListener('click', cancelMsaLogin);
  $('#btn-msa-open').addEventListener('click', () => {
    const url = accUi.session?.verificationUri || 'https://microsoft.com/link';
    window.open(url, '_blank', 'noopener');
  });
  $('#btn-msa-reconfig').addEventListener('click', () => {
    $('#msa-client-id').value = state.config.msaClientId || '';
    $('#msa-setup-hint').textContent = '';
    accUi.reconfig = true;
    renderMsaPane();
  });
  $('#btn-msa-refresh').addEventListener('click', refreshMsaToken);
  $('#btn-msa-logout').addEventListener('click', logoutMsa);

  // 控制台 tab
  $$('.ctab').forEach((t) =>
    t.addEventListener('click', () => {
      $$('.ctab').forEach((x) => x.classList.toggle('active', x === t));
      state.consoleTab = t.dataset.tab;
      showConsole(true);
      if (state.consoleTab === 'launcher') loadLauncherLogs();
      else clearConsole();
    })
  );
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  connectSSE();
  try {
    await refreshBootstrap(false);
  } catch (e) {
    toast(`初始化失败：${e.message}`, { type: 'error', timeout: 8000 });
    return;
  }

  // 恢复未结束的任务
  for (const job of state.boot.jobs || []) {
    state.jobs.set(job.id, job);
  }
  renderAllJobs();
  loadStorage();
  setGlobalStatus('就绪', 'ok');
  appendConsole('Aurora Launcher 已就绪，等待操作…', 'sys');
}

init();
