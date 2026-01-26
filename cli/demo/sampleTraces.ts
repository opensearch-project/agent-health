/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Trace Spans for Demo Mode
 *
 * OTel-format trace spans linked to sample runs.
 * Always visible alongside real traces - trace IDs prefixed with 'demo-'.
 */

import type { Span } from '../../types/index.js';

// Base timestamp for demo traces
const BASE_TIME = new Date('2024-01-15T10:05:00.000Z').getTime();

/**
 * Generate spans for Payment Service Latency Spike (demo-report-001)
 *
 * Realistic e-commerce checkout flow showing:
 * - API Gateway routing
 * - Authentication/authorization
 * - Cart validation
 * - Fraud detection (ML model)
 * - Payment processing with Stripe (bottleneck)
 * - Order creation
 */
function generatePaymentTraceSpans(): Span[] {
  const traceId = 'demo-trace-001';
  const baseTime = BASE_TIME;

  return [
    // Root span: API Gateway
    {
      traceId,
      spanId: 'span-001-root',
      name: 'POST /api/v1/checkout',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 1150).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'api-gateway',
        'http.method': 'POST',
        'http.route': '/api/v1/checkout',
        'http.status_code': 200,
        'http.request_content_length': 1245,
        'http.response_content_length': 892,
        'user.id': 'usr_8472913',
        'request.id': 'req_a1b2c3d4e5',
        'run.id': 'demo-agent-run-001',
      },
    },
    // Auth validation
    {
      traceId,
      spanId: 'span-001-auth',
      parentSpanId: 'span-001-root',
      name: 'auth-service.validateToken',
      startTime: new Date(baseTime + 5).toISOString(),
      endTime: new Date(baseTime + 25).toISOString(),
      duration: 20,
      status: 'OK',
      attributes: {
        'service.name': 'auth-service',
        'auth.method': 'jwt',
        'auth.token_type': 'access_token',
        'auth.user_id': 'usr_8472913',
        'auth.scope': 'checkout:write',
      },
    },
    // Rate limiting check
    {
      traceId,
      spanId: 'span-001-ratelimit',
      parentSpanId: 'span-001-root',
      name: 'redis.get',
      startTime: new Date(baseTime + 26).toISOString(),
      endTime: new Date(baseTime + 28).toISOString(),
      duration: 2,
      status: 'OK',
      attributes: {
        'service.name': 'api-gateway',
        'db.system': 'redis',
        'db.operation': 'GET',
        'db.statement': 'GET rate_limit:usr_8472913:checkout',
        'cache.hit': true,
        'rate_limit.remaining': 98,
      },
    },
    // Frontend checkout handler
    {
      traceId,
      spanId: 'span-001-frontend',
      parentSpanId: 'span-001-root',
      name: 'checkout-service.processCheckout',
      startTime: new Date(baseTime + 30).toISOString(),
      endTime: new Date(baseTime + 1100).toISOString(),
      duration: 1070,
      status: 'OK',
      attributes: {
        'service.name': 'checkout-service',
        'checkout.session_id': 'cs_live_a1b2c3',
        'checkout.cart_id': 'cart_xyz789',
        'checkout.item_count': 3,
      },
    },
    // Cart validation from Redis
    {
      traceId,
      spanId: 'span-001-cart',
      parentSpanId: 'span-001-frontend',
      name: 'cart-service.getCart',
      startTime: new Date(baseTime + 35).toISOString(),
      endTime: new Date(baseTime + 55).toISOString(),
      duration: 20,
      status: 'OK',
      attributes: {
        'service.name': 'cart-service',
        'cart.id': 'cart_xyz789',
        'cart.items': 3,
        'cart.total': 99.99,
        'cache.source': 'redis',
      },
    },
    // Inventory reservation
    {
      traceId,
      spanId: 'span-001-inventory',
      parentSpanId: 'span-001-frontend',
      name: 'inventory-service.reserveItems',
      startTime: new Date(baseTime + 56).toISOString(),
      endTime: new Date(baseTime + 85).toISOString(),
      duration: 29,
      status: 'OK',
      attributes: {
        'service.name': 'inventory-service',
        'inventory.items_reserved': 3,
        'inventory.warehouse': 'us-west-2',
        'db.system': 'postgresql',
      },
    },
    // Payment service main span
    {
      traceId,
      spanId: 'span-001-payment',
      parentSpanId: 'span-001-frontend',
      name: 'payment-service.processPayment',
      startTime: new Date(baseTime + 90).toISOString(),
      endTime: new Date(baseTime + 1050).toISOString(),
      duration: 960,
      status: 'OK',
      attributes: {
        'service.name': 'payment-service',
        'payment.amount': 99.99,
        'payment.currency': 'USD',
        'payment.method': 'card',
        'payment.card_brand': 'visa',
        'payment.card_last4': '4242',
      },
    },
    // Customer lookup for fraud check
    {
      traceId,
      spanId: 'span-001-customer',
      parentSpanId: 'span-001-payment',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 95).toISOString(),
      endTime: new Date(baseTime + 110).toISOString(),
      duration: 15,
      status: 'OK',
      attributes: {
        'service.name': 'payment-service',
        'db.system': 'postgresql',
        'db.name': 'customers',
        'db.operation': 'SELECT',
        'db.statement': 'SELECT * FROM customers WHERE id = $1',
        'db.rows_affected': 1,
      },
    },
    // Fraud detection ML model
    {
      traceId,
      spanId: 'span-001-fraud',
      parentSpanId: 'span-001-payment',
      name: 'fraud-detection.evaluateRisk',
      startTime: new Date(baseTime + 115).toISOString(),
      endTime: new Date(baseTime + 235).toISOString(),
      duration: 120,
      status: 'OK',
      attributes: {
        'service.name': 'fraud-detection',
        'fraud.model_version': 'v3.2.1',
        'fraud.score': 0.12,
        'fraud.threshold': 0.75,
        'fraud.decision': 'approve',
        'fraud.signals_evaluated': 47,
        'ml.model_id': 'fraud_clf_prod',
        'ml.inference_time_ms': 85,
      },
    },
    // Fraud model DB lookup
    {
      traceId,
      spanId: 'span-001-fraud-db',
      parentSpanId: 'span-001-fraud',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 120).toISOString(),
      endTime: new Date(baseTime + 135).toISOString(),
      duration: 15,
      status: 'OK',
      attributes: {
        'service.name': 'fraud-detection',
        'db.system': 'postgresql',
        'db.name': 'fraud_signals',
        'db.operation': 'SELECT',
        'db.statement': 'SELECT * FROM user_risk_profile WHERE user_id = $1',
      },
    },
    // Stripe API call - THE BOTTLENECK (82% of latency)
    {
      traceId,
      spanId: 'span-001-stripe',
      parentSpanId: 'span-001-payment',
      name: 'stripe.charges.create',
      startTime: new Date(baseTime + 250).toISOString(),
      endTime: new Date(baseTime + 1030).toISOString(),
      duration: 780,
      status: 'OK',
      attributes: {
        'service.name': 'payment-service',
        'http.url': 'https://api.stripe.com/v1/charges',
        'http.method': 'POST',
        'http.status_code': 200,
        'http.response_time_ms': 780,
        'peer.service': 'stripe-api',
        'stripe.api_version': '2023-10-16',
        'stripe.charge_id': 'ch_3OkJ2h4eZvKYlo2C',
        'stripe.latency_degraded': true,
        'stripe.region': 'us-east-1',
      },
      events: [
        {
          name: 'latency_warning',
          time: new Date(baseTime + 500).toISOString(),
          attributes: {
            'warning.type': 'external_api_slow',
            'warning.threshold_ms': 500,
            'warning.actual_ms': 780,
          },
        },
      ],
    },
    // Record payment in database
    {
      traceId,
      spanId: 'span-001-record',
      parentSpanId: 'span-001-payment',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 1035).toISOString(),
      endTime: new Date(baseTime + 1048).toISOString(),
      duration: 13,
      status: 'OK',
      attributes: {
        'service.name': 'payment-service',
        'db.system': 'postgresql',
        'db.name': 'payments',
        'db.operation': 'INSERT',
        'db.statement': 'INSERT INTO payments (id, user_id, amount, stripe_charge_id, status) VALUES ($1, $2, $3, $4, $5)',
      },
    },
    // Create order record
    {
      traceId,
      spanId: 'span-001-order',
      parentSpanId: 'span-001-frontend',
      name: 'order-service.createOrder',
      startTime: new Date(baseTime + 1055).toISOString(),
      endTime: new Date(baseTime + 1095).toISOString(),
      duration: 40,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'order.id': 'ord_a1b2c3d4',
        'order.status': 'confirmed',
        'order.total': 99.99,
      },
    },
    // Publish order event to Kafka
    {
      traceId,
      spanId: 'span-001-kafka',
      parentSpanId: 'span-001-order',
      name: 'kafka.produce',
      startTime: new Date(baseTime + 1075).toISOString(),
      endTime: new Date(baseTime + 1090).toISOString(),
      duration: 15,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'messaging.system': 'kafka',
        'messaging.destination': 'orders.created',
        'messaging.operation': 'publish',
        'messaging.message_id': 'msg_xyz123',
      },
    },
  ];
}

