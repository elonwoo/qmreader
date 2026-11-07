const fs = require('node:fs');
const path = require('node:path');
const { search, transcript } = require('./podscribe');
const { videoIdFromUrl, stripGetnoteTimestamps } = require('./youtube-notes');
const { transcriptHash } = require('./podcast-transcript');

const DATA_ROOT = process.env.QMREADER_DATA_DIR || path.join(__dirname, '..', 'data');
const NOTES_DIR = process.env.QMREADER_PODSCRIBE_NOTES_DIR || path.join(DATA_ROOT, 'podscribe-notes');
const GETNOTE_DIR = process.env.QMREADER_YOUTUBE_NOTES_DIR || path.join(DATA_ROOT, 'youtube-notes');
const SHOW_SLUGS = {
  allin: 'all-in-with-chamath-jason-sacks-friedberg',
  joerogan: 'the-joe-rogan-experience',
};
const DIGEST_VERSION = 'podscribe-full-transcript-v1';

function isPodscribeEntry(entry) {
  return Boolean(entry && (SHOW_SLUGS[entry.sourceId] && videoIdFromUrl(entry.link) || dynamicEpisode(entry)));
}

function dynamicEpisode(entry) {
  const slug = /^podscribe-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(entry?.sourceId || ''))?.[1];
  if (!slug) return null;
  try {
    const url = new URL(entry.link);
    const prefix = `/` + slug + `/`;
    const episodeSlug = url.hostname === 'podcasts.happyscribe.com' && url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length).replace(/\/$/, '') : '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(episodeSlug)) return null;
    return { showSlug: slug, episodeSlug };
  } catch { return null; }
}

function notePath(entry) {
  const id = dynamicEpisode(entry) ? entry.id : (isPodscribeEntry(entry) && videoIdFromUrl(entry.link));
  return id ? path.join(NOTES_DIR, `${id}.json`) : '';
}

function loadNote(entry) {
  const file = notePath(entry);
  if (!file) return null;
  try {
    const note = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dynamic = dynamicEpisode(entry);
    const identityMatches = dynamic
      ? note.sourceId === entry.sourceId && note.showSlug === dynamic.showSlug &&
        note.episodeSlug === dynamic.episodeSlug && note.sourceUrl === entry.link
      : note.videoId === videoIdFromUrl(entry.link) && note.sourceId === entry.sourceId &&
        note.videoUrl === entry.link && note.showSlug === SHOW_SLUGS[entry.sourceId];
    if (!identityMatches ||
        typeof note.transcript !== 'string' || note.transcript.length < 1000 ||
        note.transcriptHash !== transcriptHash(note.transcript)) return null;
    return note;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Podscribe note unavailable:', error.message);
    return null;
  }
}

function loadReady(entry) {
  const note = loadNote(entry);
  return note && note.digestVersion === DIGEST_VERSION &&
    note.digestTranscriptHash === note.transcriptHash &&
    String(note.transcriptDigest || '').length >= 100 ? note : null;
}

function loadGetnoteTranscript(entry) {
  const videoId = videoIdFromUrl(entry?.link);
  if (!videoId || !SHOW_SLUGS[entry?.sourceId]) return null;
  try {
    const note = JSON.parse(fs.readFileSync(path.join(GETNOTE_DIR, `${videoId}.json`), 'utf8'));
    if (note.videoId !== videoId || note.sourceId !== entry.sourceId || note.sourceUrl !== entry.link ||
        note.status !== 'transcript' || !/^\d+$/.test(String(note.noteId || '')) || typeof note.transcript !== 'string') return null;
    const text = stripGetnoteTimestamps(note.transcript);
    if (text.length < 1000 || text.length > 500000) return null;
    return { videoId, videoUrl: entry.link, sourceId: entry.sourceId, title: entry.title,
      showSlug: SHOW_SLUGS[entry.sourceId], sourceUrl: entry.link,
      transcript: text, transcriptHash: transcriptHash(text),
      transcriptProvider: 'getnote', transcriptPrivate: true,
      updatedAt: note.updatedAt || new Date().toISOString() };
  } catch { return null; }
}

