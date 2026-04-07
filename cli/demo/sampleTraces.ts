/*
 * Copyright OpenSearch Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sample Trace Spans for Demo Mode
 *
 * OTel-format trace spans linked to sample Travel Planner runs.
 * Uses Gen-AI semantic conventions for multi-agent orchestration.
 * Always visible alongside real traces - trace IDs prefixed with 'demo-'.
 *
 * Agent Architecture reflected in spans:
 * - Root span: invoke_agent Travel Coordinator
 * - Child spans: invoke_agent Weather/Events/Booking/Budget Agent
 * - Tool spans: tools/call get_weather_forecast, search_flights, etc.
 * - LLM spans: chat claude-sonnet-4 with token usage
 */

import type { Span } from '../../types/index.js';

// Base timestamp for demo traces
const BASE_TIME = new Date('2024-01-15T10:05:00.000Z').getTime();

/**
 * Generate spans for Weekend Getaway to Napa Valley (demo-report-001)
 *
 * Multi-agent travel planning flow showing:
 * - Travel Coordinator orchestrating Weather, Events, and Booking agents
 * - LLM reasoning at each delegation point
 * - Tool calls for weather forecast, event search, restaurant reservation
 * - Final itinerary assembly
 */
function generateWeekendTripSpans(): Span[] {
  const traceId = 'demo-trace-001';
  const baseTime = BASE_TIME;

  return [
    // Root span: Travel Coordinator
    {
      traceId,
      spanId: 'span-001-root',
      name: 'invoke_agent Travel Coordinator',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 8500).toISOString(),
      duration: 8500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Travel Coordinator',
        'gen_ai.agent.type': 'orchestrator',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'user.query': 'Plan a weekend getaway to Napa Valley for two people',
        'run.id': 'demo-agent-run-001',
      },
    },
    // LLM reasoning: decide which agents to invoke
    {
      traceId,
      spanId: 'span-001-llm1',
      parentSpanId: 'span-001-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 800).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.response.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 245,
        'gen_ai.usage.output_tokens': 180,
        'gen_ai.usage.total_tokens': 425,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Weather Agent invocation
    {
      traceId,
      spanId: 'span-001-weather',
      parentSpanId: 'span-001-root',
      name: 'invoke_agent Weather Agent',
      startTime: new Date(baseTime + 850).toISOString(),
      endTime: new Date(baseTime + 2200).toISOString(),
      duration: 1350,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Weather Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Weather Agent LLM call
    {
      traceId,
      spanId: 'span-001-weather-llm',
      parentSpanId: 'span-001-weather',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 900).toISOString(),
      endTime: new Date(baseTime + 1400).toISOString(),
      duration: 500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 120,
        'gen_ai.usage.output_tokens': 85,
        'gen_ai.usage.total_tokens': 205,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Weather API tool call
    {
      traceId,
      spanId: 'span-001-weather-tool',
      parentSpanId: 'span-001-weather',
      name: 'tools/call get_weather_forecast',
      startTime: new Date(baseTime + 1450).toISOString(),
      endTime: new Date(baseTime + 2100).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'get_weather_forecast',
        'gen_ai.tool.args': '{"location":"Napa Valley, CA","dates":"Saturday-Sunday"}',
        'http.method': 'GET',
        'http.url': 'https://api.weather.gov/gridpoints/MTR/87,105/forecast',
        'http.status_code': 200,
      },
    },
    // Events Agent invocation
    {
      traceId,
      spanId: 'span-001-events',
      parentSpanId: 'span-001-root',
      name: 'invoke_agent Events Agent',
      startTime: new Date(baseTime + 2250).toISOString(),
      endTime: new Date(baseTime + 4500).toISOString(),
      duration: 2250,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Events Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Events Agent LLM call
    {
      traceId,
      spanId: 'span-001-events-llm',
      parentSpanId: 'span-001-events',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 2300).toISOString(),
      endTime: new Date(baseTime + 2900).toISOString(),
      duration: 600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 150,
        'gen_ai.usage.output_tokens': 110,
        'gen_ai.usage.total_tokens': 260,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Events search tool call
    {
      traceId,
      spanId: 'span-001-events-tool',
      parentSpanId: 'span-001-events',
      name: 'tools/call find_events',
      startTime: new Date(baseTime + 2950).toISOString(),
      endTime: new Date(baseTime + 4400).toISOString(),
      duration: 1450,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'find_events',
        'gen_ai.tool.args': '{"location":"Napa Valley","categories":["wine-tasting","food-festival","tours"]}',
        'http.method': 'GET',
        'http.status_code': 200,
        'events.results_count': 5,
      },
    },
    // Booking Agent invocation
    {
      traceId,
      spanId: 'span-001-booking',
      parentSpanId: 'span-001-root',
      name: 'invoke_agent Booking Agent',
      startTime: new Date(baseTime + 4550).toISOString(),
      endTime: new Date(baseTime + 7200).toISOString(),
      duration: 2650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Booking Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Booking Agent LLM call
    {
      traceId,
      spanId: 'span-001-booking-llm',
      parentSpanId: 'span-001-booking',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 4600).toISOString(),
      endTime: new Date(baseTime + 5200).toISOString(),
      duration: 600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 200,
        'gen_ai.usage.output_tokens': 140,
        'gen_ai.usage.total_tokens': 340,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Restaurant reservation tool call
    {
      traceId,
      spanId: 'span-001-booking-restaurant',
      parentSpanId: 'span-001-booking',
      name: 'tools/call book_restaurant',
      startTime: new Date(baseTime + 5250).toISOString(),
      endTime: new Date(baseTime + 6100).toISOString(),
      duration: 850,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'book_restaurant',
        'gen_ai.tool.args': '{"restaurant":"Bottega Napa Valley","date":"Saturday","time":"7:30 PM","party_size":2}',
        'http.method': 'POST',
        'http.status_code': 201,
        'booking.confirmation': 'BNV-2024-0892',
      },
    },
    // Hotel search tool call
    {
      traceId,
      spanId: 'span-001-booking-hotel',
      parentSpanId: 'span-001-booking',
      name: 'tools/call search_hotels',
      startTime: new Date(baseTime + 6150).toISOString(),
      endTime: new Date(baseTime + 7100).toISOString(),
      duration: 950,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_hotels',
        'gen_ai.tool.args': '{"location":"Napa Valley","checkin":"Saturday","checkout":"Sunday","guests":2}',
        'http.method': 'GET',
        'http.status_code': 200,
        'hotels.results_count': 3,
      },
    },
    // Final LLM call: assemble itinerary
    {
      traceId,
      spanId: 'span-001-llm-final',
      parentSpanId: 'span-001-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 7250).toISOString(),
      endTime: new Date(baseTime + 8400).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 850,
        'gen_ai.usage.output_tokens': 620,
        'gen_ai.usage.total_tokens': 1470,
        'gen_ai.response.finish_reason': 'stop',
      },
    },
  ];
}