/**
 * Generate spans for Cart Service Error Rate (demo-report-002)
 *
 * Realistic cart checkout failure showing:
 * - API Gateway routing
 * - Session validation
 * - Cart retrieval from Redis
 * - Pricing service call (succeeds)
 * - Inventory check (fails - service down after v3.1.0 deployment)
 */
function generateCartErrorTraceSpans(): Span[] {
  const traceId = 'demo-trace-002';
  const baseTime = BASE_TIME + 180000; // 3 minutes after first trace

  return [
    // Root span: API Gateway
    {
      traceId,
      spanId: 'span-002-root',
      name: 'POST /api/v1/cart/checkout',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 5100).toISOString(),
      duration: 5100,
      status: 'ERROR',
      attributes: {
        'service.name': 'api-gateway',
        'http.method': 'POST',
        'http.route': '/api/v1/cart/checkout',
        'http.status_code': 503,
        'http.request_content_length': 856,
        'user.id': 'usr_9283746',
        'request.id': 'req_f5e4d3c2b1',
        'run.id': 'demo-agent-run-002',
        'error': true,
      },
      events: [
        {
          name: 'error',
          time: new Date(baseTime + 5100).toISOString(),
          attributes: {
            'error.kind': 'DependencyFailure',
            'error.downstream_service': 'inventory-service',
          },
        },
      ],
    },
    // Auth validation (succeeds)
    {
      traceId,
      spanId: 'span-002-auth',
      parentSpanId: 'span-002-root',
      name: 'auth-service.validateToken',
      startTime: new Date(baseTime + 3).toISOString(),
      endTime: new Date(baseTime + 18).toISOString(),
      duration: 15,
      status: 'OK',
      attributes: {
        'service.name': 'auth-service',
        'auth.method': 'jwt',
        'auth.user_id': 'usr_9283746',
        'auth.token_valid': true,
      },
    },
    // Cart service main handler
    {
      traceId,
      spanId: 'span-002-cart',
      parentSpanId: 'span-002-root',
      name: 'cart-service.processCheckout',
      startTime: new Date(baseTime + 20).toISOString(),
      endTime: new Date(baseTime + 5080).toISOString(),
      duration: 5060,
      status: 'ERROR',
      attributes: {
        'service.name': 'cart-service',
        'cart.id': 'cart_abc123',
        'cart.user_id': 'usr_9283746',
        'error': true,
      },
    },
    // Session validation from Redis (succeeds)
    {
      traceId,
      spanId: 'span-002-session',
      parentSpanId: 'span-002-cart',
      name: 'redis.get',
      startTime: new Date(baseTime + 25).toISOString(),
      endTime: new Date(baseTime + 28).toISOString(),
      duration: 3,
      status: 'OK',
      attributes: {
        'service.name': 'cart-service',
        'db.system': 'redis',
        'db.operation': 'GET',
        'db.statement': 'GET session:usr_9283746',
        'cache.hit': true,
      },
    },
    // Get cart from Redis (succeeds)
    {
      traceId,
      spanId: 'span-002-getcart',
      parentSpanId: 'span-002-cart',
      name: 'redis.hgetall',
      startTime: new Date(baseTime + 30).toISOString(),
      endTime: new Date(baseTime + 35).toISOString(),
      duration: 5,
      status: 'OK',
      attributes: {
        'service.name': 'cart-service',
        'db.system': 'redis',
        'db.operation': 'HGETALL',
        'db.statement': 'HGETALL cart:cart_abc123',
        'cache.hit': true,
        'cart.items': 2,
      },
    },
    // Pricing service call (succeeds)
    {
      traceId,
      spanId: 'span-002-pricing',
      parentSpanId: 'span-002-cart',
      name: 'pricing-service.calculateTotal',
      startTime: new Date(baseTime + 40).toISOString(),
      endTime: new Date(baseTime + 75).toISOString(),
      duration: 35,
      status: 'OK',
      attributes: {
        'service.name': 'pricing-service',
        'pricing.subtotal': 149.98,
        'pricing.tax': 12.0,
        'pricing.shipping': 5.99,
        'pricing.total': 167.97,
        'pricing.discount_applied': false,
      },
    },
    // Inventory check - FAILS (connection refused)
    {
      traceId,
      spanId: 'span-002-inventory',
      parentSpanId: 'span-002-cart',
      name: 'inventory-service.checkStock',
      startTime: new Date(baseTime + 80).toISOString(),
      endTime: new Date(baseTime + 5060).toISOString(),
      duration: 4980,
      status: 'ERROR',
      attributes: {
        'service.name': 'cart-service',
        'peer.service': 'inventory-service',
        'http.method': 'POST',
        'http.url': 'http://inventory-service:8080/api/v1/stock/check',
        'http.status_code': 503,
        'error': true,
        'error.message': 'Connection refused: inventory-service:8080',
        'retry.count': 3,
        'retry.strategy': 'exponential_backoff',
      },
      events: [
        {
          name: 'retry_attempt',
          time: new Date(baseTime + 1080).toISOString(),
          attributes: {
            'retry.attempt': 1,
            'retry.delay_ms': 1000,
            'retry.error': 'Connection refused',
          },
        },
        {
          name: 'retry_attempt',
          time: new Date(baseTime + 3080).toISOString(),
          attributes: {
            'retry.attempt': 2,
            'retry.delay_ms': 2000,
            'retry.error': 'Connection refused',
          },
        },
        {
          name: 'retry_attempt',
          time: new Date(baseTime + 5060).toISOString(),
          attributes: {
            'retry.attempt': 3,
            'retry.delay_ms': 2000,
            'retry.error': 'Connection refused',
          },
        },
        {
          name: 'exception',
          time: new Date(baseTime + 5060).toISOString(),
          attributes: {
            'exception.type': 'ConnectionRefusedException',
            'exception.message': 'Connection refused: inventory-service:8080 - all 3 retries exhausted',
            'exception.stacktrace': 'at InventoryClient.checkStock(InventoryClient.java:142)\nat CartService.processCheckout(CartService.java:89)',
          },
        },
      ],
    },
    // First retry attempt - TCP connection
    {
      traceId,
      spanId: 'span-002-inv-retry1',
      parentSpanId: 'span-002-inventory',
      name: 'tcp.connect',
      startTime: new Date(baseTime + 80).toISOString(),
      endTime: new Date(baseTime + 1080).toISOString(),
      duration: 1000,
      status: 'ERROR',
      attributes: {
        'service.name': 'cart-service',
        'net.peer.name': 'inventory-service',
        'net.peer.port': 8080,
        'net.transport': 'tcp',
        'error': true,
        'error.message': 'Connection refused',
      },
    },
    // Second retry attempt
    {
      traceId,
      spanId: 'span-002-inv-retry2',
      parentSpanId: 'span-002-inventory',
      name: 'tcp.connect',
      startTime: new Date(baseTime + 1080).toISOString(),
      endTime: new Date(baseTime + 3080).toISOString(),
      duration: 2000,
      status: 'ERROR',
      attributes: {
        'service.name': 'cart-service',
        'net.peer.name': 'inventory-service',
        'net.peer.port': 8080,
        'net.transport': 'tcp',
        'error': true,
        'error.message': 'Connection refused',
      },
    },
    // Third retry attempt
    {
      traceId,
      spanId: 'span-002-inv-retry3',
      parentSpanId: 'span-002-inventory',
      name: 'tcp.connect',
      startTime: new Date(baseTime + 3080).toISOString(),
      endTime: new Date(baseTime + 5060).toISOString(),
      duration: 1980,
      status: 'ERROR',
      attributes: {
        'service.name': 'cart-service',
        'net.peer.name': 'inventory-service',
        'net.peer.port': 8080,
        'net.transport': 'tcp',
        'error': true,
        'error.message': 'Connection refused',
      },
    },
    // Log error to monitoring
    {
      traceId,
      spanId: 'span-002-log',
      parentSpanId: 'span-002-cart',
      name: 'datadog.log',
      startTime: new Date(baseTime + 5065).toISOString(),
      endTime: new Date(baseTime + 5075).toISOString(),
      duration: 10,
      status: 'OK',
      attributes: {
        'service.name': 'cart-service',
        'log.level': 'error',
        'log.message': 'Checkout failed: inventory-service unavailable',
        'monitoring.alert_triggered': true,
      },
    },
  ];
}

