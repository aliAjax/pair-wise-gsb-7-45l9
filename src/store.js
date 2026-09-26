// 版本化数据层：每个展项保留最近 MAX_VERSIONS 个历史版本，
// 已发布内容以独立快照保存（撤回 / 历史滚动都不影响访客端）。
// 所有写操作都走乐观锁：保存时必须带上打开时记下的 baseRevision，
// 若 head 已被别人推进，则拒绝写入并返回字段级冲突信息。

const V2_KEY = 'guide-exhibits-v2';
const V1_KEY = 'guide-exhibits';

export const MAX_VERSIONS = 5;

// 参与版本对比 / 冲突检测的内容字段
export const FIELDS = [
  ['title', '展项标题'],
  ['room', '所在展厅'],
  ['type', '内容类型'],
  ['desc', '展项介绍'],
  ['audio', '语音导览 URL'],
];

const COLORS = ['#e6b45d', '#ef8f84', '#83b9b1', '#9ba7dc'];

const seedRaw = [
  { id: 1, title: '潮汐之后', room: 'A01 · 主展厅', type: '装置', desc: '一件记录海岸线变化的沉浸式影像装置。', audio: 'https://example.com/audio.mp3', status: '已发布', color: '#e6b45d' },
  { id: 2, title: '未寄出的信', room: 'B02 · 纸上时间', type: '档案', desc: '来自三代人的手写信件与声音档案。', audio: '', status: '草稿', color: '#ef8f84' },
  { id: 3, title: '柔软的边界', room: 'C01 · 新媒介', type: '互动', desc: '观众的移动会改变墙面上的光影。', audio: '', status: '已发布', color: '#83b9b1' },
];

const fieldValues = (v) => Object.fromEntries(FIELDS.map(([k]) => [k, v?.[k] ?? '']));

function makeExhibit(o, savedAt) {
  const v = { revision: 1, ...fieldValues(o), savedAt, note: '创建' };
  const live = o.status === '已发布';
  return {
    id: o.id,
    color: o.color,
    head: 1,
    withdrawn: false,
    publishedRevision: live ? 1 : null,
    published: live ? { ...v } : null,
    versions: [v],
  };
}

function seed() {
  const now = Date.now();
  return {
    format: 2,
    exhibits: seedRaw.map((o, i) => makeExhibit(o, now - i * 37 * 60 * 1000)),
  };
}

// 兼容旧版（无版本的扁平数组）与全新用户
function migrate(raw) {
  if (!raw) return seed();
  if (raw.format === 2) return raw;
  if (Array.isArray(raw)) {
    const now = Date.now();
    return { format: 2, exhibits: raw.map((o) => makeExhibit(o, now)) };
  }
  return seed();
}

function write(db) {
  localStorage.setItem(V2_KEY, JSON.stringify(db));
}

export function read() {
  try {
    const raw = localStorage.getItem(V2_KEY);
    if (raw) return migrate(JSON.parse(raw));
    // 首次打开新版本：迁移旧数据
    const old = localStorage.getItem(V1_KEY);
    if (old) {
      const db = migrate(JSON.parse(old));
      write(db);
      localStorage.removeItem(V1_KEY);
      return db;
    }
  } catch {
    /* 损坏的数据一律回落到示例 */
  }
  return seed();
}

