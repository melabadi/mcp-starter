targetScope = 'resourceGroup'

@description('Azure region for the tutorial resources.')
param location string = resourceGroup().location

@description('Lowercase resource name prefix.')
@minLength(3)
@maxLength(18)
param baseName string = 'mcp-setup'

var tags = {
  project: 'mcp-setup'
  purpose: 'tutorial'
  managedBy: 'bicep'
}

module identity 'br/public:avm/res/managed-identity/user-assigned-identity:0.6.0' = {
  params: {
    name: '${baseName}-pull'
    location: location
    enableTelemetry: false
    tags: tags
  }
}

module registry 'br/public:avm/res/container-registry/registry:0.13.1' = {
  params: {
    name: 'mcp${uniqueString(resourceGroup().id)}'
    location: location
    acrSku: 'Basic'
    acrAdminUserEnabled: false
    azureADAuthenticationAsArmPolicyStatus: 'enabled'
    publicNetworkAccess: 'Enabled'
    networkRuleSetDefaultAction: 'Allow'
    enableTelemetry: false
    tags: tags
    roleAssignments: [
      {
        principalId: identity.outputs.principalId
        principalType: 'ServicePrincipal'
        roleDefinitionIdOrName: 'AcrPull'
      }
    ]
  }
}

module logs 'br/public:avm/res/operational-insights/workspace:0.16.1' = {
  params: {
    name: '${baseName}-logs'
    location: location
    skuName: 'PerGB2018'
    dataRetention: 30
    dailyQuotaGb: '0.1'
    enableTelemetry: false
    tags: tags
  }
}

module environment 'br/public:avm/res/app/managed-environment:0.16.0' = {
  params: {
    name: '${baseName}-env'
    location: location
    enableTelemetry: false
    tags: tags
    zoneRedundant: false
    publicNetworkAccess: 'Enabled'
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsWorkspaceResourceId: logs.outputs.resourceId
    }
  }
}

type Infrastructure = {
  registryName: string
  registryLoginServer: string
  environmentName: string
  environmentId: string
  identityId: string
  location: string
}

output infrastructure Infrastructure = {
  registryName: registry.outputs.name
  registryLoginServer: registry.outputs.loginServer
  environmentName: environment.outputs.name
  environmentId: environment.outputs.resourceId
  identityId: identity.outputs.resourceId
  location: location
}