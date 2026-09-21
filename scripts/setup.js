#!/usr/bin/env node
'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   GO Events Calendar — Setup             ║');
console.log('╚══════════════════════════════════════════╝\n');

// 1. Check Node version
const nv = process.version.match(/^v(\d+)/);
if (!nv || parseInt(nv[1]) < 18) {
  console.error('✗ Node.js 18+ required. Current:', process.version);
  process.exit(1);
}
console.log('✓ Node.js', process.version);

// 2. Create .env from example if missing
const envPath = path.join(ROOT, '.env');
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(ROOT, '.env.example'), envPath);
  console.log('✓ .env created — please edit it before starting');
} else {
  console.log('✓ .env already exists');
}

// 3. Create credentials dir
const credDir = path.join(ROOT, 'credentials');
if (!fs.existsSync(credDir)) {
  fs.mkdirSync(credDir, { recursive: true });
  console.log('✓ credentials/ directory created');
}

// 4. Check service account key (only needed for the one-time Sheets migration)
const keyFile = path.join(credDir, 'service-account.json');
if (!fs.existsSync(keyFile)) {
  console.log('\n⚠  credentials/service-account.json is missing (only needed for `npm run db:migrate`)');
} else {
  console.log('✓ service-account.json found');
}

// 5. Install dependencies
console.log('\nInstalling npm dependencies…');
try {
  execSync('npm install --production', { cwd: ROOT, stdio: 'inherit' });
  console.log('✓ Dependencies installed');
} catch(e) {
  console.error('✗ npm install failed:', e.message);
  process.exit(1);
}

// 6. Validate .env has required keys
const env = fs.readFileSync(envPath, 'utf8');
const required = ['DATABASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'SESSION_SECRET'];
const missing  = required.filter(k => !env.includes(k+'=') || env.includes(k+'=PASTE_') || env.includes(k+'=your-'));
if (missing.length) {
  console.log('\n⚠  Please set these in .env before starting:');
  missing.forEach(k => console.log('    -', k));
} else {
  console.log('✓ .env has all required keys');
}

console.log('\n══════════════════════════════════════════');
console.log('  Setup complete! Next:');
console.log('  1. Edit .env with your configuration');
console.log('  2. Start Postgres and set DATABASE_URL');
console.log('  3. Run: npm run db:init      (creates schema)');
console.log('  4. Run: npm run db:migrate   (one-time, copies the Google Sheet in)');
console.log('  5. Run: npm start');
console.log('  6. Open: http://localhost:3000');
console.log('══════════════════════════════════════════\n');
