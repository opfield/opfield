[English](README.md) | Русский | [中文](README.cn.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/brand/opfield-lockup-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/brand/opfield-lockup-light.png">
    <img src="docs/assets/brand/opfield-lockup-light.png" width="360" alt="Opfield">
  </picture>
</p>

# Opfield

AI-first, но не AI-dependent платформа управления инфраструктурой для nginx ingress, Docker-нагрузок, сертификатов, баз данных, логов, мониторинга, статус-страниц и автоматизации.

> [!NOTE]
> Основная разработка ведется на [GitHub](https://github.com/opfield/opfield). Issues и запросы функций можно оставлять в [GitHub issue tracker](https://github.com/opfield/opfield/issues).

## Зачем нужен Opfield

Opfield заменяет стек инфраструктуры на ваших серверах. Входящий трафик, TLS, контейнеры, развёртывания, отказоустойчивость, базы данных, объектное хранилище, бэкапы, мониторинг, логи, алерты, статус-страницы, приватная сеть и права доступа: один продукт, одна установка, одна модель прав, один журнал аудита.

AI Workspace превращает цель или готовый Scenario в план, который вы проверяете, и выполняет его только после подтверждения. Operations Console — полноценный интерфейс сам по себе: установка, эксплуатация, автоматизация и восстановление Opfield никогда не зависят от AI.

С Opfield вы:

- Ведёте прокси, Docker-, storage- и monitoring-ноды без входящих портов управления на них.
- Даёте операторам интерфейс и API для рабочих задач вместо root-доступа к серверам.
- Держите TLS, внутренний PKI, ACME-сертификаты, домены, статус-страницы, уведомления и журнал аудита в одном месте.
- Управляете Docker-контейнерами, Compose-проектами, развёртываниями, архивами `.ofca`, логами, файлами, консолями, секретами и реестрами на всех нодах.
- Автоматизируете работу через API-токены, OAuth, CI/CD-вебхуки и MCP-клиентов с теми же ограниченными правами.
- Планируете многошаговое изменение в AI Workspace и выполняете его после явного подтверждения.

## Что заменяет Opfield

| Вместо | В Opfield |
|--------|-----------|
| nginx или Traefik, certbot, cert-manager | Маршруты и домены с автоматическими сертификатами ACME, внутренний PKI, списки доступа и страницы обслуживания |
| Portainer и другие панели Docker | Контейнеры, Compose-проекты, образы, тома, сети, логи, файлы и консоли на всех нодах |
| Coolify, Dokku, PaaS в стиле Heroku | Сборки из Git, развёртывания с переключением слотов и откатом, приложения с окружениями, Pages для статических сайтов |
| Kubernetes ради отказоустойчивости | Docker Availability: приложения переезжают на другую ноду, если одна отказала, без кластера, который нужно обслуживать |
| Операторы баз данных и облачные базы | Managed PostgreSQL, key-value хранилища, ClickHouse и S3-хранилище с отказоустойчивостью и приватными подключениями |
| Скрипты и сервисы бэкапов | Бэкапы баз по расписанию в S3, FTP, FTPS или SFTP, восстановление, которое никогда не перезаписывает исходную базу, и зашифрованный экспорт, который восстанавливает всю установку |
| VPN, bastion-хосты, открытые порты управления | Secure Links и relay: ноды подключаются сами, приложениям и базам не нужны открытые порты |
| Prometheus, Grafana, Loki, Alertmanager | Метрики нод и контейнеров, централизованные логи, правила алертов и уведомления |
| Statuspage, Uptime Kuma | Статус-страницы с компонентами и инцидентами |

Почему каждая замена проще и лучше: [Зачем нужен Opfield](https://docs.opfield.dev/ru/getting-started/why-opfield/). Операционная система серверов и сетевой периметр остаются за вами, а единица работы — контейнер или Compose-проект.

## Первые интеграторы

Opfield работает в продуктовой, корпоративной, торговой и финтех-инфраструктуре:

- [Remedy Trade](https://docs.opfield.dev/ru/success-stories/remedy-trade/) — эксплуатация системной торговли.
- [Just Working](https://docs.opfield.dev/ru/success-stories/just-working/) — enterprise-платформы и cloud-интеграции.
- [DFK Algotrade](https://docs.opfield.dev/ru/success-stories/dfk-algotrade/) — fintech-разработка и портфельная инфраструктура.

## Самая быстрая установка

Установите Opfield на Linux-сервер с Docker:

```bash
curl -fsSL https://get.opfield.dev | bash
```

> [!IMPORTANT]
> **Примечание для production-развертывания:** Opfield - привилегированная панель управления инфраструктурой. Для внутренних операций, таких как self-updates и локальное обслуживание, приложение Opfield монтирует Docker socket хоста. Запускайте Opfield в изолированной VM или на выделенном хосте и не размещайте на том же Docker-хосте посторонние workloads.

Installer запускает Opfield и выводит одноразовый код настройки. В браузерном мастере затем задаются канонический URL, выбираемые публичные и локальные network endpoints для nodes, один или несколько способов входа (OIDC, пароль или email-код), первый системный администратор, опциональное structured logging и опциональный AI Workspace. Opfield Inference настраивается внутри AI Workspace, а не как отдельный onboarding-продукт.

Откройте порты, подходящие для вашей схемы развертывания:

| Порт | Назначение |
|------|------------|
| `3000/tcp` | UI/API порт приложения Opfield. Для установок за NAT откройте его только в локальной сети и направьте внешний reverse proxy на него. |
| `443/tcp` | Опциональный публичный HTTPS endpoint вашего reverse proxy. Сам Opfield слушает `3000/tcp`. |
| `80/tcp` | HTTP и ACME HTTP-01 challenge, только если используется этот challenge mode. |
| `9443/tcp` | Публичный relay-backed gRPC endpoint для control и tunnel connections managed daemons. gRPC listener приложения Opfield остаётся внутренним. |

За NAT или существующим внешним reverse proxy публикуйте `3000/tcp` только в локальной сети и настройте внешний proxy на передачу публичного домена Opfield к выбранному HTTP- или HTTPS-транспорту на `<opfield-lan-ip>:3000`. Managed nodes все равно подключаются исходяще к Opfield на `9443/tcp`; входящие management-порты им не нужны.

При новой интерактивной установке единственный shell-вопрос — использовать ли native HTTPS или HTTP на порту `3000`. Вся настройка продукта выполняется в browser wizard; обновления неинтерактивны и сохраняют настройки.

Флаги, non-interactive installs, custom SSL, OIDC details, updates и node setup описаны в [installation guide](docs/installation.md).

## С чего начать

| Цель | Читать |
|------|--------|
| Понять, чем может управлять Opfield | [Capabilities](docs/capabilities.md) |
| Установить Opfield | [Installation guide](docs/installation.md) |
| Добавить Ingress, Docker, Build Worker, Storage, Monitoring или Relay узлы | [Nodes and daemons](docs/nodes.md) |
| Запустить Storage-узлы, storage connections и бэкапы баз данных | [Storage and backups](docs/storage-and-backups.md) |
| Экспортировать или импортировать Docker-контейнеры со встроенным image или без него | [OFCA container archives](docs/docker-container-archives.md) |
| Настроить tokens, OAuth, MCP, logging, updates и AI | [Operations guide](docs/operations.md) |
| Настроить multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| Изучить security model | [Security model](docs/security.md) |
| Проверить образы, SBOM и подписанные манифесты релиза | [Verifying releases](docs/verify-releases.md) |
| Понять license tiers и activation | [Licensing](docs/licensing.md) |
| Запустить проект локально или внести вклад | [Development guide](docs/development.md) |
| Посмотреть permission scopes | [SCOPES.md](SCOPES.md) |

## Обзор продукта

<table>
<tr>
<td align="center"><strong>Обзор инфраструктуры</strong></td>
<td align="center"><strong>Планирование в AI Workspace</strong></td>
</tr>
<tr>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/dashboard-overview.png" width="100%" alt="Dashboard Opfield с маршрутами, базами данных, нодами, health status и использованием ресурсов"></td>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/ai-workspace.png" width="100%" alt="AI Workspace с проверенным планом развертывания инфраструктуры"></td>
</tr>
<tr>
<td align="center"><strong>Workload и Secure Link runtime</strong></td>
<td align="center"><strong>Наблюдаемость managed database</strong></td>
</tr>
<tr>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/container-secure-link.png" width="100%" alt="Обзор Docker workload с метриками Secure Link runtime"></td>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/managed-database.png" width="100%" alt="Health и performance overview managed PostgreSQL database"></td>
</tr>
<tr>
<td align="center"><strong>Ingress route и health</strong></td>
<td align="center"><strong>Распределённые ноды</strong></td>
</tr>
<tr>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/ingress-route.png" width="100%" alt="Работающий ingress route с Docker Secure Link"></td>
<td><img src="https://docs.opfield.dev/screenshots/product-tour/nodes.png" width="100%" alt="Список нод Opfield с ingress, Docker, database, monitoring, build и relay ролями"></td>
</tr>
</table>

## Что покрывает Opfield

| Область | Кратко |
|---------|--------|
| Ingress | Домен выбирает публичную nginx ingress-ноду или, в Business+, ingress group из нескольких nginx-нод, которые обслуживают одни и те же routes и продолжают работать, пока Opfield или другой участник группы недоступен; route направляет трафик на адрес, Docker container, deployment или Pages Tag. Managed Additional Routes добавляют path-prefix targets внутри одного route, а Additional Secure Link Bindings дают advanced nginx config доступ к Docker upstreams. Также доступны maintenance mode, redirects, WebSockets, access lists, health checks, folders, templates, logs и stats. REST API сохраняет идентификаторы `proxy-host` для совместимости. |
| Pages | Проектный static-site hosting с неизменяемыми Deployments, изменяемыми Tags (включая управляемый системой `latest`), custom Routes, направленными на Tags, опциональными wildcard previews, runtime configuration без кэширования, per-project размещением и migration. Доступно в Personal и выше; Business+ добавляет Git source builds на изолированных Build Workers. Metadata источника/проекта, управление builds и publication доступны через AI Workspace и MCP, а remote MCP clients также могут загружать артефакты через authenticated resumable tool без передачи credentials в аргументах. |
| Docker | Container lifecycle, first-class single-node Compose Projects, доступный в Business+ прямой Git repository/branch push-to-deploy для containers, blue/green deployments и Compose projects, изолированные Build Workers, private-by-default внутренний registry под управлением Opfield во всех планах с опциональным внешним доступом в Business+, профиль runtime Default (`runc`) во всех планах и Secure (`runsc`/gVisor) в Business и Enterprise, Opfield-managed volumes, rollout/rollback, shared физические NVIDIA/AMD/Intel GPU, допустимые cross-node migrations контейнеров и volumes, offline inventory snapshots, registries, images, networks, tasks, webhooks, logs, console, file browser, secrets, env vars, ports и cleanup. Multi-node Availability в Business+ переносит workload между Docker-нодами, в том числе пока Opfield недоступен. Secure workloads не поддерживают GPU, migration и export; GPU-attached workloads в v1 также нельзя мигрировать или экспортировать. |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports и привязка к routes. |
| Domains | Единый реестр hostnames, выбор nginx ingress-ноды или ingress group, внешний или Cloudflare-managed DNS, validation, usage tracking и явная ingress migration. |
| Databases | Saved PostgreSQL, key-value и ClickHouse connections с encrypted credentials, health history, browsing, scoped query consoles и capability-aware write operations; private-by-default managed Postgres, key-value store (работает с Redis clients) и ClickHouse instances могут безопасно подключаться к Docker workloads через Console, AI Workspace или MCP. Плановые native backups и restores выполняются на выбранном Storage-узле. Доступно в Personal и выше; с 2.11 это относится и к saved external connections. |
| Storage | Storage connections к AWS S3, Cloudflare R2, MinIO и другим S3-compatible endpoints, FTP, FTPS и SFTP, а также private-by-default managed SeaweedFS object storage на Storage-узлах с bucket-scoped application bindings. Доступно в Personal и выше. |
| Monitoring | Node CPU, memory, disk, network, service status, capability-aware telemetry физических GPU, daemon runtime details, log streaming и update checks. |
| Logging | Опциональный ClickHouse-backed structured log ingestion со schemas, retention, ingest tokens, rate limits, search, storage caps и health safeguards. |
| Automation | API tokens, OAuth 2.0 PKCE, remote MCP endpoint со scoped-операциями для Ingress, Pages, Databases, Docker/Compose, source builds и Build Workers, чтением internal Opfield documentation, CI/CD webhooks, webhook notifications и status pages. |
| Integrations | GitLab workflows для projects, repositories, CI/CD, variables, webhooks, registry и sandbox; GitHub repositories и Actions; generic Git connectors; external SSH connectors; Cloudflare DNS/ACME automation. Credentials connectors шифруются, а доступ ограничен scopes. GitLab integration доступна в Personal и выше. |
| Relay | Long-lived local relay владеет публичным `9443/tcp` для daemon control и managed tunnel traffic. Relay Pool добавляет remote supervisor/worker pairs, явное placement и rebalancing, drain и rolling signed updates, сохраняя один логический Secure Link. Сертификаты Opfield, local relay и remote relay обновляются без перезапуска. |
| AI Workspace | Опциональные intent-driven operations с готовыми Scenarios, Plan Mode, permission-aware tools, approvals, sandboxed execution, отслеживанием прогресса и финальной проверкой. До явного подтверждения планирование не выполняет изменений. Scenarios, Plan Mode и sandboxed execution доступны в Personal и выше. |
| Inference | Опциональный multi-provider model gateway с отдельными tokens, usage controls, capability-compatible cross-provider fallback до начала output и OpenAI- и Anthropic-compatible API для Codex, Claude Code и других harness. |
| Administration | OIDC, password, email-code и passkey login, group-based и дополнительные per-user permissions, scoped programmatic access, audit logs, setup state, updates и license controls. |

## Как это работает

Opfield запускается как Docker stack на control-plane сервере. Managed hosts запускают небольшие Go daemons, которые подключаются к Opfield исходящим gRPC с mTLS.

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

Relay — отдельный long-lived container и единственный публичный владелец `9443/tcp`. Обычные app-only обновления сохраняют relay container и установленные managed-database binding streams; обновление relay остается отдельным событием обслуживания data plane. Каждый релиз Relay указывает минимальную версию Opfield, и Opfield предлагает или применяет отдельное обновление relay только после того, как сам работает на этой версии.

Opfield раз в час проверяет свои сертификаты gRPC, web и local relay и обновляет каждый за 30 дней до истечения без перезапуска: установленные соединения daemons и relay сохраняют текущий сертификат, а новые handshakes получают обновлённый. Пока есть неиспользованные enrollment tokens, gRPC-сертификат, закреплённый в их командах установки, обновляется только в последнюю неделю срока.

Локальный relay можно расширить до единого Relay Pool в **Settings > Relay**. Дополнительные relay-ноды подключаются через отдельный supervisor, исходяще соединяются с Opfield для управления и публикуют только настроенный data endpoint relay (по умолчанию TCP `9443`) для участвующих managed hosts. Opfield не меняет firewall, не выполняет NAT traversal и не создаёт overlay network. Opfield сам переносит placements на новый relay, когда pool стабилен (или когда администратор запускает **Rebalance**), и переключает workload только после того, как его хосты достучались до нового relay; новые соединения затем распределяются по заранее проверенному активному набору relay workload-а, а пользователь по-прежнему видит один логический Secure Link. Сертификаты remote relay обновляются автоматически до истечения; remote relay, который не может восстановиться, можно заново подключить на той же странице, а policy trust локального relay Opfield восстанавливает сам.

В продакшене запускайте не меньше двух relay на серверах, отличных от сервера Opfield, в разных доменах отказа. Когда relay отказывает, его потоки продолжаются через другой relay, и сокеты на обоих концах этого не замечают; с одним локальным relay Secure Links и подключения к базам зависят от сервера Opfield. См. [Сколько нужно Relay](https://docs.opfield.dev/ru/nodes/relay-pool/#сколько-нужно-relay).

Узлам не нужны входящие management-порты. Public traffic ports, например `80` и `443` на nginx nodes, все еще нужны для сервисов, которые вы публикуете.

## Security Model

Opfield безопасен по умолчанию:

- Вход поддерживает OIDC, пароль, email-коды и passkeys. Local authentication требует проверенной SMTP-доставки, а group MFA policy применяется после primary credential.
- Managed nodes подключаются к Opfield исходяще по gRPC с mTLS. Первая регистрация требует одноразовый token и сгенерированный fingerprint gRPC-сертификата Opfield, а daemon проверяет TLS leaf Opfield перед отправкой token. После enrollment daemon-команды требуют client certificate, выпущенный внутренней node CA Opfield.
- Каждый node certificate привязан к node identity. Opfield проверяет mTLS certificate identity перед приемом control streams, log streams и certificate renewal requests.
- Узлам не нужны входящие management-порты. Потеря доступа к Opfield не останавливает существующие nginx configs или Docker containers; она только приостанавливает centralized control.
- API tokens, OAuth grants, MCP access, database credentials, certificate exports и secret reveal operations ограничены scopes, не превышают текущие permissions владельца и аудируются.
- Private key material и сохраненные infrastructure credentials шифруются at rest с настроенным `PKI_MASTER_KEY`.

Итог - PKI-backed trust model: short-lived enrollment tokens вводят узел в систему только после того, как daemon подтвердит, что говорит с pinned Opfield certificate, а долгосрочное доверие основано на certificate identity вместо reusable shared secrets. Daemon никогда не отдаёт токен установки подменному серверу, а подключённая нода опознаётся по сертификату, а не по общему секрету. Полное объяснение и hardening checklist см. в [security model](docs/security.md).

## Проверка релизов

Каждый релиз можно проверить независимо:

- Opfield и его демоны устанавливают обновление только после проверки манифеста, подписанного Ed25519, открытым ключом, встроенным в них. Манифесты публикуются в ассетах релиза (`*.update.json`).
- Начиная с Opfield 2.12 каждый публикуемый образ (Opfield, relay, коннектор Secure Link, backup runner, пропатченный SeaweedFS, зеркала сторонних образов и inference core) подписывается через Sigstore без долгоживущего ключа: подпись ставит workflow GitHub Actions, который опубликовал образ, и она записывается в журнал прозрачности Rekor.
- В каждом релизе есть SBOM в формате SPDX для его образов и бинарников; те же SBOM прикреплены к образам как подписанные аттестации.

```bash
cosign verify ghcr.io/opfield/opfield:v2.12.0 \
  --certificate-identity https://github.com/opfield/opfield/.github/workflows/release.yml@refs/tags/v2.12.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Все образы, проверка SBOM и ручная проверка манифестов — в [Verifying releases](docs/verify-releases.md). Описание изменений публикуется в каждом GitHub-релизе ([CHANGELOG.md](CHANGELOG.md)). Об уязвимостях сообщайте по [SECURITY.md](SECURITY.md).

## FAQ

<details>
<summary><strong>Нужен ли Kubernetes для отказоустойчивости?</strong></summary>

Нет. Docker Availability запускает приложение на наборе нод и переносит его на другую ноду, если одна отказала, без etcd, CNI, ingress-контроллера, операторов и YAML. Управляемые базы данных и объектное хранилище работают на нескольких серверах и сами переключаются на копию, когда за это голосует свидетель (relay или третий сервер). Единица работы — контейнер или Compose-проект; манифесты Kubernetes и Helm-чарты Opfield не использует.
</details>

<details>
<summary><strong>Узлам нужны входящие management-порты?</strong></summary>

Нет. Daemons подключаются к Opfield исходящим gRPC с mTLS. Nginx nodes все еще нужны обычные public traffic ports, такие как `80` и `443`, если они обслуживают публичные сайты.
</details>

<details>
<summary><strong>Может ли Opfield управлять существующим nginx host?</strong></summary>

Да. Установите nginx daemon в режиме `integrate`. Opfield сохранит ваш существующий `nginx.conf` и добавит managed includes плюс локальный stats endpoint. См. [nginx node modes](docs/nodes.md#nginx-node-modes).
</details>

<details>
<summary><strong>Может ли Opfield работать без ClickHouse?</strong></summary>

Да. Выберите **Disabled** для structured logging в first-run wizard или **Settings > Features**. Остальная часть Opfield продолжает работать; managed local ClickHouse можно отключить без удаления data volume.
</details>

<details>
<summary><strong>Могут ли API или OAuth tokens раскрывать secrets?</strong></summary>

Только если владелец уже имеет нужные scopes. Sensitive OAuth scopes требуют явного opt-in во время consent, API/OAuth tokens не могут превышать текущие effective permissions пользователя, а resource-scoped write-capable scopes остаются ограничены тем же resource, когда они подразумевают read/view checks. См. [SCOPES.md](SCOPES.md).
</details>

<details>
<summary><strong>Как Opfield предотвращает hijacking managed nodes?</strong></summary>

Opfield использует собственную internal PKI для daemon identity. Команда setup узла содержит one-time enrollment token и fingerprint gRPC-сертификата Opfield. Daemon проверяет представленный Opfield TLS leaf certificate перед отправкой token, получает mTLS client certificate от node CA Opfield, удаляет token из локального config и переподключается с certificate. Opfield затем проверяет certificate identity на control streams, log streams и renewal requests. См. [security model](docs/security.md).
</details>

<details>
<summary><strong>Что произойдет, если Opfield offline?</strong></summary>

Managed services продолжают работать. Existing nginx configs продолжают обслуживать traffic, Docker containers продолжают работать, а daemons переподключаются, когда Opfield возвращается. Centralized UI/API control недоступен до восстановления приложения. Relays работают по последней подписанной policy в течение relay policy lease, по умолчанию 72 часа (**Settings > Relay**), после этого не принимают новые соединения до возвращения Opfield. Политики Docker Availability в lease mode продолжают failover без Opfield: в режиме strict (по умолчанию) копия на ноде, отрезанной от большинства voters своей политики, останавливается штатно, и её место занимает следующий кандидат. Подробнее в [offline behavior](docs/nodes.md#offline-behavior).
</details>

<details>
<summary><strong>AI Workspace обязателен?</strong></summary>

Нет. AI Workspace опционален. Operations Console, REST API, OAuth и MCP работают независимо, а Opfield не отправляет данные AI provider, пока администратор не включит AI Workspace и не настроит provider. Оператор может начать с готового Scenario или выбрать Plan Mode для подготовки проверенного и понятного плана; до явного подтверждения реализации никаких изменений не выполняется.
</details>

## Планы и лицензирование

У Opfield четыре продуктовых плана. Платные планы применяются к одной установке Opfield без отдельной оплаты за managed nodes, пользователей или custom permission groups.

Исходный код Opfield публикуется по [PolyForm Perimeter License 1.0.1](LICENSE.md). Код можно использовать, изменять и распространять, в том числе внутри коммерческой компании. Ограничение касается предложения другим людям или организациям продукта, который позиционируется как замена Opfield. Ключ Personal, Business или Enterprise открывает возможности и лимиты соответствующего тарифа по [Paid Key Terms](COMMERCIAL-LICENSE.md); обычный ключ не даёт права выпускать OEM- или white-label-версию, перепродавать Opfield либо предлагать конкурирующий hosted-сервис.

Этот репозиторий — открытое ядро: фронтенд, бэкенд, демоны узлов, relay и установщики. Возможности платных тарифов в бэкенде поставляются как коммерческое ядро — отдельно подписанный пакет, которого нет в этом репозитории. При активации платного ключа Opfield устанавливает ядро для своей текущей версии через механизм подписанных обновлений; Community собирается и работает только из этого репозитория. Подробнее — в [Community and the commercial core](docs/commercial-core.md).

Каждый официальный релиз также содержит [Product Continuity Grant](CONTINUITY-GRANT.md): если Opfield перестаёт поставляться (12 месяцев подряд без новых релизов при недоступном сервисе лицензий или объявление о прекращении поддержки) или лицензиар больше не может действовать, исходный код последнего релиза, включая коммерческое ядро, становится доступен всем по лицензии MIT, а владельцы действующего ключа сохраняют бессрочное безвозмездное право использовать и размещать у себя этот релиз и запускать его без сервиса лицензий. Полные условия — в самом документе.

> [!NOTE]
> Цены предварительные, не являются офертой и могут измениться. Перед покупкой уточните актуальные цены и условия.

| План | Месяц | Год | Масштаб и назначение |
|------|-------|-----|----------------------|
| ![Community](docs/assets/license/opfield-community-24.png)<br>Community | $0 | $0 | Ядро платформы, AI Workspace и Opfield Inference для своей инфраструктуры и других сценариев, не конкурирующих с Opfield; до 25 managed nodes, 3 пользователей и 1 custom permission group; read-only discovery, inventory, monitoring и logs Compose-проектов. Pages, databases, storage, GitLab integration, а также Scenarios, Plan Mode и sandboxes AI Workspace недоступны. |
| ![Personal](docs/assets/license/opfield-personal-24.png)<br>Personal | $29 | $290 | Неограниченные plan quotas для managed nodes/users/groups, deployment и lifecycle management Compose-проектов, import/export архивов контейнеров, blue/green deployments, cross-node migration, managed databases и external database connections с бэкапами, storage connections и managed SeaweedFS object storage, GitLab integration, Scenarios, Plan Mode и sandboxes AI Workspace, публичные status pages, Pages static-site hosting и registry discovery. Multi-node Workload Availability доступна с Business и выше. |
| ![Business](docs/assets/license/opfield-business-24.png)<br>Business | $189 | $1,890 | Возможности Personal (включая Compose management и Pages), а также Git push-to-deploy для containers, blue/green deployments, Compose Projects и Pages с изолированными Build Workers и build vulnerability policy, опциональный внешний доступ к private internal registry, Docker Secure Runtime, structured logging, audit export, guided onboarding, доступную multi-node Workload Availability (HA), а также расширенное сканирование безопасности, автомасштабирование по метрикам и same-node multi-instance после выпуска. |
| ![Enterprise](docs/assets/license/opfield-enterprise-24.png)<br>Enterprise | По запросу | По запросу | Возможности Business (включая Pages), а также Internal PKI, SIEM export, выделенный технический контакт и сопровождение развёртывания и миграции. |

Эти лимиты Community и возможности выше, которым теперь нужен Personal или выше, действуют с 2.11; в 2.10 Community допускал 100 managed nodes, 10 пользователей и 5 custom permission groups. Лимиты проверяются только при создании, поэтому установка, которая уже превышает их, сохраняет существующие ноды, пользователей и группы, но не может добавить новые, пока остаётся на лимите или выше.

Полная матрица возможностей, статусы доступности, проверка лицензии и граница source license приведены в [Планах и лицензировании](docs/licensing.md).

После истечения платного ключа технические entitlements продолжают действовать 24 часа для Personal, 3 дня для Business или 7 дней для Enterprise. Затем Opfield блокирует создание новых платных ресурсов и другие новые платные операции, но не останавливает и не удаляет уже настроенную инфраструктуру. Отозванные, заменённые, недействительные и явно деактивированные ключи обрабатываются отдельно.

Copyright (c) 2021-2026 Alexandr Slavinschii, Republic of Moldova
