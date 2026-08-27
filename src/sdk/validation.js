import { validateDiscoveryPolicy } from '../catalog/validation.js';

export function validateDiscoveryDeclaration(decl) {
  const result = validateDiscoveryPolicy(decl);
  return result.hardDrop ? [result.reason, ...result.softDrops] : result.advisories;
}

export { validateDiscoveryPolicy };
