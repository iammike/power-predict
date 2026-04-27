// Build script: bundle src/*.js into dist/app.min.js, minify shared.css.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  const distDir = path.join(__dirname, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'app.js')],
    bundle: true,
    minify: true,
    target: 'es2020',
    format: 'iife',
    outfile: path.join(distDir, 'app.min.js'),
  });

  // Bundle the archive Web Worker as its own file. The worker owns
  // file reading, decompression, and FIT parsing so the main thread
  // never blocks on heavy archives.
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'archive-worker.js')],
    bundle: true,
    minify: true,
    target: 'es2020',
    format: 'iife',
    outfile: path.join(distDir, 'archive-worker.js'),
  });

  const cssSrc = fs.readFileSync(path.join(__dirname, 'shared.css'), 'utf8');
  const cssResult = await esbuild.transform(cssSrc, { minify: true, loader: 'css' });
  fs.writeFileSync(path.join(distDir, 'app.min.css'), cssResult.code);

  console.log('built dist/app.min.js + dist/archive-worker.js + dist/app.min.css');
}

build().catch((err) => { console.error(err); process.exit(1); });
