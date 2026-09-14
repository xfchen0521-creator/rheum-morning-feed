'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
function validate(c) {
  assert(c && Array.isArray(c.papers) && c.papers.length, 'Missing papers');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(c.latestDate), 'Invalid date');
  assert(c.weekly && typeof c.weekly === 'object', 'Missing weekly');
  const ids = new Set();
  for (const p of c.papers) {
    assert(p.id && p.date && p.title && p.original && p.pmid, 'Incomplete paper');
    assert(!ids.has(p.id), 'Duplicate paper'); ids.add(p.id);
    assert(p.date <= c.latestDate, 'Future paper date');
  }
  assert.equal(c.papers.filter(p => p.date === c.latestDate).length, 5);
}
async function main() {
  const content = JSON.parse(fs.readFileSync('content.json', 'utf8'));
  validate(content);
  if (process.argv.includes('--check')) {
    console.log('Validated', content.latestDate, content.papers.length); return;
  }
  for (const key of ['TCB_ENV_ID','TCB_SECRET_ID','TCB_SECRET_KEY'])
    assert(process.env[key], 'Missing GitHub secret: ' + key);
  assert.equal(process.env.TCB_FREE_QUOTA_CONFIRMED, 'true', 'Free quota must be confirmed before enabling writes');
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  assert.equal(content.latestDate, today, 'Refuse stale feed');
  const cloudbase = require('@cloudbase/node-sdk');
  const app = cloudbase.init({
    env: process.env.TCB_ENV_ID,
    secretId: process.env.TCB_SECRET_ID,
    secretKey: process.env.TCB_SECRET_KEY,
    timeout: 30000
  });
  const ref = app.database().collection('content_cache').doc('current');
  // Existing cache is required. Permission/read errors abort without writing.
  const before = await ref.get();
  const old = before.data && before.data[0] && before.data[0].content;
  validate(old);
  assert(old.latestDate <= content.latestDate, 'Refuse rollback');
  const incoming = new Map(content.papers.map(p => [p.id, p]));
  for (const p of old.papers) {
    assert(incoming.has(p.id), 'Refuse missing historical paper');
    assert.deepEqual(incoming.get(p.id), p, 'Historical content differs; requires review');
  }
  if (new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Shanghai',weekday:'long'}).format(new Date()) !== 'Monday')
    assert.deepEqual(content.weekly, old.weekly, 'Weekly changed outside Monday');
  try { assert.deepEqual(old, content); console.log('Cache already matches', content.latestDate); return; } catch {}
  const result = await ref.set({content,sourceUpdatedAt:content.updatedAt || '',cachedAtMs:Date.now()});
  assert(!result.code, 'Database write failed');
  const after = await ref.get();
  assert.deepEqual(after.data[0].content, content, 'Readback mismatch');
  console.log('Verified cache sync', content.latestDate, content.papers.length);
}
main().catch(e => {
  // Do not emit SDK request objects or credential-bearing error details.
  console.error('Sync failed:', e.code || e.name || 'ERROR');
  if (e.name === 'AssertionError') console.error(e.message.split('\n')[0]);
  process.exitCode = 1;
});