/**
 * Generate spans for Japan Cherry Blossom Trip (demo-report-002)
 *
 * Complex multi-city international planning showing:
 * - Parallel agent invocations (Booking + Weather)
 * - Events Agent with multi-city search
 * - Multiple booking tool calls (flights, hotels, rail pass)
 * - Large LLM context for day-by-day itinerary assembly
 */
function generateJapanTripSpans(): Span[] {
  const traceId = 'demo-trace-002';
  const baseTime = BASE_TIME + 300000; // 5 minutes after first trace

  return [
    // Root span: Travel Coordinator
    {
      traceId,
      spanId: 'span-002-root',
      name: 'invoke_agent Travel Coordinator',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 18500).toISOString(),
      duration: 18500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Travel Coordinator',
        'gen_ai.agent.type': 'orchestrator',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'user.query': 'Plan a 10-day trip to Japan during cherry blossom season',
        'run.id': 'demo-agent-run-002',
      },
    },
    // Initial LLM reasoning
    {
      traceId,
      spanId: 'span-002-llm1',
      parentSpanId: 'span-002-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 1200).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 380,
        'gen_ai.usage.output_tokens': 250,
        'gen_ai.usage.total_tokens': 630,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Booking Agent: search flights
    {
      traceId,
      spanId: 'span-002-booking',
      parentSpanId: 'span-002-root',
      name: 'invoke_agent Booking Agent',
      startTime: new Date(baseTime + 1300).toISOString(),
      endTime: new Date(baseTime + 5800).toISOString(),
      duration: 4500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Booking Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Booking LLM
    {
      traceId,
      spanId: 'span-002-booking-llm',
      parentSpanId: 'span-002-booking',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 1350).toISOString(),
      endTime: new Date(baseTime + 2000).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 220,
        'gen_ai.usage.output_tokens': 160,
        'gen_ai.usage.total_tokens': 380,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Flight search tool
    {
      traceId,
      spanId: 'span-002-flight-search',
      parentSpanId: 'span-002-booking',
      name: 'tools/call search_flights',
      startTime: new Date(baseTime + 2050).toISOString(),
      endTime: new Date(baseTime + 3800).toISOString(),
      duration: 1750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_flights',
        'gen_ai.tool.args': '{"origin":"SFO","destinations":["NRT","KIX"],"type":"open_jaw","dates":"Mar 25-Apr 4"}',
        'http.method': 'GET',
        'http.status_code': 200,
        'flights.results_count': 3,
      },
    },
    // Hotel booking tool (multiple cities)
    {
      traceId,
      spanId: 'span-002-hotel-book',
      parentSpanId: 'span-002-booking',
      name: 'tools/call book_hotel',
      startTime: new Date(baseTime + 3850).toISOString(),
      endTime: new Date(baseTime + 5700).toISOString(),
      duration: 1850,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'book_hotel',
        'gen_ai.tool.args': '{"cities":["Tokyo","Kyoto","Osaka"],"include_ryokan":true}',
        'http.method': 'POST',
        'http.status_code': 201,
        'bookings.count': 3,
      },
    },
    // Weather Agent: cherry blossom forecast (parallel with events)
    {
      traceId,
      spanId: 'span-002-weather',
      parentSpanId: 'span-002-root',
      name: 'invoke_agent Weather Agent',
      startTime: new Date(baseTime + 5900).toISOString(),
      endTime: new Date(baseTime + 8200).toISOString(),
      duration: 2300,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Weather Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Weather LLM
    {
      traceId,
      spanId: 'span-002-weather-llm',
      parentSpanId: 'span-002-weather',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 5950).toISOString(),
      endTime: new Date(baseTime + 6500).toISOString(),
      duration: 550,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 140,
        'gen_ai.usage.output_tokens': 95,
        'gen_ai.usage.total_tokens': 235,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Cherry blossom forecast tool
    {
      traceId,
      spanId: 'span-002-weather-tool',
      parentSpanId: 'span-002-weather',
      name: 'tools/call get_weather_forecast',
      startTime: new Date(baseTime + 6550).toISOString(),
      endTime: new Date(baseTime + 8100).toISOString(),
      duration: 1550,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'get_weather_forecast',
        'gen_ai.tool.args': '{"locations":["Tokyo","Kyoto","Osaka"],"forecast_type":"cherry_blossom"}',
        'http.method': 'GET',
        'http.status_code': 200,
      },
    },
    // Events Agent: cultural events across three cities
    {
      traceId,
      spanId: 'span-002-events',
      parentSpanId: 'span-002-root',
      name: 'invoke_agent Events Agent',
      startTime: new Date(baseTime + 5900).toISOString(),
      endTime: new Date(baseTime + 10500).toISOString(),
      duration: 4600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Events Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Events LLM
    {
      traceId,
      spanId: 'span-002-events-llm',
      parentSpanId: 'span-002-events',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 5950).toISOString(),
      endTime: new Date(baseTime + 6700).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 180,
        'gen_ai.usage.output_tokens': 130,
        'gen_ai.usage.total_tokens': 310,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Events search: Tokyo
    {
      traceId,
      spanId: 'span-002-events-tokyo',
      parentSpanId: 'span-002-events',
      name: 'tools/call find_events',
      startTime: new Date(baseTime + 6750).toISOString(),
      endTime: new Date(baseTime + 7900).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'find_events',
        'gen_ai.tool.args': '{"location":"Tokyo","categories":["cherry-blossom","cultural"]}',
        'events.results_count': 4,
      },
    },
    // Events search: Kyoto
    {
      traceId,
      spanId: 'span-002-events-kyoto',
      parentSpanId: 'span-002-events',
      name: 'tools/call find_events',
      startTime: new Date(baseTime + 7950).toISOString(),
      endTime: new Date(baseTime + 9100).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'find_events',
        'gen_ai.tool.args': '{"location":"Kyoto","categories":["tea-ceremony","temple","illumination"]}',
        'events.results_count': 4,
      },
    },
    // Events search: Osaka
    {
      traceId,
      spanId: 'span-002-events-osaka',
      parentSpanId: 'span-002-events',
      name: 'tools/call find_events',
      startTime: new Date(baseTime + 9150).toISOString(),
      endTime: new Date(baseTime + 10400).toISOString(),
      duration: 1250,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'find_events',
        'gen_ai.tool.args': '{"location":"Osaka","categories":["food-tour","festival"]}',
        'events.results_count': 3,
      },
    },
    // Final LLM: assemble 10-day itinerary
    {
      traceId,
      spanId: 'span-002-llm-final',
      parentSpanId: 'span-002-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 10600).toISOString(),
      endTime: new Date(baseTime + 18400).toISOString(),
      duration: 7800,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 2200,
        'gen_ai.usage.output_tokens': 1800,
        'gen_ai.usage.total_tokens': 4000,
        'gen_ai.response.finish_reason': 'stop',
      },
    },
  ];
}

