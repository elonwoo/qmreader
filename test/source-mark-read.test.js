const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-source-mark-read-test-'));
process.env.QMREADER_DATA_DIR = testDataDir;

const store = require('../lib/store');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

function entry(id, sourceId, title) {
  return {
    id,
    sourceId,
    title,
    link: `https://example.com/${id}`,
    published: '2026-01-01T00:00:00Z',
    publishedTs: Date.parse('2026-01-01T00:00:00Z'),
    content: `<p>${title}</p>`,
  };
}

const reader = store.createUser({
  email: 'source-mark-read@example.com',
  password: 'mark-read-pass-123',
  displayName: 'Mark Read',
});

test('markSourceRead marks every live entry of one source and preserves stars and history', () => {
  store.upsertEntries([
    entry('mark-read-a1', 'mark-read-source-a', 'A1'),
    entry('mark-read-a2', 'mark-read-source-a', 'A2'),
    entry('mark-read-a3', 'mark-read-source-a', 'A3'),
    entry('mark-read-b1', 'mark-read-source-b', 'B1'),
  ]);
  store.softDeleteEntry('mark-read-a3');
  store.setUserEntryState(reader.id, 'mark-read-a2', { starred: true, viewed: true });

  const before = store.countEntries({ sourceIds: ['mark-read-source-a'], userId: reader.id });
  assert.deepEqual({ all: before.all, unread: before.unread }, { all: 2, unread: 2 });
  const starredBefore = store.getUserEntryState(reader.id, 'mark-read-a2');

  const marked = store.markSourceRead(reader.id, 'mark-read-source-a');
  assert.equal(marked, 2);

  const after = store.countEntries({ sourceIds: ['mark-read-source-a'], userId: reader.id });
  assert.deepEqual({ all: after.all, unread: after.unread }, { all: 2, unread: 0 });
  assert.equal(store.getUserEntryState(reader.id, 'mark-read-a1').read, true);
  assert.equal(store.getUserEntryState(reader.id, 'mark-read-a3').read, false, 'soft-deleted entries are not marked');

  const starredAfter = store.getUserEntryState(reader.id, 'mark-read-a2');
  assert.equal(starredAfter.read, true);
  assert.equal(starredAfter.starredAt, starredBefore.starredAt);
  assert.equal(starredAfter.viewedAt, starredBefore.viewedAt);

  const other = store.countEntries({ sourceIds: ['mark-read-source-b'], userId: reader.id });
  assert.deepEqual({ all: other.all, unread: other.unread }, { all: 1, unread: 1 });
});

test('marking the same source twice keeps the original read timestamp and star state', () => {
  store.upsertEntries([
    entry('mark-read-c1', 'mark-read-source-c', 'C1'),
    entry('mark-read-c2', 'mark-read-source-c', 'C2'),
  ]);
  store.setUserEntryState(reader.id, 'mark-read-c1', { starred: true, viewed: true });
  const starredBefore = store.getUserEntryState(reader.id, 'mark-read-c1');

  assert.equal(store.markSourceRead(reader.id, 'mark-read-source-c'), 2);
  const first = store.getUserEntryState(reader.id, 'mark-read-c1');
  assert.ok(first.readAt);
  assert.equal(first.starredAt, starredBefore.starredAt);
  assert.equal(first.viewedAt, starredBefore.viewedAt);

  store.markSourceRead(reader.id, 'mark-read-source-c');
  const second = store.getUserEntryState(reader.id, 'mark-read-c1');
  assert.equal(store.countEntries({ sourceIds: ['mark-read-source-c'], userId: reader.id }).unread, 0);
  assert.equal(second.readAt, first.readAt);
  assert.equal(second.starredAt, starredBefore.starredAt);
  assert.equal(second.viewedAt, starredBefore.viewedAt);
});

test('markSourceRead ignores missing users and unknown sources', () => {
  assert.equal(store.markSourceRead('', 'mark-read-source-a'), 0);
  assert.equal(store.markSourceRead(reader.id, ''), 0);
  assert.equal(store.markSourceRead(reader.id, 'mark-read-missing-source'), 0);
});
