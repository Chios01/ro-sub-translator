'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'Unable to extract ' + startMarker);
  return source.slice(start, end);
}
const sandbox = {
  applyBecauseOfWhatISaidCorrection: (_original, translation) => translation,
  isJunkOrInterjection: () => false
};
vm.runInNewContext(
  extract('function applySourceGroundedSemanticFixes(original, translation) {', '\nfunction normalizeTranslationPayload(') +
  '\n;globalThis.fix = applySourceGroundedSemanticFixes;',
  sandbox
);
vm.runInNewContext(
  extract('const LOCAL_GRAMMAR_FIXES = [', '\nfunction applyLocalGrammarDeterministicFixes(text) {') +
  '\nfunction applyLocalGrammarDeterministicFixes(text) { let result = String(text || ""); for (const [pattern, replacement] of LOCAL_GRAMMAR_FIXES) result = result.replace(pattern, match => match === match.toUpperCase() ? replacement.toUpperCase() : match[0] === match[0].toUpperCase() ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement); return result; }\n;globalThis.localFix = applyLocalGrammarDeterministicFixes;',
  sandbox
);
test('repairs malformed looking-at-breasts translation using source', () => {
  assert.equal(sandbox.fix('Stop looking at my tits.', 'oprește-te din a-mi uita la sâni.'), 'Nu te mai uita la țâțele mele.');
});
test('repairs malformed service phrase using the exact source context', () => {
  assert.equal(sandbox.fix("That's how you get service.", 'Asta e sunetul care-ți aduce servire.'), 'Așa obții servire.');
});
test('repairs help-her-know and waitressing idioms', () => {
  assert.equal(sandbox.fix("Don't help her know that I said that.", 'Să n-o ajuți să știe că am zis asta.'), 'Nu-i spune că am zis asta.');
  assert.equal(sandbox.fix("And let's get to waitressing.", 'și haideți să ospătări.'), 'Hai să ne apucăm de servit.');
});
test('repairs the ketchup-marriage pun', () => {
  assert.equal(sandbox.fix("I wanted to get here early to marry the ketchup.", 'A, am vrut să ajung mai devreme să măsor ketchupul.'), 'A, am vrut să ajung mai devreme să mă mărit cu sticlele de ketchup.');
});
test('repairs apostrophe Chestnut phrase and typo locally', () => {
  assert.equal(sandbox.fix("Did that goddamn Chestnut hit you in the head?", "Te-a dat dracu' de Chestnut aici în cap"), 'Te-a lovit Chestnut ăla al naibii în cap?');
  assert.equal(sandbox.localFix('Ești o mincinosoasă.'), 'Ești o mincinoasă.');
});
test('runs a full contextual review over all eligible cues in batches of 80', () => {
  assert.match(source, /const FULL_SUBTITLE_REVIEW_BATCH_SIZE = 80;/);
  assert.match(source, /mode: 'full', contextItems: items, batchSize: FULL_SUBTITLE_REVIEW_BATCH_SIZE/);
  assert.match(source, /options\.mode === 'full'/);
});