/**
 * Generate spans for Database Connection Pool (demo-report-003)
 *
 * Realistic flash sale scenario showing:
 * - API Gateway with high traffic
 * - Load balancing across instances
 * - Auth service (succeeds quickly)
 * - Order service trying to process orders
 * - Multiple DB queries queuing up
 * - Connection pool exhaustion under load
 * - Missing index causing slow queries
 */
function generateDbPoolTraceSpans(): Span[] {
  const traceId = 'demo-trace-003';
  const baseTime = BASE_TIME + 420000; // 7 minutes after first trace

  return [
    // Root span: API Gateway
    {
      traceId,
      spanId: 'span-003-root',
      name: 'POST /api/v1/orders',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 30500).toISOString(),
      duration: 30500,
      status: 'ERROR',
      attributes: {
        'service.name': 'api-gateway',
        'http.method': 'POST',
        'http.route': '/api/v1/orders',
        'http.status_code': 504,
        'http.request_content_length': 2048,
        'user.id': 'usr_5647382',
        'request.id': 'req_g6h7i8j9k0',
        'run.id': 'demo-agent-run-003',
        'error': true,
        'flash_sale.active': true,
        'flash_sale.id': 'sale_summer2024',
      },
      events: [
        {
          name: 'gateway_timeout',
          time: new Date(baseTime + 30500).toISOString(),
          attributes: {
            'timeout.reason': 'upstream_timeout',
            'timeout.threshold_ms': 30000,
          },
        },
      ],
    },
    // Auth service (fast - not the bottleneck)
    {
      traceId,
      spanId: 'span-003-auth',
      parentSpanId: 'span-003-root',
      name: 'auth-service.validateToken',
      startTime: new Date(baseTime + 5).toISOString(),
      endTime: new Date(baseTime + 15).toISOString(),
      duration: 10,
      status: 'OK',
      attributes: {
        'service.name': 'auth-service',
        'auth.method': 'jwt',
        'auth.user_id': 'usr_5647382',
      },
    },
    // Rate limiting check from Redis
    {
      traceId,
      spanId: 'span-003-ratelimit',
      parentSpanId: 'span-003-root',
      name: 'redis.incr',
      startTime: new Date(baseTime + 16).toISOString(),
      endTime: new Date(baseTime + 20).toISOString(),
      duration: 4,
      status: 'OK',
      attributes: {
        'service.name': 'api-gateway',
        'db.system': 'redis',
        'db.operation': 'INCR',
        'db.statement': 'INCR rate_limit:flash_sale:usr_5647382',
        'rate_limit.current': 15,
        'rate_limit.limit': 100,
      },
    },
    // Order service main span
    {
      traceId,
      spanId: 'span-003-order',
      parentSpanId: 'span-003-root',
      name: 'order-service.createOrder',
      startTime: new Date(baseTime + 25).toISOString(),
      endTime: new Date(baseTime + 30450).toISOString(),
      duration: 30425,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'order.flash_sale': true,
        'order.items': 3,
        'error': true,
        'error.message': 'Database connection timeout',
      },
    },
    // Check user eligibility - waiting for connection
    {
      traceId,
      spanId: 'span-003-user',
      parentSpanId: 'span-003-order',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 30).toISOString(),
      endTime: new Date(baseTime + 10030).toISOString(),
      duration: 10000,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'db.system': 'postgresql',
        'db.name': 'users',
        'db.operation': 'SELECT',
        'db.statement': 'SELECT * FROM users WHERE id = $1',
        'db.rows_affected': 1,
        'db.pool.wait_time_ms': 9500,
        'db.pool.active_connections': 20,
        'db.pool.max_connections': 20,
        'db.pool.pending_requests': 85,
      },
      events: [
        {
          name: 'pool_wait_start',
          time: new Date(baseTime + 30).toISOString(),
          attributes: {
            'pool.queue_position': 85,
          },
        },
        {
          name: 'connection_acquired',
          time: new Date(baseTime + 9530).toISOString(),
          attributes: {
            'pool.wait_time_ms': 9500,
          },
        },
      ],
    },
    // Get order history - THE SLOW QUERY (missing index)
    {
      traceId,
      spanId: 'span-003-history',
      parentSpanId: 'span-003-order',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 10050).toISOString(),
      endTime: new Date(baseTime + 30050).toISOString(),
      duration: 20000,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'db.system': 'postgresql',
        'db.name': 'orders',
        'db.operation': 'SELECT',
        'db.statement': 'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
        'db.rows_affected': 0,
        'db.pool.active_connections': 20,
        'db.pool.max_connections': 20,
        'db.pool.pending_requests': 150,
        'db.pool.wait_time_ms': 10000,
        'db.query.execution_time_ms': 450,
        'db.query.rows_scanned': 5000000,
        'db.query.plan': 'Sequential Scan on orders (cost=0.00..185432.00 rows=1234 width=256)',
        'error': true,
        'error.message': 'Connection is not available, request timed out after 30000ms',
      },
      events: [
        {
          name: 'pool_wait_start',
          time: new Date(baseTime + 10050).toISOString(),
          attributes: {
            'pool.queue_position': 150,
            'pool.active': 20,
            'pool.max': 20,
          },
        },
        {
          name: 'pool_exhausted',
          time: new Date(baseTime + 10100).toISOString(),
          attributes: {
            'pool.active': 20,
            'pool.max': 20,
            'pool.pending': 150,
            'alert.triggered': true,
          },
        },
        {
          name: 'slow_query_detected',
          time: new Date(baseTime + 15000).toISOString(),
          attributes: {
            'query.duration_ms': 450,
            'query.threshold_ms': 100,
            'query.missing_index': 'orders(user_id, created_at)',
          },
        },
        {
          name: 'connection_timeout',
          time: new Date(baseTime + 30050).toISOString(),
          attributes: {
            'timeout.type': 'pool_acquisition',
            'timeout.threshold_ms': 30000,
            'timeout.actual_wait_ms': 20000,
          },
        },
      ],
    },
    // Attempted inventory check (never gets connection)
    {
      traceId,
      spanId: 'span-003-inv',
      parentSpanId: 'span-003-order',
      name: 'inventory-service.reserveStock',
      startTime: new Date(baseTime + 10060).toISOString(),
      endTime: new Date(baseTime + 10080).toISOString(),
      duration: 20,
      status: 'OK',
      attributes: {
        'service.name': 'inventory-service',
        'inventory.items': 3,
        'inventory.reserved': true,
        'inventory.warehouse': 'us-east-1',
      },
    },
    // Inventory DB query (succeeds - different connection pool)
    {
      traceId,
      spanId: 'span-003-inv-db',
      parentSpanId: 'span-003-inv',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 10065).toISOString(),
      endTime: new Date(baseTime + 10075).toISOString(),
      duration: 10,
      status: 'OK',
      attributes: {
        'service.name': 'inventory-service',
        'db.system': 'postgresql',
        'db.name': 'inventory',
        'db.operation': 'UPDATE',
        'db.statement': 'UPDATE inventory SET reserved = reserved + $1 WHERE sku = $2',
        'db.pool.active_connections': 5,
        'db.pool.max_connections': 20,
      },
    },
    // Metrics emission
    {
      traceId,
      spanId: 'span-003-metrics',
      parentSpanId: 'span-003-order',
      name: 'prometheus.push',
      startTime: new Date(baseTime + 30055).toISOString(),
      endTime: new Date(baseTime + 30060).toISOString(),
      duration: 5,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'metrics.name': 'db_pool_exhaustion',
        'metrics.labels': 'service=order-service,pool=primary',
        'metrics.value': 1,
      },
    },
    // Error logging
    {
      traceId,
      spanId: 'span-003-log',
      parentSpanId: 'span-003-order',
      name: 'elasticsearch.index',
      startTime: new Date(baseTime + 30065).toISOString(),
      endTime: new Date(baseTime + 30080).toISOString(),
      duration: 15,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'db.system': 'elasticsearch',
        'db.operation': 'index',
        'log.level': 'error',
        'log.message': 'Order creation failed: DB connection pool exhausted during flash sale',
      },
    },
    // Transaction rollback
    {
      traceId,
      spanId: 'span-003-rollback',
      parentSpanId: 'span-003-order',
      name: 'transaction.rollback',
      startTime: new Date(baseTime + 30100).toISOString(),
      endTime: new Date(baseTime + 30120).toISOString(),
      duration: 20,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'transaction.id': 'txn_xyz789',
        'transaction.reason': 'connection_timeout',
        'transaction.compensating_actions': 'inventory_release',
      },
    },
    // Release inventory reservation
    {
      traceId,
      spanId: 'span-003-release',
      parentSpanId: 'span-003-rollback',
      name: 'inventory-service.releaseStock',
      startTime: new Date(baseTime + 30105).toISOString(),
      endTime: new Date(baseTime + 30115).toISOString(),
      duration: 10,
      status: 'OK',
      attributes: {
        'service.name': 'inventory-service',
        'inventory.items_released': 3,
        'inventory.reason': 'order_failed',
      },
    },
  ];
}

