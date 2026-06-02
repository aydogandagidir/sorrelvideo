/**
 * SorrelRenderStack — the AWS side of Sorrel's distributed render backend (M11).
 *
 * What it provisions:
 *   1. The Hyperframes render state machine, via the `HyperframesRenderStack`
 *      construct from `@hyperframes/aws-lambda/cdk` (Step Functions orchestration
 *      over Lambda render workers). The construct OWNS its own S3 bucket — it
 *      creates the bucket internally and streams ALL intermediates (frame chunks)
 *      and the final MP4 through it. There is no other transport (no completion
 *      webhooks; the api-server polls getRenderProgress). We do NOT pass a bucket
 *      in — we read it back via `render.bucket` (see NOTE on the limited control
 *      we have over its lifecycle/encryption).
 *   2. A least-privilege IAM policy for the Sorrel api-server runtime: just
 *      enough to start/stop/describe one render execution and read+delete the
 *      render artifacts under the construct's bucket. Attached to a dedicated
 *      user whose access keys the api-server consumes via AWS_ACCESS_KEY_ID /
 *      AWS_SECRET_ACCESS_KEY.
 *
 * IMPORTANT context for reviewers:
 *   - Sorrel's PRIMARY object storage is GCS, not S3. The construct's bucket is
 *     scoped to the Lambda render pipeline ONLY (Hyperframes requires S3);
 *     finished MP4s are handed back to the app, which may re-home them in GCS.
 *     Do not treat this as general app storage.
 *   - The api-server-side glue (renderBackend.ts / lambdaBackend.ts that wires
 *     into renderQueue.ts) is owned by a DIFFERENT milestone and lives under
 *     artifacts/api-server. It is NOT in this package.
 *
 * Verified against @hyperframes/aws-lambda@0.6.65 published types (the `^0.6.6`
 * dependency resolves into the 0.6.x line). The construct's surface that this
 * file depends on:
 *   - import: `@hyperframes/aws-lambda/cdk` (NOT the package root — root re-exports
 *     only the SDK + handler runtime).
 *   - `class HyperframesRenderStack extends Construct` (an L3 construct, NOT a
 *     cdk.Stack — despite the "Stack" suffix it is embedded inside this stack).
 *   - constructor `(scope, id, props?: HyperframesRenderStackProps)`.
 *   - public accessors: `bucket: s3.Bucket`, `renderFunction: lambda.Function`,
 *     `stateMachine: sfn.StateMachine`.
 *   - props (all optional): `projectName`, `lambdaMemoryMb`, `lambdaTimeoutSec`,
 *     `reservedConcurrency`, `chromeSource: "sparticuz" | "chrome-headless-shell"`,
 *     `chunkInvocationAlarmThreshold`, `handlerZipPath`, `bucketRemovalPolicy`.
 */
import * as cdk from "aws-cdk-lib";
import { aws_iam as iam } from "aws-cdk-lib";
import { Construct } from "constructs";

import { HyperframesRenderStack } from "@hyperframes/aws-lambda/cdk";

/**
 * Chromium binary source for the render Lambda. Mirrors the construct's
 * `chromeSource` prop exactly (@hyperframes/aws-lambda@0.6.65). NOTE: the literal
 * is `"sparticuz"`, NOT the npm package name `"@sparticuz/chromium"` — the
 * construct maps this short token to the layer internally.
 */
export type ChromeSource = "sparticuz" | "chrome-headless-shell";

export interface SorrelRenderStackProps extends cdk.StackProps {
  /** Deployment stage (dev|prod|…) — used for resource naming + tagging. */
  readonly stage: string;
}

