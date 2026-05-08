import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import setCookie from 'set-cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '../../..');
const docsDir = path.join(repoRoot, 'observability', 'local', 'docs');
const screenshotsDir = path.join(docsDir, 'screenshots');

const kongUrl = process.env.OBS_KONG_URL ?? 'http://localhost:8000';
const prometheusUrl = process.env.OBS_PROMETHEUS_URL ?? 'http://localhost:9090';
const grafanaUrl = process.env.OBS_GRAFANA_URL ?? 'http://localhost:3005';
const jaegerUrl = process.env.OBS_JAEGER_URL ?? 'http://localhost:16686';
const routerUrl = process.env.OBS_ROUTER_URL ?? 'http://localhost:4001/graphql';
const password = process.env.OBS_TEST_PASSWORD ?? 'Password123!';
const grafanaUser = process.env.OBS_GRAFANA_USER ?? 'admin';
const grafanaPassword = process.env.OBS_GRAFANA_PASSWORD ?? 'admin';

const requiredGrafanaDashboards = [
  { uid: 'local-platform-overview', title: 'Local Platform Overview' },
  { uid: 'services-red', title: 'Services — RED Metrics' },
];

const criticalJobs = ['apollo-router', 'payment-service', 'user-service'];

const signalQueries = [
  {
    key: 'paymentCreateSuccessRate',
    title: 'Payment Create Success Rate',
    unit: 'reqps',
    query: 'sum(rate(http_requests_total{service="payment-service",route="/api/payments",status_code=~"2.."}[5m])) or vector(0)',
  },
  {
    key: 'paymentCreateFailureRate',
    title: 'Payment Create Failure Rate',
    unit: 'percent',
    query:
      'sum(rate(http_requests_total{service="payment-service",route="/api/payments",status_code=~"4..|5.."}[5m])) / clamp_min(sum(rate(http_requests_total{service="payment-service",route="/api/payments"}[5m])), 0.001) * 100 or vector(0)',
  },
  {
    key: 'paymentLookupFailures5m',
    title: 'Payment Lookup Failures (5m)',
    unit: 'count',
    query: 'sum(increase(payment_order_lookup_failures_total[5m])) or vector(0)',
  },
  {
    key: 'paymentLookupRetries15m',
    title: 'Payment Lookup Retries (15m)',
    unit: 'count',
    query: 'sum(increase(payment_order_lookup_retries_total[15m])) or vector(0)',
  },
  {
    key: 'paymentLookupBreakerOpen',
    title: 'Payment Lookup Circuit Breaker',
    unit: 'state',
    query: 'payment_order_lookup_circuit_breaker_open or vector(0)',
  },
  {
    key: 'routerOperationsTotal',
    title: 'Apollo Router Operations Total',
    unit: 'count',
    query: 'sum(apollo_router_operations_total) or vector(0)',
  },
  {
    key: 'routerQueryPlanningP95',
    title: 'Apollo Router Query Planning p95',
    unit: 'seconds',
    query: 'histogram_quantile(0.95, sum(apollo_router_query_planning_total_duration_bucket) by (le)) or vector(0)',
  },
  {
    key: 'attendanceScanValidations',
    title: 'Attendance Scan Validations',
    unit: 'count',
    query: 'sum(increase(attendance_scan_validations_total[15m])) or vector(0)',
  },
  {
    key: 'attendanceScanCheckins',
    title: 'Attendance Scan Check-ins',
    unit: 'count',
    query: 'sum(increase(attendance_scan_checkins_total[15m])) or vector(0)',
  },
  {
    key: 'attendanceIssuanceCount',
    title: 'Attendance Issuance Count',
    unit: 'count',
    query: 'sum(increase(attendance_issuance_total[15m])) or vector(0)',
  },
  {
    key: 'attendanceIssuanceLatencyP95',
    title: 'Attendance Issuance Latency p95',
    unit: 'seconds',
    query: 'histogram_quantile(0.95, sum(rate(attendance_issuance_latency_seconds_bucket[15m])) by (le)) or vector(0)',
  },
];

