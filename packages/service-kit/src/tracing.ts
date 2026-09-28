/**
 * Distributed tracing primitives and span context propagation helpers (#301).
 * Enables end-to-end trace visibility across service boundaries:
 *
 *   browser → api-gateway → {wallet,policy,lifecycle,verification}-service
 *           → verification record (jsonb) → worker-service
 *
 * Two header families are carried on every hop:
 *   - W3C `traceparent` (00-<32 hex trace-id>-<16 hex parent-id>-01), which is
 *     what OpenTelemetry-compatible backends (Jaeger, Zipkin, Datadog) read;
 *   - `x-trace-id` / `x-span-id`, the vendor-neutral ids our logs are keyed by.
 *
 * Inbound values are untrusted: a malformed `traceparent` is ignored and an
 * `x-trace-id` that isn't a short token is replaced, so a client can't inject
 * log lines or unbounded strings through trace headers.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  service: string;
  name: string;
  startTimeMs: number;
  endTimeMs?: number;
  status: "ok" | "error";
  attributes: Record<string, unknown>;
}

export interface TraceContext {
  traceId: string;
  spanId?: string;
}

export interface TraceHeaderMap {
  [key: string]: string | string[] | undefined;
}

export type SpanListener = (span: TraceSpan) => void;

/** Upper bound on buffered spans. Every request records one, so an unbounded
 * buffer is a slow memory leak in a long-lived process. */
const DEFAULT_MAX_SPANS = 10_000;

export class TraceCollector {
  private static instance: TraceCollector;
  private readonly spans: TraceSpan[] = [];
  private readonly listeners = new Set<SpanListener>();
  private maxSpans = DEFAULT_MAX_SPANS;

  public static getInstance(): TraceCollector {
    if (!TraceCollector.instance) {
      TraceCollector.instance = new TraceCollector();
    }
    return TraceCollector.instance;
  }

  public recordSpan(span: TraceSpan): void {
    this.spans.push(span);
    if (this.spans.length > this.maxSpans) {
      this.spans.splice(0, this.spans.length - this.maxSpans);
    }
    for (const listener of this.listeners) {
      try {
        listener(span);
      } catch {
        /* an exporter failure must never fail the traced request */
      }
    }
  }

