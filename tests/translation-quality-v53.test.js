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
  isJunkOrInterjection: () => false,
  getFastItemIndex: () => -1
};
vm.runInNewContext(
  extract('function getMissingExplicitAnatomicalTerms(original, translation) {', '\nfunction getSourceFidelityIssues(') +
  '\n' +
  extract('function getSourceFidelityIssues(original, translation, context = {}) {', '\nfunction getSourceFidelityContext(') +
  '\n' +
  extract('function applySourceGroundedSemanticFixes(original, translation) {', '\nfunction ') +
  '\n' +
  extract('function detectSourceAwareQualityReviewReasons(item, translation, contextItems, translatedById) {', '\nfunction collectQualityReviewReasons(') +
  '\n;globalThis.anatomy = getMissingExplicitAnatomicalTerms;' +
  '\n;globalThis.fidelity = getSourceFidelityIssues;' +
  '\n;globalThis.fix = applySourceGroundedSemanticFixes;' +
  '\n;globalThis.sourceAware = detectSourceAwareQualityReviewReasons;',
  sandbox
);

test('Unicode Romanian letters are recognized in explicit anatomy terms', () => {
  assert.deepEqual(Array.from(sandbox.anatomy('stop looking at my boobs.', 'Nu te mai uita la țâțele mele.')), []);
  assert.deepEqual(Array.from(sandbox.anatomy('stop looking at my breasts.', 'Nu te mai uita la sânii mei.')), []);
});

test('restaurant pickup correction depends on source context and table numbers', () => {
  assert.equal(sandbox.fix('Pick up! Tables 12, 4, 11.', 'La comandă!\nMesele 12, 4, 11.'), 'Comenzile sunt gata!\nMesele 12, 4, 11.');
  assert.equal(sandbox.fix('Please order up at the counter.', 'Te rog, comandă la tejghea.'), 'Te rog, comandă la tejghea.');
});

test('body-looking verbs are not mistranslated as watering', () => {
  assert.equal(sandbox.fix('Stop looking at my boobs.', 'Oprește-te din udat la țâțele mele.'), 'Nu te mai uita la țâțele mele.');
  assert.equal(sandbox.fix('Stop staring at my breasts.', 'Oprește-te din stropit la sânii mei.'), 'Nu te mai uita la sânii mei.');
});

test('does not flag the Romanian lexical equivalent for lack of money', () => {
  assert.deepEqual(Array.from(sandbox.fidelity("She doesn't have a dime.", 'E lefteră.')), []);
  assert.deepEqual(Array.from(sandbox.fidelity('He has no money.', 'E falit.')), []);
});

test('recognizes rhetorical negative questions about negative traits as idiomatic equivalents', () => {
  assert.deepEqual(Array.from(sandbox.fidelity('Is he rude and obnoxious?', 'Nu e cumva nesuferit și nesimțit?')), []);
});

test('continues to flag genuinely lost or added negation', () => {
  assert.match(Array.from(sandbox.fidelity("I didn't kill him.", 'L-am omorât.'))[0], /pierdere a negației/);
  assert.match(Array.from(sandbox.fidelity('I killed him.', 'Nu l-am omorât.'))[0], /negație adăugată/);
});

test('finds idiom/role reversals in different shows using source-aware review', () => {
  const check = (sourceText, translated) => Array.from(sandbox.sourceAware({id:1,text:sourceText},translated,[{id:1,text:sourceText}],{'1':translated}));
  assert.match(check("I'm dead inside.", 'Sunt o cauză pierdută.').join('; '), /dead inside/);
  assert.match(check("You've been robbed!", 'Le-ai spart casa!').join('; '), /inversare de rol/);
  assert.match(check('No offense, but the subway is cleaner.', 'Fără să mint, metroul e mai curat.').join('; '), /No offense/);
  assert.match(check("I've waited tables all my life.", 'Am așteptat toată viața mea.').join('; '), /waited tables/);
});
