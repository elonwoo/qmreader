const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-rss-subscribe-test-'));
process.env.QMREADER_DATA_DIR = testDataDir;

const sources = require('../lib/sources');
const store = require('../lib/store');
const fetcher = require('../lib/fetcher');

const rssFile = path.join(testDataDir, 'rss-sources.json');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

function feed(title = '') {
  return async () => ({ isFeed: true, title, itemCount: 1 });
}

function storedRecords() {
  try { return JSON.parse(fs.readFileSync(rssFile, 'utf8')); }
  catch { return []; }
}

test('a valid feed URL registers an article source with the required flags', async () => {
  const [result] = await sources.subscribeRssSources(
    [{ url: 'https://example.com/rss/valid.xml' }],
    { fetchFeed: feed('示例 Feed 标题') },
  );

  assert.equal(result.ok, true);
  assert.equal(result.added, true);
  const source = result.source;
  assert.match(source.id, /^rss-[0-9a-f]{12}$/);
  assert.equal(source.name, '示例 Feed 标题');
  assert.equal(source.category, 'article');
  assert.equal(source.customRss, true);
  assert.equal(source.optIn, false);
  assert.equal(source.autoRewrite, false);
  assert.equal(source.limit, 20);
  assert.equal(source.refreshIntervalMs, 60 * 60 * 1000);
  assert.equal(source.refreshPriority, 1);
  assert.equal(source.refreshCost, 1);
  assert.ok(sources.SOURCES.some(item => item.id === source.id));
  assert.ok(storedRecords().some(record => record.url === 'https://example.com/rss/valid.xml'));
});

test('invalid URLs and non-feed responses are rejected', async () => {
  const results = await sources.subscribeRssSources([
    { url: 'not a url' },
    { url: 'ftp://example.com/feed.xml' },
    { url: 'https://example.com/not-a-feed.html' },
  ], { fetchFeed: async () => ({ isFeed: false, title: '', itemCount: 0 }) });

  assert.deepEqual(results.map(result => result.ok), [false, false, false]);
  assert.match(results[0].error, /无效/);
  assert.match(results[1].error, /http/);
  assert.match(results[2].error, /不是 RSS/);
  assert.equal(sources.SOURCES.some(item => item.feeds?.includes('https://example.com/not-a-feed.html')), false);
  assert.equal(sources.normalizeRssSourceUrl('https://example.com/feed.xml#section'), 'https://example.com/feed.xml');
});

test('feed document detection accepts RSS, Atom, RDF and JSON Feed but not HTML', () => {
  const { looksLikeFeedDocument, parseJsonFeedDocument } = fetcher.__test;
  assert.equal(looksLikeFeedDocument('<html><body>hello</body></html>'), false);
  assert.equal(looksLikeFeedDocument('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>'), true);
  assert.equal(looksLikeFeedDocument('<feed xmlns="http://www.w3.org/2005/Atom"></feed>'), true);
  assert.equal(looksLikeFeedDocument('<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"></rdf:RDF>'), true);
  assert.equal(looksLikeFeedDocument('{"version":"https://jsonfeed.org/version/1.1","items":[]}'), true);

  const document = parseJsonFeedDocument(JSON.stringify({
    version: 'https://jsonfeed.org/version/1.1',
    title: 'JSON Feed',
    items: [{
      id: 'one',
      url: 'https://example.com/posts/one',
      title: '第一篇',
      content_text: '正文内容',
      date_published: '2026-01-02T03:04:05Z',
    }],
  }));
  assert.equal(document.title, 'JSON Feed');
  assert.equal(document.items[0].link, 'https://example.com/posts/one');
  assert.equal(document.items[0].guid, 'one');
  assert.match(document.items[0].content, /正文内容/);
  assert.equal(document.items[0].isoDate, '2026-01-02T03:04:05Z');
});

