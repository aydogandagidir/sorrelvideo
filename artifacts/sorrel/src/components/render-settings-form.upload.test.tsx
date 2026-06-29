/**
 * RenderSettingsForm — uploads must be FINALIZED. The storage two-phase upload
 * (request-url + PUT) leaves the object with NO ACL; the server's canAccessObject
 * fails closed, so without a finalize call the render-time owner check silently
 * drops background audio and transcribeObject 404s the caption job. These tests
 * pin that the form finalizes the uploaded objectPath before it's used.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/test-utils";
import { DEFAULT_RENDER_SETTINGS } from "@/lib/render-settings";
import { RenderSettingsForm } from "./render-settings-form";

const OBJECT_PATH = "/objects/uploads/test-clip";

const { finalizeSpy, generateSpy, uploadSpy } = vi.hoisted(() => ({
  finalizeSpy: vi.fn().mockResolvedValue({ objectPath: "/objects/uploads/test-clip" }),
  generateSpy: vi
    .fn()
    .mockResolvedValue({ words: [{ text: "hi", start: 0, end: 1 }] }),
  uploadSpy: vi.fn().mockResolvedValue({
    objectPath: "/objects/uploads/test-clip",
    uploadURL: "https://example.test/put",
    metadata: { name: "clip", size: 1, contentType: "audio/mpeg" },
  }),
}));

vi.mock("@workspace/object-storage-web", () => ({
  useUpload: () => ({ uploadFile: uploadSpy, isUploading: false, error: null }),
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useFinalizeUpload: () => ({ mutateAsync: finalizeSpy, isPending: false }),
    useGenerateCaptions: () => ({ mutateAsync: generateSpy, isPending: false }),
  };
});

afterEach(() => vi.clearAllMocks());

function setup() {
  const onChange = vi.fn();
  renderWithProviders(
    <RenderSettingsForm
      value={{ ...DEFAULT_RENDER_SETTINGS }}
      onChange={onChange}
      plan="pro"
    />,
  );
  return { onChange };
}

/** The two hidden audio file inputs, in DOM order: [background, caption]. */
function fileInputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
  );
}

describe("RenderSettingsForm — upload finalize", () => {
  it("finalizes the background-audio upload before storing the objectPath", async () => {
    const { onChange } = setup();
    const file = new File(["x"], "music.mp3", { type: "audio/mpeg" });

    fireEvent.change(fileInputs()[0], { target: { files: [file] } });

    await waitFor(() =>
      expect(finalizeSpy).toHaveBeenCalledWith({
        data: { objectPath: OBJECT_PATH },
      }),
    );
    // backgroundAudio is only stored AFTER finalize stamped the owner ACL.
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        backgroundAudio: expect.objectContaining({ objectPath: OBJECT_PATH }),
      }),
    );
  });

  it("finalizes the caption-audio upload before transcribing", async () => {
    const { onChange } = setup();
    const file = new File(["x"], "voice.mp3", { type: "audio/mpeg" });

    fireEvent.change(fileInputs()[1], { target: { files: [file] } });

    await waitFor(() =>
      expect(finalizeSpy).toHaveBeenCalledWith({
        data: { objectPath: OBJECT_PATH },
      }),
    );
    // Transcription runs only after finalize, with the same path.
    await waitFor(() =>
      expect(generateSpy).toHaveBeenCalledWith({
        data: { audioObjectPath: OBJECT_PATH },
      }),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        captions: expect.objectContaining({ words: expect.any(Array) }),
      }),
    );
  });
});
