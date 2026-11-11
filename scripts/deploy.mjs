// Publishes the built site (dist/) to the `gh-pages` branch, which GitHub Pages serves.
// Run with `npm run deploy` (it builds first). The branch holds only the built files and
// is replaced on every deploy; your working branch and its files are not touched.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!existsSync('dist/index.html')) {
  console.error('There is no build in dist/. Run "npm run build" first (or use "npm run deploy").');
  process.exit(1);
}
// GitHub Pages runs sites through Jekyll unless this file is present
writeFileSync('dist/.nojekyll', '');

const tmp = mkdtempSync(join(tmpdir(), 'rnb-deploy-'));
// a separate index, so staging dist/ never disturbs what is staged in the real one
const env = { ...process.env, GIT_INDEX_FILE: join(tmp, 'index') };
const git = (...args) => execFileSync('git', args, { env, encoding: 'utf8' }).trim();

try {
  const from = git('rev-parse', '--short', 'HEAD');
  git('--work-tree=dist', 'add', '--all', '--force');
  const tree = git('write-tree');
  const commit = git('commit-tree', tree, '-m', `Deploy ${from}`);
  git('push', '--force', 'origin', `${commit}:refs/heads/gh-pages`);
  console.log(`Published ${from} to the gh-pages branch. The site updates in a minute or two.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
