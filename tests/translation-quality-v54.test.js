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
  extract('const LOCAL_GRAMMAR_FIXES = [', '\nfunction detectLocalGrammarReviewReasons(') +
  '\n;globalThis.localFix = applyLocalGrammarDeterministicFixes;',
  sandbox
);
vm.runInNewContext(
  extract('function detectLocalGrammarReviewReasons(', '\nconst itemsIndexCache') +
  '\n;globalThis.reviewReasons = detectLocalGrammarReviewReasons;',
  sandbox
);

test('fixes the source-confirmed sound / vagina punchline', () => {
  assert.equal(sandbox.fix("That's the sound that dries my vagina.", 'Asta e metoda prin care mi se usucă vaginul.'), 'Ăsta e sunetul care-mi usucă vaginul.');
});
test('uses a natural equivalent for dead inside when gendered output is wrong', () => {
  assert.equal(sandbox.fix("I'm dead inside.", 'Sunt mort sufletește.'), 'M-am stins pe dinăuntru.');
});
test('repairs payday context without retaining the incoherent literal translation', () => {
  assert.equal(sandbox.fix("Happy payday! I've got your paychecks.", 'Salutare azi. Am salariul pentru voi.'), 'E ziua de salariu! Am salariile voastre.');
});
test('repairs pretend-not-home without changing the source tense', () => {
  assert.equal(sandbox.fix("They all had to pretend they weren't home.", 'și toți au trebuit să se predea că nu sunt acasă.'), 'și toți au trebuit să se prefacă că nu erau acasă.');
});
test('repairs an obvious line-boundary fragment around muffins and liar', () => {
  assert.equal(sandbox.fix("And you lied about the muffins... you're a liar.", 'și ai mințit despre brioșe...ști o mincinoasă.'), 'și ai mințit despre brioșe... ești o mincinoasă.');
});
test('repairs a Chestnut / hit / head mistranslation only when source confirms it', () => {
  assert.equal(sandbox.fix('Did that goddamn Chestnut hit you in the head?', 'Te-a dat dracului de Chestnut în cap'), 'Te-a lovit Chestnut ăla al naibii în cap?');
  assert.equal(sandbox.fix('Chestnut is a horse.', 'Te-a dat dracului de Chestnut în cap'), 'Te-a dat dracului de Chestnut în cap');
});
test('preserves source-grounded meaning of gentrification and foreclosure', () => {
  assert.equal(sandbox.fix('I moved here to match the gentrifying neighborhood.', 'ca să mă potrivesc cu cartierul în schimbare.'), 'ca să mă potrivesc cu cartierul care se gentrifică.');
  assert.equal(sandbox.fix('Our house was foreclosed on by the bank.', 'Casa noastră a fost luată și închisă de bancă'), 'Casa noastră a fost executată silit de bancă.');
});
test('repairs a wrong polarity phrase and "No offense" calque', () => {
  assert.equal(sandbox.fix("You don't find anything wrong with that?", 'Ție nu ți se pare nimic în regulă cu asta?'), 'Ție nu ți se pare nimic în neregulă cu asta?');
  assert.equal(sandbox.fix('No offense, the subway is cleaner.', 'Fără să mint, metroul e mai curat.'), 'Fără supărare, metroul e mai curat.');
});
test('idiomatic repairs are source-sensitive', () => {
  assert.equal(sandbox.fix('She gets a few things right.', 'dar ghicește și unele lucruri bine.'), 'dar unele lucruri le nimerește.');
  assert.equal(sandbox.fix('Thank God you are here.', 'A, mulțumită cerului că ai ajuns'), 'Slavă Domnului că ai ajuns.');
});
test('cleans clear typos and flags unresolved high-risk phrases', () => {
  assert.equal(sandbox.localFix('N-a s-a simțit roz.'), 'Nu s-a simțit roz.');
  assert.equal(sandbox.localFix('Fata aia blondă? N-are nicio idee despre kas vorbește.'), 'Fata aia blondă? N-are nicio idee despre ce vorbește.');
  assert.ok(sandbox.reviewReasons('Te-a dat dracului de Chestnut în cap').length > 0);
  assert.ok(sandbox.reviewReasons('background în afaceri').length > 0);
  assert.ok(sandbox.reviewReasons('ghicește și unele lucruri bine').length > 0);
});
