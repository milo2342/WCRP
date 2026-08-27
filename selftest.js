const { commandData, parseDuration, normalizeName, parseIds } = require('./index');

const commands = commandData();
const names = commands.map(c => c.name);
const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
if (duplicates.length) throw new Error(`Duplicate command names: ${[...new Set(duplicates)].join(', ')}`);
if (commands.length < 20) throw new Error(`Unexpectedly few commands: ${commands.length}`);
if (parseDuration('10m') !== 600000) throw new Error('Duration parsing failed');
if (parseDuration('2h') !== 7200000) throw new Error('Duration parsing failed');
if (normalizeName(' Hello World! ') !== 'hello-world') throw new Error('Name normalization failed');
if (parseIds('12345678901234567, bad, 123456789012345678') .length !== 2) throw new Error('ID parsing failed');
console.log(`Self-test passed: ${commands.length} commands, no duplicate names.`);
console.log(names.join(', '));