/**
 * Generate spans for Cold Start (demo-report-004)
 *
 * Realistic ML service cold start showing:
 * - Container initialization
 * - Kubernetes pod scheduling
 * - Dependency injection / IoC container
 * - Configuration loading from ConfigMap/Secrets
 * - S3 model download (large 2GB file)
 * - Model deserialization into memory
 * - GPU allocation
 * - Model warmup inference
 * - Health check registration (premature!)
 * - First request handling
 */
function generateColdStartTraceSpans(): Span[] {
  const traceId = 'demo-trace-004';
  const baseTime = BASE_TIME + 660000; // 11 minutes after first trace

  return [
    // Root span: First user request (during cold start)
    {
      traceId,
      spanId: 'span-004-root',
      name: 'GET /api/v1/recommendations',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 35000).toISOString(),
      duration: 35000,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'http.method': 'GET',
        'http.route': '/api/v1/recommendations',
        'http.status_code': 200,
        'http.response_time_ms': 35000,
        'user.id': 'usr_1234567',
        'request.id': 'req_l1m2n3o4p5',
        'run.id': 'demo-agent-run-004',
        'cold_start': true,
        'k8s.pod.name': 'recommendation-service-7b9c8d6e5f-abc12',
        'k8s.namespace': 'production',
      },
      events: [
        {
          name: 'cold_start_detected',
          time: new Date(baseTime).toISOString(),
          attributes: {
            'cold_start.reason': 'pod_scaled_up',
            'cold_start.trigger': 'hpa_scale_event',
          },
        },
      ],
    },
    // Container runtime initialization
    {
      traceId,
      spanId: 'span-004-container',
      parentSpanId: 'span-004-root',
      name: 'container.init',
      startTime: new Date(baseTime + 10).toISOString(),
      endTime: new Date(baseTime + 2010).toISOString(),
      duration: 2000,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'container.runtime': 'containerd',
        'container.image': 'recommendation-service:v2.1.0',
        'container.image_size_mb': 1850,
      },
    },
    // Python runtime startup
    {
      traceId,
      spanId: 'span-004-python',
      parentSpanId: 'span-004-container',
      name: 'python.startup',
      startTime: new Date(baseTime + 500).toISOString(),
      endTime: new Date(baseTime + 1800).toISOString(),
      duration: 1300,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'python.version': '3.11.5',
        'python.packages_loaded': 127,
      },
    },
    // Dependency injection container
    {
      traceId,
      spanId: 'span-004-di',
      parentSpanId: 'span-004-root',
      name: 'dependency_injection.init',
      startTime: new Date(baseTime + 2020).toISOString(),
      endTime: new Date(baseTime + 3020).toISOString(),
      duration: 1000,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'di.container': 'dependency_injector',
        'di.providers_registered': 23,
        'di.singletons_created': 8,
      },
    },
    // Config loading from Kubernetes
    {
      traceId,
      spanId: 'span-004-config',
      parentSpanId: 'span-004-di',
      name: 'config.load',
      startTime: new Date(baseTime + 2050).toISOString(),
      endTime: new Date(baseTime + 2150).toISOString(),
      duration: 100,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'config.source': 'kubernetes_configmap',
        'config.name': 'recommendation-config',
        'config.keys_loaded': 15,
      },
    },
    // Secrets loading
    {
      traceId,
      spanId: 'span-004-secrets',
      parentSpanId: 'span-004-di',
      name: 'secrets.load',
      startTime: new Date(baseTime + 2160).toISOString(),
      endTime: new Date(baseTime + 2260).toISOString(),
      duration: 100,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'secrets.source': 'aws_secrets_manager',
        'secrets.keys_loaded': 3,
        'secrets.cached': false,
      },
    },
    // Database connection pool init
    {
      traceId,
      spanId: 'span-004-dbpool',
      parentSpanId: 'span-004-di',
      name: 'postgresql.pool.init',
      startTime: new Date(baseTime + 2300).toISOString(),
      endTime: new Date(baseTime + 2800).toISOString(),
      duration: 500,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'db.system': 'postgresql',
        'db.pool.min_connections': 2,
        'db.pool.max_connections': 10,
        'db.pool.initial_connections': 2,
      },
    },
    // Redis client init
    {
      traceId,
      spanId: 'span-004-redis',
      parentSpanId: 'span-004-di',
      name: 'redis.client.init',
      startTime: new Date(baseTime + 2810).toISOString(),
      endTime: new Date(baseTime + 2910).toISOString(),
      duration: 100,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'db.system': 'redis',
        'redis.cluster': true,
        'redis.nodes': 3,
      },
    },
    // S3 model download - SLOW
    {
      traceId,
      spanId: 'span-004-s3',
      parentSpanId: 'span-004-root',
      name: 'aws.s3.getObject',
      startTime: new Date(baseTime + 3100).toISOString(),
      endTime: new Date(baseTime + 11100).toISOString(),
      duration: 8000,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'aws.service': 's3',
        'aws.region': 'us-west-2',
        'aws.operation': 'GetObject',
        'rpc.method': 'GetObject',
        's3.bucket': 'ml-models-prod',
        's3.key': 'models/recommendation/v2/model.pt',
        's3.object_size': 2147483648, // 2GB
        's3.download_speed_mbps': 268,
        'http.status_code': 200,
      },
      events: [
        {
          name: 'download_started',
          time: new Date(baseTime + 3100).toISOString(),
          attributes: {
            'download.size_bytes': 2147483648,
            'download.expected_duration_ms': 8000,
          },
        },
        {
          name: 'download_progress',
          time: new Date(baseTime + 7100).toISOString(),
          attributes: {
            'download.bytes_received': 1073741824,
            'download.percent': 50,
          },
        },
        {
          name: 'download_completed',
          time: new Date(baseTime + 11100).toISOString(),
          attributes: {
            'download.bytes_received': 2147483648,
            'download.duration_ms': 8000,
          },
        },
      ],
    },
    // GPU allocation
    {
      traceId,
      spanId: 'span-004-gpu',
      parentSpanId: 'span-004-root',
      name: 'cuda.device.allocate',
      startTime: new Date(baseTime + 11200).toISOString(),
      endTime: new Date(baseTime + 11700).toISOString(),
      duration: 500,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'gpu.device': 'cuda:0',
        'gpu.name': 'NVIDIA A10G',
        'gpu.memory_total_gb': 24,
        'gpu.memory_allocated_gb': 8,
        'cuda.version': '12.1',
      },
    },
    // Model deserialization - VERY SLOW
    {
      traceId,
      spanId: 'span-004-load',
      parentSpanId: 'span-004-root',
      name: 'pytorch.model.load',
      startTime: new Date(baseTime + 11800).toISOString(),
      endTime: new Date(baseTime + 31800).toISOString(),
      duration: 20000,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'ml.framework': 'pytorch',
        'ml.model_type': 'transformer',
        'ml.model_size_bytes': 2147483648,
        'ml.model_format': 'safetensors',
        'ml.model_version': 'v2.0.0',
        'ml.parameters': 1700000000, // 1.7B params
        'ml.precision': 'float16',
      },
      events: [
        {
          name: 'model_loading_started',
          time: new Date(baseTime + 11800).toISOString(),
          attributes: {
            'model.path': '/tmp/models/recommendation-v2.pt',
          },
        },
        {
          name: 'weights_loading',
          time: new Date(baseTime + 15800).toISOString(),
          attributes: {
            'weights.layers_loaded': 24,
            'weights.total_layers': 48,
          },
        },
        {
          name: 'model_to_device',
          time: new Date(baseTime + 28800).toISOString(),
          attributes: {
            'device': 'cuda:0',
            'memory_used_gb': 6.4,
          },
        },
      ],
    },
    // Model warmup inference
    {
      traceId,
      spanId: 'span-004-warmup',
      parentSpanId: 'span-004-root',
      name: 'pytorch.model.warmup',
      startTime: new Date(baseTime + 31900).toISOString(),
      endTime: new Date(baseTime + 34500).toISOString(),
      duration: 2600,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'ml.warmup_samples': 100,
        'ml.warmup_batch_size': 10,
        'ml.warmup_batches': 10,
        'ml.avg_inference_ms': 26,
      },
      events: [
        {
          name: 'warmup_batch',
          time: new Date(baseTime + 32160).toISOString(),
          attributes: {
            'batch.number': 1,
            'batch.duration_ms': 260,
          },
        },
        {
          name: 'warmup_batch',
          time: new Date(baseTime + 32420).toISOString(),
          attributes: {
            'batch.number': 2,
            'batch.duration_ms': 260,
          },
        },
        {
          name: 'cuda_graphs_compiled',
          time: new Date(baseTime + 34000).toISOString(),
          attributes: {
            'graphs.count': 3,
            'optimization': 'enabled',
          },
        },
      ],
    },
    // Health check registration (TOO EARLY - the bug!)
    {
      traceId,
      spanId: 'span-004-health',
      parentSpanId: 'span-004-root',
      name: 'http.health.register',
      startTime: new Date(baseTime + 2950).toISOString(),
      endTime: new Date(baseTime + 3000).toISOString(),
      duration: 50,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'health.endpoint': '/health',
        'health.registered_at': new Date(baseTime + 3000).toISOString(),
        'health.checks_model_ready': false, // BUG: doesn't check model!
        'k8s.readiness_probe.path': '/health',
        'k8s.readiness_probe.initial_delay_seconds': 10,
      },
      events: [
        {
          name: 'health_registered_prematurely',
          time: new Date(baseTime + 3000).toISOString(),
          attributes: {
            'warning': 'Health endpoint returns 200 before model is loaded',
            'model_status': 'not_loaded',
            'recommendation': 'Add model.isReady() check to health endpoint',
          },
        },
      ],
    },
    // Actual recommendation inference (after cold start)
    {
      traceId,
      spanId: 'span-004-inference',
      parentSpanId: 'span-004-root',
      name: 'recommendation.inference',
      startTime: new Date(baseTime + 34550).toISOString(),
      endTime: new Date(baseTime + 34900).toISOString(),
      duration: 350,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'ml.model_id': 'recommendation-v2',
        'ml.input_items': 5,
        'ml.output_recommendations': 10,
        'ml.inference_time_ms': 28,
        'ml.postprocessing_time_ms': 12,
      },
    },
    // Cache the results
    {
      traceId,
      spanId: 'span-004-cache',
      parentSpanId: 'span-004-inference',
      name: 'redis.set',
      startTime: new Date(baseTime + 34910).toISOString(),
      endTime: new Date(baseTime + 34940).toISOString(),
      duration: 30,
      status: 'OK',
      attributes: {
        'service.name': 'recommendation-service',
        'db.system': 'redis',
        'db.operation': 'SETEX',
        'db.statement': 'SETEX recommendations:usr_1234567 3600 ...',
        'cache.ttl_seconds': 3600,
      },
    },
  ];
}

