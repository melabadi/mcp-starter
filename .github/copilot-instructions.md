# MCP Setup

- Use the official MCP TypeScript SDK v2. Do not implement JSON-RPC or MCP handshakes manually.
- SDK documentation: https://ts.sdk.modelcontextprotocol.io/v2/
- SDK source and examples: https://github.com/modelcontextprotocol/typescript-sdk
- Protocol specification: https://modelcontextprotocol.io/specification/latest
- Registry API: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/api/openapi.yaml
- Use Node.js 22.18+ native TypeScript support and run `npm test` and `npm run typecheck` after code changes.
- Keep the demo tools read-only and free of private data. Never add credentials to code, catalog entries, logs, or screenshots.
- Keep Azure resources in Bicep and deployment commands in PowerShell scripts using Azure CLI.
- Keep registry catalog edits in source control. The registry intentionally has no public write API.