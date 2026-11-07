const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCE_IDS = new Set(['zhangxiaojun', '42zhangjing', 'latetalk', 'bannatie', 'nexttoken', 'crossing', 'aialchemy', '35huan', 'zhixing', 'mianji']);
const NOTES_DIR = process.env.QMREADER_PODCAST_NOTES_DIR || path.join(process.env.QMREADER_DATA_DIR || path.join(__dirname, '..', 'data'), 'podcast-notes');
const DIGEST_VERSION = 'transcript-chunks-v1';

function isTranscriptPodcast(entry) {
  return Boolean(entry && SOURCE_IDS.has(entry.sourceId));
}

function episodeIdFromLink(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== 'www.xiaoyuzhoufm.com') return '';
    return /^\/episode\/([a-f0-9]{24})$/.exec(url.pathname)?.[1] || '';
  } catch { return ''; }
}

function transcriptHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stripAudioTimestamps(value) {
  return String(value || '').replace(/\[\d{2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?\][ \t]*/g, '');
}

function loadTranscriptNote(entry) {
  if (!isTranscriptPodcast(entry)) return null;
  const episodeId = episodeIdFromLink(entry.link);
  if (!episodeId) return null;
  try {
    const note = JSON.parse(fs.readFileSync(path.join(NOTES_DIR, `${episodeId}.json`), 'utf8'));
    if (note.episodeId !== episodeId || note.sourceId !== entry.sourceId ||
        episodeIdFromLink(note.sourceUrl) !== episodeId ||
        String(note.transcript || '').length < 1000) return null;
    return note;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Podcast transcript unavailable:', error.message);
    return null;
  }
}

function loadReadyTranscript(entry) {
  const note = loadTranscriptNote(entry);
  if (!note || note.digestVersion !== DIGEST_VERSION ||
      note.digestTranscriptHash !== transcriptHash(note.transcript) ||
      String(note.transcriptDigest || '').length < 100) return null;
  return note;
}

function transcriptChunks(value, maxChars = 9000) {
  const lines = String(value || '').split(/\n+/).map(line => line.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const line of lines) {
    for (let offset = 0; offset < line.length; offset += maxChars) {
      const part = line.slice(offset, offset + maxChars);
      if (current && current.length + part.length + 1 > maxChars) {
        chunks.push(current);
        current = '';
      }
      current += `${current ? '\n' : ''}${part}`;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

module.exports = {
  DIGEST_VERSION, isTranscriptPodcast, episodeIdFromLink, transcriptHash, stripAudioTimestamps,
  loadTranscriptNote, loadReadyTranscript, transcriptChunks,
};
