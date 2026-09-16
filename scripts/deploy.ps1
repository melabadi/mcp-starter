#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$SubscriptionId,
    [string]$ResourceGroup = 'rg-mcp-setup-demo',
    [string]$Location = 'eastus2',
    [ValidatePattern('^[a-z][a-z0-9-]{2,17}$')]
    [string]$BaseName = 'mcp-setup',
    [ValidatePattern('^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$')]
    [string]$ImageTag = (Get-Date -AsUTC -Format 'yyyyMMddHHmmss')
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if (-not (Test-Path './infra/main.bicep')) {
    throw 'Run this script from the repository root.'
}
Get-Command az, node, npm -ErrorAction Stop | Out-Null

$account = az account show --subscription $SubscriptionId --output json --only-show-errors | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Sign in with az login and check the subscription ID.' }
if ($account.state -ne 'Enabled') { throw 'The selected subscription is not enabled.' }
Write-Host "Subscription: $($account.name) | Resource group: $ResourceGroup | Image tag: $ImageTag"
Write-Host 'This tutorial creates billable Azure resources. Complete the README prerequisites first.'

Write-Host '1. Run tests and typecheck'
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed. Nothing was deployed.' }
npm run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed. Nothing was deployed.' }

Write-Host '2. Create the tutorial resource group'
$exists = az group exists --subscription $SubscriptionId --name $ResourceGroup --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Could not check the resource group.' }
if ($exists -eq 'true') {
    $project = az group show --subscription $SubscriptionId --name $ResourceGroup --query tags.project --output tsv --only-show-errors
    if ($LASTEXITCODE -ne 0 -or $project -ne 'mcp-setup') {
        throw 'Refusing to reuse a resource group without the project=mcp-setup tag.'
    }
} else {
    az group create --subscription $SubscriptionId --name $ResourceGroup --location $Location --tags project=mcp-setup purpose=tutorial --output none --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw 'Resource group creation failed.' }
}

Write-Host '3. Deploy the infrastructure from infra/main.bicep'
$infrastructure = az deployment group create `
    --subscription $SubscriptionId --resource-group $ResourceGroup `
    --name "$BaseName-infrastructure" --template-file infra/main.bicep `
    --parameters "location=$Location" "baseName=$BaseName" `
    --query properties.outputs.infrastructure.value --output json --only-show-errors | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Infrastructure deployment failed.' }

Write-Host '4. Build the container image in ACR'
az acr build --subscription $SubscriptionId --registry $infrastructure.registryName `
    --image "mcp-setup:$ImageTag" --file Dockerfile --platform linux/amd64 . --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Image build failed. The apps were not updated.' }

$digest = az acr repository show --subscription $SubscriptionId --name $infrastructure.registryName `
    --image "mcp-setup:$ImageTag" --query digest --output tsv --only-show-errors
if ($LASTEXITCODE -ne 0 -or $digest -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Could not resolve the image digest.' }
$image = "$($infrastructure.registryLoginServer)/mcp-setup@$digest"

Write-Host '5. Deploy the registry and MCP server from infra/apps.bicep'
$endpoints = az deployment group create `
    --subscription $SubscriptionId --resource-group $ResourceGroup `
    --name "$BaseName-apps" --template-file infra/apps.bicep `
    --parameters "location=$Location" "baseName=$BaseName" "registryName=$($infrastructure.registryName)" "image=$image" `
    --query properties.outputs.endpoints.value --output json --only-show-errors | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'App deployment failed.' }

New-Item -ItemType Directory -Path '.azure' -Force | Out-Null
$endpoints | ConvertTo-Json | Set-Content '.azure/deployment.json' -Encoding utf8NoBOM
Write-Host "GitHub registry base URL: $($endpoints.registryUrl)"
Write-Host "MCP server URL: $($endpoints.mcpServerUrl)"
Write-Host 'Run node scripts/smoke.ts before changing GitHub settings.'