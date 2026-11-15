// `node --test tests-web/` resolves the directory to this file (Node ≥ 22 treats a directory
// argument as a module path), so load every *.test.js here. `node --test tests-web/*.test.js` also works.
const fs = require('fs');
const path = require('path');
for (const f of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort()) require(path.join(__dirname, f));
