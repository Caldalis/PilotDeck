import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("keeps test buttons disabled while status is unavailable and recovers by polling", async () => {
    mocks.authenticatedFetch.mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ ok: true, json: async () => ({ tasks: [{ id: "task", providerId: "HXAPI", status: "testing" }] }) });
    render(<ProviderCard providerId="HXAPI" provider={{ protocol: "openai", url: "https://example.test", apiKey: "********", models: { model: {} } }} onSave={vi.fn()} onRemove={vi.fn()} />);
    await screen.findByText("pilotDeckConfig.panels.models.testStatusUnavailable");
    expect((screen.getByRole("button", { name: "pilotDeckConfig.panels.models.checkingTestStatus" }) as HTMLButtonElement).disabled).toBe(true);
    await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.testing" }, { timeout: 3000 });
    expect((screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testing" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("retains manual choices across changed polling snapshots until confirmation", async () => {
    let polls = 0;
    let status = "manual";
    mocks.authenticatedFetch.mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") status = "success";
      else polls++;
      return { ok: true, json: async () => ({ tasks: [{
        id: "manual-task", providerId: "HXAPI", status, updatedAt: polls,
        result: { models: ["one", "two"].map(modelId => ({ modelId, textInput: "supported", imageInput: "unknown" })) },
      }] }) };
    });
    render(<ProviderCard providerId="HXAPI" provider={{ protocol: "openai", url: "https://example.test", apiKey: "********", models: { one: {}, two: {} } }} onSave={vi.fn()} onRemove={vi.fn()} />);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getAllByRole("radio", { name: "connection.manualUnsupported" })[0]);
    await waitFor(() => expect(polls).toBeGreaterThanOrEqual(3), { timeout: 4000 });
    expect((screen.getAllByRole("radio", { name: "connection.manualUnsupported" })[0] as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getAllByRole("radio", { name: "connection.manualSupported" })[1]);
    const before = polls;
    await waitFor(() => expect(polls).toBeGreaterThan(before), { timeout: 3000 });
    fireEvent.click(screen.getByRole("button", { name: "connection.manualConfirm" }));
    await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.connectionNormal" });
    const submission = mocks.authenticatedFetch.mock.calls.find(([, options]) => options?.method === "PUT");
    expect(JSON.parse(submission?.[1].body)).toEqual({ models: [
      { modelId: "one", imageInput: "unsupported" }, { modelId: "two", imageInput: "supported" },
    ] });
  });

  it("restores a running task after remount and disables testing on other providers", async () => {
    let tasks: Array<Record<string, unknown>> = [];
    mocks.authenticatedFetch.mockImplementation(async (_url, options) => {
      if (options?.method === "POST") tasks = [{ id: "task-1", providerId: "HXAPI", status: "testing" }];
      return { ok: true, json: async () => ({ tasks }) };
    });
    const provider = { protocol: "openai" as const, url: "https://example.test/v1", apiKey: "********", models: { model: {} } };
    const props = { provider, onSave: vi.fn(), onRemove: vi.fn() };
    const first = render(<ProviderCard providerId="HXAPI" {...props} />);
    await waitFor(() => expect((screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testing" }) as HTMLButtonElement).disabled).toBe(true));
    first.unmount();
    const other = render(<ProviderCard providerId="aicore" {...props} />);
    await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" });
    expect(screen.queryByText("pilotDeckConfig.panels.models.otherProviderTesting")).toBeNull();
    expect((screen.getByRole("button", { name: "pilotDeckConfig.panels.models.testConnection" }) as HTMLButtonElement).disabled).toBe(true);
    other.unmount();
    render(<ProviderCard providerId="HXAPI" {...props} />);
    await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.testing" });
    tasks = [{ id: "task-1", providerId: "HXAPI", status: "savingTest" }];
    await waitFor(() => expect((screen.getByRole("button", { name: "pilotDeckConfig.panels.models.savingTest" }) as HTMLButtonElement).disabled).toBe(true), { timeout: 3000 });
    tasks = [{ id: "task-1", providerId: "HXAPI", status: "success" }];
    await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.connectionNormal" }, { timeout: 3000 });
    expect(mocks.authenticatedFetch.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("restores save failures and retries server-side saving without starting a new test", async () => {
    let tasks = [{ id: "task-1", providerId: "HXAPI", status: "saveError", message: "Save failed" }];
    mocks.authenticatedFetch.mockImplementation(async (url) => {
      if (url.endsWith("/retry")) tasks = [{ ...tasks[0], status: "success", message: "" }];
      return { ok: true, json: async () => ({ tasks }) };
    });
    render(<ProviderCard providerId="HXAPI" provider={{ protocol: "openai", url: "https://example.test", apiKey: "********", models: { model: {} } }} onSave={vi.fn()} onRemove={vi.fn()} />);
    await screen.findByText("pilotDeckConfig.panels.models.testSaveFailed");
    expect(screen.queryByRole("button", { name: "pilotDeckConfig.panels.models.connectionNormal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "pilotDeckConfig.panels.models.retryTestSave" }));
    await screen.findByRole("button", { name: "pilotDeckConfig.panels.models.connectionNormal" });
    expect(mocks.authenticatedFetch).toHaveBeenCalledWith("/api/config/connection-test-tasks/task-1/retry", expect.objectContaining({ method: "POST" }));
  });
});
