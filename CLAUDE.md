# Cartograph Backend — Development Context

Handoff spec for the backend code agent. Describes the service, its API contract, and the static-analysis extractor architecture.

---

## 1. Service overview

**Cartograph** is an **engineering knowledge graph** backend — a dev-tool that analyzes a GitHub repository of Spring Boot microservices and extracts its architecture in static code.

### What it does
- **Receives** a repo URL, branch, and scan scope (list of directories/modules to analyze)
- **Extracts** the microservice architecture: services (Spring Boot app modules), dependencies (REST calls via Feign/WebClient/RestTemplate, Kafka topics via `@KafkaListener` / `KafkaTemplate`), and contracts (REST endpoint signatures, Kafka message schemas)
- **Reports** all findings with **confidence levels** — distinguished between **confirmed** (declared in code, e.g. `@FeignClient`), **likely** (inferred from config, e.g. WebClient with base URL from properties), and **uncertain** (guessed at runtime, e.g. RestTemplate to a variable host)
- **Tracks changes** via commit diffs — what architectural changes did each commit introduce (added/removed/changed dependencies, new contracts, confidence shifts)
- **Persists** the graph and serves it to the frontend via REST APIs

### Core principle: honesty about detection

Static analysis has limits. The backend **never hides uncertainty**; instead, it:
- Marks every edge/contract with its **confidence level** and **source** (where detection came from)
- Flags **unresolved targets** (a call to a hostname that doesn't match any scanned service, or a config URL that can't be resolved)
- **Never invents** — if a relationship can't be detected or confirmed, it's recorded as uncertain or omitted, not fabricated
- Treats the graph as **factual only** — no "severity" or "breaking-change" judgments are made by the backend; judgment is left to the frontend or the user

---

## 2. API contract (from UI agent)

The UI expects a RESTful API with the following endpoints. All data is time-indexed (can be queried at a specific commit SHA). The API is **read-only** from the UI perspective.

### 2.1 GET `/api/graph`
**Returns the current microservice architecture graph.**

**Query params:**
- `repo` (required, string) — GitHub repo URL, e.g. `acme/shop-platform`
- `branch` (default `main`, string) — branch name
- `at` (optional, string) — commit SHA. If omitted, returns the current head

**Response:**
```json
{
  "nodes": [
    {
      "id": "PaymentService",
      "name": "PaymentService",
      "team": "payments",
      "type": "service",
      "note": null,
      "deg": 12,
      "inDeg": 8,
      "outDeg": 4
    },
    {
      "id": "StripeAPI",
      "name": "StripeAPI",
      "type": "external",
      "note": null,
      "deg": 2
    },
    {
      "id": "http://pricing-svc:8080/{?}",
      "name": "http://pricing-svc:8080/{?}",
      "type": "unknown",
      "note": "Target host resolved from a variable at runtime — path shape is known, service identity is not.",
      "deg": 1
    }
  ],
  "edges": [
    {
      "id": "e0",
      "from": "CheckoutOrchestrator",
      "to": "PaymentService",
      "protocol": "rest",
      "method": "FeignClient",
      "confidence": "confirmed",
      "label": "POST /payments"
    },
    {
      "id": "e1",
      "from": "PaymentService",
      "to": "StripeAPI",
      "protocol": "rest",
      "method": "WebClient",
      "confidence": "likely",
      "label": "POST /v1/charges"
    },
    {
      "id": "e2",
      "from": "OrderService",
      "to": "OrderCreated",
      "protocol": "kafka",
      "method": "@KafkaListener",
      "confidence": "confirmed",
      "label": "OrderCreated"
    }
  ],
  "teams": [
    {
      "id": "payments",
      "name": "Payments",
      "tier": 2,
      "hue": 150
    }
  ],
  "meta": {
    "scannedAt": "2024-07-13T14:22:01Z",
    "commit": "a3f19c2",
    "branch": "main",
    "serviceCount": 92,
    "depCount": 189
  }
}
```