function writeNote(entry, note) {
  const file = notePath(entry);
  if (!file) throw new Error('播客视频链接无效');
  fs.mkdirSync(NOTES_DIR, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(note), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function normalizedTitle(value) {
  return String(value || '').normalize('NFKC').toLowerCase()
    .replace(/&amp;/g, '&').replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function searchTitleForEntry(entry) {
  const title = String(entry?.title || '').trim();
  return entry?.sourceId === 'joerogan'
    ? title.replace(/^Joe Rogan Experience\s*/i, '').trim()
    : title;
}

function selectEpisode(entry, episodes) {
  const expected = normalizedTitle(searchTitleForEntry(entry));
  const matches = (episodes || []).filter(item => item.show_slug === SHOW_SLUGS[entry.sourceId] &&
    normalizedTitle(item.title) === expected);
  return matches.length === 1 ? matches[0] : null;
}

async function ensureTranscript(entry) {
  if (!isPodscribeEntry(entry)) {
    const error = new Error('不是支持的播客视频');
    error.statusCode = 400;
    throw error;
  }
  const saved = loadNote(entry);
  if (saved) {
    // The public transcript endpoint must never expose a private GetNote archive.
    if (saved.transcriptPrivate) {
      const error = new Error('这期的私人逐字稿仅用于生成改写，暂无公开源文稿');
      error.statusCode = 403;
      throw error;
    }
    return saved;
  }
  const dynamic = dynamicEpisode(entry);
  if (dynamic) {
    const data = await transcript(dynamic.showSlug, dynamic.episodeSlug);
    const text = data.transcript.segments.map(segment => segment.text.trim()).filter(Boolean).join('\n');
    if (text.length < 1000 || text.length > 500000) {
      const error = new Error('源文稿不完整或过长');
      error.statusCode = 422;
      throw error;
    }
    const note = {
      sourceId: entry.sourceId, title: entry.title, showSlug: dynamic.showSlug,
      episodeSlug: dynamic.episodeSlug, sourceUrl: entry.link,
      publishedAt: data.episode?.published_at || '', transcript: text,
      transcriptHash: transcriptHash(text), updatedAt: new Date().toISOString(),
    };
    writeNote(entry, note);
    return note;
  }
  const query = searchTitleForEntry(entry);
  if (!query) {
    const error = new Error('没有节目标题，不能安全匹配源文稿');
    error.statusCode = 409;
    throw error;
  }
  const results = await search(query);
  const match = selectEpisode(entry, results.episodes);
  if (!match) {
    const error = new Error('Podscribe 未找到与这期视频标题唯一对应的源文稿');
    error.statusCode = 404;
    throw error;
  }
  const data = await transcript(match.show_slug, match.episode_slug);
  const publishedTs = Date.parse(data.episode?.published_at || '') || 0;
  if (publishedTs && entry.publishedTs && Math.abs(publishedTs - Number(entry.publishedTs)) > 7 * 86400000) {
    const error = new Error('源文稿日期与视频相差过大，未自动关联');
    error.statusCode = 409;
    throw error;
  }
  const text = data.transcript.segments.map(segment => segment.text.trim()).filter(Boolean).join('\n');
  if (text.length < 1000 || text.length > 500000) {
    const error = new Error('源文稿不完整或过长');
    error.statusCode = 422;
    throw error;
  }
  const note = {
    videoId: videoIdFromUrl(entry.link), videoUrl: entry.link, sourceId: entry.sourceId,
    title: entry.title, showSlug: match.show_slug, episodeSlug: match.episode_slug,
    sourceUrl: data.episode?.url || match.url, publishedAt: data.episode?.published_at || '',
    transcript: text, transcriptHash: transcriptHash(text), updatedAt: new Date().toISOString(),
  };
  writeNote(entry, note);
  return note;
}

async function ensureReady(entry, condense) {
  const note = loadNote(entry) || loadGetnoteTranscript(entry) || await ensureTranscript(entry);
  const ready = loadReady(entry);
  if (ready) return ready;
  const digest = await condense(note.transcript, { title: entry.title });
  const updated = { ...note, transcriptDigest: digest, digestVersion: DIGEST_VERSION,
    digestTranscriptHash: note.transcriptHash, digestUpdatedAt: new Date().toISOString() };
  writeNote(entry, updated);
  return updated;
}

module.exports = { isPodscribeEntry, dynamicEpisode, loadNote, loadReady, loadGetnoteTranscript, ensureTranscript, ensureReady, selectEpisode, normalizedTitle, searchTitleForEntry };
