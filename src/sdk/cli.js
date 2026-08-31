#!/usr/bin/env node
import fs from 'fs';
import { validateDiscoveryPolicy } from './validation.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: validate-discovery <path-to-json>');
  process.exit(1);
}

try {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const result = validateDiscoveryPolicy(data);

  if (result.hardDrop) {
    console.error('Validation failed:');
    console.error(` - ${result.reason}`);
    process.exit(1);
  }

  for (const field of result.softDrops) {
    console.warn(`Warning: ${field} will be dropped or sanitized by the catalog.`);
  }
  for (const advisory of result.advisories) {
    console.warn(`Advisory: ${advisory}`);
  }
  console.log('Validation passed.');
} catch (err) {
  console.error('Error reading or parsing file:', err.message);
  process.exit(1);
}
