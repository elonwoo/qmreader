(() => {
  const $ = id => document.getElementById(id);
  const app = $('app');
  if (!$('ps-entry-view')) return;
  // Checked against the transcript index on 2026-09-22.
  const featured = [
    ['Lex Fridman Podcast', 'lex-fridman-podcast-artificial-intelligence-ai', 'AI · 长访谈'],
    ['All-In', 'all-in-with-chamath-jason-sacks-friedberg', '科技 · 商业'],
    ['Acquired', 'acquired', '公司史 · 商业'],
    ['Pivot', 'pivot', '科技 · 商业'],
    ['Invest Like the Best', 'invest-like-the-best', '投资 · 创业'],
    ['Masters of Scale', 'masters-of-scale', '创业 · 增长'],
    ['The Diary Of A CEO', 'the-diary-of-a-ceo-with-steven-bartlett', '商业 · 人物'],
    ['The Prof G Pod', 'the-prof-g-pod-with-scott-galloway', '商业 · 科技'],
    ['Freakonomics Radio', 'freakonomics-radio', '经济 · 商业'],
    ['The Joe Rogan Experience', 'the-joe-rogan-experience', '科技 · 长访谈'],
  ];
  const showShortCodes = {
    'lex-fridman-podcast-artificial-intelligence-ai': 'Le',
    'all-in-with-chamath-jason-sacks-friedberg': 'AI',
    acquired: 'Aq',
    pivot: 'Pi',
    'invest-like-the-best': 'In',
    'masters-of-scale': 'Ma',
    'the-diary-of-a-ceo-with-steven-bartlett': 'DC',
    'the-prof-g-pod-with-scott-galloway': 'PG',
    'freakonomics-radio': 'Fr',
    'the-joe-rogan-experience': 'JR',
  };
  const state = { request: 0, episodeRequest: 0, show: '', page: 0, hasNext: false, selected: '', query: '', routeKey: null, timer: null };
  function node(tag, value, className = '') {
    const el = document.createElement(tag);
    el.textContent = value || '';
    if (className) el.className = className;
    return el;
  }
  function publishedLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^yesterday$/i.test(raw)) return '昨天';
    if (/^today$/i.test(raw)) return '今天';
    const match = raw.match(/^(over|almost|about)?\s*(\d+)\s*(day|week|month|year)s? ago$/i);
    if (!match) return raw;
    const unit = { day: '天', week: '周', month: '个月', year: '年' }[match[3].toLowerCase()];
    const prefix = { over: '', almost: '近 ', about: '约 ' }[match[1]?.toLowerCase()] || '';
    const suffix = match[1]?.toLowerCase() === 'over' ? '多' : '';
    return `${prefix}${match[2]} ${unit}${suffix}前`;
  }
  function episodeMeta(episode) {
    const exact = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(String(episode.published_at || ''))
      ? new Date(episode.published_at) : null;
    const date = exact && !Number.isNaN(exact.getTime())
      ? exact.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
      : publishedLabel(episode.published_relative || episode.published_at);
    const parts = [date];
    if (Number.isSafeInteger(episode.views) && episode.views >= 0) parts.push(`浏览 ${episode.views.toLocaleString()}`);
    if (Number.isSafeInteger(episode.duration_seconds) && episode.duration_seconds > 0) parts.push(`${Math.round(episode.duration_seconds / 60)} 分钟`);
    if (Number.isSafeInteger(episode.word_count) && episode.word_count > 0) parts.push(`${episode.word_count.toLocaleString()} 词`);
    return parts.filter(Boolean).join(' · ') || '查看源文稿';
  }
  function status(message = '', kind = '') {
    $('ps-status').replaceChildren(document.createTextNode(message));
    $('ps-status').dataset.kind = kind;
  }
  function retry(message, action) {
    status(message + ' ', 'error');
    const button = node('button', '重试', 'ghost-btn');
    button.type = 'button';
    button.addEventListener('click', action, { once: true });
    $('ps-status').append(button);
  }
  function errorText(error, target) {
    if (error?.status === 429) return '请求太频繁，请稍后再试。';
    if (error?.status === 404) return target + '暂无可用文稿。';
    return target + '暂时失败，请检查网络后重试。';
  }
  async function api(path, options = {}) {
    let response;
    try { response = await fetch(path, { credentials: 'same-origin', ...options }); }
    catch { throw new Error('network'); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) { const error = new Error(data.error || 'service'); error.status = response.status; throw error; }
    return data;
  }
  function setRoute({ query = state.query, show = '', episode = '' } = {}, replace = false) {
    const url = new URL('/podscribe', location.origin);
    if (query) url.searchParams.set('q', query);
    if (show) url.searchParams.set('show', show);
    if (episode) url.searchParams.set('episode', episode);
    if (url.href !== location.href) history[replace ? 'replaceState' : 'pushState']({ workspacePage: 'podscribe' }, '', url);
    state.routeKey = [query, show, episode].join('|');
  }
  function showList() { app.classList.remove('ps-reading'); $('ps-back').classList.add('hidden'); }
  function showDetail() {
    app.classList.add('ps-reading');
    $('ps-back').classList.remove('hidden');
    $('reader-pane').scrollTop = 0;
  }
  function clearReading(message = '选择中间列表中的单集，阅读源文稿。') {
    state.selected = '';
    ++state.episodeRequest;
    $('ps-article').classList.add('hidden');
    $('ps-reading-empty').textContent = message;
    $('ps-reading-empty').classList.remove('hidden');
    showList();
  }
  function group(target, label) { target.append(node('h3', label, 'ps-group-heading')); }
  function addShow(show, target = $('ps-podcasts'), subtitle = '') {
    const sidebar = target === $('ps-shows');
    const button = node('button', '', sidebar ? 'ps-show-item' : 'ps-result');
    button.type = 'button';
    button.dataset.slug = show.slug;
    if (sidebar) {
      button.setAttribute('aria-label', show.name || show.slug);
      button.title = show.name || show.slug;
    }
    button.append(node('strong', show.name || show.slug), node('small', subtitle || `${show.episodes_with_transcripts || 0} 集有文稿`));
    if (sidebar) button.append(node('span', showShortCodes[show.slug] || (show.name || show.slug).slice(0, 2), 'ps-show-short'));
    button.addEventListener('click', () => openShow(show.slug, 1, { updateRoute: true, label: show.name, selectedButton: button }));
    target.append(button);
  }
  function addEpisode(episode) {
    if (!episode?.show_slug || !episode?.episode_slug) return;
    const button = node('button', '', 'ps-result');
    button.type = 'button';
    button.append(node('strong', episode.title || episode.episode_slug), node('small', episodeMeta(episode)));
    button.addEventListener('click', () => openEpisode(episode, button, { updateRoute: true }));
    $('ps-episodes').append(button);
  }
  function renderFeatured() {
    state.show = '';
    state.hasNext = false;
    $('ps-more').classList.add('hidden');
    $('ps-shows').replaceChildren();
    $('ps-podcasts').replaceChildren();
    $('ps-episodes').replaceChildren();
    $('ps-empty').classList.remove('hidden');
    $('ps-list-title').textContent = '播客单集';
    $('ps-count').textContent = '';
    featured.forEach(([name, slug, subtitle]) => addShow({ name, slug }, $('ps-shows'), subtitle));
    status();
  }
  async function search(query, { updateRoute = true } = {}) {
    const q = String(query || '').trim();
    state.query = q;
    $('ps-query').value = q;
    if (updateRoute) setRoute({ query: q });
    clearReading();
    if (!q) {
      ++state.request;
      renderFeatured();
      openShow(featured[0][1], 1, { updateRoute: false, label: featured[0][0], selectedButton: $('ps-shows').querySelector('.ps-show-item') });
      return;
    }
    const request = ++state.request;
    $('ps-more').classList.add('hidden');
    status('正在搜索…');
    try {
      const data = await api(`/api/podscribe/search?q=${encodeURIComponent(q)}`);
      if (request !== state.request) return;
      const shows = Array.isArray(data.podcasts) ? data.podcasts : [];
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      $('ps-podcasts').replaceChildren();
      $('ps-episodes').replaceChildren();
      document.querySelectorAll('#ps-shows .ps-show-item.selected').forEach(item => item.classList.remove('selected'));
      $('ps-list-title').textContent = '搜索结果';
      $('ps-empty').classList.toggle('hidden', Boolean(shows.length || episodes.length));
      if (!shows.length && !episodes.length) $('ps-empty').textContent = `没有找到“${q}”。试试节目名、人名或更短的关键词。`;
      if (shows.length) { group($('ps-podcasts'), '节目'); shows.forEach(show => addShow(show)); }
      if (episodes.length) { group($('ps-episodes'), '单集'); episodes.forEach(addEpisode); }
      $('ps-count').textContent = `${shows.length + episodes.length} 条`;
      status();
    } catch (error) {
      if (request === state.request) {
        const needle = q.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
        const matches = featured.filter(([name, slug]) => [name, slug].some(value => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '').includes(needle)));
        if (matches.length) {
          $('ps-podcasts').replaceChildren();
          $('ps-episodes').replaceChildren();
          group($('ps-podcasts'), '精选节目中匹配');
          matches.forEach(([name, slug, subtitle]) => addShow({ name, slug }, $('ps-podcasts'), subtitle));
          $('ps-empty').classList.add('hidden');
          $('ps-count').textContent = `${matches.length} 档`;
        }
        retry(matches.length ? '在线搜索暂时不可用，先显示精选节目中的匹配项。' : errorText(error, '搜索'), () => search(q, { updateRoute: false }));
      }
    }
  }
  async function openShow(slug, pageNumber = 1, { updateRoute = true, label = '', selectedButton = null } = {}) {
    const request = ++state.request;
    if (pageNumber === 1) {
      state.show = slug;
      state.page = 0;
      state.hasNext = false;
      $('ps-episodes').replaceChildren();
      $('ps-more').classList.add('hidden');
      clearReading();
      $('ps-podcasts').replaceChildren();
      $('ps-empty').classList.remove('hidden');
      $('ps-empty').textContent = `正在获取 ${label || '节目'} 的单集…`;
      $('ps-list-title').textContent = label || featured.find(item => item[1] === slug)?.[0] || '播客单集';
      if (selectedButton) {
        document.querySelectorAll('#ps-shows .ps-show-item.selected, #ps-podcasts .ps-result.selected').forEach(item => item.classList.remove('selected'));
        selectedButton.classList.add('selected');
      }
      if (updateRoute) {
        state.query = '';
        $('ps-query').value = '';
        setRoute({ query: '', show: slug });
      }
    }
    status('正在加载单集…');
    try {
      const data = await api(`/api/podscribe/podcasts/${encodeURIComponent(slug)}/episodes?page=${pageNumber}`);
      if (request !== state.request) return;
      const episodes = Array.isArray(data.episodes) ? data.episodes : [];
      episodes.forEach(addEpisode);
      state.page = pageNumber;
      state.hasNext = Boolean(data.pagination?.has_next);
      $('ps-more').classList.toggle('hidden', !state.hasNext);
      const episodeCount = $('ps-episodes').querySelectorAll('.ps-result').length;
      $('ps-count').textContent = state.hasNext ? `已加载 ${episodeCount} 集` : `共 ${episodeCount} 集`;
      $('ps-empty').classList.toggle('hidden', Boolean($('ps-episodes').querySelector('.ps-result')));
      if (!episodes.length && pageNumber === 1) $('ps-empty').textContent = '这档节目目前没有可打开的单集文稿。';
      status();
    } catch (error) {
      if (request === state.request) {
        $('ps-empty').textContent = errorText(error, '获取单集');
        retry(errorText(error, '获取单集'), () => openShow(slug, pageNumber, { updateRoute: false, label }));
      }
    }
  }
  function selectTab(name) {
    const source = name !== 'rewrite';
    $('ps-source-panel').classList.toggle('hidden', !source);
    $('ps-rewrite-panel').classList.toggle('hidden', source);
    $('ps-tab-source').classList.toggle('active', source);
    $('ps-tab-rewrite').classList.toggle('active', !source);
    $('ps-tab-source').setAttribute('aria-selected', String(source));
    $('ps-tab-rewrite').setAttribute('aria-selected', String(!source));
  }
  async function openEpisode(episode, button, { updateRoute = true } = {}) {
    const selected = `${episode.show_slug}/${episode.episode_slug}`;
    const request = ++state.episodeRequest;
    state.selected = selected;
    state.show = episode.show_slug;
    document.querySelectorAll('#ps-episodes .ps-result.selected').forEach(item => item.classList.remove('selected'));
    button?.classList.add('selected');
    if (updateRoute) setRoute({ show: episode.show_slug, episode: episode.episode_slug });
    showDetail();
    $('ps-article').classList.add('hidden');
    $('ps-reading-empty').textContent = '正在获取完整源文稿…';
    $('ps-reading-empty').classList.remove('hidden');
    status('正在获取源文稿…');
    try {
      const data = await api(`/api/podscribe/episodes/${encodeURIComponent(episode.show_slug)}/${encodeURIComponent(episode.episode_slug)}/transcript`);
      if (request !== state.episodeRequest) return;
      $('ps-show-name').textContent = data.podcast?.name || '';
      $('ps-title').textContent = data.episode?.title || episode.title || '';
      $('ps-source-link').href = data.episode?.url || '#';
      const segments = data.transcript?.segments || [];
      const detailEpisode = { ...(data.episode || {}), ...episode };
      const detailMeta = episodeMeta(detailEpisode);
      const wordCount = Number(data.transcript?.wordCount || segments.length);
      $('ps-word-count').textContent = [detailMeta,
        detailEpisode.word_count ? '' : `${wordCount.toLocaleString()} 词`,
        data.transcript?.language || '原文'].filter(Boolean).join(' · ');
      const fragment = document.createDocumentFragment();
      segments.forEach(segment => { if (segment.text) fragment.append(node('p', segment.text)); });
      $('ps-source-text').replaceChildren(fragment);
      $('ps-rewrite-text').replaceChildren();
      $('ps-rewrite').classList.remove('hidden');
      $('ps-article').classList.remove('hidden');
      $('ps-reading-empty').classList.add('hidden');
      selectTab('source');
      status();
    } catch (error) {
      if (request === state.episodeRequest) {
        $('ps-reading-empty').textContent = errorText(error, '获取源文稿');
        retry(errorText(error, '获取源文稿'), () => openEpisode(episode, button, { updateRoute: false }));
      }
    }
  }
  async function rewrite() {
    if (!state.selected) return;
    const selected = state.selected;
    const button = $('ps-rewrite');
    button.disabled = true;
    button.textContent = '正在处理文稿…';
    status('乔木转写生成中，长播客可能需要几分钟。');
    try {
      let data = await api(`/api/podscribe/episodes/${selected}/rewrite`, { method: 'POST' });
      if (data.jobId) {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (state.selected !== selected) return;
          await new Promise(resolve => setTimeout(resolve, 3000));
          const job = await api(`/api/podscribe/rewrite-jobs/${encodeURIComponent(data.jobId)}`);
          if (job.status === 'failed') throw new Error(job.error || '转写失败');
          if (job.status === 'complete') { data = job.result; break; }
        }
        if (!data.rewrite) throw new Error('转写仍在后台处理');
      }
      if (state.selected !== selected) return;
      $('ps-rewrite-text').textContent = data.rewrite.body;
      button.classList.add('hidden');
      status();
    } catch (error) {
      if (state.selected === selected) status(error.status === 401 || error.status === 403 ? '请先登录管理员账号，再生成乔木转写。' : errorText(error, '乔木转写'), 'error');
    } finally { button.disabled = false; button.textContent = '生成乔木转写'; }
  }
  function restoreFromUrl() {
    if (!/^\/podscribe\/?$/.test(location.pathname)) return;
    const params = new URLSearchParams(location.search);
    const q = String(params.get('q') || '').trim();
    const show = String(params.get('show') || '').trim();
    const episode = String(params.get('episode') || '').trim();
    const key = [q, show, episode].join('|');
    if (state.routeKey === key) return;
    state.routeKey = key;
    state.query = q;
    $('ps-query').value = q;
    renderFeatured();
    if (q) search(q, { updateRoute: false });
    if (show || !q) {
      const slug = show || featured[0][1];
      const button = [...$('ps-shows').querySelectorAll('.ps-show-item')].find(item => item.dataset.slug === slug);
      openShow(slug, 1, { updateRoute: false, label: featured.find(candidate => candidate[1] === slug)?.[0] || '', selectedButton: button });
    }
    if (show && episode) openEpisode({ show_slug: show, episode_slug: episode }, null, { updateRoute: false });
  }
  $('ps-search-form').addEventListener('submit', event => { event.preventDefault(); clearTimeout(state.timer); search($('ps-query').value); });
  $('ps-query').addEventListener('input', () => {
    clearTimeout(state.timer);
    const q = $('ps-query').value.trim();
    if (!q) { search(''); return; }
    if (q.length >= 2) state.timer = setTimeout(() => search(q), 550);
  });
  $('ps-more').addEventListener('click', () => { if (state.show && state.hasNext) openShow(state.show, state.page + 1, { updateRoute: false }); });
  $('ps-tab-source').addEventListener('click', () => selectTab('source'));
  $('ps-tab-rewrite').addEventListener('click', () => selectTab('rewrite'));
  $('ps-rewrite').addEventListener('click', rewrite);
  $('ps-back').addEventListener('click', () => { showList(); (document.querySelector('#ps-episodes .ps-result.selected') || $('ps-query')).focus(); });
  window.qmPodscribe = { restoreFromUrl };
  if (/^\/podscribe\/?$/.test(location.pathname)) restoreFromUrl();
})();