/**
 * Generate spans for Budget Southeast Asia (demo-report-003)
 *
 * Budget-focused flow showing:
 * - Budget Agent as primary advisor (cost comparison)
 * - Booking Agent for flight search
 * - Events Agent for free/cheap activities
 * - Budget validation and optimization
 */
function generateBudgetTripSpans(): Span[] {
  const traceId = 'demo-trace-003';
  const baseTime = BASE_TIME + 600000; // 10 minutes after first trace

  return [
    // Root span: Travel Coordinator
    {
      traceId,
      spanId: 'span-003-root',
      name: 'invoke_agent Travel Coordinator',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 12000).toISOString(),
      duration: 12000,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Travel Coordinator',
        'gen_ai.agent.type': 'orchestrator',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'user.query': 'Plan a budget-friendly 5-day trip to Southeast Asia under $1500',
        'run.id': 'demo-agent-run-003',
      },
    },
    // Initial LLM reasoning
    {
      traceId,
      spanId: 'span-003-llm1',
      parentSpanId: 'span-003-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 900).toISOString(),
      duration: 850,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 290,
        'gen_ai.usage.output_tokens': 200,
        'gen_ai.usage.total_tokens': 490,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Budget Agent: destination comparison
    {
      traceId,
      spanId: 'span-003-budget',
      parentSpanId: 'span-003-root',
      name: 'invoke_agent Budget Agent',
      startTime: new Date(baseTime + 1000).toISOString(),
      endTime: new Date(baseTime + 4200).toISOString(),
      duration: 3200,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Budget Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Budget Agent LLM
    {
      traceId,
      spanId: 'span-003-budget-llm',
      parentSpanId: 'span-003-budget',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 1050).toISOString(),
      endTime: new Date(baseTime + 1800).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 200,
        'gen_ai.usage.output_tokens': 150,
        'gen_ai.usage.total_tokens': 350,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Budget comparison tool
    {
      traceId,
      spanId: 'span-003-budget-tool',
      parentSpanId: 'span-003-budget',
      name: 'tools/call compare_destination_costs',
      startTime: new Date(baseTime + 1850).toISOString(),
      endTime: new Date(baseTime + 4100).toISOString(),
      duration: 2250,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'compare_destination_costs',
        'gen_ai.tool.args': '{"destinations":["Thailand","Vietnam","Cambodia"],"budget":1500,"duration":5}',
        'http.method': 'GET',
        'http.status_code': 200,
      },
    },
    // Booking Agent: search budget flights
    {
      traceId,
      spanId: 'span-003-booking',
      parentSpanId: 'span-003-root',
      name: 'invoke_agent Booking Agent',
      startTime: new Date(baseTime + 4300).toISOString(),
      endTime: new Date(baseTime + 7500).toISOString(),
      duration: 3200,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Booking Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Booking LLM
    {
      traceId,
      spanId: 'span-003-booking-llm',
      parentSpanId: 'span-003-booking',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 4350).toISOString(),
      endTime: new Date(baseTime + 5000).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 180,
        'gen_ai.usage.output_tokens': 120,
        'gen_ai.usage.total_tokens': 300,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Flight search tool
    {
      traceId,
      spanId: 'span-003-flight',
      parentSpanId: 'span-003-booking',
      name: 'tools/call search_flights',
      startTime: new Date(baseTime + 5050).toISOString(),
      endTime: new Date(baseTime + 6500).toISOString(),
      duration: 1450,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_flights',
        'gen_ai.tool.args': '{"origin":"LAX","destination":"BKK","max_price":600,"class":"economy"}',
        'http.method': 'GET',
        'http.status_code': 200,
        'flights.results_count': 3,
      },
    },
    // Hostel search tool
    {
      traceId,
      spanId: 'span-003-hostel',
      parentSpanId: 'span-003-booking',
      name: 'tools/call search_hotels',
      startTime: new Date(baseTime + 6550).toISOString(),
      endTime: new Date(baseTime + 7400).toISOString(),
      duration: 850,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_hotels',
        'gen_ai.tool.args': '{"location":"Bangkok+Phuket","max_price_per_night":30,"type":"hostel"}',
        'http.method': 'GET',
        'http.status_code': 200,
        'hotels.results_count': 4,
      },
    },
    // Events Agent: free activities
    {
      traceId,
      spanId: 'span-003-events',
      parentSpanId: 'span-003-root',
      name: 'invoke_agent Events Agent',
      startTime: new Date(baseTime + 7600).toISOString(),
      endTime: new Date(baseTime + 10200).toISOString(),
      duration: 2600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Events Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Events LLM
    {
      traceId,
      spanId: 'span-003-events-llm',
      parentSpanId: 'span-003-events',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 7650).toISOString(),
      endTime: new Date(baseTime + 8300).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 160,
        'gen_ai.usage.output_tokens': 110,
        'gen_ai.usage.total_tokens': 270,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Events search tool
    {
      traceId,
      spanId: 'span-003-events-tool',
      parentSpanId: 'span-003-events',
      name: 'tools/call find_events',
      startTime: new Date(baseTime + 8350).toISOString(),
      endTime: new Date(baseTime + 10100).toISOString(),
      duration: 1750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'find_events',
        'gen_ai.tool.args': '{"locations":["Bangkok","Phuket"],"price_range":"free-cheap","categories":["temple","beach","market"]}',
        'events.results_count': 10,
      },
    },
    // Final LLM: assemble budget itinerary
    {
      traceId,
      spanId: 'span-003-llm-final',
      parentSpanId: 'span-003-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 10300).toISOString(),
      endTime: new Date(baseTime + 11900).toISOString(),
      duration: 1600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 1100,
        'gen_ai.usage.output_tokens': 900,
        'gen_ai.usage.total_tokens': 2000,
        'gen_ai.response.finish_reason': 'stop',
      },
    },
  ];
}

