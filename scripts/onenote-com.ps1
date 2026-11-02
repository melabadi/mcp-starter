#requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('notebooks', 'sections', 'pages', 'page')]
    [string]$Action,
    [string]$NotebookId,
    [string]$SectionId,
    [string]$PageId
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$oneNote = $null
$namespace = 'http://schemas.microsoft.com/office/onenote/2013/onenote'

function Read-OneNoteXml([string]$Text) {
    if ([Text.Encoding]::UTF8.GetByteCount($Text) -gt 1MB) {
        throw 'OneNote COM: XML exceeded the 1-MiB limit; use a smaller demo notebook or page.'
    }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
    $settings.XmlResolver = $null
    $reader = [Xml.XmlReader]::Create([IO.StringReader]::new($Text), $settings)
    try {
        $document = [Xml.XmlDocument]::new()
        $document.XmlResolver = $null
        $document.Load($reader)
        if ($document.DocumentElement.NamespaceURI -cne $namespace) {
            throw 'OneNote COM: Unexpected OneNote XML namespace.'
        }
        return ,$document
    } finally {
        $reader.Dispose()
    }
}

function Get-NotebookHierarchy([string]$Id, [int]$Scope) {
    $xml = ''
    $oneNote.GetHierarchy($Id, $Scope, [ref]$xml, 2)
    $document = Read-OneNoteXml $xml
    if ($document.DocumentElement.LocalName -cne 'Notebook' -or
        $document.DocumentElement.GetAttribute('ID') -cne $Id) {
        throw 'OneNote COM: The requested notebook was not returned.'
    }
    return ,$document
}

function Get-Metadata([Xml.XmlElement]$Element, [string]$NameKey) {
    $item = @{ id = $Element.GetAttribute('ID'); $NameKey = $Element.GetAttribute('name') }
    if ($Element.HasAttribute('lastModifiedTime')) {
        $item.lastModifiedDateTime = $Element.GetAttribute('lastModifiedTime')
    }
    return $item
}

try {
    $jsonParameters = @{ InputObject = $env:ONENOTE_ALLOWED_NOTEBOOK_IDS }
    # PowerShell 7 unwraps singleton arrays; Windows PowerShell 5.1 has no NoEnumerate switch.
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('NoEnumerate')) {
        $jsonParameters.NoEnumerate = $true
    }
    $allowed = ConvertFrom-Json @jsonParameters
    if ($allowed -isnot [array] -or $allowed.Count -lt 1 -or $allowed.Count -gt 25 -or
        @($allowed | Select-Object -Unique).Count -ne $allowed.Count) {
        throw 'OneNote COM: Configure 1-25 unique approved notebook IDs.'
    }
    foreach ($id in $allowed) {
        if ($id -isnot [string] -or $id.Length -lt 1 -or $id.Length -gt 512 -or
            $id -match '[\x00-\x1f\x7f]' -or $id.StartsWith('-')) {
            throw 'OneNote COM: Invalid approved notebook ID.'
        }
    }
    if ($Action -ne 'notebooks' -and $allowed -cnotcontains $NotebookId) {
        throw 'OneNote COM: Notebook is not in the configured allowlist.'
    }
    $oneNote = New-Object -ComObject OneNote.Application
    if ($Action -eq 'notebooks') {
        $notebooks = @(
            foreach ($id in $allowed) {
                $document = Get-NotebookHierarchy $id 0
                @{ id = $id; displayName = $document.DocumentElement.GetAttribute('name') }
            }
        )
        $result = @{ notebooks = $notebooks }
    } else {
        $scope = if ($Action -eq 'sections') { 3 } else { 4 }
        $document = Get-NotebookHierarchy $NotebookId $scope
        $manager = [Xml.XmlNamespaceManager]::new($document.NameTable)
        $manager.AddNamespace('one', $namespace)
        $sections = @($document.SelectNodes(
            '//one:Section[not(ancestor-or-self::*[@isInRecycleBin="true"])]', $manager))
        if ($sections.Count -gt 2000) {
            throw 'OneNote COM: Notebook exceeds the 2000-section limit.'
        }
        if ($Action -eq 'sections') {
            $result = @{ sections = @($sections | ForEach-Object { Get-Metadata $_ 'displayName' }) }
        } elseif ($Action -eq 'pages') {
            $section = @($sections | Where-Object { $_.GetAttribute('ID') -ceq $SectionId })
            if ($section.Count -ne 1) {
                throw 'OneNote COM: Section is not in the approved notebook.'
            }
            $pages = @($section[0].SelectNodes('one:Page', $manager))
            if ($pages.Count -gt 2000) {
                throw 'OneNote COM: Section exceeds the 2000-page limit.'
            }
            $result = @{ pages = @($pages | ForEach-Object { Get-Metadata $_ 'title' }) }
        } else {
            $pages = @($document.SelectNodes(
                '//one:Page[not(ancestor-or-self::*[@isInRecycleBin="true"])]', $manager))
            $page = @($pages | Where-Object { $_.GetAttribute('ID') -ceq $PageId })
            if ($page.Count -ne 1) {
                throw 'OneNote COM: Page is not in the approved notebook.'
            }
            $xml = ''
            $oneNote.GetPageContent($PageId, [ref]$xml, 0, 2)
            $content = Read-OneNoteXml $xml
            if ($content.DocumentElement.LocalName -cne 'Page' -or
                $content.DocumentElement.GetAttribute('ID') -cne $PageId) {
                throw 'OneNote COM: The requested page was not returned.'
            }
            $contentManager = [Xml.XmlNamespaceManager]::new($content.NameTable)
            $contentManager.AddNamespace('one', $namespace)
            $result = Get-Metadata $page[0] 'title'
            $result.html = (@($content.SelectNodes('//one:T', $contentManager) |
                ForEach-Object { '<div>' + $_.InnerText + '</div>' }) -join '')
        }
    }
    [Console]::WriteLine(($result | ConvertTo-Json -Depth 6 -Compress))
} catch {
    $message = if ($_.Exception.Message.StartsWith('OneNote COM:')) {
        $_.Exception.Message
    } else {
        'OneNote COM: Desktop API request failed (HRESULT ' + $_.Exception.HResult +
        '). Open OneNote desktop, unlock the approved notebook, and retry.'
    }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($null -ne $oneNote -and [Runtime.InteropServices.Marshal]::IsComObject($oneNote)) {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($oneNote)
    }
}
