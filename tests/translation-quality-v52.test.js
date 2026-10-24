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
  applyBecauseOfWhatISaidCorrection: (_original, translation) => translation
};
const fidelity = extract('function getSourceFidelityIssues(original, translation, context = {}) {',
                         '\nfunction getSourceFidelityContext(');
const correctionsStart = source.indexOf('function applySourceGroundedSemanticFixes(');
const correctionsEnd = source.indexOf('\nfunction ', correctionsStart + 10);
assert.ok(correctionsStart >= 0 && correctionsEnd > correctionsStart, 'semantic fixes function missing');
vm.runInNewContext(fidelity + '\n' + source.slice(correctionsStart, correctionsEnd) +
  '\n;globalThis.check = getSourceFidelityIssues; globalThis.fix = applySourceGroundedSemanticFixes;', sandbox);

const check = (original, translation, context = {}) => Array.from(sandbox.check(original, translation, context));
const fix = (original, translation) => String(sandbox.fix(original, translation));

test('corrects Pick up with table numbers', () => {
  assert.equal(fix('Pick up! Tables 12, 4, 11.', 'La comandă!\nMesele 12, 4, 11.'),
               'Comenzile sunt gata!\nMesele 12, 4, 11.');
});
test('flags literal Pick up translation when it has not yet been corrected', () => {
  assert.match(check('Pick up! Tables 12, 4, 11.', 'La comandă!\nMesele 12, 4, 11.')[0], /Pick up.*restaurant/);
});
test('does not flag the natural Pick up translation', () => {
  assert.deepEqual(check('Pick up! Tables 12, 4, 11.', 'Comenzile sunt gata!\nMesele 12, 4, 11.'), []);
});
test('corrects stop looking at my boobs mistranslated as watering', () => {
  assert.equal(fix('stop looking at my boobs.', 'oprește-te din udat la țâțele mele.'),
               'Nu te mai uita la țâțele mele.');
});
test('corrects truncated Romanian word for three years younger', () => {
  assert.equal(fix('Oh, Earl, if you were just three years younger.', 'de-ai fi fost cu re ani mai tânăr.'),
               'de-ai fi fost cu trei ani mai tânăr.');
});
test('uses idiomatic Romanian for hit on you aggressively and relentlessly', () => {
  assert.equal(fix('He will hit on you aggressively and relentlessly.',
                   'O să se ia de tine în mod agresiv și fără oprire.'),
               'O să se dea la tine insistent și agresiv.');
});
test('does not mistake relentlessly -> fără oprire for added negation', () => {
  assert.deepEqual(check('He will hit on you aggressively and relentlessly.',
                         'O să se ia de tine în mod agresiv și fără oprire.'), []);
});
test('does not mistake homeless -> fără adăpost for added negation', () => {
  assert.deepEqual(check("That's coming from someone who's homeless.",
                         'Asta vine de la cineva care e fără adăpost.'), []);
});
test('accepts no offense -> fără supărare', () => {
  assert.deepEqual(check('No offense.', 'Fără supărare.'), []);
});
test('does not flag a negation that continues across subtitle cues', () => {
  const context = {
    previousSource: 'Typed in "place where nobody',
    previousTranslation: 'Am scris: „Loc în care nimeni'
  };
  assert.deepEqual(check('from the Upper East Side would ever go, ever.',
                         'din Upper East Side n-ar merge vreodată.', context), []);
});
test('still catches a genuinely lost negation', () => {
  assert.match(check("I didn't kill him.", 'L-am omorât.')[0], /pierdere a negației/);
});
test('still catches a genuinely added negation', () => {
  assert.match(check('I killed him.', 'Nu l-am omorât.')[0], /negație adăugată/);
});
test('recognizes stop imperative as a command rather than added negation', () => {
  assert.deepEqual(check('Could you stop staring at me?', 'Nu te mai holba la mine?'), []);
});
