import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/deploy.ps1', import.meta.url));
const harness = String.raw`
$ErrorActionPreference = 'Stop'
function npm {
    [Console]::Error.WriteLine('npm ' + ($args -join ' '))
    $global:LASTEXITCODE = if ($env:DEPLOY_TEST_CASE -eq 'test-failure') { 1 } else { 0 }
}
function az {
    $command = $args -join ' '
    [Console]::Error.WriteLine('az ' + $command)
    $global:LASTEXITCODE = 0
    switch -Wildcard ($command) {
        'account show *' { '{"name":"Test subscription","state":"Enabled"}'; break }
        'group exists *' { if ($env:DEPLOY_TEST_CASE -eq 'unrelated-group') { 'true' } else { 'false' }; break }
        'group show *' { 'another-project'; break }
        'group create *' { break }
        'deployment group create *infra/main.bicep*' {
            if ($env:DEPLOY_TEST_CASE -eq 'infrastructure-failure') { $global:LASTEXITCODE = 1; break }
            '{"registryName":"testacr","registryLoginServer":"testacr.azurecr.io"}'
            break
        }
        'acr build *' { if ($env:DEPLOY_TEST_CASE -eq 'build-failure') { $global:LASTEXITCODE = 1 }; break }
        'acr repository show *' { if ($env:DEPLOY_TEST_CASE -eq 'bad-digest') { 'invalid' } else { 'sha256:' + ('a' * 64) }; break }
        'deployment group create *infra/apps.bicep*' {
            if ($env:DEPLOY_TEST_CASE -eq 'apps-failure') { $global:LASTEXITCODE = 1; break }
            '{"registryUrl":"https://registry.example.com","mcpServerUrl":"https://server.example.com/mcp","serverName":"mcp-setup-server","registryAppName":"mcp-setup-registry"}'
            break
        }
        default { throw "Unexpected Azure command: $command" }
    }
}
Set-Location $env:DEPLOY_TEST_ROOT
& $env:DEPLOY_TEST_SCRIPT -SubscriptionId test-subscription -ImageTag test-release
`;

test('deployment script uses direct commands and stops before unsafe follow-up work', async (context) => {
  for (const scenario of ['success', 'test-failure', 'unrelated-group', 'infrastructure-failure', 'build-failure', 'bad-digest', 'apps-failure']) {
    await context.test(scenario, () => {
      const root = mkdtempSync(join(tmpdir(), 'mcp-deploy-'));
      try {
        mkdirSync(join(root, 'infra'));
        writeFileSync(join(root, 'infra/main.bicep'), '');
        const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], {
          cwd: root,
          env: { ...process.env, DEPLOY_TEST_CASE: scenario, DEPLOY_TEST_ROOT: root, DEPLOY_TEST_SCRIPT: script },
          encoding: 'utf8',
          timeout: 30_000,
        });
        assert.ifError(result.error);
        if (scenario === 'success') {
          assert.equal(result.status, 0, result.stderr);
          const deployment = JSON.parse(readFileSync(join(root, '.azure/deployment.json'), 'utf8'));
          assert.equal(deployment.registryUrl, 'https://registry.example.com');
          assert.equal(deployment.mcpServerUrl, 'https://server.example.com/mcp');
          assert.match(result.stderr, /image=testacr\.azurecr\.io\/mcp-setup@sha256:a{64}/);
          for (const command of result.stderr.split('\n').filter((line) => line.startsWith('az '))) {
            assert.ok(command.includes('--subscription test-subscription'), command);
          }
        } else {
          assert.notEqual(result.status, 0, scenario);
          if (scenario === 'test-failure') assert.doesNotMatch(result.stderr, /^az group /m);
          if (scenario === 'unrelated-group') assert.doesNotMatch(result.stderr, /^az deployment /m);
          if (scenario === 'infrastructure-failure') assert.doesNotMatch(result.stderr, /^az acr build /m);
          if (['build-failure', 'bad-digest'].includes(scenario)) assert.doesNotMatch(result.stderr, /^az deployment .*infra\/apps\.bicep/m);
          assert.doesNotMatch(result.stdout, /GitHub registry base URL:/);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});