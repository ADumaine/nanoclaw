# Chapter Onboarding: MCP Server on the MonDAI API

> Companion to [nanoclaw-api-consumers.md](nanoclaw-api-consumers.md) and [api_server_summary.md](api_server_summary.md).
> Written from the NanoClaw side without a checkout of the CM Data API repo — file/function names for the DB layer are best guesses from `api_server_summary.md`; adjust import paths to match the real repo.

## Why this instead of a skillscript-side connector

The chapter onboarding skills (skillscript-runtime, see `[[project_chapter_onboarding]]`) need to read/update chapters and send emails. Two ways to wire that:

1. **Custom `McpConnector` inside skillscript** — fork `McpConnectorTemplate`, write a custom bootstrap (`registerConnectorClass` must run before `loadConnectorsConfig`), rebuild the `skillscript-dashboard` image, restart. One-off; only skillscript benefits.
2. **MCP server on the MonDAI API itself** (this doc) — skillscript's bundled `HttpMcpConnector` speaks Streamable HTTP MCP directly. Zero new code in skillscript — just a `connectors.json` entry + container restart. Any other MCP client (Claude Desktop, future agents) can point at the same endpoint too.

(2) is the better architecture. This doc covers the MonDAI API side; the skillscript side is one JSON block (§4).

Either way, the API token that authenticates skillscript-cm's calls has to live in skillscript-cm's own env — it's a separate Docker service, not a NanoClaw agent container, so it can't pull from the OneCLI vault the way agent-runner containers do. That's an inherent cost of running skillscript-cm outside NanoClaw's container orchestration, not something this design choice changes.

## 1. Dependency

```bash
npm install @modelcontextprotocol/sdk
```

## 2. Tool definitions — `server/mcp/tools.js`

Mirrors the tool contracts NanoClaw's agent-runner already relies on (`container/agent-runner/src/mcp-tools/mondai.ts`) so behavior stays identical for both consumers. Point the four `TODO` calls at whatever your `/chapters` route and `/email/send` route actually call internally — ideally the exact same service functions, so there's one implementation behind both the REST route and the MCP tool.

```js
// server/mcp/tools.js
// Tool surface: get_chapters, get_chapter, update_chapter, send_email.
// Reuses the same DB/service functions the /chapters and /email/send
// REST routes already call — do not reimplement the query logic here.

const db = require('../services/db.js');       // TODO: point at your real chapters query/update functions
const mailer = require('../services/mailer.js'); // TODO: point at your real Mailgun send function

const tools = [
  {
    tool: {
      name: 'get_chapters',
      description: 'Query CryptoMondays chapters. Supports optional filtering by name (partial match), country, and status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filter by chapter name (case-insensitive partial match).' },
          country: { type: 'string', description: 'Filter by country.' },
          status: { type: 'string', enum: ['active', 'inactive', 'pending'], description: 'Filter by chapter status (defaults to active).' },
        },
        additionalProperties: false,
      },
    },
    async handler(args) {
      const chapters = await db.getChapters({ name: args.name, country: args.country, status: args.status });
      return { content: [{ type: 'text', text: JSON.stringify(chapters, null, 2) }] };
    },
  },

  {
    tool: {
      name: 'get_chapter',
      description: 'Get a single CryptoMondays chapter by its UUID.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Chapter UUID.' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const chapter = await db.getChapterById(args.id);
      return { content: [{ type: 'text', text: JSON.stringify(chapter, null, 2) }] };
    },
  },

  {
    tool: {
      name: 'update_chapter',
      description: 'Update a chapter record. Chapter Leads may update their own chapter; admins can update any chapter.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Chapter UUID.' },
          description: { type: 'string' },
          co_organizers: { type: 'array', items: { type: 'string' } },
          luma_link: { type: 'string' },
          meetup_link: { type: 'string' },
          image_url: { type: 'string' },
          status: { type: 'string', enum: ['active', 'inactive', 'pending'], description: 'Onboarding/lifecycle status.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const { id, ...fields } = args;
      const updated = await db.updateChapter(id, fields);
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    },
  },

  {
    tool: {
      name: 'send_email',
      description: 'Send an email via Mailgun to one or more recipients.',
      inputSchema: {
        type: 'object',
        properties: {
          recipients: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          subject: { type: 'string' },
          htmlBody: { type: 'string' },
        },
        required: ['recipients', 'subject', 'htmlBody'],
        additionalProperties: false,
      },
    },
    async handler(args) {
      const result = await mailer.send({ to: args.recipients, subject: args.subject, html: args.htmlBody });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  },
];

module.exports = { tools };
```

