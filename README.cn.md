[English](README.md) | [Русский](README.ru.md) | 中文

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/opfield-lockup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/opfield-lockup-light.png">
    <img src="docs/assets/brand/opfield-lockup-light.png" width="360" alt="Opfield">
  </picture>
</p>

# Opfield

AI-first 但不依赖 AI 的自托管基础设施控制平面，用于 nginx ingress、Docker 工作负载、证书、数据库、日志、监控、状态页和自动化。

> [!NOTE]
> 主要开发在 [GitHub](https://github.com/the-square-labs/gateway) 进行。Issues 和功能请求可以提交到 [GitHub issue tracker](https://github.com/the-square-labs/gateway/issues)。

## 为什么需要 Opfield

Opfield 为小型基础设施团队提供一个产品，用来处理日常工作中通常分散在 nginx 配置、shell 脚本、Docker 主机、证书目录、数据库客户端、仪表盘和告警工具里的任务。

AI Workspace 是推荐的 intent-driven 界面：从完整 Scenario 开始或描述期望结果，查看建议计划，然后决定是否执行。Operations Console 仍然是管理同一基础设施的完整独立界面，因此 Opfield 的安装、运维、自动化和恢复都不依赖 AI。

当你希望做到以下事情时，可以使用 Opfield：

- 管理多个 proxy、Docker 和 monitoring 节点，而不需要在这些节点上开放入站 management 端口。
- 给运维人员一个聚焦的 UI 和 API 来处理 production 任务，而不需要给他们 root shell access。
- 集中管理 TLS、内部 PKI、ACME 证书、域名、状态页、通知和审计历史。
- 在一个地方管理 Docker containers、deployments、portable 或 registry-backed `.gwca` archives、logs、files、consoles、secrets 和 registry workflows。
- 通过 API tokens、OAuth、CI/CD webhooks 和 MCP clients 提供受控自动化。
- 从 AI Workspace Scenario 开始，或使用 Plan Mode 在明确确认执行之前研究并验证多步骤变更。

## 首批集成伙伴

Opfield 已被集成到产品、企业、交易和金融科技基础设施中：

- [Wiolett Industries](https://docs.opfield.dev/en/success-stories/wiolett-industries/) — 产品工程与基础设施交付。
- [Remedy Trade](https://docs.opfield.dev/en/success-stories/remedy-trade/) — 系统化交易运营。
- [Just Working](https://docs.opfield.dev/en/success-stories/just-working/) — 企业平台与云集成。
- [DFK Algotrade](https://docs.opfield.dev/en/success-stories/dfk-algotrade/) — 金融科技工程与投资组合基础设施。

## 最快安装

在带 Docker 的 Linux 服务器上安装 Opfield：

```bash
curl -fsSL https://get.opfield.dev | bash
```

> [!IMPORTANT]
> **Production 部署说明：** Opfield 是一个高权限的基础设施控制平面。为了执行 self-updates 和本地维护等内部操作，Opfield app 会挂载宿主机 Docker socket。请在隔离 VM 或专用主机上运行 Opfield，不要在同一 Docker 主机上放置无关 workloads。

安装器会启动 Opfield 并输出一次性设置代码。随后浏览器向导会配置规范 URL、可选择的节点 public/local network endpoints、一个或多个登录方式（OIDC、密码或 email code）、首个系统管理员、可选的 structured logging 和可选的 AI Workspace。Opfield Inference 在 AI Workspace 流程内配置，而不是作为单独的 onboarding 产品。

根据你的部署方式开放对应端口：

| 端口 | 用途 |
|------|------|
| `3000/tcp` | Opfield app UI/API 端口。对于 behind-NAT installs，请只在本地网络开放，并让外部 reverse proxy 指向它。 |
| `443/tcp` | 由你自己的 reverse proxy 提供的可选 public HTTPS endpoint。Opfield 本身监听 `3000/tcp`。 |
| `80/tcp` | HTTP 和 ACME HTTP-01 challenge，仅在使用该 challenge mode 时需要。 |
| `9443/tcp` | managed daemon control 与 tunnel connections 使用的公开 relay-backed gRPC endpoint。Opfield app 的 gRPC listener 仅在内部使用。 |

在 NAT 或已有外部 reverse proxy 后面时，只在本地网络发布 `3000/tcp`，并配置外部 proxy 将 Opfield 公共域名转发到选定的 HTTP 或 HTTPS transport（`<gateway-lan-ip>:3000`）。Managed nodes 仍会 outbound 连接 Opfield 的 `9443/tcp`；它们不需要入站 management ports。

新的交互式安装在 shell 中只询问一个问题：端口 `3000` 使用 native HTTPS 还是 HTTP。所有产品配置都在 browser wizard 中完成；更新是非交互式的，并保留现有设置。

关于 flags、non-interactive installs、custom SSL、OIDC details、updates 和 node setup，请阅读 [installation guide](docs/installation.md)。

## 从这里开始

| 目标 | 阅读 |
|------|------|
| 了解 Opfield 可以管理什么 | [Capabilities](docs/capabilities.md) |
| 安装 Opfield | [Installation guide](docs/installation.md) |
| 添加 Ingress、Docker、Build Worker、Storage、Monitoring 或 Relay 节点 | [Nodes and daemons](docs/nodes.md) |
| 运行 Storage 节点、storage connections 和数据库备份 | [Storage and backups](docs/storage-and-backups.md) |
| 导出或导入包含或不包含内嵌 image 的 Docker containers | [GWCA container archives](docs/docker-container-archives.md) |
| 配置 tokens、OAuth、MCP、logging、updates 和 AI | [Operations guide](docs/operations.md) |
| 配置 multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| 查看 security model | [Security model](docs/security.md) |
| 了解 license tiers 和 activation | [Licensing](docs/licensing.md) |
| 本地运行项目或参与贡献 | [Development guide](docs/development.md) |
| 查看 permission scopes | [SCOPES.md](SCOPES.md) |

## 产品导览

<table>
<tr>
<td align="center"><strong>基础设施总览</strong></td>
<td align="center"><strong>AI Workspace 规划</strong></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/the-square-labs/gateway-docs/main/public/screenshots/product-tour/dashboard-overview.png" width="100%" alt="Opfield dashboard，展示 routes、databases、nodes、health 和资源使用情况"></td>
<td><img src="https://raw.githubusercontent.com/the-square-labs/gateway-docs/main/public/screenshots/product-tour/ai-workspace.png" width="100%" alt="AI Workspace 展示经过审阅的基础设施部署计划"></td>
</tr>
<tr>
<td align="center"><strong>Workload 与 Secure Link runtime</strong></td>
<td align="center"><strong>Managed database 可观测性</strong></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/the-square-labs/gateway-docs/main/public/screenshots/product-tour/container-secure-link.png" width="100%" alt="Docker workload overview 与 Secure Link runtime metrics"></td>
<td><img src="https://raw.githubusercontent.com/the-square-labs/gateway-docs/main/public/screenshots/product-tour/managed-database.png" width="100%" alt="Managed PostgreSQL database health 与 performance overview"></td>
</tr>
<tr>
<td align="center"><strong>Ingress route 与 health</strong></td>
<td align="center"><strong>分布式 node inventory</strong></td>
</tr>
<tr>
<td><img src="https://raw.githubusercontent.com/the-square-labs/gateway-docs/main/public/screenshots/product-tour/ingress-route.png" width="100%" alt="由 Docker Secure Link 支持的健康 ingress route"></td>
<td><img src="https://raw.githubusercontent.com/the-square-labs/gateway-docs/main/public/screenshots/product-tour/nodes.png" width="100%" alt="Opfield node inventory，包含 ingress、Docker、database、monitoring、build 和 relay roles"></td>
</tr>
</table>

## Opfield 覆盖范围

| 领域 | 摘要 |
|------|------|
| Ingress | Domain 选择 public nginx ingress node，或在 Business+ 中选择由多个 nginx nodes 组成的 ingress group：成员服务相同的 routes，并在 Opfield 或其他成员不可用时继续服务；route 将流量转发到 address、Docker container、deployment 或 Pages Tag。Managed Additional Routes 可在同一 route 内添加 path-prefix targets，Additional Secure Link Bindings 则让 advanced nginx config 使用 Docker upstreams。还包括 maintenance mode、redirects、WebSockets、access lists、health checks、route folders、templates、logs 和 stats。REST API 为兼容性保留 `proxy-host` identifiers。 |
| Pages | 基于项目的静态站点托管，支持不可变 Deployments、可变 Tags（包括系统管理的 `latest`）、指向 Tags 的自定义 Routes、可选 wildcard previews、no-store runtime configuration、per-project node placement 和 migration。Personal 及以上计划可用；Business+ 增加在隔离 Build Workers 上运行的 Git source builds。项目/源 metadata、build control 与 publication 可通过 AI Workspace 和 MCP 管理，remote MCP clients 还可通过 authenticated resumable tool 上传 artifacts，无需在参数中传递 credentials。 |
| Docker | Container lifecycle、first-class single-node Compose Projects、Business+ 可用的面向 container、blue/green deployment 和 Compose project 的直接 Git repository/branch push-to-deploy、隔离的 Build Worker、所有计划均可使用的默认私有 Opfield-managed internal registry（Business+ 可选 external access）、所有计划均可使用的 Default (`runc`) runtime profile，以及 Business 和 Enterprise 可使用的 Secure (`runsc`/gVisor) profile、Opfield-managed volumes、rollout/rollback、shared physical NVIDIA/AMD/Intel GPU attachment、eligible cross-node container 和 volume migrations、offline inventory snapshots、registries、images、networks、tasks、webhooks、logs、console、file browser、secrets、env vars、ports 和 cleanup。Business+ 的 multi-node Availability 可在 Docker nodes 之间 failover workload，Opfield 不可用时也可以。Secure workloads 不支持 GPU、migration 或 export；GPU-attached workloads 在 v1 中也不能迁移或导出。 |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports 和 route binding。 |
| Domains | Central hostname registry、单个 node 或 ingress group 上的 nginx ingress placement、external 或 Cloudflare-managed DNS、validation、usage tracking 和 explicit ingress migration。 |
| Databases | Saved PostgreSQL、key-value 和 ClickHouse connections，含 encrypted credentials、health history、browsing、scoped query consoles 和 capability-aware write operations；private-by-default managed Postgres、key-value store（兼容 Redis clients）和 ClickHouse instances 可通过 Console、AI Workspace 或 MCP 安全绑定到 Docker workloads。定时 native backups 和 restores 在选定的 Storage 节点上运行。Personal 及以上计划可用；自 2.11 起也包括 saved external connections。 |
| Storage | 连接 AWS S3、Cloudflare R2、MinIO 及其他 S3-compatible endpoints、FTP、FTPS 和 SFTP 的 storage connections，以及 Storage 节点上默认私有的 managed SeaweedFS object storage，支持 bucket-scoped application bindings。Personal 及以上计划可用。 |
| Monitoring | Node CPU, memory, disk, network, service status, capability-aware physical GPU telemetry, daemon runtime details, log streaming 和 update checks。 |
| Logging | 可选的 ClickHouse-backed structured log ingestion，包含 schemas、retention、ingest tokens、rate limits、search、storage caps 和 health safeguards。 |
| Automation | API tokens、OAuth 2.0 PKCE、提供 Ingress、Pages、Databases、Docker/Compose、source build 与 Build Worker scoped operations 及 internal Opfield documentation 读取能力的 remote MCP endpoint、CI/CD webhooks、webhook notifications 和 status pages。 |
| Integrations | GitLab project、repository、CI/CD、variable、webhook、registry 和 sandbox workflows；GitHub repository 与 Actions workflows；generic Git connectors；external SSH connectors；以及 Cloudflare DNS/ACME automation。Connector credentials 会加密保存，访问受 scopes 限制。GitLab integration 需要 Personal 及以上计划。 |
| Relay | Long-lived local relay 负责公开 `9443/tcp` 上的 daemon control 与 managed tunnel traffic。Relay Pool 可增加 remote supervisor/worker pairs、显式 placement/rebalancing、drain 与 rolling signed updates，同时保持一个逻辑 Secure Link。Opfield、local relay 和 remote relay 的证书在运行中自动续期。 |
| AI Workspace | 可选的 intent-driven operations，包含引导式 Scenarios、Plan Mode、permission-aware tools、approvals、sandboxed execution、进度跟踪和最终验证。在明确确认之前，规划不会执行任何变更。Scenarios、Plan Mode 和 sandboxed execution 需要 Personal 及以上计划。 |
| Inference | 可选的 multi-provider model gateway，包含独立 tokens、usage controls、仅在 output 开始前进行的 capability-compatible cross-provider fallback、OpenAI/Anthropic-compatible APIs，以及通过 `@sqgateway/inference` 管理且可选 user-session auto-start 的 Codex 或 Claude Code 配置。 |
| Administration | OIDC、password、email-code 和 passkey login，group-based 和 per-user additional permissions, scoped programmatic access, audit logs, setup state, updates 和 license controls。 |

## 工作方式

Opfield 作为 Docker stack 运行在 control-plane server 上。Managed hosts 运行小型 Go daemons，它们通过 outbound gRPC 和 mTLS 连接到 Opfield。

```text
                Opfield server
        +-----------------------------+
        | app + relay + registry      |
        | redis                       |
        | postgres local or remote    |
        | clickhouse local/remote/off |
        | relay gRPC :9443            |
        +-------------+---------------+
                      |
                outbound mTLS
                      |
        +-------------+-------------------+
        |             |                   |
 nginx-daemon   docker-daemon     storage profile      monitoring-daemon
 ingress route  container host    databases, S3 store  metrics-only host
```

Relay 是一个独立的 long-lived container，也是 `9443/tcp` 唯一的公开监听方。普通 app-only 更新会保留 relay container 和已建立的 managed-database binding streams；更新 relay 仍然是一个单独的 data-plane maintenance event。每个 Relay 版本都会声明所需的最低 Opfield 版本，Opfield 只有在自身运行该版本后才会提供或执行独立的 relay 更新。

Opfield 每小时检查其 gRPC、web 和 local relay 证书，并在到期前 30 天内续期，无需重启：已建立的 daemon 和 relay 连接继续使用当前证书，新的 handshake 获得续期后的证书。只要还有未使用的 node enrollment tokens，其安装命令所固定的 gRPC 证书只会在最后一周内续期。

可以在 **Settings > Relay** 中把本地 relay 扩展为一个逻辑 Relay Pool。额外的 relay 节点由专用 supervisor 管理，控制连接仍然只需 outbound 到 Opfield，并且只向参与的 managed hosts 暴露配置的 relay data endpoint（默认 TCP `9443`）。Opfield 不修改 firewall、不提供 NAT traversal，也不创建 overlay network。Relay Pool 稳定后，Opfield 会自动把 placements 迁移到新的 relay（管理员也可以手动执行 **Rebalance**），并且只有在 workload 的主机确认能访问新 relay 后才切换；之后新连接会分散到 workload 预先验证的 active relay 集合中，而用户仍然看到一个逻辑 Secure Link。Remote relay 证书会在到期前自动续期；无法恢复的 remote relay 可以在同一页面重新注册，而 local relay 的 policy trust 由 Opfield 自动修复。

节点不需要入站 management 端口。你对外提供服务时仍然需要 public traffic ports，例如 nginx nodes 上的 `80` 和 `443`。

## Security Model

Opfield 的设计目标是让自托管基础设施控制平面默认更安全：

- 用户登录支持 OIDC、password、email code 和 passkeys。Local authentication 需要已验证的 SMTP delivery，group MFA policy 会在 primary credential 后生效。
- Managed nodes 通过 gRPC 和 mTLS outbound 连接 Opfield。首次 enrollment 需要一次性 token 和生成的 Opfield gRPC certificate fingerprint，daemon 会在发送 token 前验证 Opfield TLS leaf。Enrollment 完成后，daemon commands 需要由 Opfield internal node CA 签发的 client certificate。
- 每个 node certificate 都绑定到一个 node identity。Opfield 在接受 control streams、log streams 和 certificate renewal requests 前会检查 mTLS certificate identity。
- 节点不需要入站 management 端口。失去 Opfield 访问不会停止现有 nginx configs 或 Docker containers；它只会暂停 centralized control。
- API tokens、OAuth grants、MCP access、database credentials、certificate exports 和 secret reveal operations 都受 scope 限制，不能超过拥有者当前 permissions，并且会被审计。
- Private key material 和保存的 infrastructure credentials 使用配置的 `PKI_MASTER_KEY` 进行 at rest 加密。

最终形成的是 PKI-backed trust model：short-lived enrollment tokens 只有在 daemon 确认自己正在与 pinned Opfield certificate 通信后才会让节点进入系统，长期信任则基于 certificate identity，而不是 reusable shared secrets。这让 Opfield 对 setup 期间的 token interception 和 enrollment 后的 node hijacking 都具备更强的默认防护。完整说明和 hardening checklist 见 [security model](docs/security.md)。

## FAQ

<details>
<summary><strong>Opfield 是 Kubernetes 的替代品吗？</strong></summary>

不是。Opfield 面向直接的基础设施操作：nginx hosts、Docker hosts、certificates、domains、databases、logs、monitoring 和 automation。它可以与 Kubernetes 并存，但并不试图成为 Kubernetes control plane。
</details>

<details>
<summary><strong>节点需要入站 management 端口吗？</strong></summary>

不需要。Daemons 通过 outbound gRPC 和 mTLS 连接到 Opfield。如果 nginx nodes 提供公开站点，它们仍然需要普通的 public traffic ports，例如 `80` 和 `443`。
</details>

<details>
<summary><strong>Opfield 可以管理现有 nginx host 吗？</strong></summary>

可以。以 `integrate` 模式安装 nginx daemon。Opfield 会保留现有 `nginx.conf`，并注入 managed includes 和本地 stats endpoint。参见 [nginx node modes](docs/nodes.md#nginx-node-modes)。
</details>

<details>
<summary><strong>Opfield 可以不使用 ClickHouse 吗？</strong></summary>

可以。在 first-run wizard 或 **Settings > Features** 中为 structured logging 选择 **Disabled**。Opfield 的其他部分会继续工作；managed local ClickHouse 可以在不删除 data volume 的情况下关闭。
</details>

<details>
<summary><strong>API 或 OAuth tokens 会暴露 secrets 吗？</strong></summary>

只有当拥有者已经具备所需 scopes 时才可以。Sensitive OAuth scopes 在 consent 时需要显式 opt-in，API/OAuth tokens 不能超过用户当前的 effective permissions，并且 resource-scoped write-capable scopes 在隐含 read/view checks 时仍然限制在同一 resource 内。参见 [SCOPES.md](SCOPES.md)。
</details>

<details>
<summary><strong>Opfield 如何防止 managed nodes 被劫持？</strong></summary>

Opfield 使用自己的 internal PKI 作为 daemon identity。节点 setup command 包含 one-time enrollment token 和 Opfield gRPC certificate fingerprint。Daemon 会在发送 token 前验证 Opfield TLS leaf certificate，然后从 Opfield node CA 接收 mTLS client certificate，从本地 config 删除 token，并使用 certificate 重新连接。随后 Opfield 会在 control streams、log streams 和 renewal requests 上验证 certificate identity。参见 [security model](docs/security.md)。
</details>

<details>
<summary><strong>如果 Opfield offline 会怎样？</strong></summary>

Managed services 会继续运行。Existing nginx configs 会继续服务 traffic，Docker containers 会继续运行，daemons 会在 Opfield 恢复后重新连接。在应用恢复前，centralized UI/API control 不可用。Relays 会在 relay policy lease 期间（默认 72 小时，**Settings > Relay**）按最后一份已签名 policy 继续工作，之后在 Opfield 恢复前不再接受新连接。处于 lease mode 的 Docker Availability policies 在没有 Opfield 时也会继续 failover：在默认的 strict 模式下，与本 policy 多数 voters 断开的 node 上的副本会按设计停止，由下一个 candidate 接管。参见 [offline behavior](docs/nodes.md#offline-behavior)。
</details>

<details>
<summary><strong>AI Workspace 是必须的吗？</strong></summary>

不是。AI Workspace 是可选功能。Operations Console、REST API、OAuth 和 MCP 都可以独立使用；只有管理员启用 AI Workspace 并配置 provider 后，Opfield 才会向 AI provider 发送数据。运维人员可以从引导式 Scenario 开始，或选择 Plan Mode 生成经过验证且易读的计划；在用户明确确认实施之前，不会执行任何变更。
</details>

## 产品计划与许可

Opfield 提供四个产品计划。付费计划适用于一个 Opfield 实例，不按 managed node、用户或 custom permission group 额外收费。

Opfield 源代码依据 [PolyForm Perimeter License 1.0.1](LICENSE.md) 发布。该许可证允许为非竞争性目的使用、修改和再分发代码，包括企业内部使用；但不允许向他人提供被宣传为 Opfield 替代品的产品。Personal、Business 或 Enterprise 密钥依据 [Paid Key Terms](COMMERCIAL-LICENSE.md) 解锁相应计划的功能与限制；普通付费密钥不会自动授予 OEM、白标、转售或竞争性托管服务的权利。

每个官方版本还附带[产品连续性授权](CONTINUITY-GRANT.md)：如果 Opfield 停止提供（连续 12 个月没有新版本且许可证服务不可用，或发布停止支持公告），或许可方无法再履行职责，最后一个版本的源代码（包括商业核心）将以 MIT 许可证向所有人开放，持有当时有效密钥的用户还将获得永久、免版税的许可，可继续使用和自行托管该版本，并在没有许可证服务的情况下运行。完整条款以授权文件为准。

> [!NOTE]
> 以下价格为初步价格，不构成要约，并可能发生变化。购买前请确认最新价格和条款。

| 计划 | 月付 | 年付 | 规模与重点 |
|------|------|------|------------|
| ![Community](docs/assets/license/wiolett-gw-community-24.png)<br>Community | $0 | $0 | 核心平台、AI Workspace 和 Opfield Inference，可用于内部及其他非竞争性用途；最多 25 个 managed nodes、3 个用户和 1 个 custom permission group；提供只读 Compose 项目发现、inventory、monitoring 和 logs；Pages、databases、storage、GitLab integration 以及 AI Workspace 的 Scenarios、Plan Mode 和 sandboxes 不可用。 |
| ![Personal](docs/assets/license/wiolett-gw-personal-24.png)<br>Personal | $29 | $290 | managed nodes/users/groups 的 plan quotas 不限，并包含 Compose deployment 与 lifecycle management、container archive import/export、blue/green deployments、cross-node migration、managed databases 和带备份的 external database connections、storage connections 和 managed SeaweedFS object storage、GitLab integration、AI Workspace 的 Scenarios、Plan Mode 和 sandboxes、public status pages、Pages 静态站点托管和 registry discovery；多节点 Workload Availability 需要 Business 或 Enterprise。 |
| ![Business](docs/assets/license/wiolett-gw-business-24.png)<br>Business | $189 | $1,890 | 包含 Personal（包括 Compose management 和 Pages）的全部功能，并增加面向 containers、blue/green deployments、Compose Projects 与 Pages、带隔离 Build Workers 和 build vulnerability policy 的 Git push-to-deploy、private internal registry 的可选 external access、Docker Secure Runtime、structured logging、audit export、guided onboarding、已可用的多节点 Workload Availability (HA)，以及发布后的更广泛安全扫描、基于指标的自动扩缩容和 same-node multi-instance 功能。 |
| ![Enterprise](docs/assets/license/wiolett-gw-enterprise-24.png)<br>Enterprise | 询价 | 询价 | 包含 Business（包括 Pages）的全部功能，并增加 Internal PKI、SIEM export、专属技术联系人，以及部署和迁移协助。 |

上述 Community 限制以及现在需要 Personal 及以上计划的功能自 2.11 起生效；2.10 的 Community 允许 100 个 managed nodes、10 个用户和 5 个 custom permission groups。计划限制只在创建时检查，因此已经超出限制的实例会保留现有节点、用户和组，但在仍处于或超过限制时无法再添加。

完整功能矩阵、可用性状态、许可证验证和 source-license 边界请参见[产品计划与许可](docs/licensing.md)。

付费密钥到期后，Personal、Business 和 Enterprise 的技术 entitlements 分别继续有效 24 小时、3 天和 7 天。此后 Opfield 会阻止创建新的付费资源和其他新的付费操作，但不会停止或删除已经配置的基础设施。已撤销、已替换、无效或明确停用的密钥会单独处理。

Copyright (c) 2021-2026 Alexandr Slavinschii, Republic of Moldova
