// Bundles each UI extension with esbuild to catch syntax/import errors without the Shopify CLI.
// (The real build is done by `shopify app deploy`.)
import {build} from 'esbuild';
import {readdirSync, existsSync} from 'node:fs';

const entries = {
  'bkash-thank-you': 'src/ThankYou.jsx',
  'bkash-order-status': 'src/OrderStatus.jsx',
};

let failed = false;
for (const dir of readdirSync('extensions')) {
  const entry = entries[dir] && `extensions/${dir}/${entries[dir]}`;
  if (!entry || !existsSync(entry)) continue;
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      logLevel: 'warning',
    });
    console.log(`✓ ${dir}`);
  } catch {
    console.error(`✗ ${dir}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