/**
 * Generate spans for Team Building Retreat (demo-report-004)
 *
 * Group logistics flow showing:
 * - Weather Agent for outdoor safety
 * - Booking Agent with group accommodation and catering
 * - Events Agent for team building activities
 * - Multiple tool calls for dietary accommodations
 */
function generateGroupRetreatSpans(): Span[] {
  const traceId = 'demo-trace-004';
  const baseTime = BASE_TIME + 3900000; // 65 minutes after first trace

  return [
    // Root span: Travel Coordinator
    {
      traceId,
      spanId: 'span-004-root',
      name: 'invoke_agent Travel Coordinator',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 16000).toISOString(),
      duration: 16000,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Travel Coordinator',
        'gen_ai.agent.type': 'orchestrator',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'user.query': 'Plan a 3-day team building retreat in Colorado for 12 people',
        'run.id': 'demo-agent-run-004',
      },
    },
    // Initial LLM reasoning
    {
      traceId,
      spanId: 'span-004-llm1',
      parentSpanId: 'span-004-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 1100).toISOString(),
      duration: 1050,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 420,
        'gen_ai.usage.output_tokens': 280,
        'gen_ai.usage.total_tokens': 700,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Weather Agent
    {
      traceId,
      spanId: 'span-004-weather',
      parentSpanId: 'span-004-root',
      name: 'invoke_agent Weather Agent',
      startTime: new Date(baseTime + 1200).toISOString(),
      endTime: new Date(baseTime + 3000).toISOString(),
      duration: 1800,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Weather Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Weather LLM
    {
      traceId,
      spanId: 'span-004-weather-llm',
      parentSpanId: 'span-004-weather',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 1250).toISOString(),
      endTime: new Date(baseTime + 1800).toISOString(),
      duration: 550,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 130,
        'gen_ai.usage.output_tokens': 90,
        'gen_ai.usage.total_tokens': 220,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Weather tool
    {
      traceId,
      spanId: 'span-004-weather-tool',
      parentSpanId: 'span-004-weather',
      name: 'tools/call get_weather_forecast',
      startTime: new Date(baseTime + 1850).toISOString(),
      endTime: new Date(baseTime + 2900).toISOString(),
      duration: 1050,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'get_weather_forecast',
        'gen_ai.tool.args': '{"location":"Estes Park, CO","dates":"Thursday-Sunday","detail":"outdoor_safety"}',
        'http.method': 'GET',
        'http.status_code': 200,
      },
    },
    // Booking Agent: group accommodation
    {
      traceId,
      spanId: 'span-004-booking',
      parentSpanId: 'span-004-root',
      name: 'invoke_agent Booking Agent',
      startTime: new Date(baseTime + 3100).toISOString(),
      endTime: new Date(baseTime + 8500).toISOString(),
      duration: 5400,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Booking Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Booking LLM
    {
      traceId,
      spanId: 'span-004-booking-llm',
      parentSpanId: 'span-004-booking',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 3150).toISOString(),
      endTime: new Date(baseTime + 3900).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 280,
        'gen_ai.usage.output_tokens': 190,
        'gen_ai.usage.total_tokens': 470,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Lodge search tool
    {
      traceId,
      spanId: 'span-004-lodge',
      parentSpanId: 'span-004-booking',
      name: 'tools/call search_hotels',
      startTime: new Date(baseTime + 3950).toISOString(),
      endTime: new Date(baseTime + 5500).toISOString(),
      duration: 1550,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_hotels',
        'gen_ai.tool.args': '{"location":"Estes Park, CO","guests":12,"type":"lodge","requirements":["meeting_room","kitchen","wifi"]}',
        'http.method': 'GET',
        'http.status_code': 200,
        'hotels.results_count': 3,
      },
    },
    // Catering arrangement tool
    {
      traceId,
      spanId: 'span-004-catering',
      parentSpanId: 'span-004-booking',
      name: 'tools/call arrange_catering',
      startTime: new Date(baseTime + 5600).toISOString(),
      endTime: new Date(baseTime + 7200).toISOString(),
      duration: 1600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'arrange_catering',
        'gen_ai.tool.args': '{"group_size":12,"meals":8,"dietary":{"vegetarian":3,"vegan":1,"gluten_free":1,"nut_allergy":1}}',
        'http.method': 'POST',
        'http.status_code': 201,
        'catering.confirmation': 'MFC-2024-ESTES-0447',
      },
    },
    // Flight search tool
    {
      traceId,
      spanId: 'span-004-flights',
      parentSpanId: 'span-004-booking',
      name: 'tools/call search_flights',
      startTime: new Date(baseTime + 7250).toISOString(),
      endTime: new Date(baseTime + 8400).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_flights',
        'gen_ai.tool.args': '{"origin":"AUS","destination":"DEN","passengers":12}',
        'http.method': 'GET',
        'http.status_code': 200,
        'flights.results_count': 4,
      },
    },
    // Events Agent: team building activities
    {
      traceId,
      spanId: 'span-004-events',
      parentSpanId: 'span-004-root',
      name: 'invoke_agent Events Agent',
      startTime: new Date(baseTime + 8600).toISOString(),
      endTime: new Date(baseTime + 12000).toISOString(),
      duration: 3400,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Events Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Events LLM
    {
      traceId,
      spanId: 'span-004-events-llm',
      parentSpanId: 'span-004-events',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 8650).toISOString(),
      endTime: new Date(baseTime + 9400).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 210,
        'gen_ai.usage.output_tokens': 150,
        'gen_ai.usage.total_tokens': 360,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Activities search tool
    {
      traceId,
      spanId: 'span-004-activities',
      parentSpanId: 'span-004-events',
      name: 'tools/call find_events',
      startTime: new Date(baseTime + 9450).toISOString(),
      endTime: new Date(baseTime + 11200).toISOString(),
      duration: 1750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'find_events',
        'gen_ai.tool.args': '{"location":"Estes Park, CO","group_size":12,"categories":["hiking","rafting","team-building","stargazing"]}',
        'events.results_count': 6,
      },
    },
    // Check availability tool
    {
      traceId,
      spanId: 'span-004-availability',
      parentSpanId: 'span-004-events',
      name: 'tools/call check_availability',
      startTime: new Date(baseTime + 11250).toISOString(),
      endTime: new Date(baseTime + 11900).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'check_availability',
        'gen_ai.tool.args': '{"activities":["guided_hike","rafting","aerial_adventure","stargazing"],"group_size":12}',
        'availability.all_confirmed': true,
      },
    },
    // Final LLM: assemble group itinerary
    {
      traceId,
      spanId: 'span-004-llm-final',
      parentSpanId: 'span-004-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 12100).toISOString(),
      endTime: new Date(baseTime + 15900).toISOString(),
      duration: 3800,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 1800,
        'gen_ai.usage.output_tokens': 1400,
        'gen_ai.usage.total_tokens': 3200,
        'gen_ai.response.finish_reason': 'stop',
      },
    },
  ];
}

