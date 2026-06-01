#!/usr/bin/env node
/**
 * CDK app entry point for Sorrel's distributed (AWS Lambda) render backend.
 *
 * This app is deployed OUT-OF-BAND from the main Sorrel deployment: Sorrel runs
 * on Railway (single Node 24 container), while the render fan-out runs on AWS
 * Lambda + Step Functions provisioned by this stack. The two are linked only by
 * the CfnOutputs this stack exports (bucket name, state-machine ARN, function
 * name) and a least-privilege IAM user the api-server assumes at runtime — see
 * SorrelRenderStack and README.md.
 *
 * Run with `pnpm --filter @workspace/infra synth|deploy`.
 */
import * as cdk from "aws-cdk-lib";

import { SorrelRenderStack } from "../lib/sorrel-render-stack.js";

const app = new cdk.App();

// Stage drives the stack name + resource naming so dev/prod can coexist in one
// account if needed. Override at deploy time: `cdk deploy -c stage=prod`.
const stage = (app.node.tryGetContext("stage") as string | undefined) ?? "dev";

// Hyperframes Lambda rendering is single-region in v1. We pin the region from
// AWS_REGION rather than letting CDK pick it from the ambient profile, so a
// misconfigured shell can't silently deploy the render fleet to the wrong
// region. `account` is left undefined → resolved from the deploying credentials
// (CDK "environment-agnostic until deploy") which keeps the account out of git.
const region = process.env.AWS_REGION;
if (!region) {
  throw new Error(
    "AWS_REGION must be set (Hyperframes Lambda rendering is single-region in v1). " +
      "Export it before `cdk synth`/`cdk deploy`, e.g. AWS_REGION=us-east-1.",
  );
}

new SorrelRenderStack(app, `SorrelRender-${stage}`, {
  stage,
  env: {
    region,
    // account intentionally omitted — taken from the active credentials at deploy.
  },
  description: `Sorrel distributed render backend (${stage}) — Hyperframes Lambda + Step Functions + S3.`,
  tags: {
    app: "sorrel",
    component: "render-lambda",
    stage,
  },
});

app.synth();
