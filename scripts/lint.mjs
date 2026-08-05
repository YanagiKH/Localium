import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const includedExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.svg']);
const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'release', 'coverage']);
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name) || entry.name.startsWith('.local-') || entry.name.startsWith('tsconfig.local')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute);
    else if (includedExtensions.has(path.extname(entry.name))) await checkFile(absolute);
  }
}

async function checkFile(file) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (/\s+$/u.test(line)) failures.push(`${relative}:${index + 1}: trailing whitespace`);
    if (line.includes('\t')) failures.push(`${relative}:${index + 1}: tab character`);
  });
  const forbidden = [
    ['merge conflict marker', /^(<<<<<<<|=======|>>>>>>>)/mu],
    ['dynamic eval', /\beval\s*\(/u],
    ['dynamic Function constructor', /\bnew\s+Function\s*\(/u],
    ['committed private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
    ['committed OpenAI-style secret', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/u]
  ];
  for (const [name, pattern] of forbidden) {
    if (pattern.test(text)) failures.push(`${relative}: ${name}`);
  }
}

await walk(root);
if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Repository lint checks passed.');
}
