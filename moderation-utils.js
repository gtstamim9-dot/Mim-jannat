'use strict';

function messageText(message) {
  return String((message && (message.text || message.caption)) || '');
}

function hasLink(message) {
  if (!message) return false;
  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : [])
  ];
  if (entities.some(entity => entity && ['url', 'text_link'].includes(entity.type))) return true;
  const text = messageText(message);
  return /(?:https?:\/\/|www\.)\S+|(?:^|[\s(])t\.me\/\S+|(?:^|[\s(])telegram\.me\/\S+|(?:^|[\s(])(?:[a-z0-9-]+\.)+(?:com|net|org|io|me|co|info|app|dev|xyz|bd)(?:\/\S*)?/i.test(text);
}

module.exports = { messageText, hasLink };