// 跨标签页（即“两个人同时编辑”）同步：另一个标签写入后本标签收到通知
export function subscribe(onChange) {
  const handler = (e) => {
    if (e.key === V2_KEY && e.newValue) {
      try {
        onChange(migrate(JSON.parse(e.newValue)));
      } catch {
        /* 忽略无法解析的推送 */
      }
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export const latest = (ex) => ex.versions[0];

export function statusOf(ex) {
  if (ex.publishedRevision != null) {
    return { cls: 'live', label: '已发布', pending: ex.publishedRevision < ex.head };
  }
  if (ex.withdrawn) return { cls: 'off', label: '已撤回', pending: false };
  return { cls: 'draft', label: '草稿', pending: false };
}

const findExhibit = (db, id) => db.exhibits.find((x) => x.id === id);

// 构造冲突明细：base→head 之间被对方改过的字段，
// clash 表示“双方都改了且改得不一样”（真正的硬冲突）
function buildConflict(ex, baseRevision, values) {
  const head = latest(ex);
  const base = ex.versions.find((v) => v.revision === baseRevision) || null;
  const fields = FIELDS.filter(([k]) => !base || base[k] !== head[k]).map(([k, label]) => ({
    key: k,
    label,
    yours: values[k] ?? '',
    theirs: head[k] ?? '',
    clash: (values[k] ?? '') !== (head[k] ?? ''),
  }));
  return { baseRevision, latestRevision: head.revision, fields };
}

export function addExhibit(db, values) {
  db = structuredClone(db);
  const savedAt = Date.now();
  const v = { revision: 1, ...fieldValues({ ...values }), savedAt, note: '创建' };
  const ex = {
    id: Date.now(),
    color: COLORS[db.exhibits.length % COLORS.length],
    head: 1,
    withdrawn: false,
    publishedRevision: null,
    published: null,
    versions: [v],
  };
  db.exhibits.push(ex);
  write(db);
  return { db, id: ex.id, saved: v };
}

// 乐观锁保存：head 与打开时版本不一致则拒绝
export function saveExhibit(db, id, baseRevision, values) {
  db = structuredClone(db);
  const ex = findExhibit(db, id);
  if (!ex) return { error: '展项不存在或已被删除' };

  if (ex.head !== baseRevision) {
    return { conflict: buildConflict(ex, baseRevision, values) };
  }

  const head = latest(ex);
  const unchanged = FIELDS.every(([k]) => (head[k] ?? '') === (values[k] ?? ''));
  if (unchanged) return { db, unchanged: true };

  const v = { revision: head.revision + 1, ...fieldValues(values), savedAt: Date.now(), note: '编辑保存' };
  ex.versions = [v, ...ex.versions].slice(0, MAX_VERSIONS);
  ex.head = v.revision;
  write(db);
  return { db, saved: v };
}

// 发布只快照当前确认的 head 版本
export function publish(db, id) {
  db = structuredClone(db);
  const ex = findExhibit(db, id);
  if (!ex) return { error: '展项不存在' };
  const v = latest(ex);
  ex.publishedRevision = v.revision;
  ex.published = { ...v };
  ex.withdrawn = false;
  write(db);
  return { db, revision: v.revision };
}

// 撤回：访客端立即下线，但版本历史原样保留
export function withdraw(db, id) {
  db = structuredClone(db);
  const ex = findExhibit(db, id);
  if (!ex) return { error: '展项不存在' };
  ex.publishedRevision = null;
  ex.published = null;
  ex.withdrawn = true;
  write(db);
  return { db };
}

// 恢复旧版：不覆盖原记录，而是追加一个新版本
export function restoreVersion(db, id, baseRevision, sourceRevision) {
  db = structuredClone(db);
  const ex = findExhibit(db, id);
  if (!ex) return { error: '展项不存在' };
  if (ex.head !== baseRevision) {
    const head = latest(ex);
    return { conflict: buildConflict(ex, baseRevision, fieldValues(head)) };
  }
  const src = ex.versions.find((v) => v.revision === sourceRevision);
  if (!src) return { error: '要恢复的版本已不在历史记录中' };

  const v = {
    revision: ex.head + 1,
    ...fieldValues(src),
    savedAt: Date.now(),
    note: `恢复自 v${sourceRevision}`,
  };
  ex.versions = [v, ...ex.versions].slice(0, MAX_VERSIONS);
  ex.head = v.revision;
  write(db);
  return { db, saved: v, sourceRevision };
}

export { fieldValues };
