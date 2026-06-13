/**
 * The dev-only local-media gate, in its own tiny module so the config services
 * (ttsService / transcriptionService) can read it WITHOUT importing the model
 * service (localMediaService imports those services for their error types — a
 * value-level circular import otherwise).
 *
 * Both gates must pass: the explicit opt-in flag AND a non-production env.
 */
export function isLocalMediaEnabled(): boolean {
  return (
    process.env.LOCAL_MEDIA_MODELS === "true" &&
    process.env.NODE_ENV !== "production"
  );
}
