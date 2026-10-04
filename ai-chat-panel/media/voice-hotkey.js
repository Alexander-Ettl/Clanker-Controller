// The dictation hotkey as a string ("Ctrl+Alt+Space"): captured from a key event in Settings, parsed into Windows
// virtual-key codes for the listener (lib/voice-hotkey.js). Pure; window.voiceHotkey in the webview, require() in the host.
(function (root) {
  'use strict';

  // [name shown, KeyboardEvent flag, virtual-key code]
  const MODIFIERS = [['Ctrl', 'ctrlKey', 0x11], ['Alt', 'altKey', 0x12], ['Shift', 'shiftKey', 0x10], ['Win', 'metaKey', 0x5B]];
  const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)$/;

  const KEYS = {}; // KeyboardEvent.code -> { name, vk }
  const add = (code, name, vk) => { KEYS[code] = { name, vk }; };
  for (let i = 0; i < 26; i++) add(`Key${String.fromCharCode(65 + i)}`, String.fromCharCode(65 + i), 0x41 + i);
  for (let i = 0; i < 10; i++) add(`Digit${i}`, String(i), 0x30 + i);
  for (let i = 1; i <= 24; i++) add(`F${i}`, `F${i}`, 0x70 + i - 1);
  Object.entries({
    Space: ['Space', 0x20], Backquote: ['`', 0xC0], Minus: ['-', 0xBD], Equal: ['=', 0xBB], Comma: [',', 0xBC], Period: ['.', 0xBE],
    Slash: ['/', 0xBF], Semicolon: [';', 0xBA], Quote: ["'", 0xDE], BracketLeft: ['[', 0xDB], BracketRight: [']', 0xDD], Backslash: ['\\', 0xDC],
    Insert: ['Insert', 0x2D], Home: ['Home', 0x24], End: ['End', 0x23], PageUp: ['PageUp', 0x21], PageDown: ['PageDown', 0x22], Pause: ['Pause', 0x13],
  }).forEach(([code, [name, vk]]) => add(code, name, vk));
  const BY_NAME = Object.fromEntries(Object.values(KEYS).map((key) => [key.name, key]));

  // A hotkey that is only a letter, or Shift and a letter, would fire while typing: it needs a real modifier, or to be an F key.
  const usable = (mods, key) => Boolean(key) && (/^F\d+$/.test(key.name) || mods.some((name) => name !== 'Shift'));

  /** "Ctrl+Alt+Space" from a keydown event, or null while only modifiers are down or the combination would fire while typing. */
  function fromKeyEvent(event) {
    if (MODIFIER_CODES.test(event.code || '')) return null;
    const key = KEYS[event.code];
    const mods = MODIFIERS.filter(([, flag]) => event[flag]).map(([name]) => name);
    return key && usable(mods, key) ? [...mods, key.name].join('+') : null;
  }

  /** { mods: ['Ctrl'], modVks: [0x11], key: 'Space', vk: 0x20 } for a saved hotkey string, or null if it is not one. */
  function parse(text) {
    const parts = String(text || '').split('+');
    const key = BY_NAME[parts.pop()];
    const mods = parts.map((name) => MODIFIERS.find(([label]) => label === name));
    if (!key || mods.some((mod) => !mod) || new Set(parts).size !== parts.length) return null;
    const names = mods.map(([name]) => name);
    return usable(names, key) ? { mods: names, modVks: mods.map(([, , vk]) => vk), key: key.name, vk: key.vk } : null;
  }

  const api = { fromKeyEvent, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.voiceHotkey = api;
})(typeof window !== 'undefined' ? window : globalThis);
