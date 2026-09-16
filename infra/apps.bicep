targetScope = 'resourceGroup'

@description('Azure region for the apps.')
param location string = resourceGroup().location

@description('Prefix matching the base infrastructure deployment.')
@minLength(3)
@maxLength(18)
param baseName string = 'mcp-setup'

@description('Existing ACR name from the base deployment.')
param registryName string

@description('Immutable image reference including its sha256 digest.')
param image string

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: '${baseName}-env'
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: '${baseName}-pull'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

var serverName = '${baseName}-server'
var registryAppName = '${baseName}-registry'
var serverHostname = '${serverName}.${environment.properties.defaultDomain}'
var tags = {
  project: 'mcp-setup'
  purpose: 'tutorial'
  managedBy: 'bicep'
}
var probes = [
  {
    type: 'Startup'
    tcpSocket: { port: 3000 }
    initialDelaySeconds: 1
    periodSeconds: 5
    failureThreshold: 30
  }
  {
    type: 'Liveness'
    httpGet: {
      path: '/healthz'
      port: 3000
      httpHeaders: [{ name: 'Host', value: 'localhost' }]
    }
    initialDelaySeconds: 10
    periodSeconds: 30
  }
  {
    type: 'Readiness'
    httpGet: {
      path: '/healthz'
      port: 3000
      httpHeaders: [{ name: 'Host', value: 'localhost' }]
    }
    initialDelaySeconds: 3
    periodSeconds: 10
  }
]

module apps 'br/public:avm/res/app/container-app:0.23.0' = [for service in ['server', 'registry']: {
  params: {
    name: service == 'server' ? serverName : registryAppName
    location: location
    environmentResourceId: environment.id
    workloadProfileName: 'Consumption'
    enableTelemetry: false
    tags: tags
    ingressExternal: true
    ingressAllowInsecure: false
    ingressTargetPort: 3000
    ingressTransport: 'auto'
    managedIdentities: {
      userAssignedResourceIds: [identity.id]
    }
    registries: [
      {
        server: registry.properties.loginServer
        identity: identity.id
      }
    ]
    containers: [
      {
        name: service
        image: image
        env: [
          { name: 'SERVICE', value: service }
          { name: 'PORT', value: '3000' }
          { name: 'HOST', value: '0.0.0.0' }
          { name: 'ALLOWED_HOSTS', value: serverHostname }
          { name: 'MCP_SERVER_URL', value: 'https://${serverHostname}/mcp' }
        ]
        resources: {
          cpu: json('0.25')
          memory: '0.5Gi'
        }
        probes: probes
      }
    ]
    scaleSettings: {
      minReplicas: 0
      maxReplicas: 1
      rules: [
        {
          name: 'http'
          http: {
            metadata: { concurrentRequests: '10' }
          }
        }
      ]
    }
  }
}]

type Endpoints = {
  registryUrl: string
  mcpServerUrl: string
  serverName: string
  registryAppName: string
}

output endpoints Endpoints = {
  registryUrl: 'https://${apps[1].outputs.fqdn}'
  mcpServerUrl: 'https://${apps[0].outputs.fqdn}/mcp'
  serverName: serverName
  registryAppName: registryAppName
}