test('registering the same URL twice is idempotent and keeps one source', async () => {
  const url = 'https://example.com/rss/idempotent.xml';
  const [first] = await sources.subscribeRssSources([{ url, name: '第一次' }], { fetchFeed: feed('源标题') });
  const [second] = await sources.subscribeRssSources([{ url, name: '第二次' }], { fetchFeed: feed('源标题') });

  assert.equal(first.added, true);
  assert.equal(second.added, false);
  assert.equal(second.source.id, first.source.id);
  assert.equal(sources.SOURCES.filter(source => source.id === first.source.id).length, 1);
  assert.equal(storedRecords().filter(record => record.url === url).length, 1);
});

test('batch subscription reports per-URL results and keeps partial successes', async () => {
  const results = await sources.subscribeRssSources([
    { url: 'https://example.com/rss/batch-ok.xml' },
    { url: 'https://example.com/rss/batch-bad.xml' },
    { url: 'https://example.com/rss/batch-ok-2.xml' },
  ], {
    fetchFeed: async url => {
      if (url.includes('batch-bad')) throw new Error('Status code 404');
      return { isFeed: true, title: '批量源', itemCount: 2 };
    },
  });

  assert.deepEqual(results.map(result => result.ok), [true, false, true]);
  assert.match(results[1].error, /404/);
  assert.equal(sources.SOURCES.some(source => source.id === results[0].source.id), true);
  assert.equal(sources.SOURCES.some(source => source.id === results[2].source.id), true);
});

test('deleting a custom source removes it and soft-deletes its entries and rewrite jobs', async () => {
  const [subscribed] = await sources.subscribeRssSources(
    [{ url: 'https://example.com/rss/delete-me.xml', name: '待删除源' }],
    { fetchFeed: feed('待删除') },
  );
  const source = subscribed.source;
  store.upsertEntries([
    {
      id: 'rss-delete-entry-1',
      sourceId: source.id,
      title: '文章一',
      link: 'https://example.com/rss/1',
      published: '2026-01-01T00:00:00Z',
      publishedTs: Date.parse('2026-01-01T00:00:00Z'),
      content: '<p>正文一</p>',
    },
    {
      id: 'rss-delete-entry-2',
      sourceId: source.id,
      title: '文章二',
      link: 'https://example.com/rss/2',
      published: '2026-01-02T00:00:00Z',
      publishedTs: Date.parse('2026-01-02T00:00:00Z'),
      content: '<p>正文二</p>',
    },
  ]);
  store.enqueueRewriteJob('rss-delete-entry-1', { sourceId: source.id, contentHash: 'hash-1' });
  assert.equal(store.listRewriteJobs({ limit: 500 }).filter(job => job.sourceId === source.id).length, 1);
  fetcher.setEnabled(source.id, false);

  const result = sources.deleteRssSource(source.id, { store });
  fetcher.forgetSource(source.id);
  fetcher.flushDisk();

  assert.equal(result.entries, 2);
  assert.equal(result.rewriteJobs, 1);
  assert.equal(sources.SOURCES.some(item => item.id === source.id), false);
  assert.equal(store.isEntryDeleted('rss-delete-entry-1'), true);
  assert.equal(store.isEntryDeleted('rss-delete-entry-2'), true);
  assert.equal(store.listRewriteJobs({ limit: 500 }).filter(job => job.sourceId === source.id).length, 0);
  assert.equal(storedRecords().some(record => record.url === 'https://example.com/rss/delete-me.xml'), false);
  const diskState = JSON.parse(fs.readFileSync(path.join(testDataDir, 'state.json'), 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(diskState, source.id), false);
});

test('deleting a built-in source is refused', () => {
  assert.throws(
    () => sources.deleteRssSource('qiaomu-blog', { store }),
    error => error.statusCode === 400 && /只能删除/.test(error.message),
  );
  assert.equal(sources.SOURCES.some(source => source.id === 'qiaomu-blog'), true);
  assert.throws(
    () => sources.deleteRssSource('missing-rss-source', { store }),
    error => error.statusCode === 404,
  );
});
