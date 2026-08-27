import crypto from 'node:crypto';
import { clearInterval, setInterval, setTimeout } from 'node:timers';
import { createEd25519Signer } from '@x402/stellar';

function keyId(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function normaliseKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('Key source must return a non-empty keys array.');
  }
  const seen = new Set();
  return keys.map(entry => {
    const secret = typeof entry === 'string' ? entry : entry?.secret;
    if (!secret || typeof secret !== 'string' || !secret.startsWith('S')) {
      throw new Error('Key source returned an invalid Stellar secret key.');
    }
    const kid = typeof entry === 'string' ? keyId(secret) : entry.kid || keyId(secret);
    if (seen.has(kid)) throw new Error(`Key source returned duplicate kid: ${kid}`);
    seen.add(kid);
    return { kid, secret };
  });
}

export class KeyManager {
  constructor({
    network,
    secrets,
    loadKeys,
    pollIntervalMs = 0,
    createSigner = createEd25519Signer,
  }) {
    if (!network) throw new Error('KeyManager requires a network.');
    this.network = network;
    this.loadKeys = loadKeys;
    this.createSigner = createSigner;
    this.pollIntervalMs = pollIntervalMs;
    this.generations = new Map();
    this.currentGeneration = 0;
    this.timer = null;
    this.refreshPromise = null;
    this.onRefresh = null;
    this.retirementGraceMs = 60_000;
    this._install(normaliseKeys(secrets));
  }

  _install(keys) {
    const generation = ++this.currentGeneration;
    const entries = new Map(
      keys.map(({ kid, secret }) => [
        kid,
        { kid, secret, signer: this.createSigner(secret, this.network), leases: 0 },
      ]),
    );
    this.generations.set(generation, { generation, entries, retiredAt: null });
    for (const state of this.generations.values()) {
      if (state.generation !== generation && !state.retiredAt) {
        state.retiredAt = Date.now();
        setTimeout(() => {
          this._purgeRetired();
        }, this.retirementGraceMs).unref?.();
      }
    }
    this._purgeRetired();
    return generation;
  }

  _purgeRetired() {
    for (const [generation, state] of this.generations) {
      if (
        generation !== this.currentGeneration &&
        state.retiredAt + this.retirementGraceMs <= Date.now() &&
        [...state.entries.values()].every(entry => entry.leases === 0)
      ) {
        this.generations.delete(generation);
      }
    }
  }

  getCurrent() {
    return this.generations.get(this.currentGeneration);
  }

  getActiveKeyIds() {
    return [...this.getCurrent().entries.keys()];
  }

  snapshot() {
    const state = this.getCurrent();
    for (const entry of state.entries.values()) entry.leases += 1;
    return {
      generation: state.generation,
      entries: [...state.entries.values()],
      release: () => {
        for (const entry of state.entries.values()) entry.leases = Math.max(0, entry.leases - 1);
        this._purgeRetired();
      },
    };
  }

  async refresh() {
    if (!this.loadKeys) return false;
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = Promise.resolve()
      .then(() => this.loadKeys())
      .then(async keys => {
        const next = normaliseKeys(keys);
        const current = this.getCurrent();
        if (
          next.length === current.entries.size &&
          next.every(({ kid }) => current.entries.has(kid))
        ) {
          return false;
        }
        this._install(next);
        await this.onRefresh?.();
        return true;
      })
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  start() {
    if (!this.loadKeys || this.pollIntervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      this.refresh().catch(err => console.warn(`[KeyManager] refresh failed: ${err.message}`));
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export { keyId };