export class SorrelRenderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: SorrelRenderStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // Read tunables from context (set in cdk.json, overridable with `-c`).
    const chromeSource = this.resolveChromeSource();
    const concurrency = this.resolveConcurrency();

    // ---------------------------------------------------------------------
    // 1. Hyperframes render state machine (Step Functions + Lambda workers).
    // ---------------------------------------------------------------------
    // RESOLVED against @hyperframes/aws-lambda@0.6.65: the construct OWNS its S3
    // bucket — there is no `bucket`/`renderBucket` prop to inject. We read the
    // bucket back via `render.bucket` below and scope IAM to it. Concurrency is
    // `reservedConcurrency` (not `maxConcurrency`); there is no `sdrOnly` prop
    // (SDR-only is just the engine behaviour, not a CDK toggle).
    //
    // NOTE: the published props expose NO control over the bucket's lifecycle
    // rules, encryption, or public-access block — only `bucketRemovalPolicy`.
    // The previous scaffold hand-rolled a bucket with chunk/output lifecycle
    // expiry + SSE + BLOCK_ALL; none of that is reachable through this
    // construct's surface. We set `bucketRemovalPolicy: DESTROY` (render
    // artifacts are disposable, never a source of truth) so `cdk destroy` tears
    // the bucket down, and rely on the engine's own object cleanup for cost
    // control. If we need lifecycle expiry / explicit SSE again, the path is
    // either an upstream prop request or attaching an L1 lifecycle
    // configuration to `render.bucket` after construction (deferred — not done
    // here to avoid fighting the construct's own configuration).
    const render = new HyperframesRenderStack(this, "HyperframesRender", {
      // Stage-namespaced so dev/prod render fleets don't collide on resource
      // names within one account. Maps to the construct's naming prefix.
      projectName: `sorrel-render-${stage}`,
      // Chromium source — drives Lambda package size. Literal is the short
      // "sparticuz" token (NOT "@sparticuz/chromium"), per the verified type.
      chromeSource,
      // Cap parallel render Lambdas. The published prop is `reservedConcurrency`;
      // there is no `maxConcurrency`.
      reservedConcurrency: concurrency,
      // Disposable render artifacts — let `cdk destroy` remove the bucket rather
      // than orphan it. (See NOTE above re: lifecycle/SSE not being exposed.)
      bucketRemovalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // The construct-owned bucket Hyperframes streams chunks + output through.
    // Verified accessor: `render.bucket` (s3.Bucket).
    const renderBucket = render.bucket;

    // The state machine that the api-server starts per render.
    // Verified accessor: `render.stateMachine` (sfn.StateMachine).
    const stateMachine = render.stateMachine;

    // The render worker Lambda, surfaced for ops/log lookups.
    // Verified accessor: `render.renderFunction` (lambda.Function).
    const renderFunction = render.renderFunction;

    // ---------------------------------------------------------------------
    // 2. Least-privilege IAM for the Sorrel api-server runtime.
    // ---------------------------------------------------------------------
    // The api-server only needs to: drive ONE state machine (start/stop/describe
    // executions) and read+delete the render artifacts in the construct's
    // bucket. It must NOT be able to list the bucket, write objects, or invoke
    // Lambda directly. We model that as a standalone managed policy attached to a
    // dedicated user; the user's access keys feed AWS_ACCESS_KEY_ID /
    // AWS_SECRET_ACCESS_KEY on Railway.
    //
    // NOTE: an access-key user is the pragmatic choice because the api-server
    // runs on Railway (outside AWS) and cannot assume an instance role. If/when
    // Sorrel moves onto AWS compute, swap this for an IRSA / instance role and
    // attach `runtimePolicy` to that principal instead — the policy document is
    // identical, only the principal changes.

    const runtimePolicy = new iam.ManagedPolicy(this, "ApiServerRuntimePolicy", {
      managedPolicyName: `sorrel-render-runtime-${stage}`,
      description:
        "Least-privilege policy for the Sorrel api-server to drive the Hyperframes render state machine and fetch/cleanup its S3 artifacts.",
      statements: [
        // Step Functions: drive executions of the ONE render state machine only.
        // StartExecution + DescribeExecution (poll status) + StopExecution
        // (cancel). Scoped to the single state-machine ARN, not "*".
        new iam.PolicyStatement({
          sid: "DriveRenderStateMachine",
          effect: iam.Effect.ALLOW,
          actions: [
            "states:StartExecution",
            "states:StopExecution",
            "states:DescribeExecution",
          ],
          // `stateMachine` is a concrete sfn.StateMachine (verified accessor),
          // so `.stateMachineArn` is the standard sfn surface. DescribeExecution
          // / StopExecution target execution ARNs which are children of the
          // state-machine ARN; we grant both the machine ARN and its execution
          // ARNs so a single statement covers start + describe/stop.
          resources: [
            stateMachine.stateMachineArn,
            this.executionArnPattern(stateMachine.stateMachineArn),
          ],
        }),
        // S3: read + delete render artifacts in the construct's bucket. No
        // ListBucket, no PutObject (the Lambda writes, not the api-server).
        // GetObject lets the api-server download the finished MP4; DeleteObject
        // lets it clean up after handing the file to the app.
        //
        // NOTE: scoped to ALL objects in `render.bucket` (`<bucket>/*`) rather
        // than to `output/` + `chunks/` prefixes. The previous scaffold scoped
        // by prefix, but the construct owns the bucket and its published types
        // (@hyperframes/aws-lambda@0.6.65) do NOT document the object key layout
        // it writes under — hard-coding `output/`/`chunks/` here would risk
        // either over- or under-granting if the engine's keys differ. The grant
        // is still tightly bounded: a single dedicated bucket, no ListBucket, no
        // write. Tighten to verified prefixes once the engine documents its key
        // scheme (or expose it as a construct accessor upstream).
        new iam.PolicyStatement({
          sid: "ReadDeleteRenderArtifacts",
          effect: iam.Effect.ALLOW,
          actions: ["s3:GetObject", "s3:DeleteObject"],
          resources: [renderBucket.arnForObjects("*")],
        }),
      ],
    });

    const runtimeUser = new iam.User(this, "ApiServerRuntimeUser", {
      userName: `sorrel-render-runtime-${stage}`,
      managedPolicies: [runtimePolicy],
    });

    // ---------------------------------------------------------------------
    // CfnOutputs — consumed by the operator wiring up the api-server env.
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, "RenderBucketName", {
      value: renderBucket.bucketName,
      description:
        "S3 render bucket — set as HYPERFRAMES_S3_BUCKET on the api-server.",
      exportName: `SorrelRender-${stage}-BucketName`,
    });

    new cdk.CfnOutput(this, "RenderStateMachineArn", {
      value: stateMachine.stateMachineArn,
      description:
        "Render state-machine ARN the api-server starts executions against.",
      exportName: `SorrelRender-${stage}-StateMachineArn`,
    });

    new cdk.CfnOutput(this, "RenderFunctionName", {
      value: renderFunction.functionName,
      description: "Render worker Lambda name (for log/metric lookups).",
      exportName: `SorrelRender-${stage}-FunctionName`,
    });

    new cdk.CfnOutput(this, "ApiServerRuntimeUserName", {
      value: runtimeUser.userName,
      description:
        "IAM user whose access keys feed AWS_ACCESS_KEY_ID/SECRET on Railway. " +
        "Create the access key out-of-band (console/CLI) — never store secrets in CFN.",
      exportName: `SorrelRender-${stage}-RuntimeUserName`,
    });
  }

  /**
   * Validate + resolve the Chromium source from context. Constrained to the two
   * values accepted by the construct's `chromeSource` prop (verified against
   * @hyperframes/aws-lambda@0.6.65) so a typo can't silently produce an
   * oversized (or nonexistent) Lambda layer.
   */
  private resolveChromeSource(): ChromeSource {
    const raw =
      (this.node.tryGetContext("chromeSource") as string | undefined) ??
      "sparticuz";
    if (raw !== "sparticuz" && raw !== "chrome-headless-shell") {
      throw new Error(
        `Invalid chromeSource context "${raw}". ` +
          'Expected "sparticuz" (~70MiB, default) or "chrome-headless-shell" (~140MiB). ' +
          'NOTE: the value is the short "sparticuz" token expected by ' +
          "@hyperframes/aws-lambda, NOT the npm package name \"@sparticuz/chromium\".",
      );
    }
    return raw;
  }

  /**
   * Resolve render concurrency from context, defaulting to the stated 8. Guarded
   * so a non-numeric / non-positive value fails synth loudly rather than
   * deploying a broken fan-out.
   */
  private resolveConcurrency(): number {
    const raw = this.node.tryGetContext("concurrency") as
      | number
      | string
      | undefined;
    if (raw === undefined) {
      return 8;
    }
    const n = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `Invalid concurrency context "${String(raw)}". Expected a positive integer (default 8).`,
      );
    }
    return n;
  }

  /**
   * Derive the execution-ARN wildcard for a state machine ARN so DescribeExecution
   * / StopExecution can be scoped to children of the one machine rather than "*".
   *
   * State machine ARN: arn:aws:states:<region>:<account>:stateMachine:<name>
   * Execution    ARN: arn:aws:states:<region>:<account>:execution:<name>:<id>
   *
   * We token-safely swap the `stateMachine:` segment for `execution:` and append
   * a `:*` wildcard for the execution id. Built with cdk.Fn so it works on the
   * unresolved CFN token at synth time.
   */
  private executionArnPattern(stateMachineArn: string): string {
    // arn:aws:states:REGION:ACCOUNT:stateMachine:NAME → split on ":stateMachine:"
    const parts = cdk.Fn.split(":stateMachine:", stateMachineArn);
    const prefix = cdk.Fn.select(0, parts); // arn:aws:states:REGION:ACCOUNT
    const name = cdk.Fn.select(1, parts); // NAME
    return `${prefix}:execution:${name}:*`;
  }
}