## 3. MCP server + Express route — `server/mcp/index.js`

Same low-level `Server` + `setRequestHandler` shape NanoClaw's own agent-runner uses (`container/agent-runner/src/mcp-tools/server.ts`), swapping `StdioServerTransport` for `StreamableHTTPServerTransport` since this runs as an HTTP endpoint, not a spawned subprocess. Stateless mode (`sessionIdGenerator: undefined`) — build a fresh `Server` + `transport` per request — is the simplest correct shape for a plain Express handler; no session store needed.

```js
// server/mcp/index.js
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { tools } = require('./tools.js');

const toolMap = new Map(tools.map((t) => [t.tool.name, t]));

function buildServer() {
  const server = new Server({ name: 'cm-data-api', version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    try {
      return await tool.handler(args ?? {});
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });

  return server;
}

// Stateless: one Server + one transport per HTTP request.
async function handleMcpRequest(req, res) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}

module.exports = { handleMcpRequest };
```

## 4. Mount in `server/server.js`

Reuse the existing `checkApiToken` middleware — same auth model every other agent-facing route already uses, so `CM_AGENT_TOKEN` continues to be the one credential that matters (skillscript-cm just needs a copy of it in its own env, see §5).

```js
const { handleMcpRequest } = require('./mcp/index.js');
const checkApiToken = require('./middleware/checkAPIToken.js'); // adjust to actual path/export shape

app.post('/mcp/chapters', checkApiToken, handleMcpRequest);
```

Sanity-check the endpoint directly before wiring skillscript to it:

```bash
curl -s -X POST http://<api-host>/mcp/chapters \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CM_AGENT_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}},"id":1}'

curl -s -X POST http://<api-host>/mcp/chapters \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $CM_AGENT_TOKEN" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2}'
```

## 5. Wire it into skillscript

Edit `/mnt/merge/skillscript-cm/data/connectors.json` (mounted as `$SKILLSCRIPT_HOME/connectors.json` inside the `skillscript-dashboard` container):

```json
{
  "mondai": {
    "class": "HttpMcpConnector",
    "config": {
      "endpoint": "http://<api-host>/mcp/chapters",
      "headers": {
        "Authorization": "Bearer ${CM_AGENT_TOKEN}"
      }
    }
  }
}
```

`CM_AGENT_TOKEN` resolves from the `skillscript-dashboard` container's own env — add it there (this is the duplicated-credential point flagged in §"Why"). Restart the container to reload config:

```bash
docker restart skillscript-dashboard
```

Confirm it's live:

```bash
curl -s -X POST http://localhost:7878/rpc -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"runtime_capabilities","arguments":{"include":["mcpConnectors"]}},"id":1}'
```

## 6. Example skill using it

```
# Skill: pending-chapters-report
# Description: Lists chapters currently in "pending" status for onboarding triage.
# Status: Draft
# Autonomous: false

${CHAPTERS.items|length} chapter(s) pending onboarding.

run:
    $ mondai.get_chapters status="pending" -> RAW
    $ json_parse ${RAW} -> CHAPTERS

default: run
```

`lint_skill` / `compile_skill` it the same way as `chapter-onboarding-log` before writing + approving. Note `mondai.get_chapters` returns MCP tool content (`{content:[{type:"text", text:"..."}]}`) from the API server — confirm the exact shape via a `compile_skill` dry run or `skill_preflight` probe before assuming `${RAW}` is directly the JSON string; adjust the `json_parse` step if the SDK wraps it differently.
