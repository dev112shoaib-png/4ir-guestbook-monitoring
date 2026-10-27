
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const cfg = new pulumi.Config();

const namespaceName = cfg.get("namespace") || "guestbook";
const monitoringName = cfg.get("monitoringNamespace") || "monitoring";
const grafanaServiceType = cfg.get("grafanaServiceType") || "NodePort";

if (!["NodePort", "LoadBalancer"].includes(grafanaServiceType)) {
  throw new Error("grafanaServiceType must be NodePort or LoadBalancer");
}

const adminPassword = cfg.requireSecret("grafanaAdminPassword");

// --------------------------------------------------
// Namespaces
// --------------------------------------------------

const appNs = new k8s.core.v1.Namespace("guestbook-ns", {
  metadata: { name: namespaceName },
});

const monitorNs = new k8s.core.v1.Namespace("monitoring-ns", {
  metadata: { name: monitoringName },
});

// --------------------------------------------------
// Guestbook Workload Helper
// --------------------------------------------------

function workload(
  name: string,
  image: string,
  port: number,
  replicas: number,
  env?: k8s.types.input.core.v1.EnvVar[],
  extraContainers?: k8s.types.input.core.v1.Container[]
) {
  const labels = { app: name };

  const deployment = new k8s.apps.v1.Deployment(
    name,
    {
      metadata: {
        namespace: namespaceName,
      },
      spec: {
        replicas,
        selector: {
          matchLabels: labels,
        },
        template: {
          metadata: {
            labels,
          },
          spec: {
            containers: [
              {
                name,
                image,
                ports: [{ containerPort: port }],
                env,
                resources: {
                  requests: {
                    cpu: "50m",
                    memory: "64Mi",
                  },
                  limits: {
                    memory: "256Mi",
                  },
                },
              },
              ...(extraContainers || []),
            ],
          },
        },
      },
    },
    { dependsOn: [appNs] }
  );

  const service = new k8s.core.v1.Service(
    `${name}-svc`,
    {
      metadata: {
        name,
        namespace: namespaceName,
        labels,
      },
      spec: {
        selector: labels,
        ports: [
          {
            name: "http",
            port,
            targetPort: port,
          },
        ],
      },
    },
    { dependsOn: [deployment] }
  );

  return { deployment, service };
}

// --------------------------------------------------
// Redis Leader and Replica
// --------------------------------------------------

const redisEnv = [
  {
    name: "GET_HOSTS_FROM",
    value: "dns",
  },
];

const redisExporter = (): k8s.types.input.core.v1.Container => ({
  name: "redis-exporter",
  image: "oliver006/redis_exporter:v1.67.0",
  ports: [
    {
      name: "metrics",
      containerPort: 9121,
    },
  ],
  env: [
    {
      name: "REDIS_ADDR",
      value: "redis://localhost:6379",
    },
  ],
  resources: {
    requests: {
      cpu: "10m",
      memory: "32Mi",
    },
    limits: {
      memory: "128Mi",
    },
  },
});

const redisLeader = workload(
  "redis-leader",
  "redis:7.2-alpine",
  6379,
  1,
  undefined,
  [redisExporter()]
);

const redisReplica = workload(
  "redis-replica",
  "pulumi/guestbook-redis-replica:latest",
  6379,
  2,
  redisEnv,
  [redisExporter()]
);

// --------------------------------------------------
// Guestbook Frontend
// --------------------------------------------------

const frontend = workload(
  "frontend",
  "pulumi/guestbook-php-redis:latest",
  80,
  3,
  redisEnv
);

// --------------------------------------------------
// Redis Exporter Metrics Services
// --------------------------------------------------

for (const [name, deployment] of [
  ["redis-leader", redisLeader.deployment],
  ["redis-replica", redisReplica.deployment],
] as const) {
  new k8s.core.v1.Service(
    `${name}-metrics`,
    {
      metadata: {
        name: `${name}-metrics`,
        namespace: namespaceName,
        labels: {
          monitoring: "redis-exporter",
        },
      },
      spec: {
        selector: {
          app: name,
        },
        ports: [
          {
            name: "metrics",
            port: 9121,
            targetPort: "metrics",
          },
        ],
      },
    },
    { dependsOn: [deployment] }
  );
}

// --------------------------------------------------
// Prometheus Blackbox Exporter
// --------------------------------------------------

const blackbox = new k8s.helm.v3.Release(
  "blackbox",
  {
    chart: "prometheus-blackbox-exporter",
    repositoryOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    namespace: monitoringName,
    values: {
      fullnameOverride: "guestbook-blackbox",
      config: {
        modules: {
          http_2xx: {
            prober: "http",
            timeout: "5s",
            http: {
              valid_status_codes: [],
              method: "GET",
              preferred_ip_protocol: "ip4",
            },
          },
        },
      },
    },
  },
  { dependsOn: [monitorNs] }
);