  /** Subscribe an exporter (OTLP bridge, log sink). Returns an unsubscribe fn. */
  public onSpan(listener: SpanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public setMaxSpans(max: number): void {
    this.maxSpans = Math.max(1, max);
    if (this.spans.length > this.maxSpans) {
      this.spans.splice(0, this.spans.length - this.maxSpans);
    }
  }

  public getSpans(traceId?: string): TraceSpan[] {
    if (traceId) {
      return this.spans.filter((s) => s.traceId === traceId);
    }
    return [...this.spans];
  }

  public clear(): void {
    this.spans.length = 0;
  }
}

// ── Id helpers ───────────────────────────────────────────────────────────────

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX16_RE = /^[0-9a-f]{16}$/;
/** Opaque ids we accept from `x-trace-id` / `x-span-id` / `x-request-id`. */
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** A fresh W3C trace-id (16 random bytes, 32 lowercase hex). */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** A fresh W3C span/parent-id (8 random bytes, 16 lowercase hex). */
export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** Map any trace id onto a valid W3C trace-id. UUIDs and 32-hex ids map to
 * themselves (dashes stripped); other opaque ids hash deterministically, so
 * every hop derives the same `traceparent` from the same `x-trace-id`. */
export function toW3CTraceId(traceId: string): string {
  const compact = traceId.replace(/-/g, "").toLowerCase();
  if (HEX32_RE.test(compact) && !/^0+$/.test(compact)) return compact;
  return createHash("sha256").update(traceId).digest("hex").slice(0, 32);
}

function toW3CSpanId(spanId: string): string {
  const lower = spanId.toLowerCase();
  if (HEX16_RE.test(lower) && !/^0+$/.test(lower)) return lower;
  return createHash("sha256").update(spanId).digest("hex").slice(0, 16);
}

function header(headers: TraceHeaderMap, name: string): string | undefined {
  let value = headers[name];
  if (value === undefined) {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
    value = key ? headers[key] : undefined;
  }
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : undefined;
}

function safeId(value: string | undefined): string | undefined {
  return value && SAFE_ID_RE.test(value) ? value : undefined;
}

/** Parse a W3C traceparent; undefined when malformed or an invalid (all-zero
 * or version ff) value, per the Trace Context spec. */
export function parseTraceparent(value: string | undefined): TraceContext | undefined {
  if (!value) return undefined;
  const m = TRACEPARENT_RE.exec(value.toLowerCase());
  if (!m) return undefined;
  const [, version, traceId, spanId] = m as unknown as [string, string, string, string];
  if (version === "ff" || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

// ── Propagation ──────────────────────────────────────────────────────────────

/**
 * Generate or extract a trace context from HTTP headers / queue metadata.
 * Precedence: valid `traceparent` → `x-trace-id` (+ `x-span-id`) →
 * `x-request-id` → a fresh trace.
 */
export function extractTraceContext(headers?: TraceHeaderMap): TraceContext {
  if (!headers) {
    return { traceId: newTraceId() };
  }

  const fromParent = parseTraceparent(header(headers, "traceparent"));
  if (fromParent) return fromParent;

  const traceId = safeId(header(headers, "x-trace-id")) ?? safeId(header(headers, "x-request-id"));
  if (traceId) {
    return { traceId, spanId: safeId(header(headers, "x-span-id")) };
  }

  return { traceId: newTraceId() };
}

/**
 * Inject trace context into outgoing HTTP headers or queue message metadata.
 * `context.spanId` is the caller's current span — it becomes the downstream
 * parent. With no current span a fresh parent-id is minted.
 */
export function injectTraceContext(
  context: TraceContext,
  headers: Record<string, string> = {},
): Record<string, string> {
  const spanId = context.spanId ?? newSpanId();
  return {
    ...headers,
    "x-trace-id": context.traceId,
    "x-span-id": spanId,
    traceparent: `00-${toW3CTraceId(context.traceId)}-${toW3CSpanId(spanId)}-01`,
  };
}

/** The context a child operation should run under: same trace, this span as parent. */
export function childContext(span: TraceSpan): TraceContext {
  return { traceId: span.traceId, spanId: span.spanId };
}

/**
 * Create and execute a traced span function, automatically recording timing and status.
 */
export async function withTraceSpan<T>(
  service: string,
  name: string,
  context: TraceContext,
  fn: (span: TraceSpan) => Promise<T>,
  attributes: Record<string, unknown> = {},
): Promise<T> {
  const span: TraceSpan = {
    traceId: context.traceId,
    spanId: newSpanId(),
    parentSpanId: context.spanId,
    service,
    name,
    startTimeMs: Date.now(),
    status: "ok",
    attributes: { ...attributes },
  };

  try {
    const result = await fn(span);
    span.endTimeMs = Date.now();
    span.status = "ok";
    TraceCollector.getInstance().recordSpan(span);
    return result;
  } catch (err) {
    span.endTimeMs = Date.now();
    span.status = "error";
    span.attributes.error = err instanceof Error ? err.message : String(err);
    TraceCollector.getInstance().recordSpan(span);
    throw err;
  }
}

// ── Fastify integration ──────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyRequest {
    /** This request's server span context (#301). Child work — outbound calls,
     * enqueued jobs, `withTraceSpan` — should use it as the parent. */
    traceContext?: TraceContext;
    traceSpan?: TraceSpan;
  }
}

/**
 * Wires trace propagation onto a Fastify service (#301):
 *
 * 1. onRequest: extract the inbound context, open a server span as its child,
 *    expose it on `request.traceContext`, and bind `traceId`/`spanId` into the
 *    request logger so every log line of the request is searchable by trace.
 * 2. onSend: echo `traceparent` + `x-trace-id` on the response so a caller
 *    (or a curl during an incident) can see which trace served it.
 * 3. onResponse: close and record the span, error status on 5xx.
 *
 * Register it BEFORE any onRequest hook that reads `request.traceContext`.
 */
export function registerTracing(app: FastifyInstance, serviceName: string): void {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const parent = extractTraceContext(request.headers);
    const span: TraceSpan = {
      traceId: parent.traceId,
      spanId: newSpanId(),
      parentSpanId: parent.spanId,
      service: serviceName,
      name: `${request.method} ${request.url.split("?")[0]}`,
      startTimeMs: Date.now(),
      status: "ok",
      attributes: { "http.method": request.method },
    };
    request.traceSpan = span;
    request.traceContext = childContext(span);
    request.log = request.log.child({ traceId: span.traceId, spanId: span.spanId });
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.traceContext) return;
    const out = injectTraceContext(request.traceContext);
    reply.header("traceparent", out.traceparent);
    reply.header("x-trace-id", out["x-trace-id"]);
  });

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const span = request.traceSpan;
    if (!span) return;
    // Route pattern, not raw path — same cardinality rule as the metrics.
    const route = request.routeOptions?.url;
    if (route) span.name = `${request.method} ${route}`;
    span.endTimeMs = Date.now();
    span.status = reply.statusCode >= 500 ? "error" : "ok";
    span.attributes["http.route"] = route ?? "unmatched";
    span.attributes["http.status_code"] = reply.statusCode;
    TraceCollector.getInstance().recordSpan(span);
  });
}
