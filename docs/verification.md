# Verify Your MCP Setup

Use this checklist for your own checkout, deployment, and Copilot accounts. A saved registry URL, a successful Azure deployment, or a green server health endpoint does not by itself prove that tools work or policy blocks unapproved servers.

All commands below run from the repository root in PowerShell. See the [walkthrough](../README.md) for prerequisites and setup.

## 1. Validate the Source

```powershell
npm ci --ignore-scripts
npm test
npm run typecheck
npm run demo:hello
npm run demo:notes
node .\scripts\smoke.ts --local
```

Expected outcomes:

- Tests and TypeScript checks pass.
- Hello World discovers the tool, receives the exact greeting, and rejects invalid input.
- The text-notes demo discovers and reads committed synthetic examples, not your personal files.
- The smoke check reports **5/5 checks passed** and closes its temporary HTTP services.

The test suite includes registry routing, metadata, pagination, CORS/write rejection, real SDK stdio and HTTP exchanges, invalid inputs, OneNote access boundaries, HTML extraction limits, and PowerShell deployment failure paths. Mocked Graph/COM tests are not evidence of live Microsoft sign-in or desktop access.

Bridge regressions run under both Windows PowerShell 5.1 and PowerShell 7 on Windows. Linux checks the same XML/JSON and access-boundary behavior with a fake COM object; OneNote desktop COM itself still requires Windows.

GitHub Actions runs tests and typecheck on Windows and Linux and compiles Bicep on Linux. Check the run for your commit rather than relying on an old successful run.

## 2. Verify Catalog Discovery

Start `npm run start:registry` in another terminal, then:

```powershell
$base = 'http://127.0.0.1:3000'
$name = [uri]::EscapeDataString('io.github.melabadi/onenote-local')
Invoke-RestMethod "$base/v0.1/servers?version=latest&limit=10"
Invoke-RestMethod "$base/v0.1/servers/$name/versions/latest"
Invoke-RestMethod "$base/v0.1/servers/$name/versions/1.0.0"
```

Check that:

- The default catalog has exactly the ADO and OneNote entries in [catalog.json](../registry/catalog.json).
- The ADO URL and read-only headers match your intended organization/setup.
- OneNote is described as a manual local checkout, not a nonexistent npm package or hosted endpoint.
- Latest/version routes return the intended entry, unknown versions return 404, CORS permits anonymous reads, and writes return 405.
- Pagination is complete before you report a full inventory.

The ADO entry in source uses the documented organization-neutral endpoint. `ADO_MCP_URL` selects an organization-specific endpoint at registry startup. The registry does not connect to either server during discovery.

## 3. Verify Your Azure Deployment

After running [deploy.ps1](../scripts/deploy.ps1) with your own subscription and `-AdoOrganization`, use the generated endpoint record:

```powershell
node .\scripts\smoke.ts --output .\.azure\verification.json
```

From another checkout, pass all deployment-specific values:

```powershell
$AdoOrganization = Read-Host 'Your Azure DevOps organization name'
node .\scripts\smoke.ts `
  --registry https://YOUR-REGISTRY.azurecontainerapps.io `
  --server https://YOUR-SERVER.azurecontainerapps.io/mcp `
  --ado-url "https://mcp.dev.azure.com/$AdoOrganization" `
  --output .\.azure\verification.json
```

Expect **5/5 checks passed**. Inspect the report for the exact catalog identities, HTTP behavior and SDK tool calls. The comparison uses your source catalog plus the configured ADO URL; it must not accept an unrelated catalog merely because the server count matches.

In Azure, confirm the latest revision is ready and traffic reaches the intended immutable image:

```powershell
az containerapp show --subscription $SubscriptionId `
  --resource-group $ResourceGroup --name "$BaseName-registry" `
  --query "{ready:properties.latestReadyRevisionName,latest:properties.latestRevisionName,image:properties.template.containers[0].image,traffic:properties.configuration.ingress.traffic}"
```

Do not treat provisioning success as application readiness. Allow a new revision to become ready, then rerun the smoke check. Keep deployment records and rollback image references outside source control.

