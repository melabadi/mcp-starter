#requires -Version 7.2
$CopilotArguments = @($args)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    if (-not (Test-Path -LiteralPath '.mcp.json')) {
        throw 'Run powershell.exe -NoProfile -STA -ExecutionPolicy RemoteSigned -File .\scripts\setup-onenote-demo.ps1 -AdoOrganization YOUR-ORGANIZATION first.'
    }
    $configured = copilot mcp list --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0) { throw 'Could not list Copilot CLI MCP configuration.' }
    $allowed = @('azure-devops', 'onenote-local')
    foreach ($name in $allowed) {
        if ($null -eq $configured.mcpServers.$name -or -not $configured.mcpServers.$name.enabled) {
            throw "Required MCP server '$name' is missing or disabled. Run the setup script and review /mcp."
        }
    }
    $arguments = @('--disable-builtin-mcps')
    foreach ($server in $configured.mcpServers.PSObject.Properties) {
        if ($server.Name -notin $allowed) {
            $arguments += @('--disable-mcp-server', $server.Name)
        }
    }
    $arguments += $CopilotArguments
    & copilot @arguments
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $exitCode
