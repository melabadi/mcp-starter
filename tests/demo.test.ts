import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('CLI, VS Code and registry agree on the two approved demo identities and read-only ADO headers', () => {
  const shared = JSON.parse(readFileSync(new URL('../.github/mcp.json', import.meta.url), 'utf8'));
  const vscode = JSON.parse(readFileSync(new URL('../.vscode/mcp.json', import.meta.url), 'utf8'));
  const catalog = JSON.parse(readFileSync(new URL('../registry/catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(shared.mcpServers), ['azure-devops']);
  assert.deepEqual(Object.keys(vscode.servers), ['azure-devops', 'onenote-local']);
  const ado = shared.mcpServers['azure-devops'];
  assert.equal(ado.type, 'http');
  assert.equal(ado.url, 'https://mcp.dev.azure.com/');
  assert.equal(vscode.servers['azure-devops'].url, 'https://mcp.dev.azure.com/${input:adoOrganization}');
  assert.ok(vscode.inputs.some((input: { id: string }) => input.id === 'adoOrganization'));
  assert.deepEqual(vscode.servers['azure-devops'].headers, ado.headers);
  assert.equal(ado.headers['X-MCP-Readonly'], 'true');
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0].server.remotes[0].url, ado.url);
  assert.deepEqual(Object.fromEntries(catalog[0].server.remotes[0].headers
    .map((header: { name: string; value: string }) => [header.name, header.value])), ado.headers);
  assert.equal(catalog[1].server.name, 'io.github.melabadi/onenote-local');
  assert.equal(catalog[1].server.packages, undefined);
  assert.equal(catalog[1].server.remotes, undefined);
  assert.equal(vscode.servers['onenote-local'].env.ONENOTE_BACKEND, 'com');
});

test('workshop Hello World runs the actual SDK client, discovery, call and validation', () => {
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../examples/hello/client.ts', import.meta.url)),
  ], { encoding: 'utf8', timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hello, World!/u);
});

test('demo launcher disables all extra user, plugin and built-in MCPs without granting broad permissions', () => {
  const harness = String.raw`
$ErrorActionPreference = 'Stop'
function Test-Path { return $true }
function copilot {
    $global:LASTEXITCODE = 0
    if (($args -join ' ') -eq 'mcp list --json') {
        '{"mcpServers":{"azure-devops":{"enabled":true},"onenote-local":{"enabled":true},"computer-use":{"enabled":true},"extra-server":{"enabled":true}}}'
    } else {
        [Console]::Error.WriteLine($args -join ' ')
    }
}
& $env:DEMO_TEST_SCRIPT '-i' '/mcp'
`;
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', harness], {
    env: { ...process.env, DEMO_TEST_SCRIPT: fileURLToPath(new URL('../scripts/demo.ps1', import.meta.url)) },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--disable-builtin-mcps/u);
  assert.match(result.stderr, /--disable-mcp-server computer-use/u);
  assert.match(result.stderr, /--disable-mcp-server extra-server/u);
  assert.match(result.stderr, /-i \/mcp/u);
  assert.doesNotMatch(result.stderr, /--disable-mcp-server (?:azure-devops|onenote-local)|--allow-all/u);
});

test('workshop setup uses the reader organization and reuses only its own synthetic notebook', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mcp-setup-reader-')));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, '.github'));
    const script = join(root, 'scripts', 'setup-onenote-demo.ps1');
    writeFileSync(script, readFileSync(new URL('../scripts/setup-onenote-demo.ps1', import.meta.url)));
    writeFileSync(join(root, '.github', 'mcp.json'),
      readFileSync(new URL('../.github/mcp.json', import.meta.url)));
    const harness = String.raw`
$ErrorActionPreference = 'Stop'
$global:demoOneNote = [PSCustomObject]@{}
$global:demoOneNote | Add-Member -MemberType ScriptMethod -Name OpenHierarchy -Value {
    param($path, $parent, $output, $create)
    [Console]::Error.WriteLine('fixture-write:OpenHierarchy')
    $output.Value = if ($create -eq 1) { 'fixture-notebook' } else { 'fixture-section' }
}
$global:demoOneNote | Add-Member -MemberType ScriptMethod -Name CreateNewPage -Value {
    param($section, $output, $style)
    [Console]::Error.WriteLine('fixture-write:CreateNewPage')
    $output.Value = 'fixture-page'
}
$global:demoOneNote | Add-Member -MemberType ScriptMethod -Name UpdatePageContent -Value {
    param($xml, $modified, $schema, $force)
    if ($xml -notmatch 'MCP_WORKSHOP_PUBLIC_FIXTURE_V1') { throw 'Synthetic marker is missing.' }
    [Console]::Error.WriteLine('fixture-write:UpdatePageContent')
}
$global:demoOneNote | Add-Member -MemberType ScriptMethod -Name GetHierarchy -Value {
    param($id, $scope, $output, $schema)
    if ($id -ne 'fixture-notebook' -or $scope -ne 0) { throw 'Unexpected notebook access.' }
    $output.Value = '<one:Notebook xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote" name="MCP Workshop Demo"/>'
}
function New-Object {
    param([string]$ComObject)
    if ($ComObject -ne 'OneNote.Application') { throw 'Unexpected COM object.' }
    return $global:demoOneNote
}
& $env:READER_SETUP_SCRIPT -AdoOrganization $env:READER_ADO_ORGANIZATION
`;
    const run = (organization: string) => spawnSync('pwsh', [
      '-NoProfile', '-NonInteractive', '-Command', harness,
    ], {
      env: { ...process.env, READER_SETUP_SCRIPT: script, READER_ADO_ORGANIZATION: organization },
      encoding: 'utf8', timeout: 15_000,
    });
    const first = run('reader-org');
    assert.ifError(first.error);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /fixture-write:UpdatePageContent/u);
    const config = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(config.mcpServers), ['azure-devops', 'onenote-local']);
    assert.equal(config.mcpServers['azure-devops'].url, 'https://mcp.dev.azure.com/reader-org');
    assert.equal(config.mcpServers['azure-devops'].headers['X-MCP-Readonly'], 'true');
    assert.equal(config.mcpServers['onenote-local'].env.ONENOTE_ALLOWED_NOTEBOOK_IDS, '["fixture-notebook"]');
    assert.equal(config.mcpServers['onenote-local'].env.ONENOTE_BACKEND, 'com');
    assert.deepEqual(config.mcpServers['onenote-local'].args, [join(root, 'src', 'onenote-stdio.ts')]);
    const policy = JSON.parse(readFileSync(join(root, '.local', 'managed-settings.json'), 'utf8'));
    assert.deepEqual(policy.allowedMcpServers, [
      { serverUrl: 'https://mcp.dev.azure.com/reader-org' },
      { serverCommand: ['node', join(root, 'src', 'onenote-stdio.ts')] },
    ]);
    const repeated = run('second-org');
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.doesNotMatch(repeated.stderr, /fixture-write:/u);
    assert.equal(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'))
      .mcpServers['azure-devops'].url, 'https://mcp.dev.azure.com/second-org');
    const invalid = run('https://not-an-organization.example/');
    assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(invalid.stderr, /fixture-write:/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