## 4. Verify ADO and OneNote in Copilot

For the optional Windows desktop workshop:

```powershell
$AdoOrganization = Read-Host 'Your Azure DevOps organization name'
powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned `
  -File .\scripts\setup-onenote-demo.ps1 -AdoOrganization $AdoOrganization
npm run demo:onenote
.\scripts\demo.ps1
```

`demo:onenote` must report **6/6 live checks passed**. It discovers all four schemas, reads only the synthetic approved notebook/section/page, verifies the expected text marker, and rejects invalid notebook, page and schema inputs. It does not print notebook contents.

In the interactive CLI:

1. Review `/mcp` and complete ADO's provider sign-in. Copilot sign-in and ADO authorization are separate.
2. Verify ADO exposes the three selected tools and OneNote exposes four read-only tools.
3. Ask to list the approved OneNote notebooks and read the **MCP Workshop Demo** page.
4. Make a small read-only ADO request against data you are authorized to use. Do not copy private work items into public verification output.

Verify the workshop launcher selects exactly two enabled MCPs without a model call:

```powershell
$configuration = .\scripts\demo.ps1 mcp list --json | ConvertFrom-Json
$configuration.mcpServers.PSObject.Properties |
    Where-Object { $_.Value.enabled } | Select-Object Name
```

Expected: `azure-devops` and `onenote-local`. The launcher temporarily disables other configured/default MCPs; it does not delete personal settings or provide an enterprise security boundary.

In VS Code, use [.vscode/mcp.json](../.vscode/mcp.json), enter your own organization and approved notebook IDs, and repeat discovery plus an actual tool call. Use **MCP: List Servers > Show Output** to diagnose errors. Do not infer invocation success from a registry gallery listing.

## 5. Verify Effective Client Policy

GitHub [recommends managed MCP allowlists](https://docs.github.com/en/copilot/how-tos/administer-copilot/manage-mcp-usage/configure-enterprise-allowlist) for execution controls. Registry-based restriction is a separate preview feature. Follow the [current settings reference](https://docs.github.com/en/copilot/reference/enterprise-administrators/enterprise-managed-settings#allowedmcpservers), including supported clients, deployment sources and first-party exemptions.

Administrator checklist:

- Review the suggested `.local/managed-settings.json` generated by setup. It permits your ADO organization URL and one exact Node command/absolute entrypoint.
- Merge only the intended keys into your enterprise's designated governance source, preserving existing plugins, marketplaces and other settings.
- Use a supported client signed into an account receiving the intended enterprise Copilot seat.
- Refresh/restart the client and inspect the effective policy, not just the committed source file.
- **Positive test:** both approved servers connect and a read-only tool call succeeds.
- **Negative test:** a harmless, unapproved test server is blocked in a normal client launch, **without** the workshop launcher's extra-server filters.
- If an unapproved server still loads, stop the rollout and record the discrepancy. Do not claim enforcement because a two-entry registry or allowlist was saved.
- Only migrate away from an existing **Registry only** restriction after the replacement controls have been validated for affected users.

For multiple policy sources, allowlists intersect and explicit deny rules take precedence. User-chosen names are not strong identity checks; prefer exact URLs or commands. These controls do not replace backend authentication, per-user authorization or OS isolation.

## 6. Check Before Sharing

- Keep `.mcp.json`, `.local`, `.azure`, notebook IDs, tokens, private notes and raw client logs out of commits.
- Use synthetic data for screenshots and live demos. Treat returned note content as untrusted data.
- Review current `npm audit` output and container dependencies. A previous zero-advisory report is not a current security assessment; do not apply unreviewed forced dependency upgrades.
- Record the timestamp, source commit, image digest, client versions, checks and limitations for your own rollout. Store account-specific records privately.
- Preserve a known-good immutable image and a reviewed policy rollback before changing registry contents or restrictions.

The existing [September JSON report](evidence/live-verification.json), [advisory snapshot](evidence/dependency-advisories.json), and [screenshots](images) are historical illustrations from a disposable test deployment. They may show old catalog entries, endpoints and client versions. They are not reusable settings, current approvals, or proof of the state of your environment.
