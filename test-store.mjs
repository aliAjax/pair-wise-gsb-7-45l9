import assert from 'node:assert';

// --- 浏览器环境桩 ---
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const listeners = new Set();
globalThis.window = {
  addEventListener: (_e, fn) => listeners.add(fn),
  removeEventListener: (_e, fn) => listeners.delete(fn),
};
globalThis.structuredClone = globalThis.structuredClone || ((x) => JSON.parse(JSON.stringify(x)));

const s = await import('./src/store.js');
const FV = (v) => s.fieldValues(v);

// 1. 初始 seed：已发布展项带 published 快照
let db = s.read();
assert.equal(db.format, 2);
const ex1 = db.exhibits[0];
assert.equal(ex1.publishedRevision, 1);
assert.equal(ex1.published.title, '潮汐之后');

// 2. 编辑保存推进版本
let r = s.saveExhibit(db, ex1.id, 1, { ...FV(s.latest(ex1)), desc: '新介绍' });
assert.ok(r.saved && r.saved.revision === 2, '保存应生成 v2');
db = r.db;
assert.equal(s.latest(db.exhibits[0]).desc, '新介绍');

// 3. 用过期的 baseRevision 保存 -> 冲突被拒，列出字段
r = s.saveExhibit(db, ex1.id, 1, { ...FV(db.exhibits[0].versions[1]), desc: '我的修改' });
assert.ok(r.conflict, '过期版本保存必须返回冲突');
assert.equal(r.conflict.latestRevision, 2);
const descField = r.conflict.fields.find((f) => f.key === 'desc');
assert.equal(descField.theirs, '新介绍');
assert.equal(descField.yours, '我的修改');
assert.equal(descField.clash, true, '双方改了同字段应标记 clash');

// 4. 未变化内容保存 -> unchanged
r = s.saveExhibit(db, ex1.id, 2, FV(s.latest(db.exhibits[0])));
assert.equal(r.unchanged, true);

// 5. 连续 6 次保存 -> 最多保留 5 个版本，且被滚掉的旧版不能再作为 base
let cur = 2;
for (let i = 0; i < 6; i++) {
  const ex = db.exhibits[0];
  r = s.saveExhibit(db, ex.id, cur, { ...FV(s.latest(ex)), desc: `改${i}` });
  assert.ok(r.saved, `第${i}次保存应成功`);
  db = r.db; cur++;
}
const versions = db.exhibits[0].versions;
assert.equal(versions.length, 5, '历史最多 5 个版本');
assert.equal(versions[0].revision, 8);
assert.equal(versions[4].revision, 4);
// v3 已被滚掉，用 v3 当 base 保存：base 找不到，冲突字段覆盖全部字段
r = s.saveExhibit(db, ex1.id, 3, { ...FV(versions[0]), title: 'X' });
assert.ok(r.conflict && r.conflict.fields.length === 5);

// 6. 发布只快照 head；之后再改不影响已发布快照
r = s.publish(db, ex1.id); db = r.db;
const beforePub = r.revision;
r = s.saveExhibit(db, ex1.id, beforePub, { ...FV(s.latest(db.exhibits[0])), title: '临时改名' });
db = r.db;
assert.equal(db.exhibits[0].published.desc, '改5', '草稿修改不得影响访客端已发布快照');
assert.equal(db.exhibits[0].published.title, '潮汐之后');
assert.equal(s.statusOf(db.exhibits[0]).pending, true, '发布后又有新草稿 -> 有未发布更新');
// 发布新版本后访客端更新
r = s.publish(db, ex1.id); db = r.db;
assert.equal(db.exhibits[0].published.title, '临时改名');

// 7. 撤回：访客端无内容，但历史保留
r = s.withdraw(db, ex1.id); db = r.db;
assert.equal(db.exhibits[0].published, null);
assert.equal(db.exhibits[0].versions.length, 5);
assert.equal(s.statusOf(db.exhibits[0]).label, '已撤回');

// 8. 恢复旧版：生成新版本且不覆盖原记录
const ex2 = db.exhibits[1];
r = s.restoreVersion(db, ex2.id, 1, 1); // 草稿 v1 恢复 v1 内容 => head 与 base 一致但内容同 v1
// v1 即 head，内容相同：restore 仍追加新版本
db = r.db;
assert.ok(r.saved, '恢复应生成新版本');
assert.equal(r.saved.revision, 2);
assert.ok(r.saved.note.includes('恢复自 v1'));
assert.equal(db.exhibits[1].versions[1].revision, 1, '原 v1 记录必须保留');
// 恢复时 base 过期 -> 冲突拒绝
r = s.restoreVersion(db, ex2.id, 1, 1);
assert.ok(r.conflict, '基于过期版本恢复应被拒绝');

// 9. 新增展项：草稿，无 published
r = s.addExhibit(s.read(), { title: '新作品', room: 'Z01', type: '装置', desc: 'd', audio: '' });
assert.equal(r.db.exhibits.at(-1).head, 1);
assert.equal(r.db.exhibits.at(-1).published, null);
assert.equal(s.statusOf(r.db.exhibits.at(-1)).label, '草稿');

// 10. 旧格式扁平数组迁移
mem.clear();
mem.set('guide-exhibits', JSON.stringify([{ id: 9, title: '旧数据', room: 'R', type: '绘画', desc: '', audio: '', status: '已发布', color: '#000' }]));
db = s.read();
assert.equal(db.format, 2);
assert.equal(db.exhibits[0].id, 9);
assert.equal(db.exhibits[0].publishedRevision, 1);
assert.equal(mem.has('guide-exhibits'), false, '迁移后旧 key 应删除');

// 11. storage 事件订阅（模拟另一个标签页写入）
mem.clear();
db = s.read();
let pushed = null;
const unsub = s.subscribe((next) => { pushed = next; });
r = s.saveExhibit(db, 1, 1, { ...FV(s.latest(db.exhibits[0])), title: '隔壁标签改的' });
const evt = { key: 'guide-exhibits-v2', newValue: JSON.stringify(r.db) };
listeners.forEach((fn) => fn(evt));
assert.equal(pushed.exhibits[0].versions[0].title, '隔壁标签改的');
unsub();

console.log('全部数据层测试通过 ✔');
