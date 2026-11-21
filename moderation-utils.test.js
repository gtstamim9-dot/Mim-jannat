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

const { matchesFilter, matchesTrigger, renderTemplate } = require('../moderation-utils');
const test2 = require('node:test');
const assert2 = require('node:assert/strict');

test2('custom filters use whole-word matching and *word* for substring', () => {
  assert2.equal(matchesFilter('this is a class', 'ass'), false);
  assert2.equal(matchesFilter('You ASS!', 'ass'), true);
  assert2.equal(matchesFilter('classy', '*ass*'), true);
  assert2.equal(matchesFilter('গালি দিও না', 'গালি'), true);
  assert2.equal(matchesFilter('hello', ''), false);
});
test2('auto reply triggers: exact, multiple, contains, case-insensitive', () => {
  assert2.equal(matchesTrigger('hi|hello', 'Hello'), true);
  assert2.equal(matchesTrigger('hi', 'hi there'), false);
  assert2.equal(matchesTrigger('*salam*', 'Assalamu salam bro'), true);
});
test2('templates escape HTML and render mention/group/username', () => {
  const out = renderTemplate('হাই {mention} {username} {group} <b>', [{ id: 5, first_name: 'A<b>', username: 'abc' }], { title: 'G&G' });
  assert2.ok(out.includes('<a href="tg://user?id=5">A&lt;b&gt;</a>'));
  assert2.ok(out.includes('@abc') && out.includes('G&amp;G') && out.includes('&lt;b&gt;'));
  assert2.equal(renderTemplate('{name}', [{ id: 1, first_name: 'রহিম' }], {}, false), 'রহিম');
});