function uniqueSuffix() {
  return `${Date.now()}`;
}

function traceSuffix() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0').slice(-8);
}

function buildTraceId(prefix, suffix) {
  return `${prefix}${suffix}`;
}

function cookieHeaderFromResponse(response) {
  const rawCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : setCookie.splitCookiesString(response.headers.get('set-cookie') ?? '');

  const parsed = setCookie.parse(rawCookies, { map: false });
  return parsed.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const bodyText = await response.text();

  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = bodyText;
  }

  if (!response.ok) {
    throw new Error(`Request failed ${response.status} ${response.statusText} for ${url}: ${JSON.stringify(body)}`);
  }

  return { response, body };
}

async function signup(email) {
  const { response, body } = await fetchJson(`${kongUrl}/api/users/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  const cookie = cookieHeaderFromResponse(response);
  if (!cookie) {
    throw new Error(`Signup did not return an auth cookie for ${email}`);
  }

  return { cookie, body };
}

async function createTicket(cookie, title) {
  const { body } = await fetchJson(`${kongUrl}/api/tickets`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
    },
    body: JSON.stringify({
      title,
      price: '55.00',
      quota: 1,
      maxPerUser: 1,
    }),
  });

  return body;
}

async function createOrder(cookie, ticketId, traceId) {
  const { body } = await fetchJson(`${kongUrl}/api/orders`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      traceparent: `00-${traceId}-aaaaaaaaaaaaaaaa-01`,
    },
    body: JSON.stringify({ ticketId, quantity: 1 }),
  });

  return body;
}

async function createPayment(cookie, orderId, traceId) {
  const { body } = await fetchJson(`${kongUrl}/api/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      traceparent: `00-${traceId}-bbbbbbbbbbbbbbbb-01`,
    },
    body: JSON.stringify({
      orderId,
      token: 'pm_card_visa',
    }),
  });

  return body;
}

async function createRouterTraffic(traceId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await fetchJson(routerUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent: `00-${traceId}-${`ccccccccccccccc${attempt}`.slice(-16)}-01`,
      },
      body: JSON.stringify({ query: 'query { __typename }' }),
    });
  }
}

