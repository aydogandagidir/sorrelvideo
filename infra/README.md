# `@workspace/infra` — distributed render backend (AWS Lambda)

CDK app (M11) that provisions the **AWS side** of Sorrel's distributed render
backend: an S3 render bucket and the Hyperframes Lambda + Step Functions render
state machine. It is **self-contained** and deployed **out-of-band** from the
main app — Sorrel itself runs on Railway (single Node 24 container) and primary
object storage is **GCS**. This stack exists purely so the Pro-tier "render on
Lambda" path has somewhere to run; the finished MP4 is handed back to the app.

> The api-server-side glue (`renderBackend.ts` / `lambdaBackend.ts` that plug
> into `renderQueue.ts`) is owned by a **different milestone** and lives under
> `artifacts/api-server`. It is intentionally **not** in this package. This
> package produces only the AWS infrastructure + the contract the api-server
> consumes.

---

## What it provisions

`SorrelRenderStack` (`lib/sorrel-render-stack.ts`):

| Resource                       | Notes                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Hyperframes render machine** | `HyperframesRenderStack` construct (from `@hyperframes/aws-lambda/cdk`) → Step Functions over render Lambdas. **Owns its own S3 bucket**; all intermediates + output stream through it. |
| **S3 render bucket**           | Created **by the construct**, not by this stack. We read it back via `render.bucket` and scope IAM to it. (See note on lifecycle/SSE below.) |
| **IAM runtime policy + user**  | Least-privilege for the api-server (drive one state machine + read/delete its bucket artifacts). Keys → Railway. |
| **CfnOutputs**                 | Bucket name, state-machine ARN, render function name, runtime user name.                                  |

> ✅ **API verified against `@hyperframes/aws-lambda@0.6.65`** (the declared
> `^0.6.6` dependency resolves into that 0.6.x build; types read from the npm
> CDN). All five prior `TODO(verify …)` markers are resolved. Key corrections
> the verification forced:
>
> - **Import path is the `/cdk` subpath**, not the package root:
>   `import { HyperframesRenderStack } from "@hyperframes/aws-lambda/cdk"`. The
>   root entry re-exports only the SDK + Lambda handler runtime.
> - **`HyperframesRenderStack extends Construct`, not `Stack`** — an L3 construct
>   embedded inside our `SorrelRenderStack` (the "Stack" suffix is the upstream
>   name; it is not a standalone CloudFormation stack).
> - **The construct owns its bucket.** There is no `bucket` prop to inject; we
>   consume `render.bucket`. Consequently the bucket's lifecycle rules, SSE mode,
>   and public-access block are **not** configurable through the construct
>   (only `bucketRemovalPolicy` is) — see the cost-controls note below.
> - **Props are different names than first assumed:** concurrency is
>   `reservedConcurrency` (not `maxConcurrency`); there is **no** `sdrOnly` prop;
>   `chromeSource` takes the short token **`"sparticuz"`**, not the npm name
>   `"@sparticuz/chromium"`.
> - **Accessors confirmed:** `render.bucket` (`s3.Bucket`),
>   `render.stateMachine` (`sfn.StateMachine`), `render.renderFunction`
>   (`lambda.Function`). There is no `*Arn` accessor — the ARNs come off the
>   standard CDK objects (`stateMachine.stateMachineArn`,
>   `renderFunction.functionName`).

---

## Constraints (v1)

- **Single region.** Hyperframes Lambda rendering is single-region in v1.
  `AWS_REGION` is **required** — `bin/app.ts` throws without it so a stray
  profile can't deploy the fleet to the wrong region. `account` is taken from
  the deploying credentials (kept out of git).
