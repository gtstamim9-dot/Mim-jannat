'use strict';
// Test-only stand-in used when the real grammy package is not installed.
class InlineKeyboard {
  constructor() { this.inline_keyboard = [[]]; }
  _push(b) { this.inline_keyboard[this.inline_keyboard.length - 1].push(b); return this; }
  text(text, callback_data) { return this._push({ text, callback_data }); }
  url(text, url) { return this._push({ text, url }); }
  row() { this.inline_keyboard.push([]); return this; }
}
class InputFile { constructor(data, filename) { this.data = data; this.filename = filename; } }
module.exports = { InlineKeyboard, InputFile };
