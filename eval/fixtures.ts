/**
 * Hand-curated (CV, JD) fixtures for the question-generation eval harness.
 *
 * Each fixture exercises the two-phase pipeline (generatePartitionedQuestions
 * → regroundPartitionedQuestions) and gets scored by eval/scorers.ts. The
 * cv text is intentionally seeded with named entities (companies, projects,
 * specific tech) so the regrounding pass has concrete anchor points; the
 * grounding-rate scorer fails if the LLM hallucinates references that don't
 * appear in the cv.
 *
 * To add a fixture:
 *   1. Append an entry below with a unique kebab-case `id`.
 *   2. The cv text should contain at least 4-6 distinguishing named entities.
 *   3. Run `npm run eval:baseline` to record its initial scores.
 */

import type { InterviewLevel } from "./types";

export interface Fixture {
  id: string;
  role: string;
  level: InterviewLevel;
  jobDescription: string;
  cvText: string;
}

export const FIXTURES: Fixture[] = [
  {
    id: "backend-sre-senior",
    role: "Senior Backend SRE",
    level: "Senior",
    jobDescription: `
We are hiring a Senior Backend SRE for our payments platform. You will own
incident response, capacity planning, and reliability engineering for a
fleet of Go and Python services running on Kubernetes (EKS). Strong systems
fundamentals — Linux internals, TCP/IP, distributed consensus — are
expected. You will design SLOs, lead postmortems, and own the on-call
rotation. Familiarity with multi-region active-active deployments and
chaos engineering practices is highly valued.`,
    cvText: `
Arjun Mehta — Senior SRE
Razorpay (2021-present): Reduced payment-gateway p99 latency from 380ms to
  140ms by sharding the Redis-backed idempotency store across 4 regions.
  Led the response to the Aug-2023 multi-region failover incident; authored
  the postmortem (root cause: stale Consul DNS TTLs).
Cred (2019-2021): Built the on-call rotation tooling on top of PagerDuty
  with a custom Slack bot for incident command. Migrated 60+ services from
  Mesos to EKS. Owned the chaos-monkey-style fault injection program.
Skills: Go, Python, Kubernetes (EKS), Terraform, Consul, Envoy, Prometheus,
  Grafana, Jaeger, eBPF (Cilium), Linux performance tuning.`,
  },

  {
    id: "ml-recsys-mid",
    role: "Machine Learning Engineer",
    level: "Mid",
    jobDescription: `
We're looking for an ML engineer to join our recommendations team. You'll
own model training, evaluation, and online serving for our content-feed
ranker. Comfortable with PyTorch, embedding-based retrieval, two-tower
architectures, and online A/B testing. Experience shipping ML to mobile
apps at scale is a plus. Strong offline-eval discipline is essential —
candidates who don't lead with eval are not a fit.`,
    cvText: `
Priya Iyer — ML Engineer
Coursera (2022-present): Built a two-tower retrieval model for course
  recommendations using PyTorch and FAISS. Shipped the v3 recommender that
  drove a 7.4% lift in enrolments (statistically significant at p<0.01
  over a 4-week A/B). Authored the offline-eval harness that gates every
  weekly model push on recall@20 and nDCG@10.
Swiggy (2020-2022): Worked on restaurant ranking. Introduced session-based
  features using LSTMs; led the migration off the legacy XGBoost stack.
Education: B.Tech Computer Science, IIT Madras 2020.
Skills: PyTorch, FAISS, Vespa, Triton inference server, Kubeflow, MLflow,
  Spark, Airflow, Python, SQL.`,
  },

  {
    id: "frontend-lead-staff",
    role: "Staff Frontend Engineer",
    level: "Staff",
    jobDescription: `
Staff-level frontend role on a collaborative document-editing product. You
will set the technical direction for our React + TypeScript codebase,
deeply own performance (TTI, LCP, INP), and mentor the broader frontend
guild. Experience with CRDTs, real-time collaboration, virtualized lists,
and large-scale design-system stewardship is essential. You will partner
closely with product and design on aesthetic + interaction details.`,
    cvText: `
Marcus Chen — Staff Frontend Engineer
Notion (2020-present): Drove the 2022 editor rewrite from Slate to a custom
  ProseMirror-based engine; cut keystroke-to-render p95 from 110ms to 28ms
  on documents over 50k blocks. Maintainer of the internal design system
  (130+ components, used by 200+ engineers).
Stripe (2018-2020): Built the Stripe Dashboard's data-grid component
  (virtualized, supports 100k rows with column resize/sort/filter).
  Co-authored the internal performance playbook.
Skills: React, TypeScript, ProseMirror, Yjs (CRDTs), Webpack/Turbopack,
  Lighthouse, web-vitals, React-Aria, Storybook, CSS Modules.`,
  },

  {
    id: "ios-mobile-mid",
    role: "iOS Engineer",
    level: "Mid",
    jobDescription: `
iOS engineer for our consumer food-delivery app (12M MAU in India). You'll
own feature development end-to-end in Swift, partner with backend on API
contracts, and contribute to our SwiftUI migration. Experience with
Combine, Core Data, and offline-first sync strategies is required.
Performance work — launch time, scroll jank, memory pressure on low-end
devices — is a recurring theme.`,
    cvText: `
Devika Rao — iOS Engineer
Swiggy (2021-present): Owned the cart-and-checkout flow; migrated 35% of
  it to SwiftUI while maintaining UIKit interop. Cut cold-start time from
  2.8s to 1.4s on iPhone 8 by deferring non-critical framework loads and
  adopting on-demand resources.
Dunzo (2019-2021): Built the offline-first order-tracking module using
  Core Data + a custom sync engine over MQTT. Filed 3 radars against
  Apple for NSPersistentCloudKitContainer migration bugs.
Skills: Swift, SwiftUI, UIKit, Combine, Core Data, MQTT, Instruments,
  XCTest, Charles Proxy, Fastlane.`,
  },

  {
    id: "security-engineer-senior",
    role: "Senior Application Security Engineer",
    level: "Senior",
    jobDescription: `
Senior AppSec role on our broker platform. You will lead threat-modelling
for new features, run our internal red-team exercises, partner with
engineering on secure-coding training, and own the bug-bounty triage
queue. Strong web exploitation background (OWASP top 10, deserialization
attacks, IDOR chains) is essential. Cloud-native security experience
(IAM least-privilege design, VPC isolation, secret rotation) is required.`,
    cvText: `
Karthik Reddy — Senior Application Security Engineer
Zerodha (2020-present): Led threat-modelling for the Kite trading platform
  rewrite. Discovered and patched a critical IDOR in the F&O order-modify
  endpoint (CVSS 8.1) before exploit. Built the in-house DAST harness
  that catches injection regressions on every PR.
Flipkart (2018-2020): Member of the offensive-security team. Authored the
  payments-team threat model. Led the SOC 2 Type II audit response.
Certifications: OSCP, OSWE, AWS Security Specialty.
Skills: Burp Suite, Semgrep, CodeQL, AWS IAM, HashiCorp Vault, GnuPG,
  Wireshark, Python, Go, BeEF, Metasploit.`,
  },

  {
    id: "platform-engineer-senior",
    role: "Senior Platform Engineer",
    level: "Senior",
    jobDescription: `
Senior platform engineer to evolve our internal developer platform. You'll
own the CI/CD substrate (build pipelines, artefact storage, deploy
orchestration), the Kubernetes-based runtime, and the developer-experience
tooling around it. We care deeply about reducing the cognitive load on
product teams; "platform-as-product" thinking is the bar.`,
    cvText: `
Sneha Kapoor — Senior Platform Engineer
Stripe (2019-present): Architect of "Sorbet Deploy", Stripe's internal
  deploy orchestrator that replaced Capistrano for 800+ services. Drove
  median deploy time from 22 minutes to 4. Maintainer of the Bazel-based
  monorepo build (Ruby + Go + TypeScript).
Shopify (2017-2019): Built the developer CLI (Shopify CLI v2). Owned the
  shared CI runner pool on Buildkite, including the GPU-runner fleet.
Skills: Kubernetes, Bazel, Buildkite, Ruby, Go, Terraform, Pulumi, Helm,
  ArgoCD, OpenTelemetry, eBPF profiling.`,
  },

  {
    id: "data-engineer-mid",
    role: "Data Engineer",
    level: "Mid",
    jobDescription: `
Data engineer to own our analytics warehouse and the upstream ETL pipelines
that feed it. You'll work in dbt + Snowflake, schedule with Airflow, and
partner with analytics + ML to model business-facing tables. Strong SQL
fundamentals (window functions, recursive CTEs, query-plan reading) and
data-modelling experience (Kimball / Inmon / Data Vault) expected.`,
    cvText: `
Rohit Bansal — Data Engineer
Flipkart (2022-present): Re-architected the seller-analytics warehouse on
  Snowflake + dbt; cut nightly batch from 5h to 47 min by clustering on
  (seller_id, order_date) and rewriting the 30-CTE seller-LTV model into
  a sequence of incremental dbt models. Maintainer of the Airflow DAGs
  for the marketplace fact tables.
Myntra (2020-2022): Built the customer-360 dimension on top of Hive + Presto.
  Migrated 200+ legacy Sqoop jobs to Airbyte.
Skills: SQL, dbt, Snowflake, Airflow, Spark, Kafka, Debezium, Python, Looker.`,
  },

  {
    id: "junior-fullstack",
    role: "Full Stack Developer",
    level: "Junior",
    jobDescription: `
Junior full-stack role at a 12-person seed-stage healthtech startup. You'll
work across our Next.js + TypeScript frontend and Node.js (Fastify) backend.
Comfort with PostgreSQL and basic AWS (RDS, S3, Lambda) is expected. You
will report directly to the CTO and ship features visible to clinicians
in the first month.`,
    cvText: `
Anya Sharma — Full Stack Developer
HealthifyMe (2024-present, internship → FT): Built the appointment-booking
  flow in Next.js 14 with server actions; integrated Twilio for SMS
  reminders. Shipped a doctor-search page with PostgreSQL trigram indexes
  cutting query latency from 800ms to 30ms.
B.Tech Computer Science, BITS Pilani 2024. Final-year project: a TensorFlow.js
  cough-detection PWA (won Best Project Award).
Skills: TypeScript, Next.js 14, Node.js, Fastify, PostgreSQL, AWS (Lambda,
  S3), Twilio, Tailwind CSS, Prisma.`,
  },

  {
    id: "staff-payments-architect",
    role: "Staff Software Engineer (Payments)",
    level: "Staff",
    jobDescription: `
Staff engineer to own the next generation of our payments infrastructure.
Multi-region active-active, exactly-once settlement semantics, vendor
fail-over within a 30-second budget. You'll set technical direction for a
team of 12, partner with finance + compliance, and own the architectural
decision records for cross-currency settlement. Distributed-systems
depth and a track record at the staff/principal level required.`,
    cvText: `
Vikram Joshi — Staff Engineer, Payments
PhonePe (2019-present): Led the multi-region rewrite of the merchant-
  settlement pipeline. Designed the Saga-orchestrator that gives
  exactly-once semantics across 14 downstream services using a Kafka-
  backed event log + idempotent consumers. Authored 18 of the team's
  Architectural Decision Records.
Visa (2015-2019): Worked on VisaNet's authorization service. Owned the
  HSM-integration layer (Thales payShield 9000) for PIN translation.
Patents: 2 granted (US, on rate-limited fraud-graph traversal).
Skills: Java, Go, Kafka, Cassandra, Vault, ISO-8583, HSM integration,
  multi-region replication, formal modelling (TLA+).`,
  },

  {
    id: "devrel-solutions-senior",
    role: "Senior Developer Relations Engineer",
    level: "Senior",
    jobDescription: `
Senior DevRel role at a developer-tooling company (CI/CD space). You'll
write code samples + SDKs, deliver conference talks, drive our docs IA,
own the developer-experience survey, and partner with product on every
public API. Excellent technical writing and the ability to ship working
code in 4+ languages is required. Prior conference-speaker history
expected.`,
    cvText: `
Eli Ramirez — Senior DevRel Engineer
CircleCI (2021-present): Owned the v3 SDK launch (Go, Python, TypeScript,
  Ruby). Drove the docs IA rewrite that lifted task-completion in the
  annual DX survey from 64% to 81%. Co-authored "CI/CD Patterns" (O'Reilly,
  2024). Speaker at KubeCon NA 2023, GopherCon 2022.
GitHub (2018-2021): Senior DA on the Actions team. Maintainer of the
  community starter-workflows repo.
Skills: TypeScript, Go, Python, Ruby, Docusaurus, OpenAPI/Stoplight,
  technical writing, public speaking, OBS Studio.`,
  },
];
