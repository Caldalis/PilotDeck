import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogProvider } from "../../../../../shared/catalogProviders";
import ProviderCard from "./ProviderCard";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("../../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("../../../../../shared/modelListApi", () => ({
  fetchProviderModels: mocks.fetchProviderModels,
}));

const catalogEntry: CatalogProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  protocol: "openai",
  defaultUrl: "https://openrouter.ai/api/v1",
  models: [],
};

describe("ProviderCard custom model add", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.fetchProviderModels.mockResolvedValue([
      { id: "anthropic/claude-fable", displayName: "Claude Fable" },
      { id: "google/gemini-flash", displayName: "Gemini Flash" },
    ]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("does not expose provider retry settings", () => {
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByText("pilotDeckConfig.panels.models.providerAdvancedToggle")).toBeNull();
  });

  it("puts add-model first in candidates and enables a typed ID on enter", async () => {
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "already-on": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "pilotDeckConfig.panels.models.addModelId" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "settingsPage.actions.edit" }));

    const addButton = await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.addModelId" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "anthropic/claude-fable" })).toBeTruthy();
    });

    expect(addButton.parentElement?.firstElementChild).toBe(addButton);
    expect(screen.queryByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder")).toBeNull();

    fireEvent.click(addButton);

    const input = screen.getByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder");
    expect(addButton.nextElementSibling).toBe(input);

    fireEvent.change(input, { target: { value: "my-custom-model" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.queryByPlaceholderText("pilotDeckConfig.panels.models.customModelIdPlaceholder")).toBeNull();
    expect(screen.getByText("my-custom-model")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "my-custom-model" })).toBeNull();
  });
});

const passingTest = {
  status: "passed" as const,
  textInput: "supported" as const,
  imageInput: "supported" as const,
};

describe("ProviderCard connection badge", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
    mocks.fetchProviderModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows configured when fields are complete without requiring a test", () => {
    const onPendingChange = vi.fn();
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );

    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });

  it("shows connected when all enabled models passed, including manual image results", () => {
    const onPendingChange = vi.fn();
    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: {
            "model-a": { connectionTest: passingTest },
            "model-b": {
              connectionTest: {
                status: "passed",
                textInput: "supported",
                imageInput: "unsupported",
              },
            },
          },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
      />,
    );

    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenCalledWith(false);
  });

  it("binds a passing connection test and then marks the provider connected", async () => {
    const onBindConnectionTest = vi.fn().mockResolvedValue({ ok: true });
    const onPendingChange = vi.fn();
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config/test-connections") {
        return {
          ok: true,
          json: async () => ({
            testId: "test_1",
            status: "passed",
            models: [{
              modelId: "model-a",
              textInput: "supported",
              imageInput: "unsupported",
            }],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={vi.fn()}
        onRemove={vi.fn()}
        onPendingChange={onPendingChange}
        onBindConnectionTest={onBindConnectionTest}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" }));

    await waitFor(() => expect(onBindConnectionTest).toHaveBeenCalledWith("test_1"));
    expect(screen.getByText("pilotDeckConfig.panels.models.configured")).toBeTruthy();
    expect(onPendingChange).toHaveBeenLastCalledWith(false);
  });

  it.each(['automatic', 'manual', 'legacy'])('reports a failed save after %s probing and retries saving without another probe', async (mode) => {
    let finishSave!: (value: { ok: boolean; error?: string }) => void;
    const save = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }))
      .mockResolvedValue({ ok: true });
    const passing = { status: 'passed', testId: 'test_case', models: [{ modelId: 'model-a', textInput: 'supported', imageInput: 'unsupported' }] };
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url.includes('/image-capabilities')) return { ok: true, json: async () => passing };
      if (url === '/api/config/test-connection') return { ok: true, json: async () => ({ ok: true, supportsImage: false }) };
      if (mode === 'legacy') return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => mode === 'manual'
        ? { ...passing, manualInputRequired: true, models: [{ modelId: 'model-a', textInput: 'supported', imageInput: 'unknown' }] }
        : passing };
    });
    render(<ProviderCard providerId="HXAPI" provider={{ protocol: 'openai', url: 'https://example.test', apiKey: '********', models: { 'model-a': {} } }}
      onSave={save} onBindConnectionTest={save} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.testConnection' }));
    if (mode === 'manual') {
      fireEvent.click(await screen.findByRole('radio', { name: 'connection.manualUnsupported' }));
      fireEvent.click(screen.getByRole('button', { name: 'connection.manualConfirm' }));
    }
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('pilotDeckConfig.panels.models.connectionNormal')).toBeNull();
    expect((screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.savingTest' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishSave({ ok: false, error: 'Configuration does not match the tested provider.' }); });
    expect(screen.getByText('pilotDeckConfig.panels.models.testSaveFailed')).toBeTruthy();
    expect(screen.getByText('pilotDeckConfig.panels.models.configured')).toBeTruthy();
    expect(screen.queryByText('pilotDeckConfig.panels.models.connectionNormal')).toBeNull();
    const probeCalls = mocks.authenticatedFetch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.panels.models.retryTestSave' }));
    await waitFor(() => expect(screen.getByText('pilotDeckConfig.panels.models.connectionNormal')).toBeTruthy());
    expect(save).toHaveBeenCalledTimes(2);
    expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(probeCalls);
    expect(screen.queryByText('pilotDeckConfig.panels.models.testSaveFailed')).toBeNull();
  });

  it("falls back to the legacy connection endpoint when the batch route is unavailable", async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true });
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config/test-connections") {
        return {
          ok: false,
          status: 404,
          json: async () => ({ message: "API route not found" }),
        };
      }
      if (url === "/api/config/test-connection") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, supportsImage: false }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <ProviderCard
        providerId="openrouter"
        provider={{
          protocol: "openai",
          url: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          models: { "model-a": {} },
        }}
        catalogEntry={catalogEntry}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" }));

    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
      "/api/config/test-connection",
      expect.objectContaining({ method: "POST" }),
    ));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      "openrouter",
      expect.objectContaining({
        models: {
          "model-a": expect.objectContaining({
            connectionTest: expect.objectContaining({ status: "passed" }),
          }),
        },
      }),
    ));
    expect(screen.getByText("pilotDeckConfig.panels.models.connectionNormal")).toBeTruthy();
  });
});
