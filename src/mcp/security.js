/**
 * Worker-thread sandbox for MCP tool execution (#417).
 *
 * Provides isolation for external tool calls to prevent runaway executions
 * and limit blast radius of malicious tool inputs.
 */
import { Worker, isMainThread } from 'node:worker_threads';
import { McpInputError } from './sanitize.js';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_PAYLOAD_SIZE = 1024 * 1024; // 1MB

/**
 * Executes a tool handler inside a worker thread with timeout and resource limits.
 *
 * @param {Function} handler - the tool handler function to execute
 * @param {object} params - parameters to pass to the handler
 * @param {object} [options]
 * @param {number} [options.timeoutMs=30000] - execution timeout in milliseconds
 * @param {number} [options.maxPayloadSize=1048576] - max result payload size in bytes
 * @returns {Promise<object>} result from the handler
 * @throws {McpInputError} if execution fails, times out, or exceeds limits
 */
export async function executeInSandbox(handler, params, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxPayloadSize = MAX_PAYLOAD_SIZE } = options;

  if (isMainThread) {
    return executeInWorker(handler, params, { timeoutMs, maxPayloadSize });
  }

  // If already in a worker, execute directly (for nested calls or testing)
  return executeDirectly(handler, params, { timeoutMs, maxPayloadSize });
}

/**
 * Executes the handler in a separate worker thread.
 */
function executeInWorker(handler, params, options) {
  return new Promise((resolve, reject) => {
    const workerCode = `
      const { parentPort, workerData } = require('node:worker_threads');
      
      (async () => {
        try {
          const { timeoutMs, maxPayloadSize } = workerData.options;
          
          const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('execution_timeout')), timeoutMs);
          });
          
          const execPromise = (async () => {
            const handlerCode = workerData.handlerCode;
            const handlerParams = workerData.params;
            
            let handlerFn;
            try {
              handlerFn = new Function('return ' + handlerCode)();
            } catch (err) {
              parentPort.postMessage({ error: 'handler_deserialization_failed', message: err.message });
              return;
            }
            
            const result = await handlerFn(handlerParams);
            const serialized = JSON.stringify(result);
            if (serialized && serialized.length > maxPayloadSize) {
              throw new Error('payload_too_large');
            }
            return result;
          })();
          
          const result = await Promise.race([execPromise, timeoutPromise]);
          parentPort.postMessage({ result });
        } catch (err) {
          parentPort.postMessage({ error: err.name, message: err.message });
        }
      })();
    `;

    const handlerCode = handler.toString();

    if (handlerCode.length > 50000) {
      throw new McpInputError('handler too large for sandbox execution');
    }

    const worker = new Worker(workerCode, {
      eval: true,
      workerData: { handlerCode, params, options },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 64,
        codeRangeSizeMb: 32,
      },
    });

    let completed = false;
    const timeout = setTimeout(() => {
      if (!completed) {
        completed = true;
        worker.terminate().catch(() => {});
        reject(new McpInputError('tool execution timed out', { field: 'timeout' }));
      }
    }, options.timeoutMs + 1000);

    worker.on('message', msg => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      worker.terminate().catch(() => {});

      if (msg.error) {
        if (msg.error === 'execution_timeout') {
          reject(new McpInputError('tool execution timed out', { field: 'timeout' }));
        } else if (msg.error === 'payload_too_large') {
          reject(new McpInputError('tool result exceeds maximum size', { field: 'payload_size' }));
        } else {
          reject(
            new McpInputError(`tool execution failed: ${msg.message}`, { field: 'execution' }),
          );
        }
      } else {
        resolve(msg.result);
      }
    });

    worker.on('error', err => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      reject(new McpInputError(`sandbox error: ${err.message}`, { field: 'sandbox' }));
    });

    worker.on('exit', code => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new McpInputError(`sandbox exited with code ${code}`, { field: 'sandbox' }));
      }
    });
  });
}

/**
 * Executes the handler directly with timeout enforcement (for testing or when already in worker).
 */
async function executeDirectly(handler, params, options) {
  const { timeoutMs, maxPayloadSize } = options;

  const timeoutPromise = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('execution_timeout')), timeoutMs);
    timer.unref?.();
  });

  const execPromise = (async () => {
    const result = await handler(params);
    const serialized = JSON.stringify(result);
    if (serialized && serialized.length > maxPayloadSize) {
      throw new Error('payload_too_large');
    }
    return result;
  })();

  return Promise.race([execPromise, timeoutPromise]);
}

/**
 * Input validation patterns for common injection attacks.
 * Order matters: more specific patterns should come before general ones.
 */
export const INJECTION_PATTERNS = {
  pathTraversal: /\.\.[/\\]|~[/\\]|[/\\](?:etc|proc|sys|dev|var|tmp|root|home)[/\\]/i,
  sqlInjection:
    /\b(?:union|select|insert|update|delete|drop|create|alter|exec|execute)\b.*\b(?:from|into|table|database|values|set|where)\b/i,
  scriptInjection: /<script|javascript:|on\w+\s*=/i,
  commandInjection:
    /[;&|`$(){}[\]<>]|\b(?:rm|cat|ls|cp|mv|chmod|chown|wget|curl|nc|bash|sh|python|perl|ruby|node)\b/i,
};

/**
 * Validates input against common injection patterns.
 *
 * @param {string} value - input value to validate
 * @param {string} fieldName - name of the field (for error messages)
 * @throws {McpInputError} if injection pattern detected
 */
export function validateAgainstInjection(value, fieldName) {
  if (typeof value !== 'string') return;

  for (const [type, pattern] of Object.entries(INJECTION_PATTERNS)) {
    if (pattern.test(value)) {
      throw new McpInputError(`'${fieldName}' contains potentially malicious content (${type})`, {
        field: fieldName,
        injectionType: type,
      });
    }
  }
}

/**
 * Recursively validates all string values in an object against injection patterns.
 *
 * @param {object} obj - object to validate
 * @param {string} [prefix=''] - field prefix for nested objects
 * @throws {McpInputError} if injection pattern detected
 */
export function validateObjectAgainstInjection(obj, prefix = '') {
  if (!obj || typeof obj !== 'object') return;

  for (const [key, value] of Object.entries(obj)) {
    const fieldName = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') {
      validateAgainstInjection(value, fieldName);
    } else if (typeof value === 'object' && value !== null) {
      validateObjectAgainstInjection(value, fieldName);
    }
  }
}

/**
 * Default sandbox configuration for MCP tools.
 */
export const DEFAULT_SANDBOX_CONFIG = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
  maxPayloadSize: MAX_PAYLOAD_SIZE,
  validateInput: true,
  validateOutput: false,
};

/**
 * Creates a sandboxed tool wrapper with injection validation and timeout.
 *
 * @param {Function} handler - the tool handler
 * @param {object} [config] - sandbox configuration
 * @returns {Function} wrapped handler
 */
export function createSandboxedTool(handler, config = {}) {
  const sandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, ...config };

  return async params => {
    if (sandboxConfig.validateInput) {
      validateObjectAgainstInjection(params);
    }

    const result = await executeInSandbox(handler, params, {
      timeoutMs: sandboxConfig.timeoutMs,
      maxPayloadSize: sandboxConfig.maxPayloadSize,
    });

    if (sandboxConfig.validateOutput) {
      validateObjectAgainstInjection(result);
    }

    return result;
  };
}

export default {
  executeInSandbox,
  createSandboxedTool,
  validateAgainstInjection,
  validateObjectAgainstInjection,
  INJECTION_PATTERNS,
  DEFAULT_SANDBOX_CONFIG,
};
