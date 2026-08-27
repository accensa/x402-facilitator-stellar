import fs from 'node:fs';
import http from 'node:http';
import { MemoryCatalogStore } from '../src/catalog/memory.js';

// Calculate DCG for a list of relevance scores
function dcg(scores) {
  return scores.reduce((sum, score, i) => sum + score / Math.log2(i + 2), 0);
}

// Calculate nDCG for a list of actual relevance scores vs ideal relevance scores
function ndcg(actualScores, idealScores) {
  const idcg = dcg(idealScores.sort((a, b) => b - a));
  if (idcg === 0) return actualScores.length === 0 ? 1 : 0;
  return dcg(actualScores) / idcg;
}

async function runEval() {
  const catalogPath = new URL('./fixtures/catalog.json', import.meta.url);
  const queriesPath = new URL('./judgements/queries.json', import.meta.url);

  const fixtures = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const judgements = JSON.parse(fs.readFileSync(queriesPath, 'utf8'));

  // Mock Embedding Server
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        if (req.url === '/embed') {
          const { input } = JSON.parse(body);
          // Very simple deterministic vector mock
          const vec = new Array(3).fill(0);
          const lower = input.toLowerCase();
          if (lower.includes('weather') || lower.includes('climate')) vec[0] = 1;
          if (lower.includes('finance') || lower.includes('currency')) vec[1] = 1;
          if (lower.includes('latitude') || lower.includes('longitude')) vec[2] = 1;

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ embedding: vec }));
        } else if (req.url === '/rerank') {
          const { documents } = JSON.parse(body);
          // Mock reranker: just return 1.0 for everything, preserving order
          const scores = documents.map(() => 1.0);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ scores }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const embeddingsUrl = `http://localhost:${port}/embed`;

  const store = new MemoryCatalogStore({ embeddingsUrl, enableReranking: true });

  // Load fixtures into memory store
  const now = Date.now();
  for (const f of fixtures) {
    await store.upsertResource(f.resource, f.source);
    // Artificially modify the last_seen_at for decay testing
    const item = store.resources.get(store._key(f.resource));
    if (item && f.daysOld) {
      item.last_seen_at = new Date(now - f.daysOld * 24 * 60 * 60 * 1000);
    }
  }

  // Wait for all background embeddings to complete before running queries.
  // flush() is deterministic — no hardcoded sleep needed.
  await store.flush();

  const K = 3;
  let totalPrecision = 0;
  let totalRecall = 0;
  let totalMRR = 0;
  let totalNDCG = 0;

  console.log(`Running evaluation against ${judgements.length} queries...\n`);

  for (const j of judgements) {
    const res = await store.search({ query: j.query, limit: K });
    const actualUrls = res.resources.map(r => r.url);

    // Relevance scores (0-3)
    const expectedMap = j.expected || {};
    const relevantCount = Object.values(expectedMap).filter(v => v > 0).length;

    let precision = 1;
    let recall = 1;
    let mrr = 0;

    if (relevantCount === 0) {
      if (actualUrls.length > 0) {
        precision = 0;
        recall = 0;
        mrr = 0;
      } else {
        precision = 1;
        recall = 1;
        mrr = 1;
      }
    } else {
      let hits = 0;
      let firstHitRank = 0;

      for (let i = 0; i < actualUrls.length; i++) {
        const url = actualUrls[i];
        if (expectedMap[url] && expectedMap[url] > 0) {
          hits++;
          if (firstHitRank === 0) firstHitRank = i + 1;
        }
      }

      precision = hits / Math.max(actualUrls.length, 1); // Avoid division by zero
      // If actualUrls is 0, precision is 0
      if (actualUrls.length === 0) precision = 0;

      recall = hits / relevantCount;
      if (firstHitRank > 0) {
        mrr = 1 / firstHitRank;
      }
    }

    // Calculate nDCG
    const actualScores = actualUrls.map(url => expectedMap[url] || 0);
    const idealScores = Object.values(expectedMap).filter(v => v > 0);
    const qNDCG = ndcg(actualScores, idealScores);

    totalPrecision += precision;
    totalRecall += recall;
    totalMRR += mrr;
    totalNDCG += qNDCG;

    console.log(`Query: "${j.query}"`);
    console.log(
      `  P@${K}: ${precision.toFixed(2)} | R@${K}: ${recall.toFixed(2)} | MRR: ${mrr.toFixed(2)} | nDCG: ${qNDCG.toFixed(2)}`,
    );
  }

  const N = judgements.length;
  const avgPrecision = totalPrecision / N;
  const avgRecall = totalRecall / N;
  const avgMRR = totalMRR / N;
  const avgNDCG = totalNDCG / N;

  console.log(`\n--- Aggregate Metrics ---`);
  console.log(`Precision@${K}: ${avgPrecision.toFixed(3)}`);
  console.log(`Recall@${K}:    ${avgRecall.toFixed(3)}`);
  console.log(`MRR:           ${avgMRR.toFixed(3)}`);
  console.log(`nDCG:          ${avgNDCG.toFixed(3)}`);

  // Define thresholds to prevent regressions
  const THRESHOLDS = {
    ndcg: 0.85,
    mrr: 0.8,
  };

  let failed = false;
  if (avgNDCG < THRESHOLDS.ndcg) {
    console.error(
      `\n❌ Regression: nDCG (${avgNDCG.toFixed(3)}) is below threshold (${THRESHOLDS.ndcg})`,
    );
    failed = true;
  }
  if (avgMRR < THRESHOLDS.mrr) {
    console.error(
      `\n❌ Regression: MRR (${avgMRR.toFixed(3)}) is below threshold (${THRESHOLDS.mrr})`,
    );
    failed = true;
  }

  if (failed) {
    server.close();
    process.exit(1);
  } else {
    console.log('\n✅ Evaluation passed!');
    server.close();
  }
}

runEval().catch(err => {
  console.error('Eval failed:', err);
  process.exit(1);
});
