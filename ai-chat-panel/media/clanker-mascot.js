/* Empty-state Clanker: the preview's SVG rig; all reactions are silent except launch. */
(function () {
  'use strict';
  let serial = 0;
  let audio = null;
  function fanfare() {
    try {
      if (navigator.userActivation && !navigator.userActivation.isActive) return;
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audio = audio || new Audio();
      if (audio.state === 'suspended') void audio.resume().catch(() => {});
      [523.25, 659.25, 783.99, 1046.50].forEach((frequency, index) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + index * 0.065;
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.075, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start);
        oscillator.stop(start + 0.16);
      });
    } catch { /* An unavailable audio device must never prevent sending. */ }
  }

  window.createClankerMascot = function ({ root, input, modelPicker, attach, mic, transcript }) {
    const clipId = `clanker-visor-${++serial}`;
    root.querySelector('.empty-mark').innerHTML = `<svg class="clanker-rig" viewBox="0 0 374.78 296.77" aria-hidden="true" focusable="false">
<defs>
<clipPath id="${clipId}">
<path d="M289.89,178.84c4.41-2.14,8.16-4.6,11.92-7.45,17.27-13.06,27.8-33.76,27.85-55.39l.05-18.27c.04-16.43-4.99-32.63-15.1-45.63-5.96-7.66-13.29-13.79-21.7-18.64-11.41-6.58-24.43-9.75-37.65-9.75l-131.94.04c-11.18-.35-22.27,1.27-32.63,5.43-18.47,7.42-33.75,22.36-40.7,41.11-2.98,8.04-4.94,16.18-4.95,24.82l-.03,20.9c.21,11.28,3.09,22.28,8.34,32.25,12.54,23.81,38.33,38.31,65.17,38.31h137.46c11.74,0,23.34-2.61,33.91-7.74Z"/>
</clipPath>
</defs>
<g clip-path="url(#${clipId})">
<rect class="clanker-visor-bg" fill="#141416" x="0" y="0" width="374.78" height="296.77" />
</g>
<g class="clanker-chassis-rig">
<path fill="#ffffff" fill-rule="evenodd" d="M294.4,258.9l-14.83-21.98-11.92-17.18c-3.31-4.77-8.94-8.16-15.05-8.17l-130.21-.08c-6.12.46-11.61,3.01-15.08,8.06l-14.18,20.6-22.55,33.33c-4.46,6.6-13.31,17.34-19.76,21.29-5.85,3.59-14.06,1.67-19.94-1.7-7.03-4.03-13.25-9.34-18.23-15.78C3.66,265.7.41,249.46.05,234.98c-.44-17.56,2.36-38.84,5.42-56.35,2.35-13.4,4.93-26.6,8.16-39.81l8.76-35.87,6.5-23.72,5.65-18.6c2.35-7.73,5.29-15.01,9.1-22.12,4.7-8.78,13.13-16.6,21.55-21.93C79.86,7.3,96.57,1.64,113.86.1c6.63-.59,11.53,1.52,15.29,6.84.25.35.79.65,1.4.65h113.64c.66,0,1.2-.4,1.48-.8,3.27-4.73,8.37-7.18,14.24-6.75,17,1.25,33.49,6.62,48.05,15.47,4.45,2.7,8.43,5.68,12.26,9.15,5.23,4.72,9.27,10.35,12.34,16.68,2.36,4.87,4.48,9.6,6.12,14.75l5.04,15.82,3.22,10.99,10.75,41.3,9.91,44.81c2.82,14.36,4.99,28.62,6.22,43.18l.93,18.76c.06,15.99-2.52,33.05-12.22,46.07-4.86,6.52-11,11.73-17.97,15.85-3.6,2.13-7.42,3.35-11.54,3.8-3.66.4-7.07-.55-10.02-2.68-6.15-4.43-14.5-14.31-18.86-20.73l-9.78-14.37ZM289.89,178.84c4.41-2.14,8.16-4.6,11.92-7.45,17.27-13.06,27.8-33.76,27.85-55.39l.05-18.27c.04-16.43-4.99-32.63-15.1-45.63-5.96-7.66-13.29-13.79-21.7-18.64-11.41-6.58-24.43-9.75-37.65-9.75l-131.94.04c-11.18-.35-22.27,1.27-32.63,5.43-18.47,7.42-33.75,22.36-40.7,41.11-2.98,8.04-4.94,16.18-4.95,24.82l-.03,20.9c.21,11.28,3.09,22.28,8.34,32.25,12.54,23.81,38.33,38.31,65.17,38.31h137.46c11.74,0,23.34-2.61,33.91-7.74Z"/>
</g>
<g clip-path="url(#${clipId})">
<g class="clanker-face-rig">
<g class="clanker-brow-left-rig">
<polygon fill="#ffffff" points="111.71 85.86 98.81 98.59 91.08 91.02 106.88 75.42 152.6 75.43 152.62 85.86 111.71 85.86"/>
</g>
<g class="clanker-brow-right-rig">
<polygon fill="#ffffff" points="272.16 74.13 255.05 57.3 216.17 60.18 215.11 49.48 258.94 46.27 279.64 66.68 272.16 74.13"/>
</g>
<g class="clanker-eye-left-rig">
<polygon fill="#ffffff" points="140.48 135.21 123.78 135.19 123.74 129.86 118.16 129.8 118.09 124.55 112.89 124.49 112.89 107.23 118.15 107.24 118.17 101.79 123.68 101.78 123.72 96.4 140.53 96.38 140.54 101.84 145.8 101.84 145.79 107.23 151.12 107.28 151.12 124.56 145.93 124.58 145.82 129.8 140.49 129.82 140.48 135.21"/>
</g>
<g class="clanker-eye-right-rig">
<polygon fill="#ffffff" points="247.93 135.7 225.69 135.73 225.67 129.79 219.72 129.76 219.72 124.52 214.18 124.48 214.15 118.35 208.41 118.3 208.41 96.74 214.06 96.71 214.2 90.39 219.74 90.31 219.83 85.05 225.68 85 225.74 78.95 247.94 78.93 248.02 85 253.78 85.01 253.81 90.22 259.49 90.31 259.6 96.44 265.38 96.51 265.33 118.13 259.57 118.11 259.56 124.17 253.91 124.16 253.83 129.61 247.98 129.62 247.93 135.7"/>
</g>
</g>
</g>
<g clip-path="url(#${clipId})">
<line class="clanker-scanline" x1="45" y1="0" x2="330" y2="0" stroke="var(--clanker-scanline, #60a5fa)" stroke-width="3.5" opacity="0" />
</g>
</svg>`;
    const mark = root.querySelector('.empty-mark');
    const face = root.querySelector('.clanker-face-rig');
    const abort = new AbortController();
    const timers = new Set();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let alive = true, visible = true, frame = 0, keys = 0, listening = false;
    let pauseTimer, reactionTimer, idleTimer;
    const live = () => alive && root.isConnected && visible && !document.hidden;
    const later = (fn, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); if (alive) fn(); }, delay);
      timers.add(timer);
      return timer;
    };
    const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
    const listen = (el, type, fn) => el.addEventListener(type, fn, { signal: abort.signal });
    function state(name) {
      cancel(reactionTimer);
      face.style.transform = '';
      root.dataset.mascot = name;
    }
    function rest() {
      if (listening) { state('listening'); return; }
      state(document.activeElement === input ? input.value.trim() ? 'typing' : 'focus' : 'idle');
    }
    function react(name, duration = 1400) {
      if (!live() || listening) return;
      state(name);
      reactionTimer = later(rest, duration);
    }
    function think(infinite = false) {
      if (!live() || reduced.matches || (!input.value.trim() && !infinite)) return;
      keys = 0;
      if (infinite) {
        state('thinking');
      } else {
        react('thinking', 2200);
      }
    }
    function setListening(active) {
      if (!live()) return;
      listening = Boolean(active);
      cancel(reactionTimer);
      cancel(pauseTimer);
      if (listening) {
        state('listening');
      } else {
        rest();
      }
    }
    function blink() {
      if (live() && !reduced.matches && !listening && ['idle', 'focus', 'typing'].includes(root.dataset.mascot)) {
        root.classList.add('mascot-blinking');
        later(() => root.classList.remove('mascot-blinking'), 150);
      }
      later(blink, 4200 + Math.random() * 2400);
    }
    function resetIdleTimer() {
      cancel(idleTimer);
      idleTimer = later(() => {
        if (live() && !reduced.matches && !listening && root.dataset.mascot === 'idle') {
          react('thinking', 2400);
          resetIdleTimer();
        }
      }, 7000 + Math.random() * 2000);
    }
    listen(document, 'pointermove', event => {
      resetIdleTimer();
      if (!live() || reduced.matches || listening || !['idle', 'focus'].includes(root.dataset.mascot)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!live() || listening || !['idle', 'focus'].includes(root.dataset.mascot)) return;
        const rect = mark.getBoundingClientRect();
        const x = Math.max(-11, Math.min(11, (event.clientX - rect.left - rect.width / 2) / 200 * 11));
        const y = Math.max(-7.5, Math.min(7.5, (event.clientY - rect.top - rect.height / 2) / 220 * 7.5));
        face.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      });
    });
    listen(document.documentElement, 'pointerleave', () => { if (live()) face.style.transform = ''; });
    listen(input, 'focus', () => { cancel(idleTimer); rest(); });
    listen(input, 'blur', () => { cancel(pauseTimer); rest(); resetIdleTimer(); });
    listen(input, 'input', event => {
      if (!live() || listening) return;
      cancel(pauseTimer);
      cancel(idleTimer);
      keys++;
      if (event.data === '@' || event.data === '/') { react(event.data === '@' ? 'mention' : 'action'); return; }
      if (root.dataset.mascot === 'thinking' && keys <= 3) return;
      rest();
      if (!input.value.trim()) { keys = 0; return; }
      if (((event.data === ' ' && keys >= 6) || keys >= 16) && Math.random() < 0.28) { think(); return; }
      if (!reduced.matches) face.style.transform = `translate(${(input.value.length % 7 - 3).toFixed(1)}px, 7.5px)`;
      pauseTimer = later(() => {
        if (live() && document.activeElement === input && input.value.trim() && !listening) {
          think(true);
        }
      }, 750);
    });
    listen(attach, 'click', () => react('image'));
    listen(modelPicker, 'click', () => react('model', 450));
    listen(modelPicker, 'clanker:model-change', () => react('model', 450));
    if (mic) {
      listen(mic, 'click', () => {
        // Toggle listening feedback will be synced through setVoiceState
      });
    }
    root.querySelectorAll('[data-mascot-action]').forEach(button => listen(button, 'click', () => {
      const action = button.dataset.mascotAction;
      if (action === 'image') attach.click();
      else {
        input.focus();
        input.setRangeText(action === 'mention' ? '@' : '/', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      react(action);
    }));
    const visibility = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      root.classList.toggle('mascot-paused', !visible);
    });
    visibility.observe(mark);
    listen(document, 'visibilitychange', () => root.classList.toggle('mascot-paused', document.hidden || !visible));
    const detached = new MutationObserver(() => { if (!root.isConnected) dispose(); });
    detached.observe(transcript, { childList: true });
    function dispose() {
      alive = false;
      abort.abort();
      timers.forEach(clearTimeout);
      timers.clear();
      cancelAnimationFrame(frame);
      visibility.disconnect();
      detached.disconnect();
    }
    rest();
    later(blink, 4200 + Math.random() * 1600);
    resetIdleTimer();
    return {
      dispose,
      launch() {
        if (!alive || !root.isConnected) { dispose(); root.remove(); return; }
        const rect = root.getBoundingClientRect();
        dispose();
        root.classList.remove('mascot-blinking', 'mascot-paused');
        root.dataset.mascot = 'idle';
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;max-width:none`;
        root.classList.add('is-launching');
        document.body.append(root);
        fanfare();
        setTimeout(() => root.remove(), reduced.matches ? 180 : 700);
      },
      setListening,
    };
  };
})();
