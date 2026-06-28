// Read-only MCP server — exposes Supabase tables to Claude.ai connectors.
// Auth: Bearer token via MCP_BEARER_TOKEN env var.
// Data: service-role key (server-side only, never browser-exposed).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

const SUPABASE_URL  = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const BEARER_TOKEN  = process.env.MCP_AUTH_TOKEN ?? '';

// In-memory session store (per Vercel instance; resets on cold start — fine for personal use)
const sessions = new Map();

async function fetchOpenApiSpec() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

function buildServer() {
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

  const mcp = new McpServer({
    name: 'mydashboard',
    version: '1.0.0',
    description: 'Read-only access to MyDashboard Supabase data'
  });

  // ── list_tables ──────────────────────────────────────────────────────────────
  mcp.tool('list_tables', 'List every table in the database', {}, async () => {
    try {
      const spec   = await fetchOpenApiSpec();
      const tables = Object.keys(spec.definitions ?? {});
      return {
        content: [{ type: 'text', text: tables.length ? tables.join('\n') : '(no tables found)' }]
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });

  // ── describe_table ───────────────────────────────────────────────────────────
  mcp.tool(
    'describe_table',
    'Show columns, types, and nullability for a table',
    { table_name: z.string().describe('Table name to inspect') },
    async ({ table_name }) => {
      try {
        const spec = await fetchOpenApiSpec();
        const def  = spec.definitions?.[table_name];
        if (!def) {
          return { content: [{ type: 'text', text: `Table '${table_name}' not found` }], isError: true };
        }
        const required = new Set(def.required ?? []);
        const cols = Object.entries(def.properties ?? {}).map(([col, prop]) => {
          const type     = prop.format ?? prop.type ?? 'unknown';
          const nullable = required.has(col) ? 'NOT NULL' : 'nullable';
          const desc     = prop.description ? `  — ${prop.description}` : '';
          return `  ${col}  (${type}, ${nullable})${desc}`;
        });
        return { content: [{ type: 'text', text: `${table_name}:\n${cols.join('\n')}` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── query_table ──────────────────────────────────────────────────────────────
  mcp.tool(
    'query_table',
    'Select rows from a table with optional filtering and sorting',
    {
      table_name: z.string().describe('Table to query'),
      columns:    z.string().optional().describe('Comma-separated columns (default: all)'),
      eq_column:  z.string().optional().describe('Column name to filter by (equality)'),
      eq_value:   z.string().optional().describe('Value to match for eq_column'),
      order_by:   z.string().optional().describe('Column to sort by'),
      ascending:  z.boolean().optional().describe('Sort ascending? (default: true)'),
      limit:      z.number().int().min(1).max(500).optional().describe('Max rows (default: 50)')
    },
    async ({ table_name, columns, eq_column, eq_value, order_by, ascending, limit }) => {
      try {
        let q = sb.from(table_name).select(columns ?? '*').limit(limit ?? 50);
        if (eq_column != null && eq_value != null) q = q.eq(eq_column, eq_value);
        if (order_by) q = q.order(order_by, { ascending: ascending !== false });
        const { data, error } = await q;
        if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
        const text = data.length === 0
          ? `No rows found in '${table_name}'`
          : JSON.stringify(data, null, 2);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── count_rows ───────────────────────────────────────────────────────────────
  mcp.tool(
    'count_rows',
    'Count rows in a table, optionally filtered',
    {
      table_name: z.string(),
      eq_column:  z.string().optional().describe('Column to filter by'),
      eq_value:   z.string().optional().describe('Value to match')
    },
    async ({ table_name, eq_column, eq_value }) => {
      try {
        let q = sb.from(table_name).select('*', { count: 'exact', head: true });
        if (eq_column != null && eq_value != null) q = q.eq(eq_column, eq_value);
        const { count, error } = await q;
        if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
        return { content: [{ type: 'text', text: `${count} rows in '${table_name}'` }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── aggregate_column ─────────────────────────────────────────────────────────
  mcp.tool(
    'aggregate_column',
    'Compute count, sum, average, min, and max of a numeric column',
    {
      table_name: z.string(),
      column:     z.string().describe('Numeric column to aggregate')
    },
    async ({ table_name, column }) => {
      try {
        const { data, error } = await sb.from(table_name).select(column);
        if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
        const vals = (data ?? []).map(r => Number(r[column])).filter(v => !isNaN(v));
        if (!vals.length) return { content: [{ type: 'text', text: 'No numeric values found' }] };
        const sum = vals.reduce((a, b) => a + b, 0);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              count: vals.length,
              sum:   +sum.toFixed(4),
              avg:   +(sum / vals.length).toFixed(4),
              min:   Math.min(...vals),
              max:   Math.max(...vals)
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  // ── get_table_summary ────────────────────────────────────────────────────────
  mcp.tool(
    'get_table_summary',
    'Get row count plus a sample of recent rows from a table',
    {
      table_name:  z.string(),
      sample_size: z.number().int().min(1).max(20).optional().describe('Rows to sample (default: 5)')
    },
    async ({ table_name, sample_size }) => {
      try {
        const [countRes, sampleRes] = await Promise.all([
          sb.from(table_name).select('*', { count: 'exact', head: true }),
          sb.from(table_name).select('*').limit(sample_size ?? 5)
        ]);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              total_rows: countRes.count ?? '?',
              sample:     sampleRes.data ?? []
            }, null, 2)
          }]
        };
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  return mcp;
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers required by Claude.ai
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Auth check
  const auth = (req.headers['authorization'] ?? '').trim();
  if (!BEARER_TOKEN || auth !== `Bearer ${BEARER_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized — set Authorization: Bearer <MCP_AUTH_TOKEN>' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var not set' });
  }

  const sessionId = req.headers['mcp-session-id'];

  try {
    if (req.method === 'POST') {
      let transport;

      if (sessionId && sessions.has(sessionId)) {
        // Reuse existing session transport
        transport = sessions.get(sessionId);
      } else {
        // New session
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
            setTimeout(() => sessions.delete(id), 30 * 60 * 1000); // 30-min TTL
          }
        });
        const server = buildServer();
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);

    } else if (req.method === 'GET') {
      // SSE stream for server→client notifications
      if (!sessionId || !sessions.has(sessionId)) {
        return res.status(400).json({
          error: 'No active session. POST /api/mcp with an initialize message first.'
        });
      }
      await sessions.get(sessionId).handleRequest(req, res);

    } else if (req.method === 'DELETE') {
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId).close();
        sessions.delete(sessionId);
      }
      res.status(204).end();

    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error('[MCP]', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
}
