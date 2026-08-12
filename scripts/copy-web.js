// Copie les pages HTML dans dist/ apres tsc : elles ne passent pas par le compilateur.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'web');
const dst = path.join(__dirname, '..', 'dist', 'web');

fs.mkdirSync(dst, { recursive: true });
if (fs.existsSync(src)) {
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
}
