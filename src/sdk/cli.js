#!/usr/bin/env node
import fs from 'fs';
import { validateDiscoveryPolicy } from '../catalog/validation.js';

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
    console.warn(`Warning: ${field} will be dropped by the catalog.`);
  }
  // Truncation is not a drop (#219): the field is stored, only shortened.
  // Saying "will be dropped or sanitized" for both left the seller unable to
  // tell which of their fields had actually been discarded.
  for (const field of result.truncations ?? []) {
    console.warn(`Warning: ${field} will be kept but shortened by the catalog.`);
  }
  for (const advisory of result.advisories) {
    console.warn(`Advisory: ${advisory}`);
  }
  console.log('Validation passed.');
} catch (err) {
  console.error('Error reading or parsing file:', err.message);
  process.exit(1);
}