/**
 * Generate spans for Cascading Failure (demo-report-005)
 *
 * Realistic cascading failure showing:
 * - Order confirmation request
 * - Multiple service dependencies
 * - Notification service calling Twilio (external outage)
 * - 30s timeout × 3 retries = 90s blocking
 * - Thread pool exhaustion in upstream services
 * - Circuit breaker NOT wrapping async calls (the bug!)
 * - User service blocked waiting for order service
 * - Complete failure cascade
 */
function generateCascadeTraceSpans(): Span[] {
  const traceId = 'demo-trace-005';
  const baseTime = BASE_TIME + 900000; // 15 minutes after first trace

  return [
    // Root span: API Gateway receives order confirmation
    {
      traceId,
      spanId: 'span-005-root',
      name: 'POST /api/v1/orders/confirm',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 95000).toISOString(),
      duration: 95000,
      status: 'ERROR',
      attributes: {
        'service.name': 'api-gateway',
        'http.method': 'POST',
        'http.route': '/api/v1/orders/confirm',
        'http.status_code': 504,
        'http.request_content_length': 1024,
        'user.id': 'usr_7890123',
        'request.id': 'req_q1r2s3t4u5',
        'order.id': 'ord_cascade_001',
        'run.id': 'demo-agent-run-005',
        'error': true,
      },
      events: [
        {
          name: 'cascade_detected',
          time: new Date(baseTime + 95000).toISOString(),
          attributes: {
            'cascade.origin': 'notification-service',
            'cascade.affected_services': 'order-service,user-service',
            'cascade.total_duration_ms': 95000,
          },
        },
      ],
    },
    // Auth check (fast, succeeds)
    {
      traceId,
      spanId: 'span-005-auth',
      parentSpanId: 'span-005-root',
      name: 'auth-service.validateToken',
      startTime: new Date(baseTime + 5).toISOString(),
      endTime: new Date(baseTime + 15).toISOString(),
      duration: 10,
      status: 'OK',
      attributes: {
        'service.name': 'auth-service',
        'auth.user_id': 'usr_7890123',
        'auth.method': 'jwt',
      },
    },
    // Order service main span
    {
      traceId,
      spanId: 'span-005-order',
      parentSpanId: 'span-005-root',
      name: 'order-service.confirmOrder',
      startTime: new Date(baseTime + 20).toISOString(),
      endTime: new Date(baseTime + 94500).toISOString(),
      duration: 94480,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'order.id': 'ord_cascade_001',
        'order.status': 'pending_confirmation',
        'error': true,
        'error.message': 'Upstream timeout waiting for notification-service',
      },
    },
    // Update order status in DB (fast, succeeds)
    {
      traceId,
      spanId: 'span-005-db',
      parentSpanId: 'span-005-order',
      name: 'postgresql.query',
      startTime: new Date(baseTime + 25).toISOString(),
      endTime: new Date(baseTime + 45).toISOString(),
      duration: 20,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'db.system': 'postgresql',
        'db.name': 'orders',
        'db.operation': 'UPDATE',
        'db.statement': 'UPDATE orders SET status = $1, confirmed_at = $2 WHERE id = $3',
        'db.rows_affected': 1,
      },
    },
    // Check circuit breaker status (shows misconfiguration)
    {
      traceId,
      spanId: 'span-005-circuit',
      parentSpanId: 'span-005-order',
      name: 'circuit_breaker.check',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 55).toISOString(),
      duration: 5,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'circuit_breaker.name': 'notification-service',
        'circuit_breaker.state': 'closed', // Should be open!
        'circuit_breaker.failure_count': 47,
        'circuit_breaker.failure_threshold': 50,
        'circuit_breaker.covers_async': false, // THE BUG!
      },
      events: [
        {
          name: 'circuit_breaker_misconfigured',
          time: new Date(baseTime + 55).toISOString(),
          attributes: {
            'warning': 'Circuit breaker only wraps synchronous HTTP calls',
            'recommendation': 'Wrap async notification calls with circuit breaker',
            'async_calls_unprotected': true,
          },
        },
      ],
    },
    // Notification service call - BLOCKING (the cause of cascade)
    {
      traceId,
      spanId: 'span-005-notify',
      parentSpanId: 'span-005-order',
      name: 'notification-service.sendConfirmation',
      startTime: new Date(baseTime + 60).toISOString(),
      endTime: new Date(baseTime + 90060).toISOString(),
      duration: 90000,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'peer.service': 'notification-service',
        'http.method': 'POST',
        'http.url': 'http://notification-service:8080/api/v1/send',
        'http.status_code': 503,
        'error': true,
        'error.message': 'Service Unavailable after 3 retries',
        'retry.count': 3,
        'retry.strategy': 'fixed_delay',
        'retry.timeout_per_attempt_ms': 30000,
        'notification.type': 'order_confirmation',
        'notification.channels': 'sms,email',
      },
    },
    // First retry to notification service
    {
      traceId,
      spanId: 'span-005-notify-r1',
      parentSpanId: 'span-005-notify',
      name: 'http.client.request',
      startTime: new Date(baseTime + 60).toISOString(),
      endTime: new Date(baseTime + 30060).toISOString(),
      duration: 30000,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'http.method': 'POST',
        'http.url': 'http://notification-service:8080/api/v1/send',
        'http.status_code': 503,
        'retry.attempt': 1,
        'error': true,
      },
    },
    // Notification service processing (attempt 1)
    {
      traceId,
      spanId: 'span-005-notify-proc1',
      parentSpanId: 'span-005-notify-r1',
      name: 'notification-service.process',
      startTime: new Date(baseTime + 100).toISOString(),
      endTime: new Date(baseTime + 30050).toISOString(),
      duration: 29950,
      status: 'ERROR',
      attributes: {
        'service.name': 'notification-service',
        'notification.id': 'notif_001',
        'error': true,
      },
    },
    // Twilio SMS call (attempt 1) - EXTERNAL OUTAGE
    {
      traceId,
      spanId: 'span-005-twilio1',
      parentSpanId: 'span-005-notify-proc1',
      name: 'twilio.messages.create',
      startTime: new Date(baseTime + 150).toISOString(),
      endTime: new Date(baseTime + 30050).toISOString(),
      duration: 29900,
      status: 'ERROR',
      attributes: {
        'service.name': 'notification-service',
        'peer.service': 'twilio-api',
        'http.method': 'POST',
        'http.url': 'https://api.twilio.com/2010-04-01/Accounts/AC1234567890/Messages.json',
        'http.status_code': 503,
        'error': true,
        'error.message': 'Service Unavailable - Twilio experiencing outage',
        'twilio.account_sid': 'AC1234567890',
        'twilio.timeout_ms': 30000,
      },
      events: [
        {
          name: 'external_service_outage',
          time: new Date(baseTime + 30050).toISOString(),
          attributes: {
            'provider': 'twilio',
            'status_page': 'https://status.twilio.com',
            'incident': 'SMS API Degraded Performance',
            'incident.started_at': new Date(baseTime - 600000).toISOString(),
          },
        },
      ],
    },
    // Second retry to notification service
    {
      traceId,
      spanId: 'span-005-notify-r2',
      parentSpanId: 'span-005-notify',
      name: 'http.client.request',
      startTime: new Date(baseTime + 30060).toISOString(),
      endTime: new Date(baseTime + 60060).toISOString(),
      duration: 30000,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'http.method': 'POST',
        'http.url': 'http://notification-service:8080/api/v1/send',
        'http.status_code': 503,
        'retry.attempt': 2,
        'error': true,
      },
    },
    // Twilio SMS call (attempt 2)
    {
      traceId,
      spanId: 'span-005-twilio2',
      parentSpanId: 'span-005-notify-r2',
      name: 'twilio.messages.create',
      startTime: new Date(baseTime + 30150).toISOString(),
      endTime: new Date(baseTime + 60050).toISOString(),
      duration: 29900,
      status: 'ERROR',
      attributes: {
        'service.name': 'notification-service',
        'peer.service': 'twilio-api',
        'http.status_code': 503,
        'error': true,
        'error.message': 'Service Unavailable - Twilio experiencing outage',
      },
    },
    // Third retry to notification service
    {
      traceId,
      spanId: 'span-005-notify-r3',
      parentSpanId: 'span-005-notify',
      name: 'http.client.request',
      startTime: new Date(baseTime + 60060).toISOString(),
      endTime: new Date(baseTime + 90060).toISOString(),
      duration: 30000,
      status: 'ERROR',
      attributes: {
        'service.name': 'order-service',
        'http.method': 'POST',
        'http.url': 'http://notification-service:8080/api/v1/send',
        'http.status_code': 503,
        'retry.attempt': 3,
        'error': true,
      },
    },
    // Twilio SMS call (attempt 3)
    {
      traceId,
      spanId: 'span-005-twilio3',
      parentSpanId: 'span-005-notify-r3',
      name: 'twilio.messages.create',
      startTime: new Date(baseTime + 60150).toISOString(),
      endTime: new Date(baseTime + 90050).toISOString(),
      duration: 29900,
      status: 'ERROR',
      attributes: {
        'service.name': 'notification-service',
        'peer.service': 'twilio-api',
        'http.status_code': 503,
        'error': true,
        'error.message': 'Service Unavailable - Twilio experiencing outage',
      },
      events: [
        {
          name: 'all_retries_exhausted',
          time: new Date(baseTime + 90050).toISOString(),
          attributes: {
            'retry.total_attempts': 3,
            'retry.total_duration_ms': 90000,
            'fallback.email_attempted': false,
            'fallback.reason': 'not_configured',
          },
        },
      ],
    },
    // Thread pool exhaustion in order-service
    {
      traceId,
      spanId: 'span-005-threadpool',
      parentSpanId: 'span-005-order',
      name: 'thread_pool.exhaustion_check',
      startTime: new Date(baseTime + 90070).toISOString(),
      endTime: new Date(baseTime + 90080).toISOString(),
      duration: 10,
      status: 'OK',
      attributes: {
        'service.name': 'order-service',
        'thread_pool.name': 'http-nio',
        'thread_pool.active': 200,
        'thread_pool.max': 200,
        'thread_pool.queue_size': 500,
        'thread_pool.exhausted': true,
      },
      events: [
        {
          name: 'thread_pool_exhausted',
          time: new Date(baseTime + 90080).toISOString(),
          attributes: {
            'impact': 'New requests will be rejected',
            'blocked_threads': 180,
            'blocked_by': 'notification-service calls',
          },
        },
      ],
    },
    // User service call (blocked by cascade)
    {
      traceId,
      spanId: 'span-005-user',
      parentSpanId: 'span-005-root',
      name: 'user-service.updateOrderHistory',
      startTime: new Date(baseTime + 90100).toISOString(),
      endTime: new Date(baseTime + 94000).toISOString(),
      duration: 3900,
      status: 'ERROR',
      attributes: {
        'service.name': 'user-service',
        'user.id': 'usr_7890123',
        'error': true,
        'error.message': 'Timeout waiting for order-service response',
        'cascade.affected': true,
      },
    },
    // User service trying to call order service
    {
      traceId,
      spanId: 'span-005-user-order',
      parentSpanId: 'span-005-user',
      name: 'http.client.request',
      startTime: new Date(baseTime + 90150).toISOString(),
      endTime: new Date(baseTime + 93950).toISOString(),
      duration: 3800,
      status: 'ERROR',
      attributes: {
        'service.name': 'user-service',
        'peer.service': 'order-service',
        'http.method': 'GET',
        'http.url': 'http://order-service:8080/api/v1/orders/ord_cascade_001',
        'http.status_code': 503,
        'error': true,
        'error.message': 'Connection pool exhausted on target service',
      },
    },
    // Alert triggered
    {
      traceId,
      spanId: 'span-005-alert',
      parentSpanId: 'span-005-root',
      name: 'pagerduty.alert.create',
      startTime: new Date(baseTime + 94100).toISOString(),
      endTime: new Date(baseTime + 94300).toISOString(),
      duration: 200,
      status: 'OK',
      attributes: {
        'service.name': 'api-gateway',
        'alert.severity': 'critical',
        'alert.title': 'Cascading failure detected: notification-service → order-service → user-service',
        'alert.routing_key': 'sre-oncall',
        'alert.dedup_key': 'cascade-notification-twilio-outage',
      },
    },
    // Metrics emission for incident tracking
    {
      traceId,
      spanId: 'span-005-metrics',
      parentSpanId: 'span-005-root',
      name: 'datadog.metrics.emit',
      startTime: new Date(baseTime + 94350).toISOString(),
      endTime: new Date(baseTime + 94400).toISOString(),
      duration: 50,
      status: 'OK',
      attributes: {
        'service.name': 'api-gateway',
        'metrics.name': 'cascade_failure',
        'metrics.tags': 'origin:notification-service,root_cause:twilio_outage',
        'metrics.value': 1,
      },
    },
    // Error response to user
    {
      traceId,
      spanId: 'span-005-response',
      parentSpanId: 'span-005-root',
      name: 'http.response.error',
      startTime: new Date(baseTime + 94450).toISOString(),
      endTime: new Date(baseTime + 94500).toISOString(),
      duration: 50,
      status: 'OK',
      attributes: {
        'service.name': 'api-gateway',
        'http.status_code': 504,
        'http.response.body': '{"error": "Gateway Timeout", "message": "Order confirmation is being processed. You will receive a notification shortly.", "retry_after": 60}',
        'error.user_friendly': true,
      },
    },
  ];
}

