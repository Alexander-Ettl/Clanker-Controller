// The composer clock's scheduling modes (styles: schedule-timer.css). Clicking the clock steps through three ways to
// send a prompt later, then off:
//   reset     when the usage resets (the default: a pill that shows what it is waiting for)
//   timer     after a delay, set on a vertical bar
//   calendar  at a chosen day and time
// Clicking or hovering the clock grows a tall pill out of it, with the picker for the current mode. The mode the last scheduled
// prompt used is the one the next click starts with (main.js saves it). Everything is mouse-driven and live: every
// change applies at once, leaving the pill closes it. Loaded before main.js, which owns arming and the task itself.
(() => {
  const STEPS = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440]; // minutes
  const COLUMNS = 4; // the delay buttons: four to a row, so three rows hold every step
  const MODES = ['reset', 'timer', 'calendar'];
  const TITLES = { reset: 'Usage reset', timer: 'Send after', calendar: 'Calendar' };
  const prefs = window.TIME_PREFS || {};
  const cycle = { '24h': 'h23', '12h': 'h12' }[prefs.timeFormat || '24h'];
  const clock = (date) => date.toLocaleTimeString(prefs.locale, { hour: '2-digit', minute: '2-digit', ...(cycle ? { hourCycle: cycle } : {}) });
  const pad = (n) => String(n).padStart(2, '0');
  const stepName = (min) => (min < 60 ? `${min} min` : `${min / 60} ${min === 60 ? 'hour' : 'hours'}`);
  const stepChip = (min) => (min < 60 ? `${min} min` : `${min / 60} h`); // the short form on the picker's buttons
  const startOfDay = (date) => new Date(new Date(date).setHours(0, 0, 0, 0));
  const dayOffset = (date, now = new Date()) => Math.round((startOfDay(date) - startOfDay(now)) / 864e5);
  const dayName = (date) => {
    const offset = dayOffset(date);
    return offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : date.toLocaleDateString(prefs.locale, { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const el = (tag, className, html = '') => Object.assign(document.createElement(tag), { className, innerHTML: html });
  const btn = (className, html, label) => { const b = el('button', className, html); b.type = 'button'; if (label) b.setAttribute('aria-label', label); return b; };
  const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    prev: svg('<path d="M9.5 4 5.5 8l4 4"/>'),
    next: svg('<path d="M6.5 4l4 4-4 4"/>'),
  };
  /** 3:43:14 or 43:14; days beyond a day as "5d 2h". */
  function countdown(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
    return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
  }

  /** Press once to step, hold to keep stepping. */
  function holdRepeat(button, step) {
    let delay; let timer;
    const stop = () => { clearTimeout(delay); clearInterval(timer); };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      step();
      delay = setTimeout(() => { timer = setInterval(step, 70); }, 380);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(type, stop);
  }

  /**
   * @param {{ button: HTMLElement, composer: HTMLElement, preferred?: string, usage: () => { windows: { key: string, name: string, remaining: number|null, resetsAt: number|null }[] }, onChange: () => void }} options
   */
  window.initScheduleTimer = ({ button, composer, preferred = 'reset', usage, onChange }) => {
    let mode = null; // null: off (the prompt just sends)
    let base = MODES.includes(preferred) ? preferred : 'reset'; // the mode a click from "off" starts with
    let resetKey = '5h'; // which limit the reset mode waits for
    let index = STEPS.indexOf(120); // the bar's step: two hours to begin with, so the bar is never empty and shows it can be moved
    let sel = null; // calendar: { day, h, m }
    let viewMonth = null;
    let at = null; // calendar: the chosen moment, ms
    let open = false;
    let leaveTimer;
    let ticker;

    // ---- markup: one pill: a title (wide modes), the picker, and the clock itself as the foot
    const bud = el('div', 'timer-bud');
    bud.hidden = true;
    const pill = el('div', 'timer-pill');
    const title = el('div', 'timer-title');
    const body = el('div', 'timer-body');

    // Timer: every delay is a button. A row of plain choices needs no drag and no hint that it can be dragged: you see
    // the options, one is lit, a click picks it (arrow keys and the wheel step through them as well).
    const chips = el('div', 'timer-chips');
    chips.setAttribute('role', 'radiogroup');
    chips.setAttribute('aria-label', 'Send after');
    const chipButtons = STEPS.map((minutes, i) => {
      const chip = btn('timer-chip', stepChip(minutes));
      chip.setAttribute('role', 'radio');
      chip.title = stepName(minutes);
      chip.addEventListener('click', () => setStep(i));
      return chip;
    });
    chips.append(...chipButtons);

    const windowsView = el('div', 'timer-windows');
    const note = el('div', 'timer-note');

    const monthTitle = el('span', 'timer-month');
    const prev = btn('timer-nav', ICON.prev, 'Previous month');
    const next = btn('timer-nav', ICON.next, 'Next month');
    const weekdays = el('div', 'timer-weekdays');
    const monday = new Date(2024, 0, 1); // a Monday: the week starts there
    for (let i = 0; i < 7; i++) weekdays.append(el('span', '', new Date(monday.getTime() + i * 864e5).toLocaleDateString(prefs.locale, { weekday: 'narrow' })));
    const days = el('div', 'timer-days');
    const calTime = timeRow();
    const calendar = el('div', 'timer-calendar');
    const monthBar = el('div', 'timer-monthbar');
    monthBar.append(prev, monthTitle, next);
    calendar.append(monthBar, weekdays, days, calTime.row);

    const slot = el('span', 'timer-slot'); // where the clock button sits
    const foot = el('div', 'timer-foot');
    foot.append(note, slot);
    body.append(chips, windowsView, calendar);
    pill.append(title, body, foot);
    bud.append(pill);
    composer.append(bud);

    /** ‹ 14 › : ‹ 35 › — the wheel over a number steps it too. */
    function timeRow() {
      const row = el('div', 'timer-time');
      const make = (unit) => {
        const value = el('span', 'timer-num');
        const down = btn('timer-nav', ICON.prev, `Earlier ${unit}`);
        const up = btn('timer-nav', ICON.next, `Later ${unit}`);
        const group = el('div', 'timer-field');
        group.append(down, value, up);
        const bump = (dir) => nudge(unit === 'hour' ? dir * 60 : dir);
        holdRepeat(down, () => bump(-1));
        holdRepeat(up, () => bump(1));
        group.addEventListener('wheel', (event) => { event.preventDefault(); bump(event.deltaY < 0 ? 1 : -1); }, { passive: false });
        return { group, value };
      };
      const hour = make('hour');
      const minute = make('minute');
      row.append(hour.group, el('b', '', ':'), minute.group);
      return { row, hour: hour.value, minute: minute.value };
    }

    // ---- the clock's label width: reserved for the widest label of the mode (timer, calendar), measured once
    const probe = el('span', 'schedule-probe');
    probe.setAttribute('aria-hidden', 'true');
    button.append(probe);
    const reserved = {};
    function labelWidth(labels) {
      return Math.ceil(Math.max(...labels.map((text) => { probe.textContent = text; return probe.getBoundingClientRect().width; })));
    }
    function reserveLabel() {
      const labels = { timer: () => STEPS.map(stepName), calendar: () => { const late = new Date(2024, 0, 1, 23, 59); return [clock(late), ...Array.from({ length: 7 }, (_, i) => `${new Date(2024, 0, 1 + i).toLocaleDateString(prefs.locale, { weekday: 'short' })} ${clock(late)}`)]; } }[mode];
      if (!labels) { button.style.removeProperty('--time-w'); return; }
      reserved[mode] ??= labelWidth(labels());
      button.style.setProperty('--time-w', `${reserved[mode]}px`);
    }

    // ---- what each mode holds
    const windows = () => usage().windows;
    const chosenWindow = () => windows().find((w) => w.key === resetKey) || windows()[0] || null;

    function render() {
      button.dataset.mode = mode || 'off';
      reserveLabel();
      pill.dataset.mode = mode || 'off';
      title.textContent = TITLES[mode] || '';
      chips.hidden = mode !== 'timer';
      windowsView.hidden = mode !== 'reset';
      calendar.hidden = mode !== 'calendar';
      if (mode === 'reset') renderWindows();
      if (mode === 'calendar' && sel) {
        calTime.hour.textContent = pad(sel.h);
        calTime.minute.textContent = pad(sel.m);
        renderMonth();
        note.textContent = at ? `${dayName(new Date(at))} at ${clock(new Date(at))}` : '';
      } else if (mode === 'timer') {
        chipButtons.forEach((chip, i) => { chip.setAttribute('aria-checked', String(i === index)); chip.classList.toggle('is-sel', i === index); chip.tabIndex = i === index ? 0 : -1; });
        const due = new Date(Date.now() + STEPS[index] * 60000); // counted from the moment you send it, so approximate
        note.textContent = `${dayOffset(due) === 0 ? 'Sends' : 'Tomorrow'} ≈ ${clock(due)}`;
      }
    }

    function renderWindows() {
      const list = windows();
      if (windowsView.children.length !== list.length) {
        windowsView.replaceChildren(...list.map((w) => {
          const row = btn('timer-window', '<span class="timer-window-dot"></span><span class="timer-window-name"></span><i class="timer-bar"><b></b></i><span class="timer-window-pct"></span><span class="timer-window-eta"></span>');
          row.dataset.key = w.key;
          row.addEventListener('click', () => { resetKey = w.key; renderWindows(); onChange(); });
          return row;
        }));
      }
      const now = Date.now();
      list.forEach((w, i) => {
        const row = windowsView.children[i];
        const pct = typeof w.remaining === 'number' ? clamp(Math.round(w.remaining), 0, 100) : null;
        row.classList.toggle('is-sel', w.key === resetKey);
        row.classList.toggle('is-low', pct !== null && pct <= 20);
        row.setAttribute('aria-pressed', String(w.key === resetKey));
        row.style.setProperty('--pct', pct ?? 0);
        row.querySelector('.timer-window-name').textContent = w.name;
        row.querySelector('.timer-window-pct').textContent = pct === null ? '—' : `${pct}%`;
        row.querySelector('.timer-window-eta').textContent = w.resetsAt ? countdown(w.resetsAt * 1000 - now) : '';
      });
      const chosen = chosenWindow();
      note.textContent = chosen?.resetsAt ? `Sends ${dayOffset(new Date(chosen.resetsAt * 1000)) === 0 ? 'at' : `${dayName(new Date(chosen.resetsAt * 1000))} at`} ${clock(new Date(chosen.resetsAt * 1000))}` : 'Sends when the limit resets';
    }

    function commit() { render(); place(); onChange(); }

    // ---- timer buttons
    function setStep(nextIndex) {
      nextIndex = clamp(nextIndex, 0, STEPS.length - 1);
      if (nextIndex === index) return;
      index = nextIndex;
      commit();
    }
    let lastWheel = 0;
    chips.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.timeStamp - lastWheel > 40) setStep(index + (event.deltaY < 0 ? -1 : 1));
      lastWheel = event.timeStamp;
    }, { passive: false });
    chips.addEventListener('keydown', (event) => {
      const target = { ArrowRight: index + 1, ArrowLeft: index - 1, ArrowDown: index + COLUMNS, ArrowUp: index - COLUMNS, Home: 0, End: STEPS.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      setStep(target);
      chipButtons[index].focus();
    });

    // ---- calendar
    function initSel() {
      const start = at ? new Date(at) : new Date(Math.ceil((Date.now() + 36e5) / 3e5) * 3e5); // an hour ahead, on a five
      sel = { day: startOfDay(start), h: start.getHours(), m: start.getMinutes() };
      at = start.getTime();
      viewMonth = new Date(sel.day.getFullYear(), sel.day.getMonth(), 1);
    }
    /** The chosen day and time; never a moment already gone (then the next free five minutes). */
    function apply() {
      let moment = new Date(sel.day);
      moment.setHours(sel.h, sel.m, 0, 0);
      if (moment.getTime() <= Date.now()) moment = new Date(Math.ceil((Date.now() + 6e4) / 3e5) * 3e5);
      Object.assign(sel, { day: startOfDay(moment), h: moment.getHours(), m: moment.getMinutes() });
      at = moment.getTime();
      commit();
    }
    function nudge(minutes) {
      const total = (((sel.h * 60 + sel.m + minutes) % 1440) + 1440) % 1440;
      sel.h = Math.floor(total / 60);
      sel.m = total % 60;
      apply();
    }
    function renderMonth() {
      const now = new Date();
      monthTitle.textContent = viewMonth.toLocaleDateString(prefs.locale, { month: 'long', year: 'numeric' });
      prev.disabled = viewMonth <= new Date(now.getFullYear(), now.getMonth(), 1);
      const lead = (viewMonth.getDay() + 6) % 7;
      days.replaceChildren(...Array.from({ length: 42 }, (_, i) => {
        const day = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1 - lead + i);
        const cell = btn('timer-day', String(day.getDate()));
        cell.disabled = day < startOfDay(now);
        cell.classList.toggle('is-other', day.getMonth() !== viewMonth.getMonth());
        cell.classList.toggle('is-today', dayOffset(day) === 0);
        cell.classList.toggle('is-sel', day.getTime() === sel.day.getTime());
        cell.addEventListener('click', () => { sel.day = day; viewMonth = new Date(day.getFullYear(), day.getMonth(), 1); apply(); });
        return cell;
      }));
    }
    const shiftMonth = (dir) => { viewMonth = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + dir, 1); renderMonth(); };
    prev.addEventListener('click', () => shiftMonth(-1));
    next.addEventListener('click', () => shiftMonth(1));
    days.addEventListener('wheel', (event) => { event.preventDefault(); if (!(event.deltaY < 0 && prev.disabled)) shiftMonth(event.deltaY < 0 ? -1 : 1); }, { passive: false });

    // ---- modes
    function select(nextMode) {
      mode = nextMode;
      if (mode === 'calendar' && !sel) initSel();
      render();
      place();
      requestAnimationFrame(place); // once the clock has taken its new width
      if (open && mode === 'reset') startTicker(); else stopTicker();
    }
    /** One click on the clock: off -> the mode last used -> the others in turn -> off. Returns the new mode, null for off. */
    function advance() {
      const order = [base, ...MODES.filter((m) => m !== base)];
      const nextIndex = mode === null ? 0 : order.indexOf(mode) + 1;
      select(nextIndex >= order.length ? null : order[nextIndex]);
      if (mode) show(); else hide();
      return mode;
    }
    const startTicker = () => { stopTicker(); ticker = setInterval(() => { if (mode === 'reset') renderWindows(); }, 1000); };
    const stopTicker = () => { clearInterval(ticker); ticker = null; };

    // ---- placement: the pill wraps the clock wherever the composer puts it (a pill, or the bottom row of the squircle)
    // The clock's layout box inside the composer, not its drawn rectangle: the hover scale and a size transition in
    // progress would move the pill off the clock by a few pixels, a different few each time.
    function boxIn(el, ancestor) {
      let x = 0; let y = 0;
      for (let node = el; node && node !== ancestor; node = node.offsetParent) { x += node.offsetLeft; y += node.offsetTop; }
      return { x, y, w: el.offsetWidth, h: el.offsetHeight };
    }
    function place() {
      if (bud.hidden) return;
      const box = boxIn(button, composer);
      bud.style.right = `${composer.clientWidth - (box.x + box.w) - 4}px`;
      bud.style.bottom = `${composer.clientHeight - (box.y + box.h) - 4}px`;
      pill.style.setProperty('--bw', `${box.w}px`);
    }
    const resizeObserver = new ResizeObserver(place);
    for (const target of [composer, button]) resizeObserver.observe(target);

    function show() {
      clearTimeout(leaveTimer);
      if (open || mode === null) return; // off: nothing to pick
      open = true;
      bud.hidden = false;
      button.classList.add('is-timer-open');
      pill.classList.remove('is-leaving');
      place();
      render();
      if (mode === 'reset') startTicker();
    }
    function hide() {
      if (!open) return;
      open = false;
      stopTicker();
      pill.classList.add('is-leaving');
      setTimeout(() => { if (!open) { bud.hidden = true; pill.classList.remove('is-leaving'); button.classList.remove('is-timer-open'); } }, 280);
    }
    button.addEventListener('mouseenter', show);
    button.addEventListener('mouseleave', () => { leaveTimer = setTimeout(hide, 260); });
    bud.addEventListener('mouseenter', () => clearTimeout(leaveTimer));
    bud.addEventListener('mouseleave', () => { leaveTimer = setTimeout(hide, 260); });
    button.addEventListener('keydown', (event) => { if (event.key === 'ArrowUp' && mode === 'timer') { event.preventDefault(); show(); chipButtons[index].focus(); } });
    bud.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); hide(); button.focus(); } });

    render();
    return {
      get mode() { return mode; },
      get resetWindow() { return resetKey; },
      advance,
      select,
      /** The mode the next click from "off" starts with (the one the last scheduled prompt used). */
      setPreferred(nextMode) { if (MODES.includes(nextMode)) base = nextMode; },
      /** The button's label for what is chosen: "1 hour", "Fri 21:30", the countdown to the reset. Empty when nothing shows. */
      short(now = Date.now()) {
        if (mode === 'timer') return stepName(STEPS[index]);
        if (mode === 'calendar' && at) { const date = new Date(at); return dayOffset(date) === 0 ? clock(date) : `${date.toLocaleDateString(prefs.locale, { weekday: 'short' })} ${clock(date)}`; }
        if (mode === 'reset') { const w = chosenWindow(); return w?.resetsAt ? countdown(w.resetsAt * 1000 - now) : ''; }
        return '';
      },
      /** "at 21:30", "tomorrow at 09:30", "on Fri 3 Oct at 09:30" for sentences; for the reset, what it waits for. */
      describe() {
        if (mode === 'reset') return resetKey === '7d' ? 'when its weekly limit resets' : '';
        const when = this.resolve();
        if (!when) return '';
        const date = new Date(when);
        const offset = dayOffset(date);
        return `${offset === 0 ? '' : offset === 1 ? 'tomorrow ' : `on ${dayName(date)} `}at ${clock(date)}`;
      },
      /** When it should fire, in ms: a delay counts from now (so it starts when the prompt is sent); null for the usage reset. */
      resolve(now = Date.now()) {
        if (mode === 'timer') return now + STEPS[index] * 60000;
        if (mode === 'calendar' && at) return Math.max(at, now + 1000);
        return null;
      },
      /** Back to off, and forget the chosen moment (the bar keeps its step). */
      clear() {
        mode = null;
        sel = null;
        at = null;
        stopTicker();
        render();
        open = false;
        bud.hidden = true;
        button.classList.remove('is-timer-open');
      },
    };
  };
})();
