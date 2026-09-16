# Deployment Verification

Recorded on **16 September 2026**. See the [walkthrough](../README.md) for repeatable instructions. Screenshots were captured from the integrated VS Code browser, not recreated mockups.

This is a historical record of a disposable test Azure tenant and test GitHub enterprise, not a set of configuration values for readers to reuse. The commands below describe the original deployed revision. For the current simplified deployment steps, use [scripts/deploy.ps1](../scripts/deploy.ps1) and the [current walkthrough](../README.md#deploy-this-registry-to-azure).

## Outcome

- Deployed the MCP registry and demo server as separate Azure Container Apps in `rg-mcp-setup-demo`, `eastus2`.
- Built the image using `az acr build`; deployed it by digest with managed-identity ACR pulls.
- Replaced the enterprise registry URL only after the live API and SDK checks passed.
- Reloaded the enterprise settings page and verified the saved URL persisted.
- Preserved **MCP servers in Copilot: Enabled everywhere** and **Restrict MCP access to registry servers: Registry only**.
- Preserved the pre-existing Playwright catalog entry exactly and added the demo. No former raw-file token was persisted in this repository.
- Signed into VS Code with a Copilot seat supplied by the test enterprise and confirmed that both registry entries appeared in the `@mcp` gallery.

## Live Endpoints

| Service | URL |
| --- | --- |
| GitHub registry base URL | https://mcp-setup-registry.thankfulplant-7b59e5ca.eastus2.azurecontainerapps.io |
| Catalog API | https://mcp-setup-registry.thankfulplant-7b59e5ca.eastus2.azurecontainerapps.io/v0.1/servers |
| MCP transport | https://mcp-setup-server.thankfulplant-7b59e5ca.eastus2.azurecontainerapps.io/mcp |
| MCP health | https://mcp-setup-server.thankfulplant-7b59e5ca.eastus2.azurecontainerapps.io/healthz |

The successful live smoke report was generated at **2026-09-16T16:45:06.532Z**. Its [JSON evidence](evidence/live-verification.json) contains the endpoints, exact check names, approved server IDs, and SDK tool results.

## Checks

| Check | Result |
| --- | --- |
| `npm test` at the original deployment | 4 tests passed: [registry contract and URL safety](../tests/registry.test.ts), [HTTP protocol modes and stdio](../tests/server.test.ts) |
| `npm run typecheck` | Passed before the deployed image build; final source is also checked before publication |
| [Base Bicep](../infra/main.bicep) compilation and ARM validation | Passed |
| [App Bicep](../infra/apps.bicep) compilation and ARM validation | Passed |
| ACR image build using [Dockerfile](../Dockerfile) | Passed; runs `npm ci --omit=dev --ignore-scripts` |
| Original deployment script | Passed with release tag `20260916-02`; its former stage options have since been removed |
| Hosted GitHub Actions validation | [Run 209944546 passed](https://ms-mcaps-fantastic4.ghe.com/GHU-Recap/MCP-Setup/actions/runs/209944546) for initial commit `1f4b125` |
| Live registry list and version routes | Passed for both entries, including URL-encoded names |
| Live CORS preflight and write rejection | Passed: OPTIONS 204, writes 405 |
| Live server health and Origin rejection | Passed: health 200, untrusted Origin 403 |
| Live SDK discovery and tool calls | Passed for `legacy` and `auto` negotiation modes |
| Live invalid tool input | Rejected by the SDK/schema validation |
| Enterprise settings persistence | Confirmed after browser reload |
| VS Code enterprise registry display | Confirmed: **MCP Setup Demo** and **Playwright MCP Server** appeared in the `@mcp` gallery |
| Resolved dependency advisory check | No known CVEs found in the 21 scanned coordinates |

The [advisory output](evidence/dependency-advisories.json) is an empty findings array. It covers the resolved production dependencies plus selected development tooling on the validation host. Optional compiler binaries for other operating systems were not individually scanned. The npm install/build audits also reported zero known vulnerabilities. This is point-in-time evidence, not proof that all dependencies are safe.

## Deployment Script Simplification

[scripts/deploy.ps1](../scripts/deploy.ps1) now uses direct `az` commands, with no helper functions or stage dispatcher. Subscription selection, resource-group ownership checks, command-failure checks, and digest-pinned app deployments are retained. Provider registration is an explicit [one-time prerequisite](../README.md#2-sign-in-and-choose-settings).

[tests/deploy.test.ts](../tests/deploy.test.ts) executes the PowerShell script with fake `az` and `npm` commands. It checks the successful command flow and endpoint output, plus test failure, unrelated resource group, infrastructure failure, build failure, invalid digest, and app-deployment failure. These checks do not call Azure or change the active enterprise registry. They run as part of `npm test`; the rewritten script has **not** been redeployed to the live test environment as part of this change.

## Azure Inventory

| Resource | Type / Configuration |
| --- | --- |
| `mcp-setup-env` | Public Container Apps environment, Consumption profile |
| `mcp-setup-registry` | Registry app; HTTPS-only external ingress on container port 3000 |
| `mcp-setup-server` | MCP app; HTTPS-only external ingress on container port 3000 |
| `mcpbhqv5astiufa2` | Azure Container Registry, Basic, admin account disabled |
| `mcp-setup-pull` | User-assigned identity, ACR-scoped `AcrPull` |
| `mcp-setup-logs` | Log Analytics, 30-day retention, 0.1 GB ingestion cap |

Both apps use 0.25 CPU, 0.5 GiB memory, and 0-1 replicas. The verified ready server revision was `mcp-setup-server--0000001`; registry traffic was confirmed to route 100% to its latest ready revision.

Image deployed:

```text
mcpbhqv5astiufa2.azurecr.io/mcp-setup@sha256:b841e3c7aa06896cbb1f383f041f2bfbffcc5ed2423f61687e0c5dc4e84788fd
```

The ACR build's Node base image digest was:

```text
node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
```

## Screenshots

### Enterprise Before Migration

The registry URL field is masked because the old value contained an access token. The later saved-configuration screenshot leaves the replacement URL visible because that endpoint is public and credential-free. The different treatment is intentional, and the existing enforcement policy was retained.

![Original enterprise settings with sensitive URL masked](images/01-github-mcp-before.png)

### Saved Enterprise Configuration

The new credential-free Azure base URL persisted after reloading the page. The policy remains **Registry only**.

![Saved enterprise MCP registry configuration](images/02-github-enterprise-registry.png)

### Azure Registry Response

The live `/v0.1/servers` response lists the demo and the preserved Playwright entry. The browser displays the service's actual JSON response.

![Live registry JSON](images/03-azure-registry-api.png)

### Azure Server Health

The live health endpoint identifies the service, Streamable HTTP endpoint, and two tools. Protocol success is established separately by the SDK checks, not by this screenshot alone.

![Live MCP server health JSON](images/04-azure-server-health.png)

### VS Code Enterprise Registry Display

After the user switched to GitHub Copilot provided by the same test enterprise, VS Code displayed both entries returned by the enterprise registry. This closes the earlier client-gallery visibility gap.

![VS Code displaying both enterprise MCP registry entries](images/05-vscode-enterprise-mcp-gallery.png)

This is evidence of registry retrieval and rendering only. The **MCP Setup Demo** entry shows a warning badge in this window, so installation/startup health must be checked separately with **MCP: List Servers > Show Output**. The deprecation banner at the top is a VS Code extension warning and is not evidence that the registry API failed.

## Issues Found and Resolved

1. The existing token-bearing raw catalog URL returned 404. Its source file was recovered using the authenticated GitHub browser and migrated into v0.1 response wrappers.
2. Published Azure Verified Module types differed from older tool examples. Compilation caught the logging input and daily-quota type differences; the code uses the current module inputs.
3. ACR Basic rejected the module's default network rule set. The code now explicitly selects `Allow` for public networking while retaining authenticated image access.
4. The environment module defaulted to disabled public access. Live checks caught the resulting Azure 403; the public demo environment is now explicitly enabled in Bicep.
5. The Windows npm PowerShell shim misparsed call-operator invocations. The original script selected `npm.cmd` on Windows. The current [simplified script](../scripts/deploy.ps1) uses ordinary `npm` commands without the call operator.
6. Azure ingress normalized encoded slashes in server names. The registry now accepts encoded and decoded routes, with regression coverage.
7. ARM success preceded completed revision routing. The initial post-rollout check reached the old route implementation; after verifying the ready revision, all live checks passed.

## Boundaries

- No business data, secrets, or write-capable demo tools were added. The demo has no user authentication and is publicly callable.
- The inherited third-party Playwright package was not installed, executed, upgraded, or independently reviewed. Its preserved metadata may be outdated; catalog ownership should review it separately.
- VS Code gallery refresh was verified for a Copilot seat supplied by the test enterprise. Installation/trust and tool startup from that gallery entry were not verified by the gallery screenshot; SDK protocol behavior was verified independently. Registry-based enforcement is preview and has documented limitations.
- Azure portal authentication is independent of CLI authentication. Azure evidence here consists of CLI-verified resources and integrated-browser screenshots of the live Azure endpoints, not a fabricated portal view.
- No production OAuth, load test, penetration test, rate limiter, container OS vulnerability scan, private-network deployment, or automatic Azure CD identity was added.
- Hosted GitHub Actions run 209944546 completed successfully at 2026-09-16T16:59:24Z. Installation, all tests, typechecking, and both Bicep compilation steps passed on Linux. The [workflow](../.github/workflows/validate.yml) has no Azure credentials and does not deploy.
- The resource group remains deployed and can incur charges. Cleanup and production hardening are documented in the walkthrough but were not executed.