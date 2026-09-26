import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import {
  read, subscribe, latest, statusOf, fieldValues,
  addExhibit, saveExhibit, publish, withdraw, restoreVersion,
  FIELDS, MAX_VERSIONS,
} from './store.js';

function fmtTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  let rel;
  if (diff < 60_000) rel = '刚刚';
  else if (diff < 3_600_000) rel = `${Math.floor(diff / 60_000)} 分钟前`;
  else if (diff < 86_400_000) rel = `${Math.floor(diff / 3_600_000)} 小时前`;
  else rel = new Date(ts).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  const abs = new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return { rel, abs };
}

function StatusBadge({ ex }) {
  const s = statusOf(ex);
  return (
    <span className="badge-wrap">
      <span className={`status ${s.cls}`}>{s.label}</span>
      {s.pending && <span className="status pending">有未发布更新</span>}
    </span>
  );
}

function ExhibitEditor({ ex, db, setDb, notify }) {
  const head = latest(ex);
  const [baseRevision, setBaseRevision] = useState(head.revision);
  const [form, setForm] = useState(() => fieldValues(head));
  const [conflict, setConflict] = useState(null);
  const [remoteHead, setRemoteHead] = useState(null);

  const base = ex.versions.find((v) => v.revision === baseRevision);
  const dirty = !conflict && base ? FIELDS.some(([k]) => (form[k] ?? '') !== (base[k] ?? '')) : false;
  const locked = !!conflict;

  // 另一个标签页（协作者）保存后，head 被推进
  useEffect(() => {
    if (head.revision === baseRevision || conflict) return;
    const nowBase = ex.versions.find((v) => v.revision === baseRevision);
    const localDirty = nowBase ? FIELDS.some(([k]) => (form[k] ?? '') !== (nowBase[k] ?? '')) : false;
    if (localDirty) {
      setRemoteHead(head.revision);
    } else {
      // 本地没改过：直接静默载入最新，避免用旧版覆盖
      setForm(fieldValues(head));
      setBaseRevision(head.revision);
      setRemoteHead(null);
      notify(`已自动载入协作者的最新版本 v${head.revision}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head.revision]);

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const reloadLatest = () => {
    const h = latest(ex);
    setForm(fieldValues(h));
    setBaseRevision(h.revision);
    setConflict(null);
    setRemoteHead(null);
    notify(`已载入最新版本 v${h.revision}，请在最新内容上重新修改`);
  };

  const save = () => {
    const res = saveExhibit(db, ex.id, baseRevision, form);
    if (res.error) { notify(res.error); return; }
    if (res.conflict) {
      setConflict(res.conflict);
      setRemoteHead(null);
      notify('保存被拒绝：协作者已更新此展项');
      return;
    }
    if (res.unchanged) { notify('内容没有变化，无需保存'); return; }
    setDb(res.db);
    setBaseRevision(res.saved.revision);
    setConflict(null);
    setRemoteHead(null);
    notify(`已保存为 v${res.saved.revision}`);
  };

  const restore = (rev) => {
    if (!window.confirm(`恢复 v${rev} 的内容？将在当前基础上生成一个新版本，不会覆盖历史记录。`)) return;
    const res = restoreVersion(db, ex.id, baseRevision, rev);
    if (res.error) { notify(res.error); return; }
    if (res.conflict) {
      setConflict(res.conflict);
      notify('恢复被拒绝：协作者已更新此展项');
      return;
    }
    setDb(res.db);
    const v = res.db.exhibits.find((x) => x.id === ex.id).versions[0];
    setForm(fieldValues(v));
    setBaseRevision(v.revision);
    setConflict(null);
    notify(`已恢复 v${res.sourceRevision} 的内容并生成 v${v.revision}`);
  };

  const s = statusOf(ex);
  const t = fmtTime(head.savedAt);

  return (
    <div className="editor-wrap">
      <div className="panel-title">
        <div>
          <span className="eyebrow">EDIT EXHIBIT</span>
          <h2>编辑展项</h2>
        </div>
        <StatusBadge ex={ex} />
      </div>

      <div className="meta-strip" title={`最近保存：${t.abs}`}>
        <span>当前版本 <b>v{head.revision}</b></span>
        <i/>
        <span>草稿状态 <b className={`meta-${s.cls}`}>{dirty ? '未保存的修改' : '已保存'}{s.pending ? ' · 待发布' : ''}</b></span>
        <i/>
        <span>最近保存 <b title={t.abs}>{t.rel}</b></span>
      </div>

      {remoteHead && (
        <div className="banner warn">
          <div><strong>协作者已保存新版本（v{remoteHead}）。</strong>你本地还有未保存的修改，请先载入最新内容，再把修改重做，以免覆盖他人内容。</div>
          <button onClick={reloadLatest}>载入最新内容</button>
        </div>
      )}

      {conflict && (
        <div className="banner conflict">
          <div className="conflict-head">
            <strong>保存失败：版本冲突</strong>
            <span>你打开时基于 v{conflict.baseRevision}，当前最新已是 v{conflict.latestRevision}。下列字段已被对方更新，请载入最新内容后重新编辑。</span>
          </div>
          <ul className="conflict-list">
            {conflict.fields.map((f) => (
              <li key={f.key}>
                <div className="conflict-field">{f.label}{f.clash && <em>双方都修改了</em>}</div>
                <div className="conflict-vals">
                  <div><small>协作者已保存</small><p>{f.theirs || <i>（空）</i>}</p></div>
                  <div><small>你本次的修改</small><p>{f.yours || <i>（空）</i>}</p></div>
                </div>
              </li>
            ))}
          </ul>
          <button className="primary" onClick={reloadLatest}>载入最新内容并重做</button>
        </div>
      )}

      <div className={`editor${locked ? ' locked' : ''}`}>
        <label>展项标题<input value={form.title} disabled={locked} onChange={(e) => update('title', e.target.value)} /></label>
        <div className="two">
          <label>所在展厅<input value={form.room} disabled={locked} onChange={(e) => update('room', e.target.value)} /></label>
          <label>内容类型
            <select value={form.type} disabled={locked} onChange={(e) => update('type', e.target.value)}>
              <option>装置</option><option>档案</option><option>互动</option><option>绘画</option>
            </select>
          </label>
        </div>
        <label>展项介绍<textarea rows="5" value={form.desc} disabled={locked} onChange={(e) => update('desc', e.target.value)} /></label>
        <label>语音导览 URL
          <input value={form.audio} disabled={locked} placeholder="https://…" onChange={(e) => update('audio', e.target.value)} />
          <small className="hint">访客扫描二维码后可播放</small>
        </label>

        <div className="save-row">
          <button className="primary" disabled={locked || !dirty} onClick={save}>保存修改</button>
          {dirty && <span className="save-hint">有未保存的修改</span>}
          {!dirty && !locked && <span className="save-hint">内容与 v{baseRevision} 一致</span>}
        </div>

        <div className="preview-block">
          <div className="preview-heading"><span>二维码预览</span><button onClick={() => notify('二维码链接已复制')}>复制链接</button></div>
          <div className="qr-preview">
            <div className="qr-box big">▦</div>
            <div><strong>展项-{String(ex.id).padStart(3, '0')}</strong><small>/guide/{ex.id}</small></div>
          </div>
        </div>
      </div>

      <div className="history">
        <div className="history-head">
          <h3>版本历史</h3>
          <span>最多保留 {MAX_VERSIONS} 个版本</span>
        </div>
        {ex.versions.map((v) => {
          const vt = fmtTime(v.savedAt);
          return (
            <div className={`version-row${v.revision === ex.head ? ' is-head' : ''}`} key={v.revision}>
              <span className="ver-no">v{v.revision}</span>
              <div className="ver-meta">
                <strong>{v.note}{v.revision === ex.head && ' · 当前版本'}</strong>
                <small title={vt.abs}>{vt.abs}</small>
              </div>
              {v.revision === ex.publishedRevision && <span className="status live">已发布版</span>}
              {v.revision !== ex.head && !locked && (
                <button className="restore-btn" onClick={() => restore(v.revision)}>恢复</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function App() {
  const [db, setDb] = useState(read);
  const [selected, setSelected] = useState(() => db.exhibits[0]?.id);
  const [view, setView] = useState('edit');
  const [filter, setFilter] = useState('全部');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({ title: '', room: '', desc: '' });

  useEffect(() => subscribe(setDb), []);
  const notify = (msg) => {
    setNotice(msg);
    window.clearTimeout(notify._t);
    notify._t = window.setTimeout(() => setNotice(''), 3200);
  };

  const exhibits = db.exhibits;
  const current = exhibits.find((x) => x.id === selected) || exhibits[0];
  useEffect(() => { if (current && current.id !== selected) setSelected(current.id); }, [current?.id]);

  const visible = useMemo(
    () => filter === '全部' ? exhibits : exhibits.filter((x) => statusOf(x).label === filter),
    [db, filter],
  );
  const lastSaved = useMemo(
    () => exhibits.reduce((m, x) => Math.max(m, latest(x).savedAt || 0), 0),
    [db],
  );

  const add = () => {
    if (!form.title.trim()) { notify('请先填写展项标题'); return; }
    const res = addExhibit(db, { title: form.title.trim(), room: form.room, type: '装置', desc: form.desc, audio: '' });
    setDb(res.db);
    setSelected(res.id);
    setForm({ title: '', room: '', desc: '' });
    notify('展项已保存为草稿（v1）');
  };

  const togglePublish = () => {
    if (!current) return;
    if (statusOf(current).label === '已发布') {
      setDb(withdraw(db, current.id).db);
      notify('已撤回：访客端不再显示，历史版本已保留');
    } else {
      const res = publish(db, current.id);
      if (res.error) { notify(res.error); return; }
      setDb(res.db);
      notify(`已发布 v${res.revision}，访客预览已更新`);
    }
  };

  const exportData = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    a.download = 'exhibition-guide.json';
    a.click();
    notify('已导出展项数据（含版本历史）');
  };

  if (view === 'visitor') {
    return (
      <div className="visitor">
        <header>
          <div className="brand"><span className="mark">M</span><span>潮汐美术馆</span></div>
          <button className="ghost" onClick={() => setView('edit')}>返回编辑</button>
        </header>
        <main className="visitor-main">
          <span className="eyebrow">VISITOR GUIDE / 2024</span>
          <h1>沿着作品，<em>走进</em>另一种时间。</h1>
          <p className="lead">当你靠近一件作品，它的故事就开始流动。选择一个展项开始探索。</p>
          <div className="visitor-grid">
            {exhibits.filter((x) => x.published).map((x) => {
              const p = x.published;
              return (
                <article className="visitor-card" key={x.id} onClick={() => { setSelected(x.id); setView('detail'); }}>
                  <div className="art" style={{ background: x.color }}><span>{String(x.id).padStart(2, '0')}</span><i>↗</i></div>
                  <div className="card-meta"><small>{p.room} · v{x.publishedRevision}</small><h3>{p.title}</h3><p>{p.desc}</p></div>
                </article>
              );
            })}
          </div>
        </main>
      </div>
    );
  }

  if (view === 'detail') {
    const p = current?.published;
    return (
      <div className="visitor">
        <header>
          <div className="brand"><span className="mark">M</span><span>潮汐美术馆 · 导览</span></div>
          <button className="ghost" onClick={() => setView('visitor')}>← 全部展项</button>
        </header>
        {p ? (
          <main className="detail">
            <div className="detail-art" style={{ background: current.color }}><span>{String(current.id).padStart(2, '0')}</span></div>
            <div className="detail-copy">
              <span className="eyebrow">{p.room} / {p.type}</span>
              <h1>{p.title}</h1>
              <p>{p.desc}</p>
              {p.audio && <button className="audio" onClick={() => notify('正在播放导览音频…')}>▶ 播放语音导览</button>}
              <div className="qr">
                <div className="qr-box">▦</div>
                <div><strong>分享这个展项</strong><small>扫描二维码，在手机上继续阅读</small></div>
              </div>
            </div>
          </main>
        ) : (
          <main className="visitor-main"><h1>该展项目前未发布</h1><p className="lead">它已被撤回或尚未发布，访客端无法查看。</p></main>
        )}
        {notice && <div className="toast">{notice}</div>}
      </div>
    );
  }

  const pubLabel = current && statusOf(current).label === '已发布' ? '撤回发布' : '发布更新';
  const foot = fmtTime(lastSaved);

  return (
    <div className="app">
      <aside>
        <div className="brand"><span className="mark">M</span><span>展览工作台</span></div>
        <div className="side-label">当前项目</div>
        <div className="project">
          <span className="project-dot"></span>
          <div><strong>潮汐之后</strong><small>2024 春季展</small></div>
          <span>⌄</span>
        </div>
        <nav>
          <button className="active">▧ <span>展项内容</span><b>{exhibits.length}</b></button>
          <button>⌁ <span>展厅动线</span></button>
          <button>◉ <span>二维码</span></button>
        </nav>
        <div className="side-foot">
          <button>⚙ 设置</button>
          <small title={foot.abs}>最近保存 · {foot.rel}</small>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">EXHIBITION BUILDER</span>
            <h1>展项内容</h1>
          </div>
          <div className="top-actions">
            <button className="secondary" onClick={exportData}>↓ 导出 JSON</button>
            <button className="secondary" onClick={() => setView('visitor')}>◉ 访客预览</button>
            <button className="primary" onClick={togglePublish} disabled={!current}>{pubLabel} <span>↗</span></button>
          </div>
        </header>

        <div className="content">
          <section className="list-pane">
            <div className="list-head">
              <div><h2>全部展项</h2><span>{exhibits.length} 个展项</span></div>
              <button className="add-btn" onClick={() => document.querySelector('.new-form').scrollIntoView({ behavior: 'smooth' })}>＋ 添加展项</button>
            </div>
            <div className="filters">
              {['全部', '已发布', '草稿'].map((x) => (
                <button className={filter === x ? 'selected' : ''} onClick={() => setFilter(x)} key={x}>{x}</button>
              ))}
            </div>
            <div className="exhibit-list">
              {visible.map((x) => {
                const v = latest(x);
                return (
                  <button className={'exhibit-row ' + (current?.id === x.id ? 'chosen' : '')} key={x.id} onClick={() => setSelected(x.id)}>
                    <span className="thumb" style={{ background: x.color }}>{String(x.id).padStart(2, '0')}</span>
                    <span className="row-copy">
                      <strong>{v.title}</strong>
                      <small>{v.room} · {v.type} · v{v.revision}</small>
                    </span>
                    <StatusBadge ex={x} />
                    <span className="chev">›</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="form-panel">
            {current && (
              <ExhibitEditor key={current.id} ex={current} db={db} setDb={setDb} notify={notify} />
            )}

            <div className="new-form">
              <div className="panel-title">
                <div><span className="eyebrow">NEW ENTRY</span><h2>快速添加展项</h2></div>
              </div>
              <div className="two">
                <input placeholder="展项标题" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                <input placeholder="展厅编号" value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })} />
              </div>
              <textarea placeholder="一句话介绍…" rows="2" value={form.desc} onChange={(e) => setForm({ ...form, desc: e.target.value })} />
              <button className="primary full" onClick={add}>保存新展项</button>
            </div>
          </section>
        </div>
      </main>

      {notice && <div className="toast">{notice}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
