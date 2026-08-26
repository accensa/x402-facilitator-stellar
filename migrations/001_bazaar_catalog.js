/**
 * 001: Bazaar catalog — discovery_resources table.
 *
 * Stores API/tool metadata discovered through the Bazaar protocol. Identity
 * is (url, tool_name) with NULLS NOT DISTINCT so two HTTP resources at the
 * same URL collapse, while an MCP tool at the same host gets its own row.
 *
 * Converted from the original 001_bazaar_catalog.sql for node-pg-migrate.
 */

export const up = pgm => {
  pgm.createTable('discovery_resources', {
    id: 'SERIAL PRIMARY KEY',
    type: { type: 'VARCHAR(50)', notNull: true },
    url: { type: 'TEXT', notNull: true },
    tool_name: { type: 'VARCHAR(255)' },
    service_name: { type: 'VARCHAR(255)' },
    description: { type: 'TEXT' },
    tags: { type: 'JSONB', default: "'[]'" },
    mime_type: { type: 'VARCHAR(100)' },
    pay_to: { type: 'TEXT' },
    network: { type: 'VARCHAR(50)' },
    scheme: { type: 'VARCHAR(50)' },
    pricing: { type: 'JSONB' },
    extensions: { type: 'JSONB', default: "'{}'" },
    route_template: { type: 'TEXT' },
    icon_url: { type: 'TEXT' },
    first_seen_at: { type: 'TIMESTAMP', default: 'CURRENT_TIMESTAMP' },
    last_seen_at: { type: 'TIMESTAMP', default: 'CURRENT_TIMESTAMP' },
    last_payment_at: { type: 'TIMESTAMP' },
    source: { type: 'VARCHAR(50)' },
  });

  // UNIQUE NULLS NOT DISTINCT: two HTTP resources at the same URL collapse,
  // but an MCP tool (non-null tool_name) at the same host keeps its own row.
  pgm.addConstraint(
    'discovery_resources',
    'discovery_resources_url_tool_name_key',
    'UNIQUE NULLS NOT DISTINCT (url, tool_name)',
  );

  pgm.createIndex('discovery_resources', 'type');
  pgm.createIndex('discovery_resources', 'tags', { method: 'GIN' });
  pgm.createIndex('discovery_resources', 'last_seen_at');
};

export const down = pgm => {
  pgm.dropTable('discovery_resources');
};