/**
 * Generate spans for Last-Minute Holiday Deal (demo-report-005)
 *
 * Time-pressure booking flow showing:
 * - Booking Agent with last-minute deal search
 * - Weather Agent for quick verification
 * - Budget Agent for deal validation
 * - Sold-out handling (Turks & Caicos becomes unavailable)
 * - Failed to complete booking (the evaluation failure point)
 */
function generateLastMinuteSpans(): Span[] {
  const traceId = 'demo-trace-005';
  const baseTime = BASE_TIME + 4200000; // 70 minutes after first trace

  return [
    // Root span: Travel Coordinator
    {
      traceId,
      spanId: 'span-005-root',
      name: 'invoke_agent Travel Coordinator',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 11000).toISOString(),
      duration: 11000,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Travel Coordinator',
        'gen_ai.agent.type': 'orchestrator',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'user.query': 'Find a last-minute holiday deal for next weekend',
        'run.id': 'demo-agent-run-005',
      },
    },
    // Initial LLM reasoning
    {
      traceId,
      spanId: 'span-005-llm1',
      parentSpanId: 'span-005-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 800).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 310,
        'gen_ai.usage.output_tokens': 220,
        'gen_ai.usage.total_tokens': 530,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Booking Agent: last-minute deals
    {
      traceId,
      spanId: 'span-005-booking',
      parentSpanId: 'span-005-root',
      name: 'invoke_agent Booking Agent',
      startTime: new Date(baseTime + 900).toISOString(),
      endTime: new Date(baseTime + 4200).toISOString(),
      duration: 3300,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Booking Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Booking LLM
    {
      traceId,
      spanId: 'span-005-booking-llm',
      parentSpanId: 'span-005-booking',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 950).toISOString(),
      endTime: new Date(baseTime + 1600).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 190,
        'gen_ai.usage.output_tokens': 130,
        'gen_ai.usage.total_tokens': 320,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Last-minute deal search tool
    {
      traceId,
      spanId: 'span-005-deals',
      parentSpanId: 'span-005-booking',
      name: 'tools/call search_last_minute_deals',
      startTime: new Date(baseTime + 1650).toISOString(),
      endTime: new Date(baseTime + 4100).toISOString(),
      duration: 2450,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_last_minute_deals',
        'gen_ai.tool.args': '{"origin":"MIA","dates":"Friday-Sunday","type":"beach_package","max_price":1000}',
        'http.method': 'GET',
        'http.status_code': 200,
        'deals.results_count': 4,
        'deals.sold_out_during_search': 1,
      },
      events: [
        {
          name: 'deal_sold_out',
          time: new Date(baseTime + 3500).toISOString(),
          attributes: {
            'destination': 'Turks & Caicos',
            'original_price': 950,
            'status': 'SOLD_OUT',
          },
        },
      ],
    },
    // Weather Agent: verify destinations
    {
      traceId,
      spanId: 'span-005-weather',
      parentSpanId: 'span-005-root',
      name: 'invoke_agent Weather Agent',
      startTime: new Date(baseTime + 4300).toISOString(),
      endTime: new Date(baseTime + 6200).toISOString(),
      duration: 1900,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Weather Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Weather LLM
    {
      traceId,
      spanId: 'span-005-weather-llm',
      parentSpanId: 'span-005-weather',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 4350).toISOString(),
      endTime: new Date(baseTime + 4900).toISOString(),
      duration: 550,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 140,
        'gen_ai.usage.output_tokens': 100,
        'gen_ai.usage.total_tokens': 240,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Weather tool for multiple destinations
    {
      traceId,
      spanId: 'span-005-weather-tool',
      parentSpanId: 'span-005-weather',
      name: 'tools/call get_weather_forecast',
      startTime: new Date(baseTime + 4950).toISOString(),
      endTime: new Date(baseTime + 6100).toISOString(),
      duration: 1150,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'get_weather_forecast',
        'gen_ai.tool.args': '{"locations":["Cancun","Nassau","Key West"],"dates":"Friday-Sunday"}',
        'http.method': 'GET',
        'http.status_code': 200,
      },
    },
    // Budget Agent: validate deals
    {
      traceId,
      spanId: 'span-005-budget',
      parentSpanId: 'span-005-root',
      name: 'invoke_agent Budget Agent',
      startTime: new Date(baseTime + 6300).toISOString(),
      endTime: new Date(baseTime + 8800).toISOString(),
      duration: 2500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Budget Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Budget LLM
    {
      traceId,
      spanId: 'span-005-budget-llm',
      parentSpanId: 'span-005-budget',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 6350).toISOString(),
      endTime: new Date(baseTime + 7100).toISOString(),
      duration: 750,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 250,
        'gen_ai.usage.output_tokens': 180,
        'gen_ai.usage.total_tokens': 430,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Deal validation tool
    {
      traceId,
      spanId: 'span-005-validate',
      parentSpanId: 'span-005-budget',
      name: 'tools/call validate_deal_pricing',
      startTime: new Date(baseTime + 7150).toISOString(),
      endTime: new Date(baseTime + 8700).toISOString(),
      duration: 1550,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'validate_deal_pricing',
        'gen_ai.tool.args': '{"deals":[{"destination":"Cancun","price":689},{"destination":"Nassau","price":725},{"destination":"Key West","price":420}]}',
        'http.method': 'POST',
        'http.status_code': 200,
        'deals.genuine_savings': true,
      },
    },
    // Final LLM: comparison and recommendation (but fails to actually book)
    {
      traceId,
      spanId: 'span-005-llm-final',
      parentSpanId: 'span-005-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 8900).toISOString(),
      endTime: new Date(baseTime + 10900).toISOString(),
      duration: 2000,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 950,
        'gen_ai.usage.total_tokens': 2150,
        'gen_ai.response.finish_reason': 'stop',
      },
    },
  ];
}

