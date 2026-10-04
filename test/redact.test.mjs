import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../src/redact.mjs';

test('redact: 텔레그램 토큰·API 키·Bearer 토큰·깃허브 토큰을 가린다', () => {
  const t = '123456789:' + 'A'.repeat(35);
  assert.equal(redact(`token ${t} end`), 'token [텔레그램 토큰 가림] end');
  assert.doesNotMatch(redact('sk-ant-' + 'x'.repeat(40)), /xxxx/);
  assert.doesNotMatch(redact('key sk-proj-' + 'y'.repeat(40)), /yyyy/);
  assert.doesNotMatch(redact('ghp_' + 'z'.repeat(36)), /zzzz/);
  assert.equal(redact('Authorization: Bearer ' + 'q'.repeat(30)), 'Authorization: Bearer [가림]');
});

test('redact: 사용자 폴더 이름은 가리고(paths:false 면 그대로), 평범한 글은 건드리지 않는다', () => {
  const home = ['C:', 'Users', '홍길동', 'Desktop', 'a.txt'].join('\\');
  const masked = ['C:', 'Users', '~', 'Desktop', 'a.txt'].join('\\');
  assert.equal(redact(home), masked);
  assert.equal(redact(home, { paths: false }), home);
  assert.equal(redact('안녕하세요 오늘 회의는 3시 30분입니다.'), '안녕하세요 오늘 회의는 3시 30분입니다.');
  assert.equal(redact(null), '');
});
