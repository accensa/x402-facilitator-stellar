import { createMetrics } from './src/metrics.js';
const m = createMetrics();
m.incRpcRetry({ code: 'ETIMEDOUT' });
console.log(m.render());
