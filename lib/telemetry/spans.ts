import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

// Supports a unified endpoint (OTEL_EXPORTER_OTLP_ENDPOINT) or separate trace/metric endpoints.
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const OTEL_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (OTLP_ENDPOINT ? `${OTLP_ENDPOINT}/v1/traces` : undefined);
const METRICS_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? (OTLP_ENDPOINT ? `${OTLP_ENDPOINT}/v1/metrics` : undefined);
const OTEL_ENABLED = !!OTEL_ENDPOINT;

let _tracer: Tracer | null = null;
let _sdkInitialized = false;

/**
 * Initialize OpenTelemetry SDK with OTLP exporter.
 * Call this once at app startup (e.g., in next.config.ts or a top-level import).
 */
export function initTelemetry() {
  if (_sdkInitialized || !OTEL_ENABLED) return;
  _sdkInitialized = true;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: "athene-app",
      [SEMRESATTRS_SERVICE_VERSION]: "1.0.0",
    }),
    traceExporter: new OTLPTraceExporter({
      url: OTEL_ENDPOINT,
    }),
    metricReader: METRICS_ENDPOINT
      ? new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: METRICS_ENDPOINT }),
          exportIntervalMillis: 30_000,
        })
      : undefined,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Disable instrumentations that cause noise
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.log(`[telemetry] OpenTelemetry initialized with endpoint: ${OTEL_ENDPOINT}`);

  // Graceful shutdown — only available in Node.js runtime, not Edge
  if (typeof process !== "undefined" && typeof process.on === "function") {
    process.on("SIGTERM", () => {
      sdk.shutdown().then(() => console.log("[telemetry] OpenTelemetry shut down")).catch(console.error);
    });
  }
}

function getTracerInstance(): Tracer {
  if (!_tracer) {
    _tracer = trace.getTracer("athene-app", "1.0.0");
  }
  return _tracer;
}

export function getTracer(): Tracer {
  return getTracerInstance();
}

/** @internal */
export function _resetTracer(): void {
  _tracer = null;
}

export function startSpan(
  name: string,
  attributes?: Record<string, string | number | boolean>
): Span {
  const tracer = getTracerInstance();
  const opts = attributes ? { attributes } : undefined;
  return tracer.startSpan(name, opts, context.active());
}

/**
 * Run `fn` under a new span, with proper OTel context propagation so that
 * any child spans created inside `fn` are correctly parented.
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
): Promise<T> {
  const tracer = getTracerInstance();
  const opts = attributes ? { attributes } : undefined;
  const span = tracer.startSpan(name, opts, context.active());

  // Make span active in the current context so child spans are parented.
  const ctx = trace.setSpan(context.active(), span);

  try {
    const result = await context.with(ctx, () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    if (error instanceof Error) {
      span.recordException(error);
    }
    throw error;
  } finally {
    span.end();
  }
}

// Vector search span helper — now accepts topK so the attribute is accurate.
export async function withVectorSearchSpan<T>(
  query: string,
  orgId: string,
  topK: number,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    "vector_search",
    fn,
    {
      "vector.query_length": query.length,
      "vector.org_id": orgId,
      "vector.top_k": topK,
    }
  );
}

// LLM call span helper
export async function withLLMSpan<T>(
  model: string,
  promptLength: number,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    "llm_call",
    (span) => fn(span),
    {
      "llm.model": model,
      "llm.prompt_length": promptLength,
    }
  );
}

// Tool call span helper
export async function withToolSpan<T>(
  toolName: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    "tool_call",
    (span) => fn(span),
    {
      "tool.name": toolName,
    }
  );
}

// SSE frame latency span helper
export async function withSSEFrameSpan<T>(
  frameType: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    "sse_frame",
    (span) => fn(span),
    {
      "sse.frame_type": frameType,
    }
  );
}

// Agent run span helper — wraps the full LangGraph invocation so that
// all child spans (llm_call, tool_call, vector_search, sse_frame) are
// correctly nested under a single top-level agent trace (8B.1).
export async function withAgentRunSpan<T>(
  orgId: string,
  threadId: string,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  return withSpan(
    "agent_run",
    (span) => fn(span),
    {
      "agent.org_id": orgId,
      "agent.thread_id": threadId,
    }
  );
}

