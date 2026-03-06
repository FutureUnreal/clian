import esbuild from 'esbuild';
import path from 'path';
import process from 'process';
import builtins from 'builtin-modules';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';

// Load .env.local if it exists
if (existsSync('.env.local')) {
  const envContent = readFileSync('.env.local', 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^=]+)=["']?(.+?)["']?$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const prod = process.argv[2] === 'production';

const DIST_DIR = path.join(process.cwd(), 'dist');
if (!existsSync(DIST_DIR)) {
  mkdirSync(DIST_DIR, { recursive: true });
}

// Keep manifest.json alongside build artifacts in dist/ for easy plugin installation.
const MANIFEST_SRC = path.join(process.cwd(), 'manifest.json');
const MANIFEST_DEST = path.join(DIST_DIR, 'manifest.json');
if (existsSync(MANIFEST_SRC)) {
  copyFileSync(MANIFEST_SRC, MANIFEST_DEST);
}

// Clean legacy output location (repo root) so build artifacts only live under dist/.
try { unlinkSync(path.join(process.cwd(), 'main.js')); } catch { /* ignore */ }
try { unlinkSync(path.join(process.cwd(), 'main.js.map')); } catch { /* ignore */ }

// Obsidian plugin folder path (set via OBSIDIAN_VAULT env var or .env.local)
const OBSIDIAN_VAULT = process.env.OBSIDIAN_VAULT;
const OBSIDIAN_PLUGIN_PATH = OBSIDIAN_VAULT && existsSync(OBSIDIAN_VAULT)
  ? path.join(OBSIDIAN_VAULT, '.obsidian', 'plugins', 'clian')
  : null;

// Plugin to copy built files to Obsidian plugin folder
const copyToObsidian = {
  name: 'copy-to-obsidian',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0 || !OBSIDIAN_PLUGIN_PATH) return;

      if (!existsSync(OBSIDIAN_PLUGIN_PATH)) {
        mkdirSync(OBSIDIAN_PLUGIN_PATH, { recursive: true });
      }

      const artifacts = [
        { src: path.join(DIST_DIR, 'main.js'), dest: 'main.js' },
        { src: path.join(DIST_DIR, 'styles.css'), dest: 'styles.css' },
        { src: path.join(DIST_DIR, 'manifest.json'), dest: 'manifest.json' },
      ];

      for (const artifact of artifacts) {
        if (existsSync(artifact.src)) {
          copyFileSync(artifact.src, path.join(OBSIDIAN_PLUGIN_PATH, artifact.dest));
          console.log(`Copied ${artifact.dest} to Obsidian plugin folder`);
        }
      }
    });
  }
};

const context = await esbuild.context({
  entryPoints: ['src/entry.ts'],
  bundle: true,
  plugins: [copyToObsidian],
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...builtins,
    ...builtins.map(m => `node:${m}`),
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: path.join(DIST_DIR, 'main.js'),
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
