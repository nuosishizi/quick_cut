import assert from 'node:assert/strict';
import { alignScript, spokenCaptionWords, buildCaptions } from '../editor-desktop/src/alignment.mjs';
const analyze = (script, text) => alignScript({segments:[{text,start:0,end:10}],script,duration:10});
const captions = (result) => buildCaptions(spokenCaptionWords(result.operations), {maxWords:10,maxChars:200,maxLines:1}).map(x=>x.text).join(' ');
for (const [script,text,expectedWord] of [
  ['God says, “his countenance was upon them.”','God says his continence was upon them','countenance'],
  ['God says, “surely goodness and mercy shall follow me.”','God says goodness and mercy shall follow me','surely'],
  ['God says, “your heart shall be glad.”','God says you heart shall be glad','your'],
  ['God says, “the man shall live.”','God says the men shall live','man'],
]) {
  const r=analyze(script,text);
  assert.equal(r.issues.some(i=>i.strict && ['missing','mismatch'].includes(i.type)), false);
  assert.match(captions(r), new RegExp(expectedWord,'i'));
}
{
  const r=analyze('God says, “the love shall remain.”','God says the hate shall remain');
  assert.equal(r.issues.some(i=>i.strict && i.type==='mismatch'), true);
}
{
  const r=analyze('God says, “surely goodness and mercy shall follow me.”','God says surely darkness and anger shall follow me');
  assert.equal(r.issues.filter(i=>i.strict && i.type==='mismatch').length >= 1, true);
}
{
  const r=analyze('Jesus loves you. Jesus loves you.','Jesus loves you Jesus loves you');
  assert.equal(r.issues.some(i=>i.type==='repeat'), false);
  assert.match(captions(r), /Jesus loves you.*Jesus loves you/i);
}
console.log('manuscript-first alignment: 7 scenarios passed');
