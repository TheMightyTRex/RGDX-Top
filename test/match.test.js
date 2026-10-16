const assert = require('assert');
const A = require('./load-app')();
const cases = [
  ['The Legend of Zelda: A Link to the Past', 'Legend of Zelda, The - A Link to the Past (USA).sfc'],
  ['Street Fighter II: The World Warrior', 'Street Fighter II - The World Warrior (World).zip'],
  ['Super Mario Bros. 3', 'Super Mario Bros. 3 (USA) (Rev 1).nes'],
  ['Pokémon Red and Blue', 'Pokemon - Red Version (USA, Europe) (SGB Enhanced).gb'],
  ['Sonic the Hedgehog 2', 'Sonic The Hedgehog 2 (World) (Rev A).md'],
  ['Castlevania: Symphony of the Night', 'Castlevania - Symphony of the Night (USA).cue'],
  ['Final Fantasy VII', 'Final Fantasy VII (USA) (Disc 1).chd'],
  ['Street Fighter II', 'sf2.zip', 'Street Fighter II: The World Warrior (World 910522)'],
];
for (const [title, file, n] of cases) {
  const idx = A.buildIndex([{ f: file, n }]);
  assert.ok(A.findIn(idx, { t: title }), `${title} should match ${file}`);
}
const neg = [['Tetris', 'Tetris 2 (USA).nes'], ['Mega Man', 'Mega Man 2 (USA).nes'], ['Doom', 'Doom 64 (USA).z64']];
for (const [title, file] of neg) assert.ok(!A.findIn(A.buildIndex([{ f: file }]), { t: title }), `${title} must not match ${file}`);
assert.strictEqual(A.parseListText('1. Super Metroid\n2) Chrono Trigger\n\nSuper Metroid').join('|'), 'Super Metroid|Chrono Trigger');
assert.strictEqual(A.parseListText('"Title, with comma",1994\nEarthBound,1994', 'x.csv').join('|'), 'Title, with comma|EarthBound');
console.log('match tests passed:', cases.length + neg.length + 2);
