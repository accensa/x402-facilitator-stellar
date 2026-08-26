import { AsyncLocalStorage } from 'node:async_hooks';

export const requestState = new AsyncLocalStorage();
