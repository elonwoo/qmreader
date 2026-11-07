const fs = require('node:fs');
const path = require('node:path');

const NOTES_DIR = process.env.QMREADER_YOUTUBE_NOTES_DIR || path.join(process.env.QMREADER_DATA_DIR || path.join(__dirname, '..', 'data'), 'youtube-notes');
const SOURCE_IDS = new Set(['allin', 'joerogan']);

function videoIdFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) || url.pathname !== '/watch') return '';
    const id = url.searchParams.get('v') || '';
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch { return ''; }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function stripGetnoteTimestamps(value) {
  return String(value || '')
    .replace(/^内容总时长：[^\n]*\n*/u, '')
    .replace(/\[\d{2}:\d{2}(?::\d{2})?\s*-\s*\d{2}:\d{2}(?::\d{2})?\]\s*/g, '')
    .trim();
}

function renderYoutubeNote(entry, note) {
  const videoId = videoIdFromUrl(entry.link);
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const title = escapeHtml(entry.title);
  const caption = note?.status === 'caption' && note.text
    ? `<h2>字幕文字稿 · ${escapeHtml(note.language)}${note.kind === 'automatic' ? '（自动字幕）' : ''}</h2><pre>${escapeHtml(note.text)}</pre>`
    : '';
  const getnote = note?.noteId && note.sourceUrl === url;
  const summary = getnote && note.summary
    ? `<h2>Get笔记摘要</h2><pre>${escapeHtml(stripGetnoteTimestamps(note.summary))}</pre>` : '';
  const transcript = getnote && note.transcript
    ? `<h2>完整逐字稿</h2><pre>${escapeHtml(stripGetnoteTimestamps(note.transcript))}</pre>` : '';
  const noteLink = getnote ? `<a href="https://www.biji.com/note/${encodeURIComponent(String(note.noteId))}" target="_blank" rel="noopener noreferrer">Get笔记来源</a>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · YouTube 私人笔记</title><style>body{max-width:850px;margin:0 auto;padding:32px 20px 80px;background:#faf9f6;color:#242424;font:17px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}h1{font-size:1.7rem;line-height:1.35}h2{font-size:1.1rem;margin-top:2rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:white;padding:24px;border-radius:12px;border:1px solid #e5e1d9}a{color:#286a67}nav{display:flex;gap:16px}</style></head><body><h1>${title}</h1><nav><a href="${url}" target="_blank" rel="noopener noreferrer">原视频 · YouTube</a>${noteLink}</nav><p>仅管理员可见 · AI 转写可能有识别错误，请以原视频为准。</p>${summary}${transcript}${caption}</body></html>`;
}

function mountYoutubeNotes(app, requireAdmin, fetcher) {
  app.get('/youtube-notes/:entryId', requireAdmin, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
    const id = String(req.params.entryId || '');
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).send('Not found');
    const entry = fetcher.getEntryById(id, req.user);
    if (!entry || !SOURCE_IDS.has(entry.sourceId)) return res.status(404).send('Not found');
    const videoId = videoIdFromUrl(entry.link);
    if (!videoId) return res.status(404).send('Not found');
    let note = null;
    try { note = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, `${videoId}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') console.error('Private YouTube note read failed:', error.message); }
    if (note && (note.videoId !== videoId || note.sourceId !== entry.sourceId ||
        (note.noteId && note.sourceUrl !== entry.link))) note = null;
    res.status(200).type('html').send(renderYoutubeNote(entry, note));
  });
}

module.exports = { SOURCE_IDS, videoIdFromUrl, stripGetnoteTimestamps, renderYoutubeNote, mountYoutubeNotes };