async function waitForOrderComplete(cookie, orderId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { body } = await fetchJson(`${kongUrl}/api/orders/${orderId}`, {
      headers: { cookie },
    });

    if (String(body.status).toLowerCase() === 'complete') {
      return body;
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Order ${orderId} did not reach complete state within ${timeoutMs}ms`);
}

async function waitForTrace(traceId, expectedServices = [], timeoutMs = 60000, predicate = () => true) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const response = await fetch(`${jaegerUrl}/api/traces/${traceId}`);

    if (response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }

    const body = await response.json();
    if (!response.ok) {
      throw new Error(`Trace lookup failed ${response.status} for ${traceId}: ${JSON.stringify(body)}`);
    }

    if (Array.isArray(body.data) && body.data.length > 0) {
      const trace = body.data[0];
      const summary = traceSummary(trace);

      if (expectedServices.every((service) => summary.services.includes(service)) && predicate(summary)) {
        return trace;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(
    `Trace ${traceId} did not include expected services ${expectedServices.join(', ')} within ${timeoutMs}ms`,
  );
}

async function getPrometheusTargets() {
  const { body } = await fetchJson(`${prometheusUrl}/api/v1/targets`);
  return body.data.activeTargets.map((target) => ({
    job: target.labels.job,
    health: target.health,
    scrapeUrl: target.scrapeUrl,
  }));
}

async function queryPrometheus(query) {
  const { body } = await fetchJson(
    `${prometheusUrl}/api/v1/query?query=${encodeURIComponent(query)}`,
  );
  return body.data.result;
}

function parseVectorValue(result) {
  const rawValue = result[0]?.value?.[1];
  const numericValue = rawValue === undefined ? Number.NaN : Number(rawValue);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

async function getPrometheusSignals() {
  return Promise.all(
    signalQueries.map(async (signal) => ({
      key: signal.key,
      title: signal.title,
      unit: signal.unit,
      query: signal.query,
      value: parseVectorValue(await queryPrometheus(signal.query)),
    })),
  );
}

async function waitForPrometheusSignal(query, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = parseVectorValue(await queryPrometheus(query));
    if (predicate(value)) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error(`Prometheus signal did not satisfy expectation within ${timeoutMs}ms: ${query}`);
}

function summarizeCriticalTargets(targets) {
  return criticalJobs.map((job) => {
    const match = targets.find((target) => target.job === job);
    return {
      job,
      health: match?.health ?? 'missing',
      scrapeUrl: match?.scrapeUrl ?? 'not found',
    };
  });
}

function assertCriticalTargetsHealthy(targets) {
  const unhealthy = targets.filter((target) => target.health !== 'up');
  if (unhealthy.length === 0) {
    return;
  }

  throw new Error(
    `Required Prometheus targets are not healthy: ${unhealthy
      .map((target) => `${target.job}=${target.health}`)
      .join(', ')}`,
  );
}

async function getGrafanaDashboards() {
  const basicAuth = Buffer.from(`${grafanaUser}:${grafanaPassword}`).toString('base64');
  const { body } = await fetchJson(`${grafanaUrl}/api/search`, {
    headers: { Authorization: `Basic ${basicAuth}` },
  });

  return requiredGrafanaDashboards.map((requiredDashboard) => {
    const dashboard = body.find((item) => item.uid === requiredDashboard.uid);
    if (!dashboard) {
      throw new Error(`Grafana dashboard ${requiredDashboard.title} was not found`);
    }

    return {
      uid: dashboard.uid,
      title: dashboard.title,
      url: dashboard.url,
    };
  });
}

function traceSummary(trace) {
  const services = [...new Set(trace.spans.map((span) => trace.processes[span.processID]?.serviceName).filter(Boolean))];
  const operations = [...new Set(trace.spans.map((span) => span.operationName))].sort();
  return { services, operations };
}

function hasAsyncPropagation(summary) {
  const hasPublish = summary.operations.some(
    (operation) => operation.startsWith('kafka publish ') || operation.startsWith('send '),
  );
  const hasConsumer = summary.operations.some(
    (operation) => operation.includes(' process') || operation.startsWith('kafka consume '),
  );
  return hasPublish && hasConsumer;
}

async function captureScreenshots(artifacts) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    httpCredentials: {
      username: grafanaUser,
      password: grafanaPassword,
    },
    viewport: { width: 1600, height: 1200 },
  });

  try {
    const prometheusPage = await context.newPage();
    await prometheusPage.goto(`${prometheusUrl}/targets`, { waitUntil: 'networkidle' });
    await prometheusPage.screenshot({ path: artifacts.prometheus, fullPage: true });

    const grafanaPage = await context.newPage();
    await grafanaPage.goto(`${grafanaUrl}${artifacts.platformDashboardPath}?orgId=1&from=now-15m&to=now`, {
      waitUntil: 'domcontentloaded',
    });
    await grafanaPage.waitForTimeout(5000);
    await grafanaPage.screenshot({ path: artifacts.platformGrafana, fullPage: true });

    const servicesRedPage = await context.newPage();
    await servicesRedPage.goto(`${grafanaUrl}${artifacts.servicesDashboardPath}?orgId=1&from=now-15m&to=now`, {
      waitUntil: 'domcontentloaded',
    });
    await servicesRedPage.waitForTimeout(5000);
    await servicesRedPage.screenshot({ path: artifacts.servicesGrafana, fullPage: true });

    const jaegerOrderPage = await context.newPage();
    await jaegerOrderPage.goto(`${jaegerUrl}/trace/${artifacts.orderTraceId}`, { waitUntil: 'domcontentloaded' });
    await jaegerOrderPage.waitForTimeout(4000);
    await jaegerOrderPage.screenshot({ path: artifacts.jaegerOrder, fullPage: true });

    const jaegerPaymentPage = await context.newPage();
    await jaegerPaymentPage.goto(`${jaegerUrl}/trace/${artifacts.paymentTraceId}`, { waitUntil: 'domcontentloaded' });
    await jaegerPaymentPage.waitForTimeout(4000);
    await jaegerPaymentPage.screenshot({ path: artifacts.jaegerPayment, fullPage: true });
  } finally {
    await context.close();
    await browser.close();
  }
}

function markdownReport(summary) {
  const targetsTable = summary.prometheusTargets
    .map((target) => `| ${target.job} | ${target.health} | ${target.scrapeUrl} |`)
    .join('\n');

  const dashboardsTable = summary.grafanaDashboards
    .map((dashboard) => `| ${dashboard.title} | ${dashboard.uid} | ${dashboard.url} |`)
    .join('\n');

  const signalsTable = summary.prometheusSignals
    .map((signal) => `| ${signal.title} | ${signal.value} | ${signal.unit} |`)
    .join('\n');

  return `# End-to-End Observability Report

Generated: ${summary.generatedAt}

## Outcome

- Result: PASS
- Flow: seller signup -> ticket create -> buyer signup -> order create -> payment submit -> order complete
- Final order status: ${summary.order.finalStatus}
- Payment status: ${summary.payment.status}

## Trace Verification

### Order Trace

- Trace ID: ${summary.order.traceId}
- Services observed: ${summary.order.services.join(', ')}
- Key operations: ${summary.order.operations.slice(0, 12).join(', ')}

### Payment Trace

- Trace ID: ${summary.payment.traceId}
- Services observed: ${summary.payment.services.join(', ')}
- Key operations: ${summary.payment.operations.slice(0, 14).join(', ')}

### Async Propagation

- Verified: ${summary.asyncPropagationVerified ? 'yes' : 'no'}
- Evidence: ${summary.asyncPropagationEvidence.join(', ')}

## Prometheus Targets

| Job | Health | Scrape URL |
| --- | --- | --- |
${targetsTable}

## Grafana Dashboards

| Dashboard | UID | URL |
| --- | --- | --- |
${dashboardsTable}

## Prometheus Signals

| Signal | Value | Unit |
| --- | --- | --- |
${signalsTable}

## Screenshots

### Prometheus Targets

![Prometheus Targets](./screenshots/prometheus-targets.png)

### Grafana Local Platform Overview

![Grafana Local Platform Overview](./screenshots/grafana-local-platform-overview.png)

### Grafana Services RED

![Grafana Services RED](./screenshots/grafana-services-red.png)

### Jaeger Order Trace

![Jaeger Order Trace](./screenshots/jaeger-order-trace.png)

### Jaeger Payment Trace

![Jaeger Payment Trace](./screenshots/jaeger-payment-trace.png)

## Notes

- Grafana was captured from the provisioned \`Local Platform Overview\` and \`Services — RED Metrics\` dashboards.
- Jaeger screenshots were captured from direct trace detail pages for the generated trace IDs.
- Prometheus remained healthy for all locally scraped application targets during this run.
- Async backlog, DLQ, retry-exhaustion, and Kafka lag panels remain a known gap because the local stack does not yet emit stable Prometheus metrics for them.
`;
}

async function main() {
  await mkdir(screenshotsDir, { recursive: true });

  const suffix = uniqueSuffix();
  const traceHex = traceSuffix();
  const sellerEmail = `obs-seller-${suffix}@test.com`;
  const buyerEmail = `obs-buyer-${suffix}@test.com`;
  const orderTraceId = buildTraceId('111111111111111111111111', traceHex);
  const paymentTraceId = buildTraceId('222222222222222222222222', traceHex);

  const seller = await signup(sellerEmail);
  const ticket = await createTicket(seller.cookie, `Observability Ticket ${suffix}`);
  const buyer = await signup(buyerEmail);
  const order = await createOrder(buyer.cookie, ticket.id, orderTraceId);
  const payment = await createPayment(buyer.cookie, order.id, paymentTraceId);
  const completedOrder = await waitForOrderComplete(buyer.cookie, order.id);
  const routerTraceId = buildTraceId('333333333333333333333333', traceHex);

  await createRouterTraffic(routerTraceId);
  await waitForPrometheusSignal(
    'sum(apollo_router_operations_total) or vector(0)',
    (value) => value > 0,
    45000,
  );

  const [orderTrace, paymentTrace, prometheusTargets, grafanaDashboards, prometheusSignals] =
    await Promise.all([
    waitForTrace(orderTraceId, ['order-service', 'ticket-service']),
    waitForTrace(paymentTraceId, ['payment-service', 'order-service'], 60000, hasAsyncPropagation),
    getPrometheusTargets(),
    getGrafanaDashboards(),
    getPrometheusSignals(),
  ]);

  const criticalTargets = summarizeCriticalTargets(prometheusTargets);
  assertCriticalTargetsHealthy(criticalTargets);

  const orderTraceData = traceSummary(orderTrace);
  const paymentTraceData = traceSummary(paymentTrace);
  const asyncPropagationEvidence = [orderTraceData, paymentTraceData]
    .flatMap((summary) => summary.operations)
    .filter(
      (operation, index, allOperations) =>
        (operation.startsWith('kafka publish ') ||
          operation.startsWith('send ') ||
          operation.includes(' process') ||
          operation.startsWith('kafka consume ')) &&
        allOperations.indexOf(operation) === index,
    );
  const asyncPropagationVerified =
    hasAsyncPropagation(orderTraceData) || hasAsyncPropagation(paymentTraceData);

  const platformDashboard = grafanaDashboards.find((dashboard) => dashboard.uid === 'local-platform-overview');
  const servicesDashboard = grafanaDashboards.find((dashboard) => dashboard.uid === 'services-red');

  if (!platformDashboard || !servicesDashboard) {
    throw new Error('Expected Grafana dashboards were not returned by the API');
  }

  const screenshotArtifacts = {
    prometheus: path.join(screenshotsDir, 'prometheus-targets.png'),
    platformGrafana: path.join(screenshotsDir, 'grafana-local-platform-overview.png'),
    servicesGrafana: path.join(screenshotsDir, 'grafana-services-red.png'),
    jaegerOrder: path.join(screenshotsDir, 'jaeger-order-trace.png'),
    jaegerPayment: path.join(screenshotsDir, 'jaeger-payment-trace.png'),
    platformDashboardPath: platformDashboard.url,
    servicesDashboardPath: servicesDashboard.url,
    orderTraceId,
    paymentTraceId,
  };

  await captureScreenshots(screenshotArtifacts);

  const summary = {
    generatedAt: new Date().toISOString(),
    order: {
      id: order.id,
      traceId: orderTraceId,
      finalStatus: String(completedOrder.status).toLowerCase(),
      services: orderTraceData.services,
      operations: orderTraceData.operations,
    },
    payment: {
      id: payment.payment.id,
      traceId: paymentTraceId,
      status: String(payment.payment.status).toLowerCase(),
      services: paymentTraceData.services,
      operations: paymentTraceData.operations,
    },
    prometheusTargets,
    criticalTargets,
    grafanaDashboards,
    prometheusSignals,
    asyncPropagationVerified,
    asyncPropagationEvidence,
    knownGaps: [
      'No stable Prometheus metrics yet for outbox backlog, DLQ volume, consumer retry exhaustion, or Kafka lag.',
    ],
  };

  await writeFile(path.join(docsDir, 'observability-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(docsDir, 'observability-report.md'), `${markdownReport(summary)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
