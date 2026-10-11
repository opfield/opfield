import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type ServiceStatus = "operational" | "degraded" | "outage" | "unknown" | "maintenance";
type OverallStatus = "operational" | "degraded" | "outage" | "maintenance";
type IncidentUpdateStatus = "update" | "investigating" | "identified" | "monitoring" | "resolved";
type BarStatus = "ok" | "warn" | "error" | "none";

interface PublicStatusPageDto {
  title: string;
  description: string;
  hideExternalBranding: boolean;
  generatedAt: string;
  overallStatus: OverallStatus;
  services: Array<{
    id: string;
    name: string;
    description: string | null;
    group: string | null;
    status: ServiceStatus;
    healthHistory: Array<{ ts: string; status: ServiceStatus; slow?: boolean }>;
  }>;
  incidents: Array<{
    id: string;
    title: string;
    message: string;
    severity: "info" | "warning" | "critical";
    status: "active" | "resolved";
    type: "automatic" | "manual";
    startedAt: string;
    resolvedAt: string | null;
    affectedServiceIds: string[];
    updates: Array<{
      id: string;
      status: IncidentUpdateStatus;
      message: string;
      createdAt: string;
    }>;
  }>;
}

const MAX_BARS = 192;
const BAR_WIDTH = 6;
const BUCKET_MS = 5 * 60 * 1000;

function endpoint() {
  return window.location.pathname.startsWith("/_status-preview")
    ? "/api/status-page/preview"
    : "/api/public/status-page";
}

async function fetchStatus(): Promise<PublicStatusPageDto> {
  const response = await fetch(endpoint(), { cache: "no-store", credentials: "include" });
  if (response.status === 503) throw new Error("Status page temporarily unavailable");
  if (!response.ok) throw new Error("Status page unavailable");
  const body = (await response.json()) as { data: PublicStatusPageDto };
  return body.data;
}

function statusLabel(status: ServiceStatus | OverallStatus) {
  return {
    operational: "Operational",
    degraded: "Degraded",
    outage: "Outage",
    unknown: "Unknown",
    maintenance: "Maintenance"
  }[status];
}

function statusClass(status: ServiceStatus | OverallStatus) {
  return {
    operational: "success",
    degraded: "warning",
    outage: "danger",
    unknown: "muted",
    maintenance: "warning"
  }[status];
}

function severityClass(severity: PublicStatusPageDto["incidents"][number]["severity"]) {
  return {
    info: "info",
    warning: "warning",
    critical: "danger"
  }[severity];
}

function barClass(status: ServiceStatus) {
  return {
    operational: "bar-success",
    degraded: "bar-warning",
    outage: "bar-danger",
    unknown: "bar-muted",
    maintenance: "bar-warning"
  }[status];
}

function publicStatusToBarStatus(status?: ServiceStatus): BarStatus {
  if (!status || status === "unknown" || status === "maintenance") return "none";
  if (status === "operational") return "ok";
  if (status === "degraded") return "warn";
  return "error";
}

function mergeLatestBar(existing: BarStatus, current: BarStatus): BarStatus {
  if (current === "none") return existing;
  if (existing === "none") return current;
  if (current === "error") return "error";
  if (current === "warn") return "warn";
  return existing === "ok" ? "ok" : "warn";
}

function publicBarStatusToServiceStatus(status: BarStatus): ServiceStatus {
  if (status === "ok") return "operational";
  if (status === "warn") return "degraded";
  if (status === "error") return "outage";
  return "unknown";
}

function incidentUpdateDisplayStatus(
  incident: PublicStatusPageDto["incidents"][number],
  event: PublicStatusPageDto["incidents"][number]["updates"][number],
  index: number
) {
  if (index === 0 && event.status === "investigating" && event.message === incident.message) {
    return "update";
  }
  return event.status;
}

