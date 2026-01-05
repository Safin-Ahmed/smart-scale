import http from "node:http";
import https from "node:https";

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });

    req.on("error", reject);
  });
}

export type PromQueryResult = Array<{
  metric: Record<string, string>;
  value: [number, string];
}>;

export async function promQuery(
  baseUrl: string,
  query: string
): Promise<PromQueryResult> {
  const u = new URL("/api/v1/query", baseUrl);
  u.searchParams.set("query", query);

  const r = await httpGet(u.toString());
  if (r.status != 200)
    throw new Error(`Prometheus HTTP ${r.status}: ${r.body}`);

  const j = JSON.parse(r.body);

  if (j.status !== "success") throw new Error(`Prometheus error: ${r.body}`);

  return j.data.result as PromQueryResult;
}

export async function getMetrics(
  promBase: string,
  pendingWindowSeconds = 180,
  idleWindowSeconds = 600,
  cpuDownThreshold = 0.3
): Promise<{
  avgCpu: number;
  pendingPods: number;
  pendingLongEnough: boolean;
  idleLongEnough: boolean;
}> {
  // CPU (0..1)
  const cpuQuery = `avg(rate(node_cpu_seconds_total{mode!="idle"}[2m]))`;

  // Pending pods now
  const pendingNowQ = `sum(kube_pod_status_phase{phase="Pending"})`;

  // IMPORTANT: clamp_min makes sure the series exists even if sum(...) is empty
  // Then compare >0, then min_over_time checks it stayed true across the window.
  const pendingSustainedQ = `avg_over_time((sum(kube_pod_status_phase{phase="Pending"}) > bool 0)[${pendingWindowSeconds}s:])`;

  // Idle sustained: CPU stayed below threshold for the whole idleWindowSeconds
  const idleSustainedQ = `avg_over_time((avg(rate(node_cpu_seconds_total{mode!="idle"}[2m])) < bool ${cpuDownThreshold})[${idleWindowSeconds}s:])`;

  // Query in parallel to reduce Lambda runtime
  const [cpuRes, pendingNow, pendingSustained, idleSustained] =
    await Promise.all([
      promQuery(promBase, cpuQuery),
      promQuery(promBase, pendingNowQ),
      promQuery(promBase, pendingSustainedQ),
      promQuery(promBase, idleSustainedQ),
    ]);

  const avgCpu = cpuRes.length ? Number(cpuRes[0].value[1]) : 0;

  const pendingPods = pendingNow.length ? Number(pendingNow[0].value[1]) : 0;

  const pendingLongEnough = pendingSustained.length
    ? Number(pendingSustained[0].value[1]) === 1
    : false;

  const idleLongEnough = idleSustained.length
    ? Number(idleSustained[0].value[1]) === 1
    : false;

  return { avgCpu, pendingPods, pendingLongEnough, idleLongEnough };
}

export async function getReadyNodeIps(baseUrl: string): Promise<string[]> {
  // Use a 5-minute range to ensure we catch nodes even if there's a slight scrape lag
  // This query finds the latest sample for each node in the last 5 minutes.
  const query = `last_over_time(kube_node_info[5m])`;
  const url = `${baseUrl}/api/v1/query?query=${encodeURIComponent(query)}`;

  const resp = await fetch(url, {
    headers: { "Cache-Control": "no-cache" }, // Prevent any intermediate caching
  });

  if (!resp.ok) throw new Error(`Prometheus query failed: ${resp.statusText}`);

  const data: any = await resp.json();

  // Normalize the extracted IPs to prevent string comparison errors
  return data.data.result
    .map((r: any) => {
      // If Prometheus gives us "ip-10-0-1-134", convert it to "10.0.1.134"
      const nodeName = r.metric.node || "";
      if (nodeName.startsWith("ip-")) {
        return nodeName
          .replace("ip-", "") // Remove "ip-"
          .replace(/-/g, "."); // Replace all dashes with dots
      }

      // Fallback to internal_ip label if it exists
      return r.metric.internal_ip || nodeName;
    })
    .filter(Boolean);
}
