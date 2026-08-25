// Public surface for the x402 MCP server module.
// Re-exports the core server class so external callers can
// import from 'src/mcp' without coupling to internal file names.
export { McpServer } from './server.js';
