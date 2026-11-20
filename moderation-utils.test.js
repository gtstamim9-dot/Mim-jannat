'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasLink } = require('../moderation-utils');

test('detects plain HTTP, WWW and Telegram links', () => {
  assert.equal(hasLink({text:'visit https://example.com'}), true);
  assert.equal(hasLink({text:'www.example.com'}), true);
  assert.equal(hasLink({text:'join t.me/example'}), true);
});

test('detects Telegram URL entities including hidden text links', () => {
  assert.equal(hasLink({text:'open this',entities:[{type:'text_link',url:'https://example.com'}]}), true);
  assert.equal(hasLink({caption:'photo',caption_entities:[{type:'url',offset:0,length:5}]}), true);
});

test('does not classify ordinary text as a link', () => {
  assert.equal(hasLink({text:'hello everyone'}), false);
});