// --------------------------------------------------
// Grafana Dashboard JSON
// --------------------------------------------------

const dashboard = require("./dashboard.json");

// --------------------------------------------------
// Prometheus and Grafana Helm Stack
// --------------------------------------------------

const monitoring = new k8s.helm.v3.Release(
  "monitoring",
  {
    chart: "kube-prometheus-stack",
    repositoryOpts: {
      repo: "https://prometheus-community.github.io/helm-charts",
    },
    namespace: monitoringName,
    timeout: 900,

    values: {
      fullnameOverride: "guestbook-monitoring",

      grafana: {
        adminUser: "admin",
        adminPassword,

        service: {
          type: grafanaServiceType,
          ...(grafanaServiceType === "NodePort"
            ? { nodePort: 30030 }
            : {}),
        },

        defaultDashboardsEnabled: false,

        // Use file-based Helm dashboard provisioning.
        sidecar: {
          dashboards: {
            enabled: false,
          },
        },

        dashboardProviders: {
          "dashboardproviders.yaml": {
            apiVersion: 1,
            providers: [
              {
                name: "default",
                orgId: 1,
                folder: "",
                type: "file",
                disableDeletion: false,
                editable: false,
                options: {
                  path: "/var/lib/grafana/dashboards/default",
                },
              },
            ],
          },
        },

        dashboards: {
          default: {
            guestbook: {
              json: JSON.stringify(dashboard),
            },
          },
        },
      },

      prometheus: {
        prometheusSpec: {
          serviceMonitorSelectorNilUsesHelmValues: false,
          serviceMonitorNamespaceSelector: {},

          podMonitorSelectorNilUsesHelmValues: false,

          // Discover Probe resources in all namespaces.
          probeSelectorNilUsesHelmValues: false,
          probeSelector: {},
          probeNamespaceSelector: {},

          retention: "2d",

          resources: {
            requests: {
              cpu: "100m",
              memory: "512Mi",
            },
          },
        },
      },

      alertmanager: {
        enabled: false,
      },

      kubeEtcd: {
        enabled: false,
      },

      kubeControllerManager: {
        enabled: false,
      },

      kubeScheduler: {
        enabled: false,
      },

      // Docker Desktop does not expose this target
      // at the address expected by the chart.
      kubeProxy: {
        enabled: false,
      },
    },
  },
  { dependsOn: [monitorNs] }
);

// --------------------------------------------------
// Redis ServiceMonitor
// --------------------------------------------------

const redisMonitor = new k8s.apiextensions.CustomResource(
  "redis-servicemonitor",
  {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: {
      name: "guestbook-redis",
      namespace: monitoringName,
    },
    spec: {
      namespaceSelector: {
        matchNames: [namespaceName],
      },
      selector: {
        matchLabels: {
          monitoring: "redis-exporter",
        },
      },
      endpoints: [
        {
          port: "metrics",
          interval: "30s",
          path: "/metrics",
        },
      ],
    },
  },
  { dependsOn: [monitoring] }
);

// --------------------------------------------------
// Guestbook HTTP Blackbox Probe
// --------------------------------------------------

const httpProbe = new k8s.apiextensions.CustomResource(
  "frontend-probe",
  {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "Probe",
    metadata: {
      name: "guestbook-frontend",
      namespace: monitoringName,
    },
    spec: {
      jobName: "guestbook-frontend",
      interval: "30s",
      module: "http_2xx",
      prober: {
        url: `guestbook-blackbox.${monitoringName}.svc.cluster.local:9115`,
        path: "/probe",
      },
      targets: {
        staticConfig: {
          static: [
            `http://frontend.${namespaceName}.svc.cluster.local/`,
          ],
        },
      },
    },
  },
  {
    dependsOn: [
      monitoring,
      blackbox,
      frontend.service,
    ],
  }
);

// --------------------------------------------------
// Pulumi Stack Outputs
// --------------------------------------------------

export const guestbookService =
  `frontend.${namespaceName}.svc.cluster.local`;

export const guestbookPortForward =
  `kubectl -n ${namespaceName} port-forward svc/frontend 8080:80`;

// Helm generates a Grafana service name from its
// release name. Discover it by label rather than
// assuming fullnameOverride controls the subchart.
export const grafanaServiceLookup =
  `kubectl -n ${monitoringName} get svc -l app.kubernetes.io/name=grafana`;

export const grafanaNodePort =
  grafanaServiceType === "NodePort" ? 30030 : undefined;

export const grafanaAccessHint =
  `kubectl -n ${monitoringName} port-forward svc/monitoring-ce4a506e-grafana 3000:80`;

export const grafanaUsername = "admin";

export const grafanaPassword = pulumi.secret(adminPassword);

export const prometheusTargetsHint =
  `kubectl -n ${monitoringName} port-forward svc/guestbook-monitoring-prometheus 9090:9090`;
