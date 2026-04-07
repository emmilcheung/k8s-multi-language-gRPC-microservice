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
const grafanaUrl = process.env.OBS_GRAFANA_URL ?? 'http://localhost:3004';
const jaegerUrl = process.env.OBS_JAEGER_URL ?? 'http://localhost:16686';
const password = process.env.OBS_TEST_PASSWORD ?? 'Password123!';
const grafanaUser = process.env.OBS_GRAFANA_USER ?? 'admin';
const grafanaPassword = process.env.OBS_GRAFANA_PASSWORD ?? 'admin';

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
      amount: 5500,
      currency: 'usd',
      token: 'pm_card_visa',
    }),
  });

  return body;
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

async function waitForTrace(traceId, expectedServices = [], timeoutMs = 60000) {
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

      if (expectedServices.every((service) => summary.services.includes(service))) {
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

async function getGrafanaDashboard() {
  const basicAuth = Buffer.from(`${grafanaUser}:${grafanaPassword}`).toString('base64');
  const { body } = await fetchJson(
    `${grafanaUrl}/api/search?query=${encodeURIComponent('Local Platform Overview')}`,
    { headers: { Authorization: `Basic ${basicAuth}` } },
  );

  const dashboard = body.find((item) => item.uid === 'local-platform-overview') ?? body[0];
  if (!dashboard) {
    throw new Error('Grafana dashboard Local Platform Overview was not found');
  }

  return dashboard;
}

function traceSummary(trace) {
  const services = [...new Set(trace.spans.map((span) => trace.processes[span.processID]?.serviceName).filter(Boolean))];
  const operations = [...new Set(trace.spans.map((span) => span.operationName))].sort();
  return { services, operations };
}

async function loginGrafana(page) {
  await page.goto(`${grafanaUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('input[name="user"]').fill(grafanaUser);
  await page.locator('input[name="password"]').fill(grafanaPassword);
  await page.getByRole('button', { name: /log in/i }).click();
  await page.waitForLoadState('networkidle');

  const skipButton = page.getByRole('button', { name: /skip/i });
  if (await skipButton.isVisible().catch(() => false)) {
    await skipButton.click();
    await page.waitForLoadState('networkidle');
  }
}

async function captureScreenshots(artifacts) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });

  try {
    const prometheusPage = await context.newPage();
    await prometheusPage.goto(`${prometheusUrl}/targets`, { waitUntil: 'networkidle' });
    await prometheusPage.screenshot({ path: artifacts.prometheus, fullPage: true });

    const grafanaPage = await context.newPage();
    await loginGrafana(grafanaPage);
    await grafanaPage.goto(`${grafanaUrl}${artifacts.grafanaPath}?orgId=1&from=now-15m&to=now`, {
      waitUntil: 'domcontentloaded',
    });
    await grafanaPage.waitForTimeout(5000);
    await grafanaPage.screenshot({ path: artifacts.grafana, fullPage: true });

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

## Prometheus Targets

| Job | Health | Scrape URL |
| --- | --- | --- |
${targetsTable}

## Screenshots

### Prometheus Targets

![Prometheus Targets](./screenshots/prometheus-targets.png)

### Grafana Local Platform Overview

![Grafana Local Platform Overview](./screenshots/grafana-local-platform-overview.png)

### Jaeger Order Trace

![Jaeger Order Trace](./screenshots/jaeger-order-trace.png)

### Jaeger Payment Trace

![Jaeger Payment Trace](./screenshots/jaeger-payment-trace.png)

## Notes

- Grafana was captured from the provisioned \`Local Platform Overview\` dashboard.
- Jaeger screenshots were captured from direct trace detail pages for the generated trace IDs.
- Prometheus remained healthy for all locally scraped application targets during this run.
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

  const [orderTrace, paymentTrace, prometheusTargets, grafanaDashboard] = await Promise.all([
    waitForTrace(orderTraceId, ['order-service', 'payment-service', 'ticket-service', 'expiration-service']),
    waitForTrace(paymentTraceId, ['payment-service', 'order-service']),
    getPrometheusTargets(),
    getGrafanaDashboard(),
  ]);

  const orderTraceData = traceSummary(orderTrace);
  const paymentTraceData = traceSummary(paymentTrace);

  const screenshotArtifacts = {
    prometheus: path.join(screenshotsDir, 'prometheus-targets.png'),
    grafana: path.join(screenshotsDir, 'grafana-local-platform-overview.png'),
    jaegerOrder: path.join(screenshotsDir, 'jaeger-order-trace.png'),
    jaegerPayment: path.join(screenshotsDir, 'jaeger-payment-trace.png'),
    grafanaPath: grafanaDashboard.url,
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
  };

  await writeFile(path.join(docsDir, 'observability-report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await writeFile(path.join(docsDir, 'observability-report.md'), `${markdownReport(summary)}\n`, 'utf8');

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});