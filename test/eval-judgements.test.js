import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const QUERIES = fileURLToPath(new URL('../eval/judgements/queries.json', import.meta.url));
const CATALOG = fileURLToPath(new URL('../eval/fixtures/catalog.json', import.meta.url));

function loadFixtureUrls() {
  const fixtures = JSON.parse(readFileSync(CATALOG, 'utf8'));
  assert.ok(
    Array.isArray(fixtures) && fixtures.length > 0,
    'eval/fixtures/catalog.json must be a non-empty array',
  );
  for (const [index, fixture] of fixtures.entries()) {
    assert.ok(
      typeof fixture?.resource?.url === 'string' && fixture.resource.url.length > 0,
      `eval/fixtures/catalog.json[${index}].resource.url must be a non-empty string`,
    );
  }
  return new Set(fixtures.map(fixture => fixture.resource.url));
}

const FIXTURE_URLS = loadFixtureUrls();
const RAW_JUDGEMENTS = readFileSync(QUERIES, 'utf8');

function duplicateObjectKeys(raw) {
  const duplicates = [];
  const stack = [];
  let i = 0;
  let pendingPath = null;

  const readString = start => {
    i = start + 1;
    while (i < raw.length) {
      if (raw[i] === '\\') {
        i += 2;
      } else if (raw[i] === '"') {
        i += 1;
        return JSON.parse(raw.slice(start, i));
      } else {
        i += 1;
      }
    }
    return JSON.parse(raw.slice(start, i));
  };

  while (i < raw.length) {
    const ch = raw[i];
    const frame = stack.at(-1);

    if (/\s/.test(ch)) {
      i += 1;
    } else if (ch === '{') {
      stack.push({ keys: new Set(), path: pendingPath ?? '', expectingKey: true });
      pendingPath = null;
      i += 1;
    } else if (ch === '[') {
      stack.push({ array: true, path: pendingPath ?? '' });
      pendingPath = null;
      i += 1;
    } else if (ch === '}' || ch === ']') {
      stack.pop();
      i += 1;
    } else if (ch === ',') {
      if (frame && !frame.array) frame.expectingKey = true;
      i += 1;
    } else if (ch === '"') {
      const value = readString(i);
      if (frame && !frame.array && frame.expectingKey) {
        const keyPath = frame.path ? `${frame.path}.${value}` : value;
        if (frame.keys.has(value)) {
          duplicates.push(keyPath);
        } else {
          frame.keys.add(value);
        }
        frame.expectingKey = false;
        pendingPath = keyPath;
      }
    } else {
      i += 1;
    }
  }

  return duplicates;
}

function validateJudgements(raw, fixtureUrls) {
  const errors = [];
  let judgements;
  try {
    judgements = JSON.parse(raw);
  } catch (error) {
    return [`queries.json is not valid JSON: ${error.message}`];
  }

  for (const key of duplicateObjectKeys(raw)) {
    errors.push(
      `queries.json has duplicate key "${key}" (JSON.parse silently keeps only the last value)`,
    );
  }

  if (!Array.isArray(judgements)) {
    errors.push('queries.json must be an array of query objects');
    return errors;
  }
  if (judgements.length === 0) {
    errors.push('queries.json must contain at least one query');
  }

  const seenQueries = new Set();
  for (const [index, entry] of judgements.entries()) {
    const label = `queries.json[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${label} must be a query object`);
      continue;
    }
    if (typeof entry.query !== 'string' || entry.query.trim() === '') {
      errors.push(`${label}.query must be a non-empty string`);
    } else if (seenQueries.has(entry.query)) {
      errors.push(`${label}.query duplicates an earlier query: "${entry.query}"`);
    } else {
      seenQueries.add(entry.query);
    }
    if (typeof entry.description !== 'string' || entry.description.trim() === '') {
      errors.push(`${label}.description must be a non-empty string`);
    }
    if (
      entry.expected === null ||
      typeof entry.expected !== 'object' ||
      Array.isArray(entry.expected)
    ) {
      errors.push(`${label}.expected must be an object mapping URLs to relevance grades`);
      continue;
    }
    for (const [url, grade] of Object.entries(entry.expected)) {
      if (url.trim() === '') {
        errors.push(`${label}.expected contains an empty URL key`);
      }
      if (!Number.isInteger(grade) || grade < 0 || grade > 3) {
        errors.push(
          `${label}.expected["${url}"] has grade ${JSON.stringify(grade)}; grades must be integers in 0..3`,
        );
      }
      if (!fixtureUrls.has(url)) {
        errors.push(
          `${label}.expected["${url}"] has no matching resource in eval/fixtures/catalog.json`,
        );
      }
    }
  }

  return errors;
}

test('committed judgement set is structurally valid and internally consistent (#745)', () => {
  const errors = validateJudgements(RAW_JUDGEMENTS, FIXTURE_URLS);
  assert.deepEqual(
    errors,
    [],
    `Invalid judgement data in eval/judgements/queries.json:\n${errors.join('\n')}`,
  );
});

test('empty expected maps remain valid for empty-result judgements', () => {
  const raw = JSON.stringify([{ query: 'unmatched', description: 'no results', expected: {} }]);
  assert.deepEqual(validateJudgements(raw, FIXTURE_URLS), []);
});

test('validator rejects each class of judgement corruption', () => {
  const url = [...FIXTURE_URLS][0];
  const quotedUrl = JSON.stringify(url);
  const valid = { query: 'valid query', description: 'valid intent', expected: { [url]: 3 } };

  const cases = [
    { raw: 'not json', message: 'is not valid JSON' },
    { raw: '{}', message: 'must be an array of query objects' },
    { raw: '[]', message: 'must contain at least one query' },
    { raw: '[null]', message: 'must be a query object' },
    {
      raw: JSON.stringify([{ ...valid, query: '' }]),
      message: '.query must be a non-empty string',
    },
    { raw: JSON.stringify([valid, valid]), message: 'duplicates an earlier query' },
    {
      raw: JSON.stringify([{ ...valid, description: '' }]),
      message: '.description must be a non-empty string',
    },
    { raw: JSON.stringify([{ ...valid, expected: [] }]), message: '.expected must be an object' },
    { raw: JSON.stringify([{ ...valid, expected: { [url]: -1 } }]), message: 'has grade -1' },
    { raw: JSON.stringify([{ ...valid, expected: { [url]: 4 } }]), message: 'has grade 4' },
    { raw: JSON.stringify([{ ...valid, expected: { [url]: 1.5 } }]), message: 'has grade 1.5' },
    { raw: JSON.stringify([{ ...valid, expected: { [url]: '3' } }]), message: 'has grade "3"' },
    {
      raw: JSON.stringify([{ ...valid, expected: { 'https://missing.example': 3 } }]),
      message: 'has no matching resource',
    },
    {
      raw: `[{"query":"q","description":"d","expected":{${quotedUrl}:3,${quotedUrl}:2}}]`,
      message: 'has duplicate key',
    },
  ];

  for (const { raw, message } of cases) {
    const errors = validateJudgements(raw, FIXTURE_URLS);
    assert.ok(
      errors.some(error => error.includes(message)),
      `expected an error containing "${message}" for ${raw}, got: ${errors.join('; ')}`,
    );
  }
});
