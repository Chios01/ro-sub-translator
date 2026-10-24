'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function getSourceFidelityIssues(original, translation) {');
const end = source.indexOf('\nfunction hasLostExplicitSourceTerm(original, translation) {', start);
assert.ok(start >= 0 && end > start, 'source-fidelity QA function must exist exactly where expected');

const sandbox = {};
vm.runInNewContext(source.slice(start, end) + '\n;globalThis.check = getSourceFidelityIssues;', sandbox);
const check = (original, translated) => Array.from(sandbox.check(original, translated));

test('flags literal Order up with restaurant table numbers', () => {
  const reasons = check('Order up! Tables 12, 4, 11.', 'La comandă! Mesele 12, 4, 11.');
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /Order up.*context de restaurant/);
});

test('accepts natural Romanian for the restaurant call', () => {
  assert.deepEqual(check('Order up! Tables 12, 4, 11.', 'Comenzile sunt gata! Mesele 12, 4 și 11.'), []);
});

test('does not flag unrelated uses of order', () => {
  assert.deepEqual(check('Please order up at the counter.', 'Te rog, comandă la tejghea.'), []);
});

test('does not flag correctly translated stop commands', () => {
  assert.deepEqual(check('Stop staring at me.', 'Nu te mai holba la mine.'), []);
});

test('recognizes Romanian negation with diacritics and contractions', () => {
  assert.deepEqual(check('Mr. Lee, no offense.', 'Domnule Lee, fără supărare.'), []);
  assert.deepEqual(check('I had nowhere else to go.', 'N-aveam unde altundeva să mă duc.'), []);
});

test('catches clear lost negation', () => {
  assert.match(check("I didn't kill him.", 'L-am omorât.')[0], /pierdere a negației/);
  assert.match(check('I would never betray you.', 'Te-aș trăda.')[0], /pierdere a negației/);
});

test('catches added negation', () => {
  assert.match(check('I killed him.', 'Nu l-am omorât.')[0], /negație adăugată/);
});

test('does not flag not only...but also', () => {
  assert.deepEqual(check('She is not only smart but also funny.', 'Nu este doar deșteaptă, ci și amuzantă.'), []);
});

test('does not flag idiomatic Romanian wording', () => {
  assert.deepEqual(check("I'm uncomfortable.", 'Nu mă simt în apele mele.'), []);
  assert.deepEqual(check("I grabbed all the wrong things.", 'Am apucat numai ce nu trebuia.'), []);
});

test('treats abia as a negative equivalent only in relevant source expressions', () => {
  assert.deepEqual(check('The concert just ended across the street.', 'Concertul abia s-a terminat vizavi.'), []);
  assert.deepEqual(check("I can't wait to see you.", 'Abia aștept să te văd.'), []);
  assert.deepEqual(check('I barely noticed.', 'Abia am observat.'), []);
});
