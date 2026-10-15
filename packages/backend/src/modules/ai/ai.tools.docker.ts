import type { AIToolDefinition } from './ai.types.js';

const STABLE_CONTAINER_REFERENCE_DESCRIPTION =
  'Exact stable container name returned by find_resource or inspect (preferred). A runtime ID is also accepted, but never manually shorten or retype one.';

export const DOCKER_AI_TOOLS: AIToolDefinition[] = [
  {
    name: 'create_docker_container',
    description:
      'Create a new Docker container on a node from an image already present on that node, and start it when you also have docker:containers:manage on it (otherwise it stays stopped). Before first creation, use list_docker_images and pull_docker_image when the requested image is absent, then wait for the pull task to complete. Volume mounts may reference only existing Opfield-managed volumes; never provide host bind paths. Secure runtime requires a healthy Secure Runtime capability on the node and does not support GPU or device attachments. For public Docker Hub images such as nginx:alpine, omit registryId; a saved registry is not required. To create inside an app environment, pass folderId from get_app placementFolderIds.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        image: { type: 'string', description: 'Image reference (e.g. nginx:latest, ubuntu:24.04)' },
        registryId: {
          type: 'string',
          description:
            'Optional saved private/custom registry UUID. Omit for public Docker Hub images; never pass an empty string.',
        },
        name: { type: 'string', description: 'Container name (optional, auto-generated if omitted)' },
        folderId: { type: 'string', description: 'Authorized destination container folder UUID.' },
        ports: {
          type: 'array',
          description: 'Port mappings',
          items: {
            type: 'object',
            properties: {
              hostPort: { type: 'number' },
              containerPort: { type: 'number' },
              protocol: { type: 'string', enum: ['tcp', 'udp'], description: 'Default: tcp' },
              hostIp: { type: 'string', description: 'Host IP address to bind. Default: 0.0.0.0' },
            },
            required: ['hostPort', 'containerPort'],
          },
        },
        volumes: {
          type: 'array',
          description:
            'Existing Opfield-managed named-volume mounts. Each volume needs docker:volumes:view (or edit) on it.',
          items: {
            type: 'object',
            properties: {
              containerPath: { type: 'string' },
              name: { type: 'string', description: 'Existing Opfield-managed volume name' },
              readOnly: { type: 'boolean' },
            },
            required: ['containerPath', 'name'],
          },
        },
        env: { type: 'object', description: 'Environment variables as key-value pairs' },
        networks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Network names to connect to. Each one other than bridge, default or none needs docker:networks:edit on that network, and Compose project networks are refused.',
        },
        restartPolicy: {
          type: 'string',
          enum: ['no', 'always', 'unless-stopped', 'on-failure'],
          description: 'Default: no',
        },
        runtimeProfile: {
          type: 'string',
          enum: ['default', 'secure'],
          description: 'Container isolation profile. Default: default (runc). Secure uses gVisor runsc.',
        },
        stopTimeout: {
          type: 'integer',
          minimum: 0,
          maximum: 300,
          description: 'Container stop grace period in seconds, 0-300. Default: Opfield fallback 20 seconds.',
        },
        gpu: {
          type: 'object',
          description: 'GPU devices to attach, by node GPU inventory device ID. Not supported with the secure runtime.',
          properties: { deviceIds: { type: 'array', items: { type: 'string' } } },
          required: ['deviceIds'],
          additionalProperties: false,
        },
        labels: { type: 'object', description: 'Container labels as key-value pairs' },
        command: { type: 'array', items: { type: 'string' }, description: 'Override container command' },
      },
      required: ['nodeId', 'image'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:create',
    invalidateStores: ['containers'],
  },
  {
    name: 'list_docker_containers',
    description:
      'List Docker containers with their status, image, ports, and resource usage, on one Docker node (nodeId, type docker) or across every Docker node you can see when nodeId is omitted.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description:
            'Docker node ID (a node of type docker in list_nodes). Omit to list across every Docker node you can see; each row then carries nodeId and nodeName.',
        },
        search: { type: 'string', description: 'Optional search over container ID, name, image, status, and ports' },
        excludeAppMembers: { type: 'boolean', description: 'Leave out resources that belong to an app.' },
        appId: { type: 'string', description: 'Only resources of this app (any environment).' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'get_docker_container',
    description:
      'Get detailed information about a specific Docker container including config, state, mounts, and network settings.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'execute_docker_container_console_command',
    description:
      'Run a one-shot command inside a Docker container console. This is destructive by policy even for read-looking commands. Use command as argv, for example ["sh","-lc","pwd && ls -la"]. Clearly dangerous commands are blocked; commands with risky patterns require explicit user approval.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        command: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command argv to execute. Use ["sh","-lc","..."] for shell syntax.',
        },
        user: { type: 'string', description: 'Optional container user for docker exec.' },
      },
      required: ['nodeId', 'containerId', 'command'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:console',
    invalidateStores: ['containers'],
  },
  {
    name: 'list_docker_deployments',
    description:
      'List blue/green Docker deployments on one Docker node (nodeId, type docker) or across every Docker node you can see when nodeId is omitted. Use this before acting on managed deployment containers; deployment rows include activeSlot, slots, routes, status, and health.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description:
            'Docker node ID (a node of type docker in list_nodes). Omit to list across every Docker node you can see; each row then carries nodeId and nodeName.',
        },
        search: { type: 'string', description: 'Optional search over deployment name, image, status, and routes' },
        excludeAppMembers: { type: 'boolean', description: 'Leave out resources that belong to an app.' },
        appId: { type: 'string', description: 'Only resources of this app (any environment).' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'get_docker_deployment',
    description:
      'Get detailed information about a blue/green Docker deployment by deployment ID. Use deploymentId, not the active slot container ID.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'start_docker_deployment',
    description:
      'Start a stopped blue/green Docker deployment through the deployment layer. Do not start the underlying managed container directly.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'stop_docker_deployment',
    description:
      'Stop a blue/green Docker deployment through the deployment layer. Do not stop the underlying managed container directly.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'restart_docker_deployment',
    description:
      'Restart a blue/green Docker deployment through the deployment layer. Use this instead of restarting the active slot container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'kill_docker_deployment',
    description:
      'Force-kill a blue/green Docker deployment through the deployment layer. Prefer stop_docker_deployment unless an immediate kill is explicitly requested.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'deploy_docker_deployment',
    description:
      'Deploy a new inactive slot for a blue/green Docker deployment, optionally with a full image reference or a new tag. This is the deployment-safe replacement for updating a managed slot container image. env sets variables over the saved environment of the deployment and removeEnv removes keys; every other saved variable stays, and the result is saved as the deployment environment. An image or tag also needs docker:containers:edit, docker:containers:environment and docker:containers:secrets on the deployment (the new slot starts with the env and secrets of the deployment); these scopes authorize pulling it, docker:images:pull is not needed. env or removeEnv alone needs docker:containers:environment. On a deployment with legacy host bind mounts, an image or tag needs docker:containers:mounts (a new image runs new code with that host access); redeploying the saved configuration, as a link change does, needs none.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
        image: { type: 'string', description: 'Optional full image reference to deploy' },
        tag: { type: 'string', description: 'Optional tag applied to the current deployment image repository' },
        registryId: { type: 'string', description: 'Optional Docker registry UUID for pulling the image' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional variables to set over the saved environment; other saved variables stay.',
        },
        removeEnv: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional environment keys to remove from the saved environment.',
        },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers', 'tasks'],
  },
  {
    name: 'switch_docker_deployment_slot',
    description:
      'Switch a blue/green Docker deployment to the specified slot. Use only with the Opfield deployment ID and slot name, not a container ID. The standby starts as it was deployed; a standby deployed before the current managed database and storage links is recreated from its own release with those links. That recreate keeps the standby image and mounts, so it needs no docker:containers:mounts even with host bind mounts.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
        slot: { type: 'string', enum: ['blue', 'green'], description: 'Target slot to make active' },
        force: { type: 'boolean', description: 'Force switch even if health checks are not healthy (default false)' },
      },
      required: ['nodeId', 'deploymentId', 'slot'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'rollback_docker_deployment',
    description:
      'Rollback a blue/green Docker deployment to the inactive previous slot. The previous release keeps the current managed database and storage links: a link added since stays attached and a link removed since is not reattached. Rolling back to another image on a deployment with host bind mounts needs docker:containers:mounts.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
        force: { type: 'boolean', description: 'Force rollback even if health checks are not healthy (default false)' },
      },
      required: ['nodeId', 'deploymentId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'stop_docker_deployment_slot',
    description:
      'Stop an inactive blue/green deployment slot. The active slot cannot be stopped by this tool; use stop_docker_deployment to stop the whole deployment.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID' },
        slot: { type: 'string', enum: ['blue', 'green'], description: 'Inactive slot to stop' },
      },
      required: ['nodeId', 'deploymentId', 'slot'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'start_docker_container',
    description: 'Start a stopped Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'stop_docker_container',
    description:
      'Stop a running Docker container. Answers once it has stopped, so it can be removed right away; a stop already under way is waited for. A stop still running after 45 s is answered with pending: true, its task and how to wait for it.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        timeout: {
          type: 'integer',
          minimum: 0,
          maximum: 300,
          description: 'Seconds to wait before killing. If omitted, uses the container stop grace setting, then 20.',
        },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'restart_docker_container',
    description:
      'Restart a Docker container. Answers once Docker has started it again, or after 45 s with pending: true, its task and how to wait for it.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        timeout: {
          type: 'integer',
          minimum: 0,
          maximum: 300,
          description: 'Seconds to wait before killing. If omitted, uses the container stop grace setting, then 20.',
        },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'remove_docker_container',
    description:
      'Remove a Docker container. The container must be stopped first; one that is still stopping is removed once the stop ends (after 45 s the result is pending: true with a remove task that finishes the removal).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        force: {
          type: 'boolean',
          description: 'Force removal of a stopped container if Docker requires it (default false)',
        },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:delete',
    invalidateStores: ['containers'],
  },
  {
    name: 'update_docker_container_image',
    description:
      'Update a Docker container to a different image tag. Pulls the new image, then recreates the container with the new image while preserving all other settings (ports, volumes, env, etc.). Use this to upgrade/downgrade container versions.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        imageTag: { type: 'string', description: 'New image tag (e.g. "1.25", "latest", "v2.0.0")' },
      },
      required: ['nodeId', 'containerId', 'imageTag'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers', 'tasks'],
  },
  {
    name: 'rename_docker_container',
    description: 'Rename a Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        name: { type: 'string', description: 'New container name' },
      },
      required: ['nodeId', 'containerId', 'name'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:edit',
    invalidateStores: ['containers'],
  },
  {
    name: 'duplicate_docker_container',
    description:
      'Clone a Docker container with a new name. Copies config, ports, volumes, env, and secrets. Requires docker:containers:create for the destination plus environment and secrets access on the source container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        name: { type: 'string', description: 'Name for the new container' },
        folderId: { type: 'string', description: 'Optional authorized destination container folder UUID.' },
      },
      required: ['nodeId', 'containerId', 'name'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:create',
    requiredScopes: ['docker:containers:environment', 'docker:containers:secrets'],
    invalidateStores: ['containers'],
  },
  {
    name: 'get_docker_container_stats',
    description: 'Get live resource usage stats for a Docker container (CPU%, memory, network I/O, PIDs).',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'get_docker_container_logs',
    description: 'Get recent log output from a Docker container.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        tail: { type: 'integer', minimum: 1, maximum: 1000, description: 'Number of lines from the end (default 100)' },
        timestamps: { type: 'boolean', description: 'Include timestamps (default false)' },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },

  // ── Docker: Images ──
  {
    name: 'list_docker_images',
    description:
      'List Docker images with their tags, size, and creation date, on one Docker node (nodeId, type docker) or across every Docker node you can see when nodeId is omitted.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description:
            'Docker node ID (a node of type docker in list_nodes). Omit to list across every Docker node you can see; each row then carries nodeId and nodeName.',
        },
        search: { type: 'string', description: 'Optional search over image ID, tags, and digests' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:images:view',
    invalidateStores: [],
  },
  {
    name: 'pull_docker_image',
    description:
      'Pull a Docker image onto a node. Public Docker Hub images such as nginx:alpine are pulled directly with registryId omitted; never create a saved Docker Hub registry just to pull a public image.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        imageRef: { type: 'string', description: 'Image reference (e.g. nginx:latest, ghcr.io/org/app:v2)' },
        registryId: {
          type: 'string',
          description:
            'Optional saved private/custom registry UUID. Omit for public Docker Hub images; never pass an empty string.',
        },
        folderId: { type: 'string', description: 'Optional authorized destination image folder UUID.' },
        workload: {
          type: 'object',
          description:
            'Pull for a container or deployment about to be created: pass its destination container folder (folderId, or omit it for the node root). docker:containers:create there authorizes the pull instead of docker:images:pull; the pull is synchronous and the image is not placed in an image folder. Do not combine with the top-level folderId.',
          properties: { folderId: { type: 'string', description: 'Destination container folder UUID.' } },
          additionalProperties: false,
        },
        wait: {
          type: 'boolean',
          description:
            'Pull synchronously and fail if the image cannot be pulled (default false: queue a background pull task).',
        },
      },
      required: ['nodeId', 'imageRef'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:images:pull',
    invalidateStores: ['images'],
  },

  {
    name: 'remove_docker_image',
    description: 'Remove a Docker image from a node.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        imageId: { type: 'string', description: 'Image ID or reference (e.g. sha256:abc... or nginx:1.25)' },
        force: { type: 'boolean', description: 'Force remove even if in use (default false)' },
      },
      required: ['nodeId', 'imageId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:images:delete',
    invalidateStores: ['images'],
  },
  {
    name: 'prune_docker_images',
    description: 'Remove all unused Docker images from a node to free disk space. Returns reclaimed space.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
      },
      required: ['nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:images:delete',
    invalidateStores: ['images'],
  },

  // ── Docker: Volumes & Networks ──
  {
    name: 'list_docker_volumes',
    description:
      'List Opfield-managed volumes plus legacy volumes still attached to visible Opfield containers, on one Docker node (nodeId, type docker) or across every Docker node you can see when nodeId is omitted. Orphaned unmanaged volumes are hidden.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description:
            'Docker node ID (a node of type docker in list_nodes). Omit to list across every Docker node you can see; each row then carries nodeId and nodeName.',
        },
        search: { type: 'string', description: 'Optional search over volume name, driver, mountpoint, and users' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:volumes:view',
    invalidateStores: [],
  },
  {
    name: 'list_docker_networks',
    description:
      'List Docker networks on one Docker node (nodeId, type docker) or across every Docker node you can see when nodeId is omitted.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: {
          type: 'string',
          description:
            'Docker node ID (a node of type docker in list_nodes). Omit to list across every Docker node you can see; each row then carries nodeId and nodeName.',
        },
        search: { type: 'string', description: 'Optional search over network ID, name, driver, and scope' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:networks:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_registry',
    description:
      'Manage saved private or custom Docker registries and the Opfield internal build registry. Operations: list, get, create, update, delete, test, test_direct for saved registries; internal_get (state, health, storage, external access), internal_repositories, internal_update_settings (external access hostname, nginx node, certificate), internal_gc (garbage collection, optionally dryRun), and internal_resume_maintenance (resume an interrupted maintenance run) for the internal registry. Do not create a registry for public Docker Hub images; pull those directly without registryId. Mutating operations require the corresponding docker:registries:* scope; internal registry reads need broad docker:registries:view and changes broad docker:registries:edit.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'list',
            'get',
            'create',
            'update',
            'delete',
            'test',
            'test_direct',
            'internal_get',
            'internal_repositories',
            'internal_update_settings',
            'internal_gc',
            'internal_resume_maintenance',
          ],
        },
        registryId: { type: 'string', description: 'Registry UUID for get/update/delete/test' },
        nodeId: { type: 'string', description: 'Optional node filter for list, or node scoped registry owner' },
        name: { type: 'string' },
        url: { type: 'string' },
        username: { type: 'string' },
        password: { type: 'string' },
        trustedAuthRealm: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'node'] },
        externalAccessEnabled: {
          type: 'boolean',
          description: 'internal_update_settings: expose the internal registry through an nginx node.',
        },
        externalHostname: { type: 'string', description: 'internal_update_settings: external registry hostname.' },
        externalNginxNodeId: { type: 'string', description: 'internal_update_settings: nginx node UUID.' },
        externalCertificateId: { type: 'string', description: 'internal_update_settings: TLS certificate UUID.' },
        dryRun: { type: 'boolean', description: 'internal_gc: report what would be removed without deleting.' },
        runId: { type: 'string', description: 'internal_resume_maintenance: maintenance run UUID.' },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:registries:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_volume',
    description:
      'Create, inspect, resize, adopt, rename, relabel, delete, and browse files of Docker volumes on a node. create makes an Opfield-managed local volume and accepts no driver setting: storageKind "regular" (default) takes no capacity; storageKind "disk-image" makes a fixed-size volume and requires capacityBytes (at least 268435456), a compatible node, and Personal-or-higher licensing. resize grows an existing Opfield-managed disk-image volume to capacityBytes; it cannot shrink. adopt brings an eligible legacy local volume under Opfield management without copying data. inspect and metrics read the cached detail and usage; managed_options lists the managed volumes the caller may attach as container mounts (docker:volumes:view on each). rename (newName), update_labels (labels), resize and adopt edit one volume and need docker:volumes:edit on it (a node or folder grant covers it). File operations (list_files, read_file, write_file, create_file, create_directory, delete_file, move_file, upload_init/upload_chunk/upload_complete/upload_abort) need docker:volumes:files:read or :write; binary content uses contentBase64 and upload chunks carry at most 1 MiB. Archive export uses the MCP-only download_docker_archive tool. delete removes the volume. Compose-owned volumes must be changed through their Compose project. Listing is available via list_docker_volumes.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'create',
            'resize',
            'adopt',
            'delete',
            'inspect',
            'metrics',
            'managed_options',
            'rename',
            'update_labels',
            'list_files',
            'read_file',
            'write_file',
            'create_file',
            'create_directory',
            'delete_file',
            'move_file',
            'upload_init',
            'upload_chunk',
            'upload_complete',
            'upload_abort',
          ],
        },
        nodeId: { type: 'string' },
        name: {
          type: 'string',
          description: 'Volume name. For create, the new volume name. managed_options ignores it.',
        },
        newName: { type: 'string', description: 'rename only. New volume name.' },
        labels: { type: 'object', description: 'update_labels only. Complete volume label map.' },
        path: { type: 'string', description: 'Absolute path inside the volume for file operations. Default: /' },
        fromPath: { type: 'string', description: 'move_file only. Absolute source path.' },
        toPath: { type: 'string', description: 'move_file only. Absolute destination path.' },
        content: { type: 'string', description: 'UTF-8 content for write_file, create_file, or upload_chunk.' },
        contentBase64: {
          type: 'string',
          description: 'Base64 content for binary write_file, create_file, or upload_chunk (chunk at most 1 MiB).',
        },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'read_file output encoding. Default: utf8' },
        offsetBytes: { type: 'integer', minimum: 0, description: 'read_file: first byte to return. Default: 0' },
        limitBytes: { type: 'integer', minimum: 1, description: 'read_file: maximum bytes to return.' },
        uploadId: { type: 'string', description: 'Upload session ID for upload_chunk, upload_complete, upload_abort.' },
        offset: { type: 'integer', minimum: 0, description: 'upload_chunk: byte offset of this chunk.' },
        totalBytes: { type: 'integer', minimum: 0, description: 'upload_init/upload_complete: total file size.' },
        storageKind: {
          type: 'string',
          enum: ['regular', 'disk-image'],
          description: 'create only. Defaults to regular.',
        },
        capacityBytes: {
          type: 'integer',
          minimum: 268435456,
          description:
            'Disk-image capacity in bytes. Required for create with storageKind disk-image, and for resize (new, larger size).',
        },
        folderId: { type: 'string', description: 'create only. Authorized destination volume folder UUID.' },
        force: { type: 'boolean', description: 'delete only.' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:volumes:create',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_network',
    description:
      'Create, delete, connect, or disconnect Docker networks on a node. Listing is available via list_docker_networks.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'delete', 'connect', 'disconnect'] },
        nodeId: { type: 'string' },
        networkId: { type: 'string', description: 'Network ID or name for delete/connect/disconnect' },
        name: { type: 'string', description: 'Network name for create' },
        driver: { type: 'string' },
        subnet: { type: 'string' },
        gateway: { type: 'string' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:networks:create',
    invalidateStores: [],
  },
  {
    name: 'manage_container_link',
    description:
      "Private TCP links between workloads (container links): a consumer (container, deployment or Compose service) reaches one port of a target workload as alias:port on its own internal link network, through the shared secure-link connector on both nodes (no relay hop when both run on the same node). The target needs no published port and no route, cannot reach the consumer, and other containers get nothing. operation: list (the links of a workload: nodeId, type, resourceId; direction outgoing = the links it starts, incoming = the links that reach it), create (sourceNodeId/sourceType/sourceResourceId, targetNodeId/targetType/targetResourceId, targetPort; optional alias, a DNS label defaulting to the target's name, and environment {host, port, url} variable names: setting any recreates the consumer once, otherwise a container joins live, a deployment joins its running slots and a Compose service gets a revision), get_runtime (linkId: the link and its relay counters), delete (linkId). A container is named by its name, a deployment by its id, a Compose service as '<projectId>:<url-encoded service>'. Status: ready, pending (the consumer takes it on its next start or rollout), waiting (the target does not run; connections are refused until it does), update_required (a node's Docker daemon lacks secure_link_egress_v1), error (lastError says why, e.g. a port an Availability deployment does not route). Needs docker:containers:edit on the consumer (docker:compose:manage for a Compose service), docker:containers:environment when it sets variables, and docker:containers:link on the target (docker:compose:manage for a Compose service); listing and the runtime need view access to that end. Creating needs a Personal plan or higher; existing links stay readable and removable.",
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'create', 'get_runtime', 'delete'] },
        nodeId: { type: 'string', description: 'list: the node of the workload' },
        type: {
          type: 'string',
          enum: ['container', 'deployment', 'compose_service'],
          description: 'list: workload type',
        },
        resourceId: {
          type: 'string',
          description: "list: container name, deployment id, or '<projectId>:<service>' of a Compose service",
        },
        direction: { type: 'string', enum: ['outgoing', 'incoming'], description: 'list: default outgoing' },
        linkId: { type: 'string', description: 'get_runtime/delete: the container link id' },
        sourceNodeId: { type: 'string' },
        sourceType: { type: 'string', enum: ['container', 'deployment', 'compose_service'] },
        sourceResourceId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        targetNodeId: { type: 'string' },
        targetType: { type: 'string', enum: ['container', 'deployment', 'compose_service'] },
        targetResourceId: { type: 'string' },
        targetPort: { type: 'number', description: 'The port the target listens on (its container port)' },
        alias: { type: 'string', description: 'DNS label the consumer reaches the target by' },
        environment: {
          type: 'object',
          description: 'Variable names for the consumer: host (the alias), port, url (http://alias:port)',
          properties: { host: { type: 'string' }, port: { type: 'string' }, url: { type: 'string' } },
        },
      },
      required: ['operation'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_compose',
    description:
      'Inspect and manage first-class single-node Docker Compose Projects. Supports discovery, validation, create/adopt/delete, immutable revisions, lifecycle operations, operation history, project secrets, and recent service logs (logs, optionally one serviceName). Managed mutations require the Compose entitlement and exact docker:compose resource scopes. While a Git-source build rollout owns a project, revision, secret, and lifecycle changes are refused with 409 BUILD_ROLLOUT_IN_PROGRESS until it finishes. operation_start pull_apply applies a revision with the managed database links that exist when it runs: links deleted since the revision was built are left out (their variables, secrets and network), links the project runs are kept and links saved pending are added when the revision defines their service. When that changes the revision, a copy of it is applied (the operation names that revision); it is refused when it lacks the service of a link the project runs. To create inside an app environment, pass folderId from get_app placementFolderIds.',
    parameters: {
      type: 'object',
      properties: {
        excludeAppMembers: { type: 'boolean', description: 'Leave out resources that belong to an app.' },
        appId: { type: 'string', description: 'Only resources of this app (any environment).' },
        operation: {
          type: 'string',
          enum: [
            'list',
            'get',
            'validate',
            'create',
            'adopt',
            'delete',
            'revision_list',
            'revision_get',
            'revision_create',
            'revision_delete',
            'operation_list',
            'operation_start',
            'secret_list',
            'secret_create',
            'secret_update',
            'secret_delete',
            'logs',
          ],
        },
        nodeId: { type: 'string', description: 'Docker node UUID.' },
        projectId: { type: 'string', description: 'Compose Project UUID.' },
        projectName: { type: 'string', description: 'Compose project name for validate/create.' },
        folderId: { type: 'string', description: 'Authorized destination Compose folder UUID for creation.' },
        yaml: { type: 'string', description: 'Complete single-file Compose YAML.' },
        variables: { type: 'object', description: 'Compose interpolation variables.' },
        secretKeys: { type: 'array', items: { type: 'string' } },
        revisionId: { type: 'string' },
        cursor: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        action: {
          type: 'string',
          enum: ['apply', 'pull_apply', 'start', 'stop', 'restart', 'down', 'delete_volumes', 'cancel'],
        },
        idempotencyKey: { type: 'string' },
        removeOrphans: {
          type: 'boolean',
          description:
            'apply, pull_apply and down. Default true: services the revision no longer declares are removed.',
        },
        volumeNames: { type: 'array', items: { type: 'string' } },
        secretId: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        serviceName: { type: 'string', description: 'logs only. Limit logs to one Compose service.' },
        tail: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          description: 'logs only. Lines per container (default 100).',
        },
        timestamps: { type: 'boolean', description: 'logs only. Include timestamps (default false).' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:compose:view',
    invalidateStores: ['containers'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'list_docker_builds',
    description:
      'List Git-source Docker builds visible to the caller, including exact commit, status, Build Worker, immutable artifact, policy result, and target resource. A succeeded build whose container, deployment or Compose Project was stopped on request carries progress.rolloutNote (for example "Container stopped — the new image runs on next start"): the new image or revision replaced the old one without starting it and runs on the next start.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Optional Docker runtime node filter' },
        builderNodeId: { type: 'string', description: 'Optional Build Worker node filter' },
        sourceBindingId: { type: 'string', description: 'Optional source binding UUID' },
        status: {
          type: 'string',
          enum: [
            'queued',
            'claimed',
            'checking_out',
            'building',
            'scanning',
            'pushing',
            'deploying',
            'succeeded',
            'failed',
            'cancelled',
            'superseded',
          ],
        },
        provider: { type: 'string', enum: ['gitlab', 'github', 'git'] },
        branch: { type: 'string' },
        search: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default: 20' },
        excludeAppMembers: { type: 'boolean', description: 'Leave out builds of resources that belong to an app.' },
        appId: { type: 'string', description: 'Only builds of resources of this app (any environment).' },
      },
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_build',
    description:
      'Inspect one Git-source build, read incremental build logs (logs returns the joined text, lastSequence to pass as afterSequence for the next page, and hasMore; a page can end mid-line, the next page continues it), request cancellation, or retry a terminal build. Authorization follows the build target: Docker container/deployment, Compose Project, or Pages Project. A target stopped on request is not started by a build: its image (for a deployment its release, for a Compose Project its revision) is replaced, the build succeeds without a readiness wait and carries progress.rolloutNote; the first build of a container created from a Git source still creates and starts it. A built container that fails readiness (healthy, or running 10 s without a restart within 60 s) is returned to its previous image and the build fails with BUILD_ROLLOUT_ROLLED_BACK (BUILD_ROLLOUT_ROLLBACK_FAILED when that return fails); the error carries the container state, exit code, restarts and last log lines. Other rollout failures are BUILD_ROLLOUT_FAILED. A Compose revision whose published port is taken on the node fails at revision creation with COMPOSE_HOST_PORT_IN_USE. Build images of deleted workloads are removed from the node automatically; an unused build image can also be removed with remove_docker_image.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['get', 'logs', 'cancel', 'retry'] },
        buildId: { type: 'string' },
        afterSequence: { type: 'integer', minimum: -1, description: 'For logs; default -1.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'For logs; default 200.' },
      },
      required: ['operation', 'buildId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: ['containers'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_docker_source',
    description:
      'Inspect, attach, update, remove, resolve, sync, or manually build the Git source bound directly to an existing Docker container, blue/green deployment, or Compose Project, or create a new container, deployment, or Compose Project from a Git source (create). sync (Sync now; docker:containers:manage, or docker:compose:manage for Compose) checks the branch for a new commit now, like one poll iteration, and queues the automatic build only when the source builds automatically and the head changed or has no build yet; it returns { source, changed, build }, needs no integrations:<provider>:use, and within about 10 seconds of the previous check returns the current state without asking the provider. resolve refreshes the desired commit without building (sync without building). pending reads a container that exists only as a queued first source build. Also lists the Git connectors a source can come from (connectors: id, name, provider) and their repositories (repositories, connectorId, optional search; returns { repositories, truncated }, truncated meaning more may exist past the listing bound, so search by name or owner/name); both need a create or edit scope of the workload the source is for and list only what the integrations:<provider>:use grants of the caller cover (what attaching the source needs). Attaching a source (create, upsert of a new source) or changing its connector, repository or branch also needs integrations:<provider>:use on that repository: unqualified, or limited to its connector, GitLab group or GitHub owner, or the exact project or repository; other upsert changes and build need only the workload scopes. upsert of an existing source changes only the fields you pass; omitted fields and policy keys keep their saved values, and it returns the saved source including policy. Manages source-scoped Build Secrets without exposing secret values. Builds always resolve an exact commit and deploy only approved immutable artifacts; while a build rollout deploys, other changes to its target are refused with 409 BUILD_ROLLOUT_IN_PROGRESS. Automatic deployments act for the account that last saved the source (its settings or Build Secrets): a new image on a workload with host bind mounts deploys only while that account holds docker:containers:mounts on it, checked when the rollout runs; otherwise the build fails with MISSING_DOCKER_MOUNTS_SCOPE naming the account and the fix (grant the scope, or save the source as a user who holds it). get returns composeServiceNames for a Compose source: the services of the Compose file it resolved, which the project can be linked to before its first revision.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'get',
            'pending',
            'create',
            'upsert',
            'remove',
            'resolve',
            'sync',
            'build',
            'admission',
            'connectors',
            'repositories',
            'secret_list',
            'secret_upsert',
            'secret_delete',
          ],
        },
        targetType: { type: 'string', enum: ['container', 'deployment', 'compose'] },
        nodeId: { type: 'string', description: 'Docker runtime node ID' },
        containerName: { type: 'string', description: 'Exact stable container name' },
        deploymentId: { type: 'string', description: 'Blue/green deployment UUID' },
        composeProjectId: { type: 'string', description: 'Compose Project UUID' },
        resourceName: { type: 'string', description: 'New container or deployment name for create.' },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'create of a container only: environment variables (NAME: value) its first build creates and starts it with.',
        },
        secrets: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'create of a container only: secrets (NAME: value) its first build creates and starts it with; needs docker:containers:secrets for the destination. A name cannot be both an env variable and a secret.',
        },
        folderId: { type: 'string', description: 'Authorized destination folder UUID for creation.' },
        projectName: { type: 'string', description: 'New Compose Project name for create.' },
        restartPolicy: {
          type: 'string',
          enum: ['no', 'always', 'unless-stopped', 'on-failure'],
        },
        runtimeProfile: { type: 'string', enum: ['default', 'secure'] },
        routes: { type: 'array', items: { type: 'object' } },
        health: { type: 'object' },
        drainSeconds: { type: 'number' },
        routerImage: { type: 'string' },
        connectorId: { type: 'string', description: 'Allowlisted Git integration UUID' },
        search: {
          type: 'string',
          description:
            'repositories only: name or owner/name to find repositories past the listing bound (GitHub search)',
        },
        projectId: { type: 'string', description: 'Allowlisted repository project UUID' },
        branch: { type: 'string' },
        dockerfilePath: { type: 'string', description: 'Repository-relative Dockerfile path' },
        contextPath: { type: 'string', description: 'Repository-relative build context' },
        composeFilePath: { type: 'string', description: 'Repository-relative Compose file path.' },
        composeVariables: { type: 'object', description: 'Compose interpolation variables.' },
        composeSecretKeys: { type: 'array', items: { type: 'string' } },
        autoBuild: { type: 'boolean', description: 'Automatically build newly detected commits' },
        autoDeploy: { type: 'boolean' },
        buildArgs: { type: 'object', description: 'Non-secret build arguments' },
        buildSecretNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Write-only Build Secret IDs configured separately on the source binding',
        },
        policy: {
          type: 'object',
          description:
            'Artifact vulnerability policy of the source (Console: Vulnerability policy and scope). On upsert, keys you omit keep their saved values.',
          additionalProperties: false,
          properties: {
            vulnerabilityThreshold: {
              type: 'string',
              enum: ['critical', 'high', 'medium', 'low', 'none', 'disabled'],
              description:
                'Lowest severity that blocks a deployment; none = report only; disabled = skip scanning and SBOM. Default critical.',
            },
            vulnerabilityScope: {
              type: 'string',
              enum: ['all', 'application', 'fixable_application', 'fixable_all'],
              description:
                'Findings that count against the threshold: all = every package; application = OS packages (deb, rpm, apk, alpm) report-only; fixable_application = only findings with a released fix, OS packages report-only; fixable_all = only findings with a released fix in any package. Default all.',
            },
          },
        },
        commitSha: { type: 'string', description: 'Optional exact current commit for a manual build' },
        force: { type: 'boolean', description: 'Queue a new attempt even when this commit already has a build' },
        secretName: { type: 'string', description: 'Source-scoped Build Secret name.' },
        secretValue: { type: 'string', description: 'Write-only Build Secret value.' },
      },
      required: ['operation', 'nodeId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: ['containers'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_docker_task',
    description:
      'List or get Docker background tasks for image pulls, container updates, and webhook actions. Callers with node-scoped docker:tasks see tasks of their nodes only. Docker migrations, including needs_attention resolution, use manage_docker_migration.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['list', 'get'] },
        taskId: { type: 'string' },
        nodeId: { type: 'string' },
        status: { type: 'string' },
        type: { type: 'string' },
        limit: { type: 'number', description: 'list: newest tasks to return (1-1000; default all)' },
      },
      required: ['operation'],
    },
    destructive: false,
    category: 'Docker',
    requiredScope: 'docker:tasks',
    invalidateStores: [],
  },
  {
    name: 'manage_docker_container_config',
    description:
      'Manage container env, files, secrets, webhooks, and HTTP health checks. Container file list/read requires docker:containers:files:read; write_file, create_file, create_directory, delete_file, move_file, and resumable upload_init/upload_chunk/upload_complete/upload_abort require docker:containers:files:write. Binary content uses contentBase64 (upload chunks at most 1 MiB); read_file returns UTF-8 unless encoding is base64. update_env recreates the container with the new values and needs docker:containers:environment. list_secrets returns the secret keys with docker:containers:environment; reveal (values) and create/update/delete_secret need docker:containers:secrets, which also grants docker:containers:environment. A container created from a Git source that its first build has not created yet (manage_docker_source pending) takes get_env, update_env and the secret operations by its containerName: the values are saved and the first build creates and starts the container with them (update_env then recreates nothing). Other operation-specific webhooks/edit/view scopes are enforced.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'get_env',
            'update_env',
            'list_files',
            'read_file',
            'write_file',
            'create_file',
            'create_directory',
            'delete_file',
            'move_file',
            'upload_init',
            'upload_chunk',
            'upload_complete',
            'upload_abort',
            'list_secrets',
            'create_secret',
            'update_secret',
            'delete_secret',
            'get_webhook',
            'upsert_webhook',
            'delete_webhook',
            'regenerate_webhook_token',
            'get_health_check',
            'upsert_health_check',
            'test_health_check',
          ],
        },
        targetType: { type: 'string', enum: ['container', 'deployment'], description: 'Defaults to container' },
        nodeId: { type: 'string' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        containerName: { type: 'string' },
        deploymentId: { type: 'string' },
        secretId: { type: 'string' },
        key: { type: 'string' },
        value: { type: 'string' },
        reveal: { type: 'boolean', description: 'list_secrets: include the values (docker:containers:secrets)' },
        env: { type: 'object', description: 'Environment key/value map for update_env' },
        removeEnv: { type: 'array', items: { type: 'string' } },
        path: { type: 'string', description: 'Container file path' },
        fromPath: { type: 'string', description: 'move_file only. Absolute source path.' },
        toPath: { type: 'string', description: 'move_file only. Absolute destination path.' },
        content: { type: 'string', description: 'UTF-8 text content for write_file, create_file, or upload_chunk' },
        contentBase64: {
          type: 'string',
          description: 'Base64 content for binary write_file, create_file, or upload_chunk (chunk at most 1 MiB).',
        },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'read_file output encoding. Default: utf8' },
        offsetBytes: { type: 'integer', minimum: 0, description: 'read_file: first byte to return. Default: 0' },
        limitBytes: { type: 'integer', minimum: 1, description: 'read_file: maximum bytes to return.' },
        uploadId: { type: 'string', description: 'Upload session ID for upload_chunk, upload_complete, upload_abort.' },
        offset: { type: 'integer', minimum: 0, description: 'upload_chunk: byte offset of this chunk.' },
        totalBytes: { type: 'integer', minimum: 0, description: 'upload_init/upload_complete: total file size.' },
        enabled: { type: 'boolean', description: 'Webhook or health check enabled state' },
        healthCheck: { type: 'object', description: 'Docker health check configuration' },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: [],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_docker_deployment',
    description:
      "Create, update, or delete a blue/green Docker deployment. create needs docker:containers:create for the node or folder; update needs docker:containers:edit, plus docker:containers:environment and docker:containers:secrets when it changes image, command, entrypoint, user or runtimeProfile, and docker:containers:environment when it changes env; an update that changes only desiredConfig.env needs docker:containers:environment alone (the slots get it with the next deploy, which needs docker:containers:manage); the deployment's own scopes authorize pulling a new image, docker:images:pull is not needed; delete needs docker:containers:delete and removes both slots and the router. Use deploy_docker_deployment to roll out a new image. To create inside an app environment, pass folderId from get_app placementFolderIds.",
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['create', 'update', 'delete'] },
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        deploymentId: { type: 'string', description: 'Opfield deployment ID for update and delete' },
        payload: {
          type: 'object',
          description:
            'create: { name, image, registryId?, folderId?, routes: [{ hostPort, containerPort, isPrimary? }], health?: { path, statusMin, statusMax, timeoutSeconds, intervalSeconds, successThreshold, startupGraceSeconds, deployTimeoutSeconds }, drainSeconds?, routerImage?, env?, mounts?, command?, entrypoint?, workingDir?, user?, labels?, restartPolicy?, runtimeProfile?, gpu? }. update: { name?, desiredConfig?, routes?, health?, drainSeconds? }.',
        },
      },
      required: ['operation', 'nodeId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:edit',
    invalidateStores: ['containers'],
  },
  {
    name: 'kill_docker_container',
    description:
      'Send a signal (default SIGKILL) to a Docker container. SIGKILL answers once the container has exited (after 45 s with pending: true and its task); another signal answers once it was delivered; a container that is not running answers at once with nothing signalled. Prefer stop_docker_container unless an immediate kill is explicitly requested. Compose-owned containers must be changed through their Compose project.',
    parameters: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        signal: { type: 'string', description: 'Signal name, for example SIGKILL or SIGTERM. Defaults to SIGKILL.' },
      },
      required: ['nodeId', 'containerId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:manage',
    invalidateStores: ['containers'],
  },
  {
    name: 'force_cancel_docker_task',
    description:
      'Force-cancel a stuck active Docker background task (image pull, container update, webhook action) found with manage_docker_task. Requires docker:tasks:manage for the task node.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Docker task ID' },
      },
      required: ['taskId'],
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:tasks:manage',
    invalidateStores: ['tasks'],
  },
  {
    name: 'manage_docker_container',
    description:
      "Change or inspect an existing standalone Docker container beyond start/stop. recreate applies a new configuration by recreating the container: image, ports, mounts (managed volumes by name; existing host bind mounts must be passed back unchanged), entrypoint, command, workingDir, user, hostname, labels, stopTimeout, restartPolicy, maxRetries, memoryLimit, memorySwap, nanoCPUs, cpuShares, pidsLimit, gpu, and runtimeProfile; omitted fields keep their current value, while ports, mounts, labels, and gpu replace the whole list. recreate needs docker:containers:manage plus edit, and changing image, entrypoint, command, user, or runtimeProfile also needs environment and secrets access; the container's own scopes authorize pulling a new image (no docker:images:pull). live_update changes restartPolicy, maxRetries, and resource limits without recreation (docker:containers:edit). update pulls a new tag and/or changes env/removeEnv and redeploys: a new tag runs other code with the env and secrets of the container, so it needs edit, environment and secrets (no docker:images:pull); env/removeEnv alone needs environment, as update_env; neither needs edit. processes lists running processes, stats_history returns recent resource samples, and gpu_usage lists GPU devices with their visible containers on the node. image_cleanup_get and image_cleanup_upsert read or set old-image retention (enabled, retentionCount 1-50) for a container or, with targetType deployment, a blue/green deployment (reading needs docker:containers:view, setting docker:containers:edit). archive_plan_import resolves an archive manifest summary (archiveManifest) against the node before upload_docker_container_archive. Compose-owned containers must be changed through their Compose project and blue/green slot containers through deployment tools; a running build rollout owns its container and changes are refused with 409.",
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'recreate',
            'live_update',
            'update',
            'processes',
            'stats_history',
            'gpu_usage',
            'image_cleanup_get',
            'image_cleanup_upsert',
            'archive_plan_import',
          ],
        },
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
        containerId: { type: 'string', description: STABLE_CONTAINER_REFERENCE_DESCRIPTION },
        containerName: {
          type: 'string',
          description: 'image_cleanup_*: exact container name (alternative to containerId).',
        },
        targetType: {
          type: 'string',
          enum: ['container', 'deployment'],
          description: 'image_cleanup_* only. Default: container.',
        },
        deploymentId: { type: 'string', description: 'image_cleanup_* with targetType deployment.' },
        image: { type: 'string', description: 'recreate: full image reference.' },
        ports: {
          type: 'array',
          description: 'recreate: complete published port list.',
          items: {
            type: 'object',
            properties: {
              hostPort: { type: 'integer', minimum: 0, maximum: 65535 },
              containerPort: { type: 'integer', minimum: 1, maximum: 65535 },
              protocol: { type: 'string', enum: ['tcp', 'udp'] },
              hostIp: { type: 'string' },
            },
            required: ['hostPort', 'containerPort'],
            additionalProperties: false,
          },
        },
        mounts: {
          type: 'array',
          description:
            'recreate: complete mount list. Use name for an Opfield-managed volume or hostPath for an existing host bind mount; a newly attached volume needs docker:volumes:view on it, and changing or removing a host bind mount requires docker:containers:mounts.',
          items: {
            type: 'object',
            properties: {
              containerPath: { type: 'string' },
              name: { type: 'string' },
              hostPath: { type: 'string' },
              readOnly: { type: 'boolean' },
            },
            required: ['containerPath'],
            additionalProperties: false,
          },
        },
        entrypoint: { type: 'array', items: { type: 'string' }, description: 'recreate: entrypoint argv.' },
        command: { type: 'array', items: { type: 'string' }, description: 'recreate: command argv.' },
        workingDir: { type: 'string', description: 'recreate: working directory.' },
        user: { type: 'string', description: 'recreate: container user.' },
        hostname: { type: 'string', description: 'recreate: container hostname.' },
        labels: { type: 'object', description: 'recreate: complete container label map.' },
        stopTimeout: { type: 'integer', minimum: 0, maximum: 300, description: 'recreate: stop grace in seconds.' },
        restartPolicy: { type: 'string', enum: ['no', 'always', 'unless-stopped', 'on-failure'] },
        maxRetries: { type: 'integer', minimum: 0, description: 'on-failure restart retries.' },
        memoryLimit: { type: 'integer', minimum: 0, description: 'Memory limit in bytes; 0 removes it.' },
        memorySwap: { type: 'integer', description: 'Memory plus swap in bytes; -1 is unlimited.' },
        nanoCPUs: { type: 'integer', minimum: 0, description: 'CPU limit in 1e-9 CPUs (1000000000 = 1 CPU).' },
        cpuShares: { type: 'integer', minimum: 0, description: 'Relative CPU weight.' },
        pidsLimit: { type: 'integer', minimum: 0, description: 'Maximum process count.' },
        gpu: {
          type: 'object',
          description: 'recreate: GPU device IDs from the node inventory; an empty list detaches all GPUs.',
          properties: { deviceIds: { type: 'array', items: { type: 'string' } } },
          required: ['deviceIds'],
          additionalProperties: false,
        },
        runtimeProfile: { type: 'string', enum: ['default', 'secure'], description: 'recreate: isolation profile.' },
        tag: { type: 'string', description: 'update: new tag for the current image repository.' },
        env: { type: 'object', description: 'update: environment variables to set.' },
        removeEnv: { type: 'array', items: { type: 'string' }, description: 'update: environment keys to remove.' },
        enabled: { type: 'boolean', description: 'image_cleanup_upsert: enable old-image cleanup.' },
        retentionCount: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'image_cleanup_upsert: previous images to keep.',
        },
        archiveManifest: {
          type: 'object',
          description:
            'archive_plan_import: the archive manifest summary { networks: [{ name, driver?, subnet?, gateway?, createable, createNew?, requiresMapping? }], mounts: [{ type: bind|volume, source, target, readOnly, driver?, labels?, createNew?, requiresMapping? }], ports: [{ containerPort, hostPort, protocol }] }.',
        },
      },
      required: ['operation', 'nodeId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:view',
    invalidateStores: ['containers', 'tasks'],
  },
  {
    name: 'manage_docker_availability',
    description:
      'Run a Docker container, blue/green deployment, or Compose Project across several Docker nodes (replicated) or with automatic failover. preflight checks eligibility and candidate nodes for a proposed policy; enable applies it; get and get_by_resource read the policy with placements; list_operations pages rollout history; update changes mode, replicas, node selection, rollout policy, offline grace, or priority mode; priorityMode with an ordered nodePriority (first node is the primary, the rest are backups in order; only eligible nodes, no duplicates) serves from the first available nodes and moves the workload back (a failback operation) once a higher-priority node has stayed healthy for failbackDelaySeconds; retry_operation retries a failed operation; disable returns the workload to one node and requires survivingPlacementId plus the typed confirmation shown by the UI. Failover runs in the data plane (lease mode) while every ingress Nginx node and relay of the workload and enough lease voters advertise availability_lease_v2, otherwise the backend drives it (legacy); a legacy policy enters lease mode only once every node and relay of the workload ran availability_lease_v2 for 2 minutes without a restart (reason participants_settling until then), and a lease-mode policy returns to legacy only after lease mode stayed impossible for 2 minutes (lease.reason.since) or on a disable, stop, start or restart, never because of the license, and leaving lease mode keeps the serving copy running (lease.retainedHolders while closing; only a stop stops it); get returns lease.mode with lease.reason, lease.excludedNodes (candidate nodes left out of holding and standbys: offline, watchdog_missing, daemon_outdated or identity_pending; never a reason to leave lease mode), the lease holder per slot, the policy voters (candidate hosts with availability_lease_v2 plus witnesses so the count is odd, at least 3; the automatic witness is never the local relay of Opfield while another member can witness), the witness with its warning, and the voter reachability margin; witness sets the witness (a relay instance or Docker node id that is not a candidate and runs on another host) or auto. partitionMode strict (default) never runs two copies of a slot; available keeps serving through a partition and may run two copies at once. A replica is judged by its Docker state and, where the workload has one, by the HTTP health check of its Routes or deployment: one failing it twice in a row leaves its routes only while another copy serves and passes (Replicated) or a ready standby takes over (Failover in lease mode), otherwise it keeps serving and the policy is degraded with AVAILABILITY_PLACEMENT_HTTP_UNHEALTHY. Mutations need docker:availability:manage; the workload, candidate nodes, and dependencies are authorized like the Availability routes.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: [
            'preflight',
            'enable',
            'get',
            'get_by_resource',
            'list_operations',
            'update',
            'disable',
            'retry_operation',
          ],
        },
        resource: {
          type: 'object',
          description: 'preflight, enable, get_by_resource: the workload.',
          properties: {
            type: { type: 'string', enum: ['container', 'deployment', 'compose'] },
            nodeId: { type: 'string', description: 'Container node UUID.' },
            containerName: { type: 'string' },
            deploymentId: { type: 'string' },
            composeProjectId: { type: 'string' },
          },
          required: ['type'],
          additionalProperties: false,
        },
        policyId: { type: 'string', description: 'Availability policy UUID.' },
        operationId: { type: 'string', description: 'retry_operation: operation UUID.' },
        mode: { type: 'string', enum: ['replicated', 'failover'] },
        desiredReplicaCount: {
          type: 'integer',
          minimum: 1,
          maximum: 32,
          description: 'replicated: 2-32; failover: exactly 1.',
        },
        nodeSelectionMode: { type: 'string', enum: ['all_compatible', 'selected'] },
        selectedNodeIds: { type: 'array', items: { type: 'string' }, description: 'Required for selected mode.' },
        rolloutPolicy: {
          type: 'object',
          properties: {
            maxUnavailable: { type: 'integer', minimum: 0, maximum: 32 },
            maxSurge: { type: 'integer', minimum: 0, maximum: 32 },
            drainSeconds: { type: 'integer', minimum: 0, maximum: 3600 },
          },
          additionalProperties: false,
        },
        offlineReplacementGraceSeconds: { type: 'integer', minimum: 0, maximum: 3600 },
        priorityMode: {
          type: 'boolean',
          description: 'Serve from the first available nodes of nodePriority and fail back to them. Default: false.',
        },
        nodePriority: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered node UUIDs: primary first, then backups. Required with priorityMode; only eligible (selected) nodes, no duplicates.',
        },
        failbackDelaySeconds: {
          type: 'integer',
          minimum: 0,
          maximum: 3600,
          description: 'Seconds a returning higher-priority node must stay healthy before failback. Default: 300.',
        },
        witness: {
          type: 'string',
          description:
            "Lease witness for enable/update: a relay instance id or a Docker node id outside the candidates' hosts, or 'auto' (default) to pick the member farthest from every candidate.",
        },
        partitionMode: {
          type: 'string',
          enum: ['strict', 'available'],
          description:
            'Lease-mode behaviour under a network partition. strict (default) never runs two copies of a slot; available keeps serving on a reachable node and can run two copies concurrently.',
        },
        survivingPlacementId: { type: 'string', description: 'disable: placement UUID that keeps running.' },
        confirmation: { type: 'string', description: 'disable: typed confirmation text.' },
        page: { type: 'integer', minimum: 1, description: 'list_operations page. Default: 1' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'list_operations page size. Default: 50' },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:availability:manage',
    invalidateStores: ['containers'],
    historyRetention: { mode: 'summary_only' },
  },
  {
    name: 'manage_docker_runtime',
    description:
      'Check (preflight) or install (install) the gVisor runsc secure container runtime on a Docker node. Installing restarts the Docker daemon on that node. Requires nodes:manage for the node (broad admin:update is still accepted).',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['preflight', 'install'] },
        nodeId: { type: 'string', description: 'Docker node ID (a node of type docker in list_nodes)' },
      },
      required: ['operation', 'nodeId'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'nodes:manage',
    invalidateStores: ['nodes'],
  },
  {
    name: 'upload_docker_container_archive',
    description:
      'Import an Opfield container archive (.gwca) as a new container on a Docker node through authenticated MCP. Preferred: operation "link" takes nodeId, the new container name, optional folderId and the resolution returned by manage_docker_container archive_plan_import, and returns a one-time upload URL (valid 15 minutes, single use) with a ready `curl -T container.gwca <url>` command; the archive streams from the shell into the import, the curl response is the new stopped container, and a failed or interrupted transfer imports nothing. Without a shell, use the resumable begin/chunk/status/finalize/abort workflow: begin takes the same arguments plus the exact archive size and its lowercase SHA-256; send ordered chunks of at most 1 MiB decoded base64 at the returned offset, then finalize. Requires docker:containers:create for the node or folder and the container archive entitlement; archive environment, secrets, networks, and volumes need the matching node scopes. Authentication comes from the MCP connection; never pass a token.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['link', 'begin', 'chunk', 'status', 'finalize', 'abort'] },
        nodeId: { type: 'string', description: 'link or begin: destination Docker node UUID.' },
        name: { type: 'string', description: 'link or begin: new container name.' },
        folderId: {
          type: 'string',
          description: 'link or begin: optional authorized destination container folder UUID.',
        },
        resolution: {
          type: 'object',
          description:
            'link or begin: network, volume, and port mappings { networks?, createNetworks?, volumes?, createVolumes?, ports? } from archive_plan_import.',
        },
        declaredSizeBytes: { type: 'integer', minimum: 1, description: 'begin: exact archive size in bytes.' },
        sha256: { type: 'string', description: 'begin: lowercase SHA-256 of the complete archive.' },
        uploadId: { type: 'string', description: 'Upload UUID returned by begin.' },
        offset: { type: 'integer', minimum: 0, description: 'chunk: current byte offset.' },
        contentBase64: {
          type: 'string',
          maxLength: 1_398_104,
          description: 'chunk: base64-encoded archive bytes, at most 1 MiB decoded.',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:create',
    invalidateStores: ['containers'],
    historyRetention: { mode: 'never_full' },
    mcpOnly: true,
  },
  {
    name: 'download_docker_archive',
    description:
      'Export a container archive (.gwca, kind container) or a volume archive (.tar.gz, kind volume) through authenticated MCP. Preferred: operation "link" takes the begin arguments and returns a one-time download URL (valid 15 minutes, single use) with a ready `curl -fsS -o <file> <url>` command that streams the archive from the node; a non-zero curl exit means the file is incomplete. Without a shell, begin prepares the archive on the Opfield host and returns a downloadId; poll status until ready (it reports sizeBytes and sha256); read chunk at increasing offsets (at most 1 MiB per call, base64) until eof; then close. Container export needs docker:containers:export, plus files read for the portable image mode, environment access when includeEnvironment (default true), and secrets access when includeSecrets. Volume export needs docker:volumes:export. Prepared archives expire after an hour of inactivity.',
    parameters: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['link', 'begin', 'status', 'chunk', 'close'] },
        kind: { type: 'string', enum: ['container', 'volume'], description: 'link or begin: what to export.' },
        nodeId: { type: 'string', description: 'link or begin: Docker node ID.' },
        containerId: {
          type: 'string',
          description: `link or begin (container): ${STABLE_CONTAINER_REFERENCE_DESCRIPTION}`,
        },
        volumeName: { type: 'string', description: 'link or begin (volume): volume name.' },
        imageMode: {
          type: 'string',
          enum: ['portable', 'registry'],
          description:
            'link or begin (container): embed the image (portable, default) or reference its registry digest.',
        },
        includeWritableLayer: {
          type: 'boolean',
          description: 'link or begin (container): include filesystem changes.',
        },
        includeEnvironment: {
          type: 'boolean',
          description: 'link or begin (container): include environment. Default: true',
        },
        includeSecrets: {
          type: 'boolean',
          description: 'link or begin (container): include secret values; requires includeEnvironment. Default: false',
        },
        downloadId: { type: 'string', description: 'Download UUID returned by begin.' },
        offset: { type: 'integer', minimum: 0, description: 'chunk: byte offset. Default: 0' },
        length: {
          type: 'integer',
          minimum: 1,
          maximum: 1_048_576,
          description: 'chunk: bytes to read. Default: 1 MiB',
        },
      },
      required: ['operation'],
      additionalProperties: false,
    },
    destructive: true,
    category: 'Docker',
    requiredScope: 'docker:containers:export',
    invalidateStores: [],
    historyRetention: { mode: 'never_full' },
    mcpOnly: true,
  },
];
