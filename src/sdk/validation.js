export function validateDiscoveryDeclaration(decl) {
  const errors = [];
  if (!decl || typeof decl !== 'object') {
    return ['Declaration must be an object'];
  }
  if (!decl.routeTemplate) errors.push('routeTemplate is required');

  // Check for parameter descriptions if parameters exist in template
  if (decl.routeTemplate) {
    const matches = decl.routeTemplate.match(/\{([^}]+)\}/g) || [];
    const seen = new Set();
    for (const raw of matches) {
      const name = raw.slice(1, -1).trim();
      if (!name) {
        errors.push('routeTemplate contains an empty parameter placeholder');
        continue;
      }
      // Parameter names: start with letter/underscore, then word chars (no dots/spaces)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push(`Invalid routeTemplate parameter name: ${name}`);
        continue;
      }
      if (seen.has(name)) {
        continue; // report missing description once
      }
      seen.add(name);
      const desc = Object.hasOwn(decl.parameters ?? {}, name) ? decl.parameters[name] : undefined;
      if (typeof desc !== 'string' || desc.trim() === '') {
        errors.push(`Missing description for parameter: ${name}`);
      }
    }
  }

  if (!decl.pricing || typeof decl.pricing !== 'object') {
    errors.push('pricing object is required');
  } else {
    if (!decl.pricing.amount) errors.push('pricing.amount is required');
    if (!decl.pricing.asset) errors.push('pricing.asset is required');
  }

  return errors;
}
