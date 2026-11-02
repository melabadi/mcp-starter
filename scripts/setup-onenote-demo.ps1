#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$')]
    [string]$AdoOrganization
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$local = Join-Path $root '.local'
$statePath = Join-Path $local 'onenote-demo.json'
$notebookPath = Join-Path $local 'onenote\MCP Workshop Demo'
$encoding = [Text.UTF8Encoding]::new($false)
$oneNote = $null

try {
    $shared = Get-Content -Raw -LiteralPath (Join-Path $root '.github\mcp.json') | ConvertFrom-Json
    $ado = $shared.mcpServers.'azure-devops'
    $adoUrl = [Uri]$ado.url
    if ($ado.type -ne 'http' -or $adoUrl.Scheme -ne 'https' -or
        $adoUrl.Host -ne 'mcp.dev.azure.com' -or $adoUrl.UserInfo -or
        $adoUrl.Query -or $adoUrl.Fragment -or $ado.headers.'X-MCP-Readonly' -ne 'true') {
        throw 'The shared Azure DevOps configuration must use the official HTTPS endpoint and read-only filtering.'
    }
    $ado.url = "https://mcp.dev.azure.com/$AdoOrganization"
    $oneNote = New-Object -ComObject OneNote.Application
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
        if ($state.fixtureVersion -notin @(0, 1) -or $state.notebookPath -cne $notebookPath -or
            -not $state.notebookId -or -not $state.sectionId -or -not $state.pageId) {
            throw 'The existing demo fixture configuration is invalid. No notebook was modified.'
        }
        $xml = ''
        $oneNote.GetHierarchy($state.notebookId, 0, [ref]$xml, 2)
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.LoadXml($xml)
        if ($document.DocumentElement.GetAttribute('name') -cne 'MCP Workshop Demo') {
            throw 'The configured notebook is not the synthetic demo notebook. No notebook was modified.'
        }
    } else {
        if (Test-Path -LiteralPath $notebookPath) {
            throw 'The demo notebook folder already exists without its fixture configuration. Refusing to modify it.'
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $notebookPath) -Force | Out-Null
        $notebookId = ''
        $sectionId = ''
        $pageId = ''
        $oneNote.OpenHierarchy($notebookPath, '', [ref]$notebookId, 1)
        $oneNote.OpenHierarchy('Workshop.one', $notebookId, [ref]$sectionId, 3)
        $oneNote.CreateNewPage($sectionId, [ref]$pageId, 1)
        $state = [ordered]@{
            fixtureVersion = 0
            notebookPath = $notebookPath
            notebookId = $notebookId
            sectionId = $sectionId
            pageId = $pageId
        }
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json) + "`n", $encoding)
    }

    if ($state.fixtureVersion -eq 0) {
        $pageId = $state.pageId
        $pageXml = @"
<one:Page xmlns:one="http://schemas.microsoft.com/office/onenote/2013/onenote" ID="$pageId">
  <one:Title><one:OE><one:T><![CDATA[MCP Workshop Demo]]></one:T></one:OE></one:Title>
  <one:Outline><one:OEChildren>
    <one:OE><one:T><![CDATA[MCP_WORKSHOP_PUBLIC_FIXTURE_V1]]></one:T></one:OE>
    <one:OE><one:T><![CDATA[MCP connects a host to typed, read-only tools.]]></one:T></one:OE>
    <one:OE><one:T><![CDATA[This page is read through the installed OneNote desktop COM API.]]></one:T></one:OE>
    <one:OE><one:T><![CDATA[No private data is included in this notebook.]]></one:T></one:OE>
  </one:OEChildren></one:Outline>
</one:Page>
"@
        $oneNote.UpdatePageContent($pageXml, [DateTime]::FromOADate(0), 2, $false)
        $state.fixtureVersion = 1
        [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json) + "`n", $encoding)
    }

    $entrypoint = Join-Path $root 'src\onenote-stdio.ts'
    $config = @{
        mcpServers = [ordered]@{
            'azure-devops' = $ado
            'onenote-local' = @{
                type = 'stdio'
                command = 'node'
                args = @($entrypoint)
                env = @{
                    ONENOTE_BACKEND = 'com'
                    ONENOTE_ALLOWED_NOTEBOOK_IDS = ConvertTo-Json -InputObject @($state.notebookId) -Compress
                }
                tools = @('*')
            }
        }
    }
    $policy = @{
        allowedMcpServers = @(
            @{ serverUrl = $ado.url }
            @{ serverCommand = @('node', $entrypoint) }
        )
    }
    [IO.File]::WriteAllText((Join-Path $root '.mcp.json'), ($config | ConvertTo-Json -Depth 10) + "`n", $encoding)
    [IO.File]::WriteAllText((Join-Path $local 'managed-settings.json'), ($policy | ConvertTo-Json -Depth 5) + "`n", $encoding)
    Write-Host 'Synthetic OneNote fixture ready; existing notebooks were not modified.'
    Write-Host 'CLI configuration: .mcp.json | Enterprise allowlist: .local\managed-settings.json'
    Write-Host 'Run npm run demo:onenote, then .\scripts\demo.ps1.'
} catch {
    [Console]::Error.WriteLine('OneNote demo setup failed: ' + $_.Exception.Message)
    exit 1
} finally {
    if ($null -ne $oneNote -and [Runtime.InteropServices.Marshal]::IsComObject($oneNote)) {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($oneNote)
    }
}
