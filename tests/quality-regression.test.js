'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = source.indexOf('function getSourceFidelityIssues(');
const end = source.indexOf('\nfunction hasLostExplicitSourceTerm', start);
assert.ok(start >= 0 && end > start);
const sandbox = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.check = getSourceFidelityIssues;', sandbox);
const cases = [["I didn't kill him.","L-am omorât.",true],["I would never betray you.","Te-aș trăda.",true],["I didn't kill him.","Nu l-am omorât.",false],["I love you.","Nu te iubesc.",true],["I can't wait to see you.","Abia aștept să te văd.",false],["Don't worry.","Stai liniștit.",false],["I wouldn't mind helping.","Mi-ar plăcea să ajut.",false],["It's not only funny but also smart.","E nu doar amuzant, ci și inteligent.",false],["I can barely hear you.","Abia te aud.",false],["No problem.","Nicio problemă.",false],["The answer is not bad.","Răspunsul e destul de bun.",false],["We won't go.","Vom pleca.",true]];
for (const [original, translation, shouldWarn] of cases) test(original + ' => ' + translation, () => {
 const result = sandbox.check(original, translation);
 assert.equal(result.length > 0, shouldWarn, JSON.stringify(result));
});