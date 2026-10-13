import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResumeState} from '../src/jobs.js';

test('resume accepts only paused tasks and retry also accepts incomplete tasks',()=>{
  assert.doesNotThrow(()=>validateResumeState({state:'paused'},false));
  assert.doesNotThrow(()=>validateResumeState({state:'paused'},true));
  assert.doesNotThrow(()=>validateResumeState({state:'incomplete'},true));
  assert.throws(()=>validateResumeState({state:'downloading'},false),/正在下载/);
  assert.throws(()=>validateResumeState({state:'complete'},false),/已经完成/);
  assert.throws(()=>validateResumeState({state:'incomplete'},false),/重试失败项/);
});