**Node types:**
- `service` — a Spring Boot microservice (module/app in the monorepo)
- `external` — third-party API (Stripe, Twilio, etc.)
- `unknown` — unresolved target (can't resolve to a scanned service; runtime URL, legacy host, etc.)

**Edge confidence levels:**
- `confirmed` — declared in code (@FeignClient, registered KafkaTemplate, etc.)
- `likely` — inferred (WebClient with base URL from properties, code-detected but config-resolved)
- `uncertain` — guessed (RestTemplate to variable host, topic with no producer, etc.)

**Edge protocols:** `rest` or `kafka`

**Edge methods (REST):** `FeignClient`, `WebClient`, `RestTemplate`, `route` (for API Gateway)

**Edge methods (Kafka):** `@KafkaListener`, `KafkaTemplate`

---

### 2.2 GET `/api/contracts`
**Returns all REST endpoints and Kafka topics detected in the graph.**

**Query params:**
- `repo` (required)
- `branch` (default `main`)
- `at` (optional, commit SHA)
- `protocol` (optional, `rest` or `kafka`) — filter by protocol

**Response:**
```json
{
  "endpoints": [
    {
      "id": "ep0",
      "kind": "rest",
      "service": "PaymentService",
      "verb": "POST",
      "path": "/payments",
      "source": "in-code DTO (Feign)",
      "confidence": "confirmed",
      "method": "FeignClient",
      "unresolved": false,
      "callers": ["CheckoutOrchestrator", "RefundService"],
      "request": [
        { "name": "orderId", "type": "UUID", "nullable": false, "note": null },
        { "name": "amount", "type": "decimal", "nullable": false, "note": null },
        { "name": "currency", "type": "string(3)", "nullable": false, "note": null }
      ],
      "response": [
        { "name": "paymentId", "type": "UUID", "nullable": false, "note": null },
        { "name": "status", "type": "enum(AUTHORIZED,CAPTURED,FAILED)", "nullable": false, "note": null },
        { "name": "gatewayRef", "type": "string", "nullable": true, "note": null }
      ]
    }
  ],
  "topics": [
    {
      "id": "tp0",
      "kind": "kafka",
      "topic": "OrderCreated",
      "producer": "OrderService",
      "source": "Schema Registry (Avro)",
      "confidence": "confirmed",
      "consumers": ["StockReservationService", "NotificationService", "AnalyticsIngestService"],
      "message": [
        { "name": "orderId", "type": "UUID", "nullable": false, "note": null },
        { "name": "customerId", "type": "UUID", "nullable": false, "note": null },
        { "name": "couponCode", "type": "string", "nullable": true, "note": "added in c98d0aa" }
      ]
    }
  ]
}
```

**Contract source types:**
- `in-code DTO (Feign)` — request/response types inferred from Feign client interface
- `in-code DTO (WebClient)` — inferred from WebClient call sites
- `in-code (RestTemplate)` — RestTemplate call, shape uncertain
- `OpenAPI spec` — from @OpenAPI annotation or external spec file
- `in-code (shape unresolved)` — target is unresolved, so schema is best-effort
- `Schema Registry (Avro)` — Kafka topic schema from registry
- `no registered schema` — Kafka topic detected, no schema found

---

### 2.3 GET `/api/diffs`
**Returns architectural changes by commit.**

**Query params:**
- `repo` (required)
- `branch` (default `main`)
- `since` (optional, commit SHA) — return commits after this one; if omitted, returns last N commits
- `limit` (optional, int, default 20) — max commits to return

**Response:**
```json
{
  "commits": [
    {
      "sha": "a3f19c2",
      "author": {
        "name": "Priya Nair",
        "handle": "priyan",
        "email": "priyan@acme.com",
        "initials": "PN",
        "hue": 262
      },
      "message": "checkout: apply basket-level promotions",
      "when": "2024-07-13T12:30:00Z",
      "pr": "#1847",
      "branch": "feat/basket-promos",
      "changes": [
        {
          "op": "add",
          "kind": "dependency",
          "from": "CheckoutOrchestrator",
          "to": "PromotionService",
          "protocol": "rest",
          "confidence": "likely",
          "contract": "POST /promotions/apply",
          "detail": "New WebClient call — target resolved from a base-URL property, so recorded as likely."
        },
        {
          "op": "add",
          "kind": "endpoint",
          "from": "PromotionService",
          "to": null,
          "protocol": "rest",
          "confidence": "likely",
          "contract": "POST /promotions/apply",
          "detail": "Endpoint first seen this commit."
        }
      ]
    }
  ]
}
```

**Change ops:**
- `add` — new edge, endpoint, topic, or schema field
- `remove` — deleted edge, endpoint, topic
- `change` — modified (e.g., endpoint path changed, schema field type changed)
- `confidence` — confidence level of an edge increased/decreased (e.g., likely → confirmed when code was refactored to use declared Feign client)

**Change kinds:**
- `dependency` — edge between two services (REST or Kafka)
- `endpoint` — new REST endpoint exposed by a service
- `topic` — new Kafka topic produced/consumed
- `schema` — schema modification (e.g., field added to a contract)

**Detail:** factual, single-sentence explanation of the change. **Never includes breaking-change judgments.**

---

### 2.4 GET `/api/schema/:contractId`
**Returns the full schema for a contract (REST endpoint or Kafka topic).**

**Params:**
- `contractId` (required) — the contract ID from `/api/contracts`

**Query params:**
- `repo` (required)
- `branch` (default `main`)
- `at` (optional, commit SHA)

**Response:**
```json
{
  "id": "ep0",
  "kind": "rest",
  "service": "PaymentService",
  "verb": "POST",
  "path": "/payments",
  "source": "in-code DTO (Feign)",
  "confidence": "confirmed",
  "method": "FeignClient",
  "unresolved": false,
  "callers": ["CheckoutOrchestrator", "RefundService"],
  "request": [
    { "name": "orderId", "type": "UUID", "nullable": false, "note": null },
    { "name": "amount", "type": "decimal", "nullable": false, "note": null },
    { "name": "currency", "type": "string(3)", "nullable": false, "note": null },
    { "name": "method", "type": "enum(CARD,WALLET,GIFT_CARD)", "nullable": false, "note": null },
    { "name": "idempotencyKey", "type": "string", "nullable": false, "note": null }
  ],
  "response": [
    { "name": "paymentId", "type": "UUID", "nullable": false, "note": null },
    { "name": "status", "type": "enum(AUTHORIZED,CAPTURED,FAILED)", "nullable": false, "note": null },
    { "name": "authorizedAt", "type": "timestamp", "nullable": true, "note": null },
    { "name": "gatewayRef", "type": "string", "nullable": true, "note": null }
  ],
  "history": [
    { "op": "add", "sha": "a1b2c3d", "when": "2024-07-10T08:00:00Z", "detail": "Endpoint first seen." },
    { "op": "change", "sha": "b2c3d4e", "when": "2024-07-12T14:22:00Z", "detail": "Field added: idempotencyKey : string" }
  ]
}
```

---

### 2.5 GET `/api/services/:serviceName`
**Returns details about a single service.**

**Params:**
- `serviceName` (required) — service name, e.g. `PaymentService`

**Query params:**
- `repo` (required)
- `branch` (default `main`)
- `at` (optional, commit SHA)

**Response:**
```json
{
  "id": "PaymentService",
  "name": "PaymentService",
  "team": "payments",
  "type": "service",
  "note": null,
  "deg": 12,
  "inDeg": 8,
  "outDeg": 4,
  "inbound": [
    { "from": "CheckoutOrchestrator", "protocol": "rest", "method": "FeignClient", "confidence": "confirmed", "label": "POST /payments" },
    { "from": "RefundService", "protocol": "rest", "method": "FeignClient", "confidence": "confirmed", "label": "POST /payments/{id}/refund" }
  ],
  "outbound": [
    { "to": "FraudCheckService", "protocol": "rest", "method": "FeignClient", "confidence": "confirmed", "label": "POST /fraud/check" },
    { "to": "StripeAPI", "protocol": "rest", "method": "WebClient", "confidence": "likely", "label": "POST /v1/charges" }
  ],
  "endpoints": [
    { "id": "ep0", "verb": "POST", "path": "/payments", "confidence": "confirmed", "callers": 2 },
    { "id": "ep1", "verb": "GET", "path": "/payments/{id}", "confidence": "confirmed", "callers": 1 }
  ],
  "produced_topics": [
    { "id": "tp0", "topic": "PaymentAuthorized", "confidence": "confirmed", "consumers": 3 },
    { "id": "tp1", "topic": "PaymentCaptured", "confidence": "confirmed", "consumers": 2 },
    { "id": "tp2", "topic": "PaymentFailed", "confidence": "confirmed", "consumers": 3 }
  ],
  "consumed_topics": []
}
```

---

### 2.6 POST `/api/scan`
**Triggers a new scan of a repository.**

**Request body:**
```json
{
  "repo": "acme/shop-platform",
  "branch": "main",
  "scanScope": [
    "services/",
    "libs/",
    "infrastructure/"
  ],
  "excludePaths": [
    "**/test/",
    "**/target/",
    "**/.git/"
  ]
}
```

**Response:**
```json
{
  "scanId": "scan_abc123",
  "status": "queued",
  "repo": "acme/shop-platform",
  "branch": "main",
  "queuedAt": "2024-07-13T14:30:00Z",
  "estimatedDuration": "5m"
}
```

The scan runs asynchronously. Frontend can poll `/api/scan/:scanId` to check progress.

---

### 2.7 GET `/api/scan/:scanId`
**Poll the status of a scan.**

**Response (in progress):**
```json
{
  "scanId": "scan_abc123",
  "status": "in_progress",
  "progress": {
    "phase": "extracting_kafka",
    "current": 45,
    "total": 92,
    "percent": 49
  },
  "startedAt": "2024-07-13T14:30:15Z"
}
```

**Response (complete):**
```json
{
  "scanId": "scan_abc123",
  "status": "complete",
  "repo": "acme/shop-platform",
  "branch": "main",
  "commit": "a3f19c2",
  "completedAt": "2024-07-13T14:35:42Z",
  "duration": "5m 27s",
  "results": {
    "services": 92,
    "dependencies": 189,
    "endpoints": 134,
    "topics": 21,
    "unresolved": 5
  }
}
```

---

## 3. Extractor architecture

The extractor is the heart of the system. It's a **static code analysis engine** that walks a git repo and extracts the microservice graph.

### 3.1 High-level flow

```
Git repo (clone / fetch)
  ↓
Scanner: discover Spring Boot modules + main classes
  ↓
Parser: analyze each module's code
  ├─ Extract REST endpoints (@RestController, @RequestMapping, @GetMapping/@PostMapping/etc.)
  ├─ Extract REST callers (Feign clients, WebClient calls, RestTemplate calls)
  ├─ Extract Kafka producers (KafkaTemplate calls) + consumers (@KafkaListener)
  ├─ Parse request/response body types (from DTO classes, @RequestBody/@ResponseBody)
  ├─ Resolve Kafka schemas (Schema Registry, Avro, or infer from code)
  └─ Assign confidence levels based on how the call was detected
  ↓
Graph builder: merge all findings into nodes/edges
  ├─ Deduplicate (same endpoint detected multiple times = one node)
  ├─ Resolve targets (does a call to hostname X match any scanned service?)
  ├─ Compute statistics (degree, team assignment)
  └─ Identify unknowns (unresolved targets, runtime URLs, etc.)
  ↓
Diff engine: compare against previous scan
  ├─ Identify added/removed/changed edges, endpoints, topics, schemas
  ├─ Track which commits introduced each change
  └─ Record confidence shifts
  ↓
Persist: store graph + commit history in DB
  ↓
API: serve via REST endpoints
```

### 3.2 Confidence levels and detection methods

| Confidence | Detection method | REST examples | Kafka examples |
|---|---|---|---|
| **confirmed** | Declared in code with a target | `@FeignClient(name="PaymentService")` interface + call site | `KafkaTemplate.send("topic")` with hardcoded topic; `@KafkaListener(topics="...")` |
| **likely** | Inferred from config; code-detected but URL resolved from properties | `WebClient.create(baseUrl)` where `baseUrl = env.getProperty(...)` | Code-detected listener, but topic name from config property |
| **uncertain** | Guessed; runtime variable or can't resolve target | `RestTemplate.postForObject(url, ...)` where `url` is a method arg | Topic consumed but no producer found; no schema registered |

### 3.3 Key analyzer components

#### **REST Endpoint Analyzer**
- Walks code for `@RestController`, `@RequestMapping`, `@GetMapping`, `@PostMapping`, etc.
- For each endpoint: extract verb (GET/POST/PUT/DELETE), path, request/response body types
- Resolve body types by walking the DTO class hierarchy (field names, types, nullable modifiers like `@Nullable`, `Optional<T>`)
- Source attribution: if the class has an `@FeignClient` interface (indicating it's consumed by others), mark as `in-code DTO (Feign)`. If there's an `@OpenAPI` annotation, mark as `OpenAPI spec`.

#### **REST Caller Analyzer**
- Scans for `@FeignClient` interface definitions → confirmed caller (declared target)
- Scans for `WebClient.create(url)` / `WebClient.builder()` calls → likely (URL may be from config)
- Scans for `RestTemplate` calls → uncertain (URL often from variable/config at runtime)
- Extracts endpoint label (verb + path) by pattern-matching the call (e.g., `client.getForObject(path, ...)` → GET, etc.)

#### **Kafka Analyzer**
- Scans for `KafkaTemplate` usages → producer. Extracts topic name and message type (from the generic param `<String, MessageType>` or from the template call).
- Scans for `@KafkaListener(topics="...")` annotations → consumer. Extracts topic name and message type.
- **Producer confidence**: if the message type is registered in Schema Registry (Avro), mark as confirmed. Otherwise likely.
- **Consumer confidence**: if the topic has a registered producer and schema, mark as confirmed. If no producer found, mark as uncertain.
- Resolves message schemas via Schema Registry API (if available) or infers from code (message class DTO).

#### **Target Resolver**
- For each edge, attempt to resolve the target hostname/service name to a scanned Spring Boot service
- Heuristics:
  - Direct service name match (e.g., `PaymentService` → found in repo) → confirmed
  - Hostname with known pattern (e.g., `payment-service.dev.svc.cluster.local` → `PaymentService`) → likely
  - Config property (e.g., `spring.payment.url = ...`) → resolve at scan time; if resolved to a scanned service, likely; if not, uncertain
  - Variable/runtime URL → uncertain, record as `unknown` node with a note
- External APIs (known third-party domains like `stripe.com`, `api.twilio.com`) → mark as `external` type
- Unresolved targets → mark as `unknown` type with a descriptive note

#### **Schema Induction**
- For REST: walk the DTO class (request/response types), extract all fields with their types and nullability (from `@Nullable`, `Optional`, `@NotNull`)
- For Kafka: same process on the message DTO
- **Type inference**: detect common types (`UUID`, `BigDecimal`, enums, arrays, nested objects) and render as strings (e.g., `array<LineItem>`, `enum(PENDING,PAID,SHIPPED)`)
- **Field notes**: if a field was added/removed/changed in a recent commit, attach a note linking to the commit SHA (e.g., `"added in c98d0aa"`)

### 3.4 Commit diff engine

Runs after each scan. Compares the new graph against the previous one:

```
For each edge/endpoint/topic:
  If it exists in previous but not new → op: 'remove'
  If it exists in new but not previous → op: 'add'
  If it exists in both:
    If target changed (e.g., host name different) → op: 'change'
    If confidence increased (e.g., likely → confirmed) → op: 'confidence'
    If schema changed (field added/removed/type changed) → op: 'change' with detail
```

For each commit between the previous scan and now, attribute the change:
```
git log <prevSha>..<newSha> --oneline
For each commit:
  diff the graph state before/after the commit
  Record which edges/contracts/fields were added/removed/changed
  Store as a change record with the commit SHA, author, message
```

---

## 4. Data model (database)

The backend persists:
- **Graphs**: keyed by `(repo, branch, commit_sha)`. Immutable — once stored, never modified.
- **Contracts** (endpoints + topics): indexed by graph, keyed by contract ID
- **Commits**: indexed by graph, keyed by SHA. Includes change records.
- **Schemas**: versioned by commit. Each field carries a note about when it was added/changed.

Example schema (PostgreSQL):
```sql
CREATE TABLE graphs (
  id UUID PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha VARCHAR(40) NOT NULL,
  scanned_at TIMESTAMP NOT NULL,
  data JSONB NOT NULL,  -- the full graph (nodes, edges, teams)
  UNIQUE(repo, branch, commit_sha)
);

CREATE TABLE commits (
  id UUID PRIMARY KEY,
  graph_id UUID NOT NULL REFERENCES graphs(id),
  commit_sha VARCHAR(40) NOT NULL,
  author_name TEXT NOT NULL,
  author_email TEXT NOT NULL,
  message TEXT NOT NULL,
  pr TEXT,
  branch TEXT,
  when TIMESTAMP NOT NULL,
  changes JSONB NOT NULL,  -- array of change records
  FOREIGN KEY (graph_id) REFERENCES graphs(id)
);

CREATE TABLE contracts (
  id UUID PRIMARY KEY,
  graph_id UUID NOT NULL REFERENCES graphs(id),
  kind TEXT NOT NULL,  -- 'rest' or 'kafka'
  data JSONB NOT NULL,  -- the contract object
  FOREIGN KEY (graph_id) REFERENCES graphs(id)
);

CREATE TABLE scans (
  id UUID PRIMARY KEY,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL,  -- 'queued', 'in_progress', 'complete', 'failed'
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  results JSONB,  -- {services, dependencies, endpoints, topics, unresolved}
  error TEXT
);
```

---

## 5. Technology choices

- **Language**: Java (Spring Boot microservice itself) or Go (lightweight scanner/extractor)
- **Parsing**: use existing static-analysis libraries (e.g., JavaParser for Java, go/ast for Go)
- **Schema Registry**: Confluent Schema Registry API for Kafka schema resolution
- **Git**: `git clone` / `git fetch` to local disk, analyze in-place
- **Database**: PostgreSQL for persistence (graphs, commits, contracts)
- **API**: Spring Boot REST controllers

---

## 6. Invariants — do not break

- **Every edge must have a confidence level.** Never infer without marking the level.
- **Unresolved targets stay visible.** If a call can't be resolved to a scanned service, create an `unknown` node with a descriptive note; never drop it.
- **No breaking-change judgments.** The extractor is factual only. All text in the API is neutral and educational, never pejorative.
- **Contracts are versioned by commit.** Each schema/field change is tracked and linked to the commit that introduced it.
- **Sources are recorded.** Every contract must carry a `source` field explaining where the schema came from (code DTO, OpenAPI spec, Schema Registry, etc.).
- **Derived vs. declared.** REST callers are "derived" from callers' code, not declared by the service. Kafka consumers are likewise derived. Always use this wording in the API to be clear.