/**
 * Generate spans for Budget Southeast Asia - Vietnam Route (demo-report-003b)
 *
 * Same use-case as demo-trace-003 but evaluated in the Advanced Benchmark run.
 * The agent picks Vietnam over Thailand for better cost savings, producing a
 * slightly shorter trace with fewer tool calls.
 */
function generateBudgetTripVietnamSpans(): Span[] {
  const traceId = 'demo-trace-003b';
  const baseTime = BASE_TIME + 3600000; // 60 minutes after first trace

  return [
    // Root span: Travel Coordinator
    {
      traceId,
      spanId: 'span-003b-root',
      name: 'invoke_agent Travel Coordinator',
      startTime: new Date(baseTime).toISOString(),
      endTime: new Date(baseTime + 9500).toISOString(),
      duration: 9500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Travel Coordinator',
        'gen_ai.agent.type': 'orchestrator',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'user.query': 'Plan a budget-friendly 5-day trip to Southeast Asia for under $1500 total',
        'run.id': 'demo-agent-run-003b',
      },
    },
    // Initial LLM reasoning
    {
      traceId,
      spanId: 'span-003b-llm1',
      parentSpanId: 'span-003b-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 50).toISOString(),
      endTime: new Date(baseTime + 900).toISOString(),
      duration: 850,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 280,
        'gen_ai.usage.output_tokens': 195,
        'gen_ai.usage.total_tokens': 475,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Budget Agent: destination comparison
    {
      traceId,
      spanId: 'span-003b-budget',
      parentSpanId: 'span-003b-root',
      name: 'invoke_agent Budget Agent',
      startTime: new Date(baseTime + 950).toISOString(),
      endTime: new Date(baseTime + 3800).toISOString(),
      duration: 2850,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Budget Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Budget Agent LLM
    {
      traceId,
      spanId: 'span-003b-budget-llm',
      parentSpanId: 'span-003b-budget',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 1000).toISOString(),
      endTime: new Date(baseTime + 1700).toISOString(),
      duration: 700,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 195,
        'gen_ai.usage.output_tokens': 145,
        'gen_ai.usage.total_tokens': 340,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Destination cost comparison tool
    {
      traceId,
      spanId: 'span-003b-budget-tool',
      parentSpanId: 'span-003b-budget',
      name: 'tools/call compare_destination_costs',
      startTime: new Date(baseTime + 1750).toISOString(),
      endTime: new Date(baseTime + 3700).toISOString(),
      duration: 1950,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'compare_destination_costs',
        'gen_ai.tool.args': '{"destinations":["Thailand","Vietnam","Cambodia"],"budget":1500,"duration":5}',
        'http.method': 'GET',
        'http.status_code': 200,
        'comparison.winner': 'Vietnam',
      },
    },
    // Booking Agent: budget flights to Vietnam
    {
      traceId,
      spanId: 'span-003b-booking',
      parentSpanId: 'span-003b-root',
      name: 'invoke_agent Booking Agent',
      startTime: new Date(baseTime + 3900).toISOString(),
      endTime: new Date(baseTime + 6800).toISOString(),
      duration: 2900,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.agent.name': 'Booking Agent',
        'gen_ai.agent.type': 'specialist',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
      },
    },
    // Booking LLM
    {
      traceId,
      spanId: 'span-003b-booking-llm',
      parentSpanId: 'span-003b-booking',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 3950).toISOString(),
      endTime: new Date(baseTime + 4600).toISOString(),
      duration: 650,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 175,
        'gen_ai.usage.output_tokens': 120,
        'gen_ai.usage.total_tokens': 295,
        'gen_ai.response.finish_reason': 'tool_calls',
      },
    },
    // Flight search tool: LAX -> SGN (Ho Chi Minh City)
    {
      traceId,
      spanId: 'span-003b-flight',
      parentSpanId: 'span-003b-booking',
      name: 'tools/call search_flights',
      startTime: new Date(baseTime + 4650).toISOString(),
      endTime: new Date(baseTime + 6100).toISOString(),
      duration: 1450,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_flights',
        'gen_ai.tool.args': '{"origin":"LAX","destination":"SGN","max_price":600,"class":"economy"}',
        'http.method': 'GET',
        'http.status_code': 200,
        'flights.results_count': 3,
      },
    },
    // Budget hotel search: Ho Chi Minh City
    {
      traceId,
      spanId: 'span-003b-hotel',
      parentSpanId: 'span-003b-booking',
      name: 'tools/call search_hotels',
      startTime: new Date(baseTime + 6150).toISOString(),
      endTime: new Date(baseTime + 6750).toISOString(),
      duration: 600,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.tool.name': 'search_hotels',
        'gen_ai.tool.args': '{"location":"Ho Chi Minh City+Da Nang","max_price_per_night":18,"type":"guesthouse"}',
        'http.method': 'GET',
        'http.status_code': 200,
        'hotels.results_count': 4,
      },
    },
    // Final LLM: assemble Vietnam itinerary
    {
      traceId,
      spanId: 'span-003b-llm-final',
      parentSpanId: 'span-003b-root',
      name: 'chat claude-sonnet-4',
      startTime: new Date(baseTime + 6900).toISOString(),
      endTime: new Date(baseTime + 9400).toISOString(),
      duration: 2500,
      status: 'OK',
      attributes: {
        'service.name': 'travel-planner',
        'gen_ai.system': 'openai',
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'claude-sonnet-4-20250514',
        'gen_ai.usage.input_tokens': 920,
        'gen_ai.usage.output_tokens': 760,
        'gen_ai.usage.total_tokens': 1680,
        'gen_ai.response.finish_reason': 'stop',
      },
    },
  ];
}

