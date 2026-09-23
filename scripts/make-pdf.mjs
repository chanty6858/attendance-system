#!/usr/bin/env node
// Renders an HTML file to PDF using headless Chrome (handles Khmer fonts).
// Usage: node scripts/make-pdf.mjs [input.html] [output.pdf]
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('No Chrome/Chromium found. Open the HTML in a browser and print to PDF instead.');
  process.exit(1);
}

const input = resolve(process.argv[2] || 'docs/attendance-workflow-kh.html');
const output = resolve(process.argv[3] || input.replace(/\.html?$/, '.pdf'));
mkdirSync(dirname(output), { recursive: true });

execFileSync(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--virtual-time-budget=20000',
    `--print-to-pdf=${output}`,
    pathToFileURL(input).href,
  ],
  { stdio: 'inherit' },
);

const { size } = statSync(output);
console.log(`PDF: ${basename(output)} (${(size / 1024).toFixed(0)} KB) -> ${output}`);
