// ==UserScript==
// @name         智慧树：观看后自动续播（不跳过）
// @namespace    local.zhihuishu.watched-autonext
// @version      1.9.3
// @match        https://fusioncourseh5.zhihuishu.com/*
// @noframes
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // A script manager may reinject after a client-side route change.  Keep one
  // controller in the top-level course page rather than accumulating timers.
  const INSTANCE_KEY = '__zhsWatchedAutoNextV101__';
  if (window[INSTANCE_KEY]) return;
  window[INSTANCE_KEY] = true;

  const STORAGE_KEY = 'zhs-watched-auto-next-settings-v1';
  const DEFAULTS = { enabled: false, chapters: true, delay: 0, speed: '1.0', minimized: false, replayAll: false, muted: false, position: null };
  const state = {
    settings: { ...DEFAULTS, ...readSettings() },
    watchedVideo: null,
    playTicket: 0,
    navigationTicket: 0,
    startedMedia: null,
    playbackPending: false,
    navigationOrigin: null,
    mediaVersions: new WeakMap(),
    muteBeforeOverride: new WeakMap(),
    mutedMedia: new Set(),
    lastStatus: null,
    ending: false,
    countdownTimer: 0,
    pollTimer: 0,
    panel: null,
    status: null,
    toggle: null,
    chapterToggle: null,
    minimizeButton: null,
  };

  function readSettings() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  }

  function visible(element) {
    if (!(element instanceof HTMLElement)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0 && rect.width > 3 && rect.height > 3;
  }

  function textOf(element) {
    return (element.getAttribute('aria-label') || element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ').trim();
  }

  function setStatus(message, kind = '') {
    if (!state.status) return;
    state.lastStatus = { message, kind };
    state.status.textContent = message;
    state.status.dataset.kind = kind;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }

  function renderPanel() {
    state.panel?.remove();
    const panel = document.createElement('section');
    panel.id = 'zhs-watched-auto-next-panel';
    panel.innerHTML = `
      <header>
        <strong title="拖动标题栏可移动">观看后自动续播 · 拖动</strong>
        <button class="zhs-icon" data-action="minimize" title="收起或展开">${state.settings.minimized ? '□' : '—'}</button>
      </header>
      <div class="zhs-content" ${state.settings.minimized ? 'hidden' : ''}>
        <p class="zhs-status">等待视频加载；开启自动续播后将播放当前视频。</p>
        <label><input type="checkbox" data-action="enabled" ${state.settings.enabled ? 'checked' : ''}> 自动播放并在视频结束后继续</label>
        <label><input type="checkbox" data-action="chapters" ${state.settings.chapters ? 'checked' : ''}> 当前页无下一视频时尝试下一章节</label>
        <label><input type="checkbox" data-action="replayAll" ${state.settings.replayAll ? 'checked' : ''}> 全部从头播放（含已完成视频）</label>
        <label><input type="checkbox" data-action="muted" ${state.settings.muted ? 'checked' : ''}> 静音当前课程页面</label>
        <label class="zhs-speed">播放倍速 <select data-action="speed">
          <option value="1.0" ${state.settings.speed === '1.0' ? 'selected' : ''}>1.0×</option>
          <option value="1.25" ${state.settings.speed === '1.25' ? 'selected' : ''}>1.25×</option>
          <option value="1.5" ${state.settings.speed === '1.5' ? 'selected' : ''}>1.5×</option>
          <option value="8" ${state.settings.speed === '8.0' ? 'selected' : ''}>8.0×beta</option>
        </select></label>
        <label class="zhs-delay">等待 <input type="number" data-action="delay" min="0" max="30" value="${escapeHtml(state.settings.delay)}"> 秒</label>
        <button class="zhs-cancel" data-action="cancel" hidden>取消本次跳转</button>
      </div>`;
    document.body.append(panel);
    state.panel = panel;
    state.status = panel.querySelector('.zhs-status');
    state.toggle = panel.querySelector('[data-action="enabled"]');
    state.chapterToggle = panel.querySelector('[data-action="chapters"]');
    state.minimizeButton = panel.querySelector('[data-action="minimize"]');
    if (state.lastStatus) setStatus(state.lastStatus.message, state.lastStatus.kind);
    panel.querySelector('[data-action="cancel"]').hidden = !state.ending;
    restorePanelPosition();
    enablePanelDragging(panel);


    panel.addEventListener('change', event => {
      const action = event.target?.dataset?.action;
      if (action === 'enabled') state.settings.enabled = event.target.checked;
      if (action === 'chapters') state.settings.chapters = event.target.checked;
      if (action === 'speed') state.settings.speed = event.target.value;
      if (action === 'muted') {
        state.settings.muted = event.target.checked;
        applyMuteSettings();
      }
      if (action === 'delay') state.settings.delay = Math.max(Math.min(30, Number(event.target.value)), DEFAULTS.delay);
      if (action === 'replayAll') {
        state.settings.replayAll = event.target.checked;
        if (state.settings.replayAll) {
          state.settings.enabled = true;
          state.toggle.checked = true;
        }
        state.startedMedia = null;
      }
      if (action === 'enabled' || action === 'replayAll') {
        state.navigationTicket += 1;
        state.navigationOrigin = null;
        state.playTicket += 1;
        state.playbackPending = false;
        cancelCountdown();
        if (state.settings.enabled) {
          state.startedMedia = null;
          bindCurrentVideo();
        }
      }
      saveSettings();
      if (action === 'enabled') setStatus(state.settings.enabled ? '已开启：正在播放当前视频，结束后按顺序继续。' : '已暂停自动续播。');
      if (action === 'speed') {
        applyPreferredSpeed(true);
      }
    });
    panel.addEventListener('click', event => {
      const action = event.target?.dataset?.action;
      if (action === 'cancel') cancelCountdown('已取消本次跳转；下一段结束时仍会再次提示。');
      if (action === 'minimize') {
        state.settings.minimized = !state.settings.minimized;
        saveSettings();
        renderPanel();
      }
    });
  }

  function clampPanelPosition(left, top) {
    const panel = state.panel;
    if (!panel) return;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left = `${Math.max(0, Math.min(left, window.innerWidth - panel.offsetWidth))}px`;
    panel.style.top = `${Math.max(0, Math.min(top, window.innerHeight - panel.offsetHeight))}px`;
  }

  function restorePanelPosition() {
    const position = state.settings.position;
    if (position && Number.isFinite(position.left) && Number.isFinite(position.top)) {
      clampPanelPosition(position.left, position.top);
    }
  }

  function enablePanelDragging(panel) {
    const header = panel.querySelector('header');
    let drag = null;
    header.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button,input,select,a')) return;
      const rect = panel.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      header.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    header.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      clampPanelPosition(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    });
    const finish = event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      const rect = panel.getBoundingClientRect();
      state.settings.position = { left: rect.left, top: rect.top };
      saveSettings();
    };
    header.addEventListener('pointerup', finish);
    header.addEventListener('pointercancel', finish);
    header.addEventListener('lostpointercapture', finish);
  }

  function addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #zhs-watched-auto-next-panel{position:fixed;z-index:2147483647;right:18px;bottom:18px;width:276px;max-width:calc(100vw - 12px);max-height:calc(100vh - 12px);overflow-y:auto;box-sizing:border-box;color:#eef5ff;background:#121a27eF;border:1px solid #5275a5;border-radius:10px;box-shadow:0 10px 28px #0008;font:14px/1.45 system-ui,"Microsoft YaHei",sans-serif}
      #zhs-watched-auto-next-panel header{display:flex;align-items:center;justify-content:space-between;padding:9px 10px;background:#1a2a40;color:#fff;cursor:move;user-select:none;touch-action:none}
      #zhs-watched-auto-next-panel .zhs-icon{border:0;background:transparent;color:#fff;font-size:18px;cursor:pointer;line-height:1}
      #zhs-watched-auto-next-panel .zhs-content{padding:10px;display:grid;gap:8px}#zhs-watched-auto-next-panel [hidden]{display:none!important}.zhs-status{margin:0;padding:7px;background:#0c1320;border-radius:6px;color:#cfe5ff}.zhs-status[data-kind="error"]{color:#ffb6b6}.zhs-status[data-kind="go"]{color:#b9ffc8}
      #zhs-watched-auto-next-panel label{display:flex;align-items:center;gap:7px;cursor:pointer}.zhs-delay input,#zhs-watched-auto-next-panel select{width:64px;padding:2px 4px;border:1px solid #6580a5;border-radius:4px;background:#0c1320;color:#fff}.zhs-cancel{padding:6px 8px;border:1px solid #7594bd;border-radius:5px;color:#fff;background:#284e7d;cursor:pointer}#zhs-watched-auto-next-panel small{color:#b7c4d7}
    `;
    document.head.append(style);
  }

  function getActiveVideo() {
    const videos = [...document.querySelectorAll('video')].filter(visible);
    return videos.find(video => !video.paused && !video.ended) || videos.find(video => video.readyState > 0) || videos[0] || null;
  }

  function applyPreferredSpeed(reportFailure = false) {
    const rate = String(state.settings.speed || '1.0');
    const nativeTab = document.querySelector(`.speedBox .speedTab[rate="${rate}"]`);
    if (nativeTab) {
      if (!nativeTab.classList.contains('active')) {
        const box = nativeTab.closest('.speedBox');
        // Open the platform menu first; direct tab click then uses its normal
        // Vue handler rather than modifying the player implementation.
        box?.querySelector(':scope > span')?.click();
        window.setTimeout(() => document.querySelector(`.speedBox .speedTab[rate="${rate}"]`)?.click(), 40);
      }
      return true;
    }

    // Fallback for a standard HTML5 player rendered without the custom menu.
    const video = getActiveVideo();
    if (video) {
      video.playbackRate = Number(rate);
      return true;
    }
    if (reportFailure) setStatus('尚未发现倍速控件；将在播放器加载后自动应用。', 'error');
    return false;
  }

  function mediaIdentity(video) {
    const chapter = document.querySelector('li.video.activeNode');
    const resource = document.querySelector('.resources-list .resources-item.active');
    return JSON.stringify([video.currentSrc || video.getAttribute('src') || '',
      chapter ? [...document.querySelectorAll('li.video')].indexOf(chapter) : -1,
      resource ? textOf(resource.querySelector('.file-name') || resource) : '',
      resource ? [...document.querySelectorAll('.resources-list .resources-item')].indexOf(resource) : -1,
      state.mediaVersions.get(video) || 0]);
  }

  function applyMuteToMedia(media) {
    if (state.settings.muted) {
      if (!state.muteBeforeOverride.has(media)) {
        state.muteBeforeOverride.set(media, media.muted);
        state.mutedMedia.add(media);
      }
      if (!media.muted) media.muted = true;
    } else if (state.muteBeforeOverride.has(media)) {
      const previous = state.muteBeforeOverride.get(media);
      state.muteBeforeOverride.delete(media);
      state.mutedMedia.delete(media);
      if (media.muted !== previous) media.muted = previous;
    }
  }

  function applyMuteSettings() {
    // Restore even a detached player when the user switches the option off.
    if (!state.settings.muted) {
      for (const media of [...state.mutedMedia]) applyMuteToMedia(media);
    }
    for (const media of document.querySelectorAll('video,audio')) applyMuteToMedia(media);
  }

  async function playCurrentVideo(video) {
    if (!state.settings.enabled || state.playbackPending || video.readyState < 1) return;
    const origin = state.navigationOrigin;
    if (origin && video === origin.video && video.currentSrc === origin.src &&
        (state.mediaVersions.get(video) || 0) === origin.version) return;
    state.navigationOrigin = null;
    const key = mediaIdentity(video);
    if (state.startedMedia?.video === video && state.startedMedia.key === key) return;
    const ticket = ++state.playTicket;
    const fromBeginning = state.settings.replayAll;
    const valid = () => ticket === state.playTicket && state.settings.enabled && state.settings.replayAll === fromBeginning &&
      video === getActiveVideo() && mediaIdentity(video) === key;
    state.playbackPending = true;
    state.startedMedia = { video, key };
    try {
      applyMuteToMedia(video);
      if (fromBeginning) {
        video.pause();
        video.currentTime = 0;
      }
      await sleep(fromBeginning ? 150 : 0);
      if (!valid()) return;
      // Apply zero once more before play, after the player's resume handler.
      if (fromBeginning) video.currentTime = 0;
      applyPreferredSpeed();
      await video.play();
      if (valid()) setStatus(fromBeginning ? '全部从头播放：当前视频已从开头开始，结束后按顺序续播。' : '已从播放器默认位置开始播放，结束后向后查找下一未完成视频。', 'go');
    } catch {
      if (valid()) setStatus(fromBeginning ? '已定位到开头；浏览器或播放器阻止自动播放，请点击视频播放按钮。' : '浏览器或播放器阻止自动播放，请点击视频播放按钮；播放位置未重置。', 'error');
    } finally {
      if (ticket === state.playTicket) state.playbackPending = false;
    }
  }

  function bindCurrentVideo() {
    applyMuteSettings();
    const video = getActiveVideo();
    if (!video) {
      setStatus('等待视频播放器加载…');
      return;
    }
    if (state.watchedVideo === video) {
      applyPreferredSpeed();
      playCurrentVideo(video);
      return;
    }
    state.watchedVideo?.removeEventListener('ended', onVideoEnded);
    state.watchedVideo = video;
    video.addEventListener('ended', onVideoEnded, { passive: true });
    playCurrentVideo(video);
    window.setTimeout(() => applyPreferredSpeed(), 100);
    setStatus(state.settings.enabled ? '已监测到视频，结束后将继续。' : '已监测到视频；自动续播当前关闭。');
  }

  function onVideoEnded() {
    if (!state.settings.enabled || state.ending) return;
    state.ending = true;
    const ticket = state.navigationTicket;
    let left = state.settings.delay;
    const cancelButton = state.panel?.querySelector('[data-action="cancel"]');
    if (cancelButton) cancelButton.hidden = false;
    setStatus(`${left} 秒后切换下一段；可取消。`, 'go');
    state.countdownTimer = window.setInterval(() => {
      if (!state.settings.enabled || ticket !== state.navigationTicket) { cancelCountdown(); return; }
      left -= 1;
      if (left <= 0) {
        cancelCountdown();
        advance();
      } else setStatus(`${left} 秒后切换下一段；可取消。`, 'go');
    }, 1000);
  }

  function cancelCountdown(message = '') {
    window.clearInterval(state.countdownTimer);
    state.countdownTimer = 0;
    state.ending = false;
    const cancelButton = state.panel?.querySelector('[data-action="cancel"]');
    if (cancelButton) cancelButton.hidden = true;
    if (message) setStatus(message);
  }

  function sleep(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  function findCourseScroller() {
    const root = document.scrollingElement || document.documentElement;
    const rootOverflow = root.scrollHeight - root.clientHeight;
    if (rootOverflow > 80) return root;

    // Many course SPAs lock <body> and put the central article in its own
    // scroll container.  Exclude the narrow right-side catalogue explicitly.
    const candidates = [...document.querySelectorAll('main,[class*="scroll" i],[class*="content" i],[class*="study" i],[class*="page" i]')]
      .filter(visible)
      .map(element => ({ element, rect: element.getBoundingClientRect(), overflow: element.scrollHeight - element.clientHeight }))
      .filter(({ rect, overflow }) => overflow > 80 && rect.width > 320 && rect.left < window.innerWidth * 0.62)
      .sort((left, right) => right.overflow - left.overflow);
    return candidates[0]?.element || root;
  }

  function scrollCourseToBottom() {
    const scroll = () => {
      const scroller = findCourseScroller();
      if (scroller === document.scrollingElement || scroller === document.documentElement) {
        window.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      } else {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
      }
    };
    scroll();
    // The PPT/article area can add content after the route changes. Repeat a
    // few times rather than watching every DOM mutation.
    window.setTimeout(scroll, 500);
    window.setTimeout(scroll, 1400);
    window.setTimeout(bindCurrentVideo, 1800);
  }

  function isCurrent(item) {
    for (let node = item; node && node !== document.body; node = node.parentElement) {
      const classTokens = String(node.className || '').split(/\s+/);
      if (classTokens.some(token => /^(active|current|selected|playing|on|is-active|is-current|is-selected)$/i.test(token) || /(^|[-_])(active|current|selected|playing)([-_]|$)/i.test(token))) return true;
      if (node.hasAttribute('aria-current') || node.getAttribute('aria-selected') === 'true' || /^(active|current|selected|playing|on)$/i.test(node.getAttribute('data-state') || '')) return true;
    }
    return false;
  }

  function isPurpleColor(value) {
    const rgb = String(value || '').match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!rgb) return false;
    const [, red, green, blue] = rgb.map(Number);
    // Keeps cyan progress bars out (they have very little red) while accepting
    // the blue-purple active dot shown in the course catalogue.
    return red >= 55 && blue >= 115 && blue > green * 1.22 && blue > red * 1.12;
  }

  function hasPurpleComputedStyle(element, pseudo = null) {
    const style = getComputedStyle(element, pseudo);
    return [
      style.backgroundColor, style.color, style.borderTopColor, style.borderRightColor,
      style.borderBottomColor, style.borderLeftColor, style.outlineColor, style.fill, style.stroke,
    ].some(isPurpleColor) || /(?:#(?:[89a-f][0-9a-f][4-9a-f]|[6-9a-f][0-9a-f][c-f]){1,2}|purple)/i.test(style.backgroundImage || '');
  }

  function hasPurpleCatalogueMarker(progressElement) {
    // Work upwards only as far as a single catalogue row. This is deliberately
    // not a page-wide colour scan: resource cards can have purple video icons.
    for (let row = progressElement, depth = 0; row && row !== document.body && depth < 7; row = row.parentElement, depth += 1) {
      const rect = row.getBoundingClientRect();
      if (rect.width > 950 || rect.height > 240) break;
      if (hasPurpleComputedStyle(row, '::before') || hasPurpleComputedStyle(row, '::after')) return true;
      const smallChildren = [...row.querySelectorAll('*')]
        .filter(child => {
          const childRect = child.getBoundingClientRect();
          return childRect.width > 0 && childRect.height > 0 && childRect.width <= 70 && childRect.height <= 70;
        })
        .slice(0, 80);
      if (smallChildren.some(child => hasPurpleComputedStyle(child))) return true;
    }
    return false;
  }

  function getRequiredProgress(element) {
    const matches = [...textOf(element).matchAll(/必学\s*(\d+)\s*\/\s*(\d+)/g)];
    if (matches.length !== 1) return null;
    const done = Number(matches[0][1]);
    const total = Number(matches[0][2]);
    return Number.isFinite(done) && Number.isFinite(total) && total > 0 ? { done, total } : null;
  }

  function findChapterClickTarget(progressElement) {
    for (let node = progressElement, depth = 0; node && depth < 7; node = node.parentElement, depth += 1) {
      if (node.matches('a,button,[role="button"],[tabindex]')) return node;
      if (/item|node|chapter|catalog|lesson|section|unit|tree/i.test(String(node.className || ''))) return node;
    }
    // Vue's delegated click handlers also receive the click from the progress
    // label, so this is safer than guessing an unrelated ancestor.
    return progressElement;
  }

  function findNextIncompleteChapter() {
    // Current 智慧树 AI-course catalogue markup is stable and explicit:
    //   <li class="clearfix video activeNode"> ...
    //     <div class="resource-text">必学 <span>2</span>/2</div>
    // Use it before the generic fallback. `activeNode` has no separator, so a
    // generic active/current token matcher cannot safely infer it.
    const zhsRows = [...document.querySelectorAll('li.video')]
      .filter(visible)
      .map(row => ({
        row,
        progress: getRequiredProgress(row.querySelector('.resource-text') || row),
      }));
    const zhsActiveIndex = zhsRows.findIndex(({ row }) => row.classList.contains('activeNode'));
    if (zhsActiveIndex >= 0) {
      // Group headings also carry `video`, but use `forbidClick` and have no
      // resource-text. Completion status may be ignored; content must exist.
      const next = zhsRows.slice(zhsActiveIndex + 1)
        .find(({ row, progress }) => !row.classList.contains('forbidClick') &&
          progress && (state.settings.replayAll || progress.done < progress.total));
      if (!next) return null;
      return { progress: next.progress || { done: 0, total: 0 }, element: next.row, target: next.row };
    }

    const progressNodes = [...document.querySelectorAll('div,span,p,li,strong,em')]
      .filter(visible)
      .map(element => ({ element, progress: getRequiredProgress(element) }))
      .filter(({ progress }) => progress)
      // Keep only the innermost node that describes a single "必学 x/y" line.
      .filter(({ element, progress }) => ![...element.querySelectorAll('*')].some(child => {
        const childProgress = getRequiredProgress(child);
        return childProgress && childProgress.done === progress.done && childProgress.total === progress.total;
      }))
      .map(({ element, progress }) => ({ progress, element, target: findChapterClickTarget(element) }));
    if (!progressNodes.length) return null;

    const activeIndex = progressNodes.findIndex(({ target, element }) =>
      isCurrent(target) || isCurrent(element) || hasPurpleCatalogueMarker(element)
    );
    // Do not jump backwards in the catalogue. If the active chapter is still
    // incomplete, the current page is first scrolled to its bottom so the
    // remaining video can load; only then do we choose a later unfinished row.
    return activeIndex >= 0
      ? progressNodes.slice(activeIndex + 1).find(({ progress }) => state.settings.replayAll || progress.done < progress.total) || null
      : null;
  }

  function openIncompleteChapter(chapter) {
    if (!chapter || !visible(chapter.target)) return false;
    const ticket = state.navigationTicket;
    chapter.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => {
      if (!state.settings.enabled || ticket !== state.navigationTicket) return;
      chapter.target.click();
      window.setTimeout(scrollCourseToBottom, 700);
    }, 250);
    return true;
  }

  function findSequentialVideoResource() {
    // Both modes use catalogue order. Only replay mode includes completed items.
    const items = [...document.querySelectorAll('.resources-list .resources-item')]
      .filter(visible).filter(item => item.querySelector('.file-type.file-video'));
    const active = items.findIndex(item => item.classList.contains('active'));
    // An unmarked current player cannot safely establish catalogue order.
    // A newly entered chapter explicitly requests its first resource.
    if (active < 0 && !state.firstResourceInChapter) return null;
    const candidates = items.slice(state.firstResourceInChapter ? 0 : active + 1);
    const item = candidates.find(item => state.settings.replayAll ||
      (!item.querySelector('.isFinsh') && !item.querySelector('.isFinish') && !/已完成/.test(textOf(item))));
    if (!item) return null;
    return { item, card: item.querySelector('.basic-info-video-card-container') || item,
      target: item, title: textOf(item.querySelector('.file-name') || item) };
  }

  function findUncompletedVideoResource() {
    return findSequentialVideoResource();
  }

  async function openUncompletedVideoResource() {
    const ticket = state.navigationTicket;
    const resource = findUncompletedVideoResource();
    if (!resource || !visible(resource.target)) return false;
    resource.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // The scroll container may re-render card children. Re-query immediately
    // before clicking and activate the stable .resources-item root.
    await sleep(180);
    if (!state.settings.enabled || ticket !== state.navigationTicket) return false;
    const latest = findUncompletedVideoResource();
    const target = latest?.target || resource.target;
    target.click();
    // Some versions bind @click directly to the inner card instead. Use it
    // only as a fallback when the outer resources-item did not become active.
    await sleep(160);
    if (!state.settings.enabled || ticket !== state.navigationTicket) return false;
    if (document.contains(target) && !target.classList.contains('active') && latest?.card && latest.card !== target) {
      latest.card.click();
    }
    setStatus(`正在打开${state.settings.replayAll ? '本章节下一视频' : '本章节未完成视频'}：${resource.title.replace(/\s+/g, ' ').slice(-64)}`, 'go');
    await sleep(200);
    // A successful resource selection applies `active` to that resources-item
    // or replaces it during a route/view update. Without either signal, allow
    // the bounded caller loop to retry after the lazy grid settles.
    return target.classList.contains('active') || !document.contains(target);
  }

  async function waitForAndOpenUncompletedVideo() {
    // The resource grid is lazily mounted after entering a chapter. Retry a
    // few times with a bounded interval; this replaces page-wide observing.
    const ticket = state.navigationTicket;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (!state.settings.enabled || ticket !== state.navigationTicket) return false;
      if (await openUncompletedVideoResource()) { state.firstResourceInChapter = false; return true; }
      if (findSequentialVideoResource() === null && document.querySelector('.resources-list .resources-item.active')) return false;
      scrollCourseToBottom();
      await sleep(1200);
    }
    return false;
  }

  async function attemptPlayAfterNavigation(previousVideo, scrollAfterChange = false, previousIdentity = mediaIdentity(previousVideo)) {
    const ticket = state.navigationTicket;
    if (scrollAfterChange) {
      await sleep(650);
      scrollCourseToBottom();
    }
    for (let attempt = 0; attempt < 18; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 750));
      if (!state.settings.enabled || ticket !== state.navigationTicket) return;
      const nextVideo = getActiveVideo();
      if (!nextVideo || (nextVideo === previousVideo && nextVideo.ended)) continue;
      if (nextVideo.readyState < 1 || (nextVideo === previousVideo && mediaIdentity(nextVideo) === previousIdentity)) continue;
      bindCurrentVideo();
      await playCurrentVideo(nextVideo);
      return;
    }
    setStatus('已请求切换，但未检测到新的播放器；请确认页面是否有课程提示或测验。', 'error');
  }

  async function advance() {
    const ticket = state.navigationTicket;
    if (!state.settings.enabled) return;
    const oldVideo = state.watchedVideo;
    const oldIdentity = oldVideo ? mediaIdentity(oldVideo) : '';
    state.navigationOrigin = oldVideo ? { video: oldVideo, src: oldVideo.currentSrc, version: state.mediaVersions.get(oldVideo) || 0 } : null;
    state.firstResourceInChapter = false;
    // Give the platform a moment to write the just-finished video's progress,
    // then expose any lazily rendered remaining video in the current chapter.
    setStatus('正在检查本章节剩余视频…', 'go');
    scrollCourseToBottom();
    await sleep(1200);
    if (!state.settings.enabled || ticket !== state.navigationTicket) return;
    if (await waitForAndOpenUncompletedVideo()) {
      if (!state.settings.enabled || ticket !== state.navigationTicket) return;
      attemptPlayAfterNavigation(oldVideo, false, oldIdentity);
      return;
    }
    if (!state.settings.enabled || ticket !== state.navigationTicket) return;
    if (state.settings.chapters) {
      const chapter = findNextIncompleteChapter();
      if (openIncompleteChapter(chapter)) {
        state.firstResourceInChapter = true;
        setStatus(`正在进入${state.settings.replayAll ? '下一章节' : '下一未完成章节'}（必学 ${chapter.progress.done}/${chapter.progress.total}）…`, 'go');
        await sleep(500);
        if (!state.settings.enabled || ticket !== state.navigationTicket) return;
        scrollCourseToBottom();
        await sleep(1700);
        if (!state.settings.enabled || ticket !== state.navigationTicket) return;
        if (await waitForAndOpenUncompletedVideo()) {
          if (!state.settings.enabled || ticket !== state.navigationTicket) return;
          attemptPlayAfterNavigation(oldVideo, false, oldIdentity);
          return;
        }
        // Some pages open a native video immediately rather than a resource
        // card. Keep that fallback, but never click a PPT or a completed card.
        if (!state.settings.enabled || ticket !== state.navigationTicket) return;
        attemptPlayAfterNavigation(oldVideo, true, oldIdentity);
        return;
      }
    }
    setStatus(state.settings.replayAll ? '已到目录末尾，或无法确认下一视频；请检查目录。' : '没有识别到当前章节之后的未完成目录项；请确认目录加载状态或手动选择。', 'error');
  }

  function startLightweightMonitor() {
    // Capture media events: they need not bubble, and players may replace the
    // media node or reset its muted state when moving to another resource.
    for (const eventName of ['loadstart', 'loadedmetadata', 'play', 'volumechange']) {
      document.addEventListener(eventName, event => {
        if (event.target instanceof HTMLMediaElement) applyMuteToMedia(event.target);
      }, true);
    }
    /*
     * Do not observe the complete Vue/React page. Video players mutate their
     * progress bars and captions continuously; a subtree MutationObserver here
     * can run thousands of times per minute and freeze the course page.
     *
     * The `ended` listener is attached once to the active <video>.  A modest
     * fallback check is only for SPA route changes or a player that loads late.
     */
    document.addEventListener('loadedmetadata', event => {
      if (event.target instanceof HTMLVideoElement && event.target === getActiveVideo()) {
        state.mediaVersions.set(event.target, (state.mediaVersions.get(event.target) || 0) + 1);
        state.playTicket += 1;
        state.playbackPending = false;
        state.startedMedia = null;
        bindCurrentVideo();
      }
    }, true);
    window.addEventListener('resize', restorePanelPosition, { passive: true });
    state.pollTimer = window.setInterval(bindCurrentVideo, 5000);
    window.addEventListener('focus', bindCurrentVideo, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) bindCurrentVideo();
    }, { passive: true });
  }

  addStyles();
  renderPanel();
  bindCurrentVideo();
  startLightweightMonitor();
})();