/**
 * All sample trace spans
 */
export const SAMPLE_TRACE_SPANS: Span[] = [
  ...generateWeekendTripSpans(),
  ...generateJapanTripSpans(),
  ...generateBudgetTripSpans(),
  ...generateBudgetTripVietnamSpans(),
  ...generateGroupRetreatSpans(),
  ...generateLastMinuteSpans(),
];

/**
 * Get sample spans for a specific run ID (via agent run ID in attributes)
 */
export function getSampleSpansForRunId(runId: string): Span[] {
  return SAMPLE_TRACE_SPANS.filter(span => span.attributes['run.id'] === runId);
}

/**
 * Get sample spans for multiple run IDs.
 *
 * Finds the traceIds of all spans matching the given run IDs, then returns
 * the full set of spans for those traces (not just the root span).
 * Only the root span of each trace carries the `run.id` attribute, so a
 * two-step lookup is needed to recover all child spans.
 */
export function getSampleSpansForRunIds(runIds: string[]): Span[] {
  if (!runIds || runIds.length === 0) return [];
  // Step 1: collect traceIds whose root span matches a requested runId
  const matchingTraceIds = new Set(
    SAMPLE_TRACE_SPANS
      .filter(span => span.attributes?.['run.id'] && runIds.includes(span.attributes['run.id']))
      .map(span => span.traceId)
  );
  // Step 2: return every span that belongs to those traces
  return SAMPLE_TRACE_SPANS.filter(span => matchingTraceIds.has(span.traceId));
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
 * Get all sample trace spans with timestamps shifted to recent times.
 *
 * Groups spans by traceId and shifts each group so that traces are spread
 * across the last 2 hours (~20 min apart). Relative ordering and durations
 * within each trace are preserved.
 */
export function getAllSampleTraceSpansWithRecentTimestamps(): Span[] {
  // Group spans by traceId
  const groups = new Map<string, Span[]>();
  for (const span of SAMPLE_TRACE_SPANS) {
    const group = groups.get(span.traceId);
    if (group) {
      group.push(span);
    } else {
      groups.set(span.traceId, [span]);
    }
  }

  const now = Date.now();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const traceIds = [...groups.keys()];
  const groupCount = traceIds.length;
  // Spread groups evenly across the last 2 hours
  const intervalMs = groupCount > 1 ? TWO_HOURS_MS / (groupCount - 1) : 0;

  const result: Span[] = [];

  for (let i = 0; i < traceIds.length; i++) {
    const spans = groups.get(traceIds[i])!;

    // Find earliest start time in this group
    const earliestStart = Math.min(
      ...spans.map(s => new Date(s.startTime).getTime())
    );

    // Target start: spread from (now - 2h) to now
    const targetStart = now - TWO_HOURS_MS + i * intervalMs;
    const offset = targetStart - earliestStart;

    for (const span of spans) {
      const newStartTime = new Date(new Date(span.startTime).getTime() + offset).toISOString();
      const newEndTime = new Date(new Date(span.endTime).getTime() + offset).toISOString();

      const shifted: Span = {
        ...span,
        startTime: newStartTime,
        endTime: newEndTime,
        // Shift event timestamps too
        ...(span.events && {
          events: span.events.map(e => ({
            ...e,
            time: new Date(new Date(e.time).getTime() + offset).toISOString(),
          })),
        }),
      };
      result.push(shifted);
    }
  }

  return result;
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
