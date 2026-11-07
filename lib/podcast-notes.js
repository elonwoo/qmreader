const fs = require('node:fs');
const path = require('node:path');
const { stripAudioTimestamps } = require('./podcast-transcript');

const NOTES_DIR = process.env.QMREADER_PODCAST_NOTES_DIR || path.join(process.env.QMREADER_DATA_DIR || path.join(__dirname, '..', 'data'), 'podcast-notes');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function renderPodcastNote(entry, note) {
  const title = escapeHtml(entry.title);
  const summary = note?.summary ? escapeHtml(stripAudioTimestamps(note.summary)) : 'Get笔记正在生成摘要，请稍后刷新。';
  const transcriptReady = typeof note?.transcript === 'string' && note.transcript.length >= 1000 && (note.transcriptSource === 'nexttoken.tv' || /\[\d{2}:\d{2}/.test(note.transcript));
  const transcriptSection = transcriptReady
    ? `<h2>完整转写</h2><pre>${escapeHtml(stripAudioTimestamps(note.transcript))}</pre>`
    : '<h2>完整转写</h2><p>Get笔记仍在处理逐字稿，完成后会在这里展示。</p>';
  const links = note ? `<a href="${escapeHtml(note.sourceUrl)}" target="_blank" rel="noopener noreferrer">小宇宙单集</a><a href="${escapeHtml(note.noteUrl)}" target="_blank" rel="noopener noreferrer">Get笔记</a>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 私人播客笔记</title><style>body{max-width:850px;margin:0 auto;padding:32px 20px 80px;background:#faf9f6;color:#242424;font:17px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}h1{font-size:1.7rem;line-height:1.35}h2{font-size:1.1rem;margin-top:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:white;padding:24px;border-radius:12px;border:1px solid #e5e1d9}nav{display:flex;gap:16px}a{color:#286a67}</style></head><body><nav>${links}</nav><h1>${title}</h1><p>仅管理员可见 · AI 转写可能有识别错误，请以原音频为准。</p><h2>Get笔记摘要</h2><pre>${summary}</pre>${transcriptSection}</body></html>`;
}

function mountPodcastNotes(app, requireAdmin, fetcher) {
  app.get('/podcast-notes/:entryId', requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    const id = String(req.params.entryId || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).send('Not found');
    const entry = fetcher.getEntryById(id, req.user);
    if (!entry || !['zhangxiaojun', '42zhangjing', 'latetalk', 'bannatie', 'nexttoken', 'crossing', 'aialchemy', '35huan', 'zhixing', 'mianji'].includes(entry.sourceId)) return res.status(404).send('Not found');
    const episodeId = String(entry.link || '').match(/xiaoyuzhoufm\.com\/episode\/([a-f0-9]{24})/)?.[1];
    if (!episodeId) return res.status(404).send('Not found');
    let note;
    try { note = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, `${episodeId}.json`), 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') console.error('Private podcast note read failed:', error.message);
    }
    if (note && note.episodeId !== episodeId) note = null;
    res.status(note ? 200 : 202).type('html').send(renderPodcastNote(entry, note));
  });
}

module.exports = { mountPodcastNotes, renderPodcastNote };
