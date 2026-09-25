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

  // Dropped and shortened are different fates and get different warnings
  // (#219): a dropped field is absent from the listing, a truncated one is
  // present but ends early.
  for (const field of result.softDrops) {
    console.warn(`Warning: ${field} will be dropped by the catalog.`);
  }
  for (const field of result.truncations) {
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