/**
 * All sample trace spans
 */
export const SAMPLE_TRACE_SPANS: Span[] = [
  ...generatePaymentTraceSpans(),
  ...generateCartErrorTraceSpans(),
  ...generateDbPoolTraceSpans(),
  ...generateColdStartTraceSpans(),
  ...generateCascadeTraceSpans(),
];

/**
 * Get sample spans for a specific run ID (via agent run ID in attributes)
 */
export function getSampleSpansForRunId(runId: string): Span[] {
  return SAMPLE_TRACE_SPANS.filter(span => span.attributes['run.id'] === runId);
}

/**
 * Get sample spans for multiple run IDs
 */
export function getSampleSpansForRunIds(runIds: string[]): Span[] {
  if (!runIds || runIds.length === 0) return [];
  return SAMPLE_TRACE_SPANS.filter(span => runIds.includes(span.attributes['run.id']));
}

/**
 * Get sample spans by trace ID
 */
export function getSampleSpansByTraceId(traceId: string): Span[] {
  return SAMPLE_TRACE_SPANS.filter(span => span.traceId === traceId);
}

/**
 * Get all sample trace spans
 */
export function getAllSampleTraceSpans(): Span[] {
  return [...SAMPLE_TRACE_SPANS];
}

/**
 * Check if a trace ID is a sample trace
 */
export function isSampleTraceId(traceId: string): boolean {
  return traceId.startsWith('demo-trace-');
}

/**
 * Get unique sample trace IDs
 */
export function getSampleTraceIds(): string[] {
  return [...new Set(SAMPLE_TRACE_SPANS.map(span => span.traceId))];
}