- **SDR only.** No HDR pipeline.
- **No completion webhooks.** The api-server **polls** `getRenderProgress(opts)`.
  Poll cadence is `LAMBDA_PROGRESS_POLL_MS`. The real shapes (verified against
  `@hyperframes/aws-lambda@0.6.65`) are in [Runtime SDK contract](#runtime-sdk-contract-api-server)
  below — `getRenderProgress` takes an options object keyed by `executionArn`
  (not a bare `renderId`) and returns a richer `RenderProgress`, not
  `{ status, progress, costCents? }`.
- **Lambda package size ceiling:** ≤ **248 MiB unzipped** / ≤ **150 MiB zipped**.
  Chromium source drives this — see below.
- **Concurrency** defaults to **8** parallel render Lambdas (`-c concurrency=N`
  or `HYPERFRAMES_LAMBDA_CONCURRENCY` on the runtime).

### Chromium source (size trade-off)

Selected by `HYPERFRAMES_LAMBDA_CHROME_SOURCE` (runtime) and the `chromeSource`
CDK context (build). NOTE: the construct's `chromeSource` prop takes the **short
token `"sparticuz"`** — verified against `@hyperframes/aws-lambda@0.6.65` — not
the npm package name `"@sparticuz/chromium"`. `cdk.json` and `resolveChromeSource()`
use the short token; passing the npm name now fails synth with a clear error.

| Value                   | Approx size | When                                            |
| ----------------------- | ----------- | ----------------------------------------------- |
| `sparticuz` (default)   | ~70 MiB     | Default. Comfortably under the size ceiling.    |
| `chrome-headless-shell` | ~140 MiB    | Only if a render needs the full headless shell. |

---

## Cost controls

- **Object cleanup is the engine's job, not ours.** ⚠️ The earlier plan to set
  S3 lifecycle expiry (`chunks/` 24h, `output/` 2d) does **not** apply: the
  `HyperframesRenderStack` construct **owns its bucket** and exposes no lifecycle
  / SSE / public-access props (only `bucketRemovalPolicy`, verified against
  `@hyperframes/aws-lambda@0.6.65`). We rely on the engine's own intermediate
  cleanup for flat storage. If lifecycle expiry becomes necessary, attach an L1
  lifecycle configuration to `render.bucket` post-construction or request an
  upstream prop — see the `NOTE:` in `lib/sorrel-render-stack.ts`.
- **Concurrency cap.** Bounded fan-out (default 8, via the construct's
  `reservedConcurrency` prop) caps peak Lambda spend.
- **Pro-tier gate + per-account cap.** Distributed rendering is Pro-only and
  bounded by `DISTRIBUTED_RENDER_LIMIT` (enforced api-server-side). `RENDER_MAX_FRAMES`
  caps a single job's frame count so one request can't fan out unboundedly.
- **Per-render cost** is surfaced by `getRenderProgress` as a `costs: RenderCost`
  object on `RenderProgress` (not a flat `costCents` field) for cost attribution
  (logging / future billing).
- **`bucketRemovalPolicy: DESTROY`.** `cdk destroy` tears the construct's bucket
  down — no orphaned storage after teardown. Safe because every object here is a
  disposable render artifact, never a source of truth. (The previous scaffold
  also set `autoDeleteObjects` on a self-managed bucket; that knob isn't ours
  now that the construct owns the bucket — `bucketRemovalPolicy` is the exposed
  control.)

---

## Build

The Hyperframes Lambda render image is built from a Hyperframes repo checkout,
**not** from npm alone. You need:

- **SAM CLI** — `sam build` packages the Lambda (respecting the size ceiling).
- **Bun** — the Hyperframes build toolchain runs on Bun.
- **A Hyperframes repo checkout** at `HYPERFRAMES_REPO_ROOT` — the construct reads
  the render runtime from there.
- **Node 24** + **pnpm** for this CDK app itself.

```bash
# 0. Prereqs: aws-cli configured, SAM CLI + Bun on PATH, Node 24.
export HYPERFRAMES_REPO_ROOT=/abs/path/to/hyperframes   # repo checkout
export AWS_REGION=us-east-1                              # single-region v1

# 1. Install (once the orchestrator has added infra/* to pnpm-workspace.yaml
#    and aligned @hyperframes/aws-lambda to the engine version).
pnpm install

# 2. Type-check the CDK app.
pnpm --filter @workspace/infra build      # tsc --noEmit

# 3. Synthesize CloudFormation (also triggers the SAM/Bun Lambda build).
pnpm --filter @workspace/infra synth
```

---

## Deploy

Use short-lived **GitHub OIDC** credentials in CI (no long-lived AWS keys in
secrets) — the workflow block below assumes a role via OIDC. For a manual deploy,
authenticate however you normally do (`aws sso login`, a profile, etc.), then:

```bash
export AWS_REGION=us-east-1

# First time in a fresh account/region only:
pnpm --filter @workspace/infra exec cdk bootstrap

# Deploy (override stage as needed):
pnpm --filter @workspace/infra deploy            # stage=dev (cdk.json default)
pnpm --filter @workspace/infra exec cdk deploy -c stage=prod
```

After deploy, read the **CfnOutputs** (`RenderBucketName`, `RenderStateMachineArn`,
`RenderFunctionName`, `ApiServerRuntimeUserName`) and wire the api-server env
(next section).

---

## The exact least-privilege IAM the api-server needs

`SorrelRenderStack` creates a managed policy (`sorrel-render-runtime-<stage>`)
attached to a dedicated IAM user (`sorrel-render-runtime-<stage>`). Mint an
access key for that user **out-of-band** (console/CLI — never put secrets in
CloudFormation) and set it as `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` on
Railway. The policy grants exactly:

```jsonc
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DriveRenderStateMachine",
      "Effect": "Allow",
      "Action": [
        "states:StartExecution",
        "states:StopExecution",
        "states:DescribeExecution"
      ],
      // The ONE render state machine + its execution children — not "*".
      "Resource": [
        "arn:aws:states:<region>:<account>:stateMachine:<renderMachine>",
        "arn:aws:states:<region>:<account>:execution:<renderMachine>:*"
      ]
    },
    {
      "Sid": "ReadDeleteRenderArtifacts",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:DeleteObject"],
      // All objects in the construct's ONE bucket — no ListBucket, no write.
      "Resource": ["arn:aws:s3:::<renderBucket>/*"]
    }
  ]
}
```

> **Why `<renderBucket>/*` and not `output/*` + `chunks/*`?** The earlier
> scaffold scoped S3 by prefix, but the construct owns the bucket and its
> published types (`@hyperframes/aws-lambda@0.6.65`) do **not** document the
> object-key layout the engine writes under. Hard-coding `output/`/`chunks/`
> would risk over- or under-granting if the engine's keys differ. The grant is
> still tightly bounded — a single dedicated bucket, no `ListBucket`, no write.
> Tighten to verified prefixes once the engine documents its key scheme.

Deliberately **not** granted: `s3:ListBucket`, `s3:PutObject` (Lambda writes,
not the api-server), `lambda:InvokeFunction` (the api-server drives Step
Functions, never the Lambda directly), and any wildcard resource beyond the
single render bucket above.

> If Sorrel ever moves onto AWS compute, drop the access-key user and attach the
> identical `runtimePolicy` to an IRSA / instance role instead — only the
> principal changes.

---

## GitHub Actions — `deploy-infra.yml`

The orchestrator adds this as `.github/workflows/deploy-infra.yml` (this package
must not write under `.github/`). It is **manual-dispatch + path-filtered**:
infra deploys are decoupled from the Railway app deploy, and production IaC
changes should be a deliberate action, not an implicit push side effect.

Prerequisites: an IAM role trusting GitHub's OIDC provider
(`token.actions.githubusercontent.com`), its ARN stored as the
`AWS_DEPLOY_ROLE_ARN` repo secret, and the target region as the `AWS_REGION`
repo variable.

```yaml
name: Deploy Infra (AWS CDK)

on:
  # Deliberate, manual trigger — IaC changes shouldn't auto-ship on push.
  workflow_dispatch:
    inputs:
      stage:
        description: "Deployment stage"
        type: choice
        options: [dev, prod]
        default: dev
  # Optional: surface drift on PRs that touch infra/ by synthesizing only.
  pull_request:
    paths:
      - "infra/**"

concurrency:
  group: deploy-infra-${{ github.event.inputs.stage || 'synth' }}
  cancel-in-progress: false

permissions:
  id-token: write # required for OIDC
  contents: read

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

jobs:
  infra:
    name: Synth / Deploy CDK
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v6

      - name: Setup pnpm
        uses: pnpm/action-setup@v4

      - name: Setup Node 24
        uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2

      - name: Setup SAM CLI
        uses: aws-actions/setup-sam@v2
        with:
          use-installer: true

      - name: Checkout Hyperframes engine
        uses: actions/checkout@v6
        with:
          repository: your-org/hyperframes # TODO: set the real engine repo
          path: .hyperframes
          # ref: pin to the same version as @hyperframes/aws-lambda

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Type-check infra
        run: pnpm --filter @workspace/infra build

      - name: Configure AWS credentials (OIDC)
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}

      - name: CDK synth
        env:
          AWS_REGION: ${{ vars.AWS_REGION }}
          HYPERFRAMES_REPO_ROOT: ${{ github.workspace }}/.hyperframes
        run: pnpm --filter @workspace/infra synth -c stage=${{ github.event.inputs.stage || 'dev' }}

      # Deploy only on manual dispatch; PRs stop at synth (drift check).
      - name: CDK deploy
        if: ${{ github.event_name == 'workflow_dispatch' }}
        env:
          AWS_REGION: ${{ vars.AWS_REGION }}
          HYPERFRAMES_REPO_ROOT: ${{ github.workspace }}/.hyperframes
        run: pnpm --filter @workspace/infra exec cdk deploy --require-approval never -c stage=${{ github.event.inputs.stage }}
```

---

## Env contract (api-server runtime)

The full block is appended to the repo-root `.env.example` under "Distributed
render (AWS Lambda — Pro tier, optional)". Summary:

| Var                               | Purpose                                                                    |
| --------------------------------- | -------------------------------------------------------------------------- |
| `RENDER_BACKEND`                  | `lambda` to route renders here; unset/`local` → existing inline/BullMQ path. |
| `AWS_REGION`                      | Single-region target. Required when `RENDER_BACKEND=lambda`.                |
| `AWS_ACCESS_KEY_ID` / `_SECRET_…` | Access key for the `sorrel-render-runtime-<stage>` IAM user.               |
| `HYPERFRAMES_S3_BUCKET`           | CfnOutput `RenderBucketName` (the construct-owned bucket).                  |
| `HYPERFRAMES_LAMBDA_CHROME_SOURCE`| `sparticuz` (default) or `chrome-headless-shell`. Same `ChromeSource` token the construct uses — NOT `@sparticuz/chromium`. |
| `HYPERFRAMES_LAMBDA_CONCURRENCY`  | Max parallel render Lambdas (default 8; the construct prop is `reservedConcurrency`). |
| `RENDER_MAX_FRAMES`               | Per-job frame cap (cost guard).                                            |
| `LAMBDA_PROGRESS_POLL_MS`         | `getRenderProgress` poll interval (no webhooks).                           |
| `DISTRIBUTED_RENDER_LIMIT`        | Per-account distributed-render cap (Pro gate).                            |
| `HYPERFRAMES_REPO_ROOT`           | Build-time only: Hyperframes checkout the Lambda image is built from.       |

---

## Runtime SDK contract (api-server)

> This is consumed by the api-server-side glue (a **different milestone**, under
> `artifacts/api-server`), documented here because this package owns the contract.
> Signatures **verified** against `@hyperframes/aws-lambda@0.6.65` — imported from
> the package **root** (`@hyperframes/aws-lambda`), distinct from the `/cdk`
> subpath this CDK app imports.

Both functions take a **single options object** (no positional args) and return
a `Promise`:

```ts
import { renderToLambda, getRenderProgress } from "@hyperframes/aws-lambda";

// 1. Kick off a render. Returns the handle the api-server persists.
const handle: RenderHandle = await renderToLambda({
  config, // SerializableDistributedRenderConfig (the render job spec)
  bucketName, // HYPERFRAMES_S3_BUCKET
  stateMachineArn, // CfnOutput RenderStateMachineArn
  region, // optional; falls back to ambient AWS_REGION
  projectDir, // optional — or pass a pre-deployed `siteHandle`
  // siteHandle?, outputKey?, executionName?, sfn?, s3?  (all optional)
});

// 2. Poll progress, keyed by executionArn from the handle (NOT a bare renderId).
const progress: RenderProgress = await getRenderProgress({
  executionArn: handle.executionArn,
  defaultMemorySizeMb, // optional (cost estimation)
  region, // optional
  // sfn?  (optional injected client)
});
```

**`RenderHandle`** (returned by `renderToLambda`):

```ts
interface RenderHandle {
  renderId: string;
  executionArn: string; // ← pass this to getRenderProgress
  bucketName: string;
  stateMachineArn: string;
  outputS3Uri: string;
  projectS3Uri: string;
  startedAt: string;
}
```

**`RenderProgress`** (returned by `getRenderProgress`) — richer than the
originally-documented `{ status, progress, costCents? }`:

```ts
type RenderStatus =
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMED_OUT"
  | "ABORTED"
  | "PENDING_REDRIVE";

interface RenderProgress {
  status: RenderStatus;
  overallProgress: number; // 0..1
  framesRendered: number;
  totalFrames: number | null;
  lambdasInvoked: number;
  costs: RenderCost; // cost attribution (was mis-documented as `costCents`)
  outputFile: { s3Uri: string; bytes: number | null } | null;
  errors: RenderError[]; // { state, error, cause }
  fatalErrorEncountered: boolean;
  startedAt: string;
  endedAt: string | null;
}
```

Notable differences from the original contract sketch the api-server glue must
account for:

- **Poll key is `executionArn`**, taken off the `RenderHandle` — not a synthetic
  `renderId`. (`renderId` exists on the handle but is not the progress lookup
  key.)
- **Status is an SFN execution status enum** (`RUNNING`/`SUCCEEDED`/`FAILED`/…),
  not a free-form/`pending|done` string. Map these to Sorrel's
  `rendering|ready|failed` states.
- **Progress is `overallProgress` (0..1)**, plus `framesRendered`/`totalFrames`
  for finer reporting.
- **Cost is a `RenderCost` object** (`costs`), not a flat `costCents`.
- **The finished MP4 is `outputFile.s3Uri`** (nullable until complete); the
  api-server downloads it from there via its `s3:GetObject` grant.
