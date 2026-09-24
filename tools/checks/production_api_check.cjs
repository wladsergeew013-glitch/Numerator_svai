const fs = require('node:fs');
const path = require('node:path');

const assetsDir = path.resolve(__dirname, '../../frontend/dist/assets');
const bundles = fs.readdirSync(assetsDir).filter(name => name.endsWith('.js'));
if (bundles.length === 0) throw new Error('Production frontend bundle is missing');

for (const name of bundles) {
  const source = fs.readFileSync(path.join(assetsDir, name), 'utf8');
  if (source.includes('http://localhost:8000') || source.includes('http://127.0.0.1:8000')) {
    throw new Error(`${name} contains a fixed development API port; the desktop backend uses a free port`);
  }
}

console.log('PASS: production frontend has no fixed development API port.');