function formatBarTitle(status: ServiceStatus, ts: string | null) {
  if (!ts) return `${statusLabel(status)} - no check data`;
  return `${statusLabel(status)} - ${new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function incidentUpdateLabel(status: IncidentUpdateStatus) {
  return {
    update: "Info",
    investigating: "Investigating",
    identified: "Identified",
    monitoring: "Monitoring",
    resolved: "Resolved"
  }[status];
}

function updatedAgoLabel(generatedAt: string, now: number) {
  const generatedTime = new Date(generatedAt).getTime();
  if (!Number.isFinite(generatedTime)) return "UPDATED JUST NOW";
  const minutes = Math.max(0, Math.floor((now - generatedTime) / 60000));
  if (minutes < 1) return "UP TO DATE";
  return `UPDATED ${minutes} MINUTE${minutes === 1 ? "" : "S"} AGO`;
}

function App() {
  const [data, setData] = useState<PublicStatusPageDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchStatus()
        .then((next) => {
          if (!cancelled) {
            setData(next);
            setError(null);
            document.title = next.title;
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : "Status page unavailable");
        });
    };
    load();
    const timer = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const initialLoadComplete = data !== null || error !== null;

  useEffect(() => {
    if (!initialLoadComplete || revealed) return;

    const frame = window.requestAnimationFrame(() => setRevealed(true));
    return () => window.cancelAnimationFrame(frame);
  }, [initialLoadComplete, revealed]);

  let content = null;

  if (error) {
    content = (
      <main className="shell">
        <section className="hero">
          <span className="badge danger">Unavailable</span>
          <h1>Status page unavailable</h1>
          <p>{error}</p>
        </section>
      </main>
    );
  } else if (data) {
    content = <StatusPage data={data} />;
  }

  return (
    <div
      className={`status-page-transition${revealed ? " status-page-transition-ready" : ""}`}
      aria-busy={!initialLoadComplete || undefined}
    >
      {content}
    </div>
  );
}

function StatusPage({ data }: { data: PublicStatusPageDto }) {
  const [now, setNow] = useState(Date.now());
  const activeIncidents = data.incidents.filter((incident) => incident.status === "active");
  const resolvedIncidents = data.incidents.filter((incident) => incident.status === "resolved");
  const groups = useMemo(() => {
    const map = new Map<string, typeof data.services>();
    for (const service of data.services) {
      const key = service.group || "Services";
      map.set(key, [...(map.get(key) ?? []), service]);
    }
    return Array.from(map.entries());
  }, [data.services]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [data.generatedAt]);

  return (
    <main className="shell">
      <section className="hero">
        <div className="hero-badges">
          <span className={`badge ${statusClass(data.overallStatus)}`}>
            {statusLabel(data.overallStatus)}
          </span>
          <span className="badge muted">{updatedAgoLabel(data.generatedAt, now)}</span>
        </div>
        <h1>{data.title}</h1>
        {data.description && <p>{data.description}</p>}
      </section>

      {activeIncidents.length > 0 && (
        <section className="section">
          <h2>Active Incidents</h2>
          <div className="incident-list">
            {activeIncidents.map((incident) => (
              <Incident key={incident.id} incident={incident} services={data.services} />
            ))}
          </div>
        </section>
      )}

      <section className="section">
        <h2>Services</h2>
        <div className="groups">
          {groups.length === 0 ? (
            <div className="panel empty-state">No services are exposed.</div>
          ) : (
            groups.map(([group, services]) => (
              <div className="panel" key={group}>
                <div className="group-title">
                  <span>{group}</span>
                  <span className="group-count">{services.length}</span>
                </div>
                <div className="service-list">
                  {services.map((service) => (
                    <div className="service-row" key={service.id}>
                      <div className="service-main">
                        <div className="service-topline">
                          <div className="service-name">{service.name}</div>
                          <span className={`badge ${statusClass(service.status)}`}>
                            {statusLabel(service.status)}
                          </span>
                        </div>
                        {service.description && (
                          <div className="service-description">{service.description}</div>
                        )}
                        <HealthBars service={service} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {resolvedIncidents.length > 0 && (
        <section className="section">
          <h2>Recent Incidents</h2>
          <div className="incident-list">
            {resolvedIncidents.map((incident) => (
              <Incident key={incident.id} incident={incident} services={data.services} />
            ))}
          </div>
        </section>
      )}

      {!data.hideExternalBranding && (
        <footer>
          <span>
            Powered by{" "}
            <a href="https://opfield.dev" target="_blank" rel="noopener noreferrer">
              Opfield
            </a>
          </span>
        </footer>
      )}
    </main>
  );
}

function HealthBars({ service }: { service: PublicStatusPageDto["services"][number] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [barCount, setBarCount] = useState(0);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const update = () => {
      const count = Math.min(MAX_BARS, Math.max(1, Math.floor(element.clientWidth / (BAR_WIDTH + 1))));
      setBarCount(count);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const now = Math.floor(Date.now() / BUCKET_MS) * BUCKET_MS + BUCKET_MS;

  const bars = useMemo(() => {
    if (barCount === 0) return [];
    const checks = service.healthHistory.filter((entry) => entry.ts);
    const rangeStart = now - barCount * BUCKET_MS;
    const result: BarStatus[] = [];

    for (let index = barCount - 1; index >= 0; index--) {
      const bucketStart = now - (index + 1) * BUCKET_MS;
      const bucketEnd = now - index * BUCKET_MS;
      const bucketEntries = checks.filter((entry) => {
        const time = new Date(entry.ts).getTime();
        return time >= bucketStart && time < bucketEnd;
      });

      if (bucketEntries.length === 0) {
        result.push("none");
        continue;
      }

      const outageCount = bucketEntries.filter((entry) => entry.status === "outage").length;
      const hasSlow = bucketEntries.some((entry) => entry.slow);
      const bucketStatus =
        outageCount === bucketEntries.length
          ? "error"
          : outageCount > 0 || hasSlow
            ? "warn"
            : "ok";
      result.push(bucketStatus);
    }

    const currentBar = publicStatusToBarStatus(service.status);
    if (currentBar !== "none") {
      result[result.length - 1] = mergeLatestBar(result[result.length - 1], currentBar);
      const recentChecks = checks.filter((entry) => {
        const time = new Date(entry.ts).getTime();
        return time >= rangeStart && time < now;
      });

      if (recentChecks.length > 0) {
        let latestKnownIndex = -1;
        for (let index = result.length - 1; index >= 0; index--) {
          if (result[index] !== "none") {
            latestKnownIndex = index;
            break;
          }
        }
        if (latestKnownIndex >= 0) {
          for (let index = latestKnownIndex + 1; index < result.length - 1; index++) {
            if (result[index] === "none") result[index] = currentBar;
          }
        }
      } else {
        result[result.length - 1] = currentBar;
      }
    }

    return result.map((status, index) => ({
      status: publicBarStatusToServiceStatus(status),
      ts: new Date(now - (barCount - 1 - index) * BUCKET_MS).toISOString()
    }));
  }, [barCount, now, service.healthHistory, service.status]);

  const totalMs = barCount * BUCKET_MS;
  const totalHours = Math.round(totalMs / 3600000);
  const totalLabel =
    totalHours >= 1
      ? `${totalHours} hour${totalHours > 1 ? "s" : ""} ago`
      : `${Math.round(totalMs / 60000)} min ago`;

  return (
    <div ref={containerRef} className="health-bars-wrap" aria-label={`${service.name} recent health checks`}>
      <div className="health-bars">
        {bars.map((bar, index) => (
          <div
            key={`${service.id}-${index}`}
            className={`bar ${barClass(bar.status)}`}
            title={formatBarTitle(bar.status, bar.ts)}
          />
        ))}
      </div>
      {barCount > 0 && (
        <div className="health-labels">
          <span>{totalLabel}</span>
          <span>Now</span>
        </div>
      )}
    </div>
  );
}

function Incident({
  incident,
  services
}: {
  incident: PublicStatusPageDto["incidents"][number];
  services: PublicStatusPageDto["services"];
}) {
  const affected = services.filter((service) => incident.affectedServiceIds.includes(service.id));
  const events =
    incident.updates?.length > 0
      ? incident.updates
      : [
          {
            id: `${incident.id}:initial`,
            status: "update" as const,
            message: incident.message,
            createdAt: incident.startedAt
          }
        ];
  return (
    <article
      className={`incident panel ${incident.status === "active" ? `active ${severityClass(incident.severity)}-border` : ""}`}
    >
      <div className="incident-header">
        <div className="incident-heading">
          <span className={`badge ${severityClass(incident.severity)}`}>
            {incident.severity}
          </span>
          {incident.type === "automatic" && <span className="badge muted">AUTO</span>}
          <h3>{incident.title}</h3>
        </div>
        <time dateTime={incident.startedAt}>{new Date(incident.startedAt).toLocaleString()}</time>
      </div>
      <div className="affected-block">
        <div className="affected-label">Affected services</div>
        <div className="affected-list">
          {affected.length > 0 ? (
            affected.map((service) => (
              <span key={service.id} className={`affected-chip ${statusClass(service.status)}`}>
                {service.name}
              </span>
            ))
          ) : (
            <span className="affected-empty">No specific services listed</span>
          )}
        </div>
      </div>
      <div className="timeline-block">
        <div className="affected-label">Timeline</div>
        <div className="incident-timeline">
          {events.map((event, index) => {
            const displayStatus = incidentUpdateDisplayStatus(incident, event, index);
            return (
              <div className="timeline-event" key={event.id}>
                <div className={`timeline-marker ${displayStatus}`}>
                  <span aria-hidden="true" />
                </div>
                <div className="timeline-body">
                  <div className="timeline-meta">
                    <span>{new Date(event.createdAt).toLocaleString()}</span>
                    <span className="timeline-status">{incidentUpdateLabel(displayStatus)}</span>
                  </div>
                  <p>{event.message}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
