import { useEffect, useRef, useState } from "react";
import { useConnectionTestTasks, isTestTaskBusy } from "../hooks/useConnectionTestTasks";
import { useTranslation } from "react-i18next";
import { isImeEnterEvent } from "../../../../../utils/ime";
import { authenticatedFetch } from "../../../../../utils/api";
import { cn } from "../../../../../lib/utils";
import {
  findCatalogProviderById,
  type CatalogModel,
  type CatalogProvider,
  type CatalogProviderProtocol,
} from "../../../../../shared/catalogProviders";
import {
  DEFAULT_MODEL_TOKEN_LIMITS,
} from "../../../../../shared/catalogProviders";
import {
  fetchProviderModels,
  type ApiModelListItem,
} from "../../../../../shared/modelListApi";
import { MASK } from "../../../shared/utils/secret";
import type { V2Provider } from "../types";
import { isMaskedSecret, providerDisplayName } from "../utils/providerRefs";
import {
  clearProviderConnectionTests,
  isProviderConfigured,
  isProviderPending,
  isProviderUrlValid,
} from "../utils/providerStatus";
import ImageCapabilityModal from "../../../../onboarding/view/subcomponents/ImageCapabilityModal";
import DeleteConfirmationModal, {
  type ModelUsageReference,
} from "./DeleteConfirmationModal";
import ProviderAvatar from "./ProviderAvatar";
import {
  CheckCircleIcon,
  InfoIcon,
  KeyIcon,
  LinkIcon,
  PendingIcon,
  PencilIcon,
  PlusIcon,
  PlugIcon,
  RefreshIcon,
  SaveIcon,
  SearchIcon,
  StackIcon,
  TrashIcon,
} from "./icons";

type ProviderCardProps = {
  providerId: string;
  provider: V2Provider;
  isNew?: boolean;
  onSave: (
    nextId: string,
    nextProvider: V2Provider,
  ) => Promise<{ ok: boolean; error?: string }>;
  onRemove: () => void;
  onCancelNew?: () => void;
  onPendingChange?: (pending: boolean) => void;
  catalogEntry?: CatalogProvider;
  initialEditing?: boolean;
  defaultModelOptions?: string[];
  onReplaceDefaultModel?: (modelRef: string) => Promise<{ ok: boolean; error?: string }>;
};

type DeleteDialogState = {
  kind: "model" | "provider";
  modelId?: string;
  name: string;
  usages: Array<{ modelName?: string; reference: ModelUsageReference }>;
  loading: boolean;
  error: string;
};

type ModelCapabilitiesRecord = {
  maxOutputTokens?: number;
  maxContextTokens?: number;
  [key: string]: unknown;
};

function asModelRecord(value: Record<string, unknown> | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" ? { ...value } : {};
}

function readCapabilities(model: Record<string, unknown> | null | undefined): ModelCapabilitiesRecord {
  const record = asModelRecord(model);
  const capabilities = record.capabilities;
  return capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    ? { ...(capabilities as ModelCapabilitiesRecord) }
    : {};
}

function catalogModelFor(
  catalogEntry: CatalogProvider | undefined,
  modelId: string,
): CatalogModel | undefined {
  return catalogEntry?.models.find((model) => model.id === modelId || model.aliases?.includes(modelId));
}

export default function ProviderCard({
  providerId,
  provider,
  isNew = false,
  onSave,
  onRemove,
  onCancelNew,
  onPendingChange,
  catalogEntry,
  initialEditing = false,
  defaultModelOptions = [],
  onReplaceDefaultModel,
}: ProviderCardProps) {
  const { t } = useTranslation("settings");
  const [draftProvider, setDraftProvider] = useState<V2Provider>(provider);
  const [editing, setEditing] = useState(isNew || initialEditing);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [draftCustomModelId, setDraftCustomModelId] = useState<string | null>(null);
  const [modelSearch, setModelSearch] = useState("");
  const [providerIdDraft, setProviderIdDraft] = useState(providerId);
  const [providerIdError, setProviderIdError] = useState("");
  const trimmedProviderId = providerIdDraft.trim();
  const effectiveCatalogEntry = catalogEntry?.id === trimmedProviderId
    ? catalogEntry
    : findCatalogProviderById(trimmedProviderId);
  const isMaskedKey = isMaskedSecret(draftProvider.apiKey);
  const protocol = draftProvider.protocol ?? effectiveCatalogEntry?.protocol ?? "openai";
  const effectiveUrl = draftProvider.url || effectiveCatalogEntry?.defaultUrl || "";
  const enabledModels = Object.keys(draftProvider.models ?? {});
  const providerRequiresApiKeyInForm = trimmedProviderId === "ollama"
    ? false
    : effectiveCatalogEntry
      ? effectiveCatalogEntry.requiresApiKey !== false
        && !effectiveCatalogEntry.apiKeyEnvVar
      : true;
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [apiModelsStatus, setApiModelsStatus] = useState<"idle" | "loading" | "error">("idle");
  const [apiModelsError, setApiModelsError] = useState("");
  const tests = useConnectionTestTasks();
  const task = tests.tasks.find(item => item.providerId === providerId);
  const activeTask = tests.tasks.find(isTestTaskBusy);
  const ownBusy = isTestTaskBusy(task);
  const testStatus = task?.status ?? "idle";
  const testMessage = task?.message;
  const manualModelIds = testStatus === "manual"
    ? (task?.result?.models ?? []).filter(model => model.textInput === "supported" && model.imageInput === "unknown").map(model => model.modelId)
    : [];
  const testDisabled = tests.checking || tests.pending || !!activeTask || saving;
  const [deleteDialog, setDeleteDialog] = useState<DeleteDialogState | null>(null);
  const displayName = providerDisplayName(
    providerIdDraft || providerId,
    effectiveCatalogEntry,
    t("pilotDeckConfig.panels.models.customProvider"),
  );
  const configured = isProviderConfigured(draftProvider, effectiveCatalogEntry);
  const fieldsDisabled = !editing || saving;
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;

  useEffect(() => {
    if (editing) return;
    setDraftProvider(provider);
    setProviderIdDraft(providerId);
    setProviderIdError("");
  }, [editing, provider, providerId]);

  useEffect(() => {
    onPendingChangeRef.current?.(isProviderPending(draftProvider, effectiveCatalogEntry));
  }, [draftProvider, effectiveCatalogEntry]);

  const update = (patchValue: Partial<V2Provider>) => {
    setProviderIdError("");
    setDraftProvider((prev) => {
      const next = { ...prev, ...patchValue };
      const credentialsChanged = ["apiKey", "url", "protocol"].some(
        (key) => key in patchValue && patchValue[key as keyof V2Provider] !== prev[key as keyof V2Provider],
      );
      return credentialsChanged ? clearProviderConnectionTests(next) : next;
    });
  };

  const cancelEditing = () => {
    if (isNew) {
      onCancelNew?.();
      return;
    }
    setDraftProvider(provider);
    setProviderIdDraft(providerId);
    setProviderIdError("");
    setDraftCustomModelId(null);
    setModelSearch("");
    setEditing(false);
  };

  const saveEditing = async () => {
    if (savingRef.current) return;
    const nextId = trimmedProviderId;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(nextId)) {
      setProviderIdError(t("pilotDeckConfig.panels.models.providerIdInvalid"));
      return;
    }
    if (!effectiveUrl.trim()) {
      setProviderIdError(t("pilotDeckConfig.panels.models.providerUrlRequired"));
      return;
    }
    if (!isProviderUrlValid(effectiveUrl)) {
      setProviderIdError(t("pilotDeckConfig.panels.models.providerUrlInvalid"));
      return;
    }
    if (providerRequiresApiKeyInForm && !draftProvider.apiKey?.trim()) {
      setProviderIdError(t("pilotDeckConfig.panels.models.providerApiKeyRequired"));
      return;
    }
    if (enabledModels.length === 0) {
      setProviderIdError(t("pilotDeckConfig.panels.models.providerModelRequired"));
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setProviderIdError("");
    try {
      const result = await onSave(nextId, {
        ...draftProvider,
        protocol,
        url: effectiveUrl,
      });
      if (!result.ok) {
        setProviderIdError(
          result.error || t("pilotDeckConfig.panels.models.providerIdDuplicate"),
        );
        return;
      }
      setEditing(false);
      setDraftCustomModelId(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const addModel = (mid: string) => {
    const id = mid.trim();
    if (!id) return;
    if (draftProvider.models && id in draftProvider.models) return;
    update({ models: { ...(draftProvider.models ?? {}), [id]: {} } });
    setDraftCustomModelId(null);
  };

  const openCustomModelInput = () => {
    if (draftCustomModelId != null) {
      addModel(draftCustomModelId);
      return;
    }
    setDraftCustomModelId("");
  };

  const commitCustomModel = () => {
    if (draftCustomModelId == null) return;
    addModel(draftCustomModelId);
  };

  const removeModel = (mid: string) => {
    const next = { ...(draftProvider.models ?? {}) };
    delete next[mid];
    update({ models: next });
  };

  const patchModelCapabilities = (
    modelId: string,
    patchValue: { maxOutputTokens?: number; maxContextTokens?: number },
  ) => {
    const current = asModelRecord(draftProvider.models?.[modelId]);
    const capabilities = { ...readCapabilities(current), ...patchValue };
    update({
      models: {
        ...(draftProvider.models ?? {}),
        [modelId]: { ...current, capabilities },
      },
    });
  };

  const tokenValue = (modelId: string, key: "maxOutputTokens" | "maxContextTokens") => {
    const stored = readCapabilities(draftProvider.models?.[modelId])[key];
    if (typeof stored === "number" && stored > 0) return stored;
    const catalog = catalogModelFor(effectiveCatalogEntry, modelId);
    if (typeof catalog?.[key] === "number") return catalog[key];
    return DEFAULT_MODEL_TOKEN_LIMITS[protocol][key];
  };

  const modelLabel = (modelId: string) =>
    catalogModelFor(effectiveCatalogEntry, modelId)?.displayName ?? modelId;

  const openDeleteDialog = async (kind: "model" | "provider", modelId?: string) => {
    const name = kind === "model" && modelId ? modelLabel(modelId) : displayName;
    const target: DeleteDialogState = {
      kind,
      modelId,
      name,
      usages: [],
      loading: false,
      error: "",
    };
    const needsReferenceCheck = kind === "provider"
      ? !isNew
      : Boolean(modelId && provider.models && modelId in provider.models);
    if (!needsReferenceCheck) {
      setDeleteDialog(target);
      return;
    }

    setDeleteDialog({ ...target, loading: true });
    try {
      const params = new URLSearchParams({ providerId });
      if (modelId) params.set("modelId", modelId);
      const response = await authenticatedFetch(`/api/config/model-references?${params.toString()}`, {
        suppressServerErrorToast: true,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDeleteDialog({
          ...target,
          error: data.message || data.error || t("pilotDeckConfig.panels.models.deleteDialog.checkFailed"),
        });
        return;
      }
      const references: ModelUsageReference[] = Array.isArray(data.references)
        ? data.references.filter((reference: unknown): reference is ModelUsageReference => (
          Boolean(reference)
          && typeof reference === "object"
          && typeof (reference as ModelUsageReference).path === "string"
          && typeof (reference as ModelUsageReference).value === "string"
        ))
        : [];
      setDeleteDialog({
        ...target,
        usages: references.map((reference) => {
          if (kind !== "provider") return { reference };
          const prefix = `${providerId}/`;
          const referencedModelId = reference.value.startsWith(prefix)
            ? reference.value.slice(prefix.length)
            : reference.value;
          return { modelName: modelLabel(referencedModelId), reference };
        }),
      });
    } catch (error) {
      setDeleteDialog({
        ...target,
        error: error instanceof Error
          ? error.message
          : t("pilotDeckConfig.panels.models.deleteDialog.checkFailed"),
      });
    }
  };

  const confirmDelete = () => {
    if (!deleteDialog) return;
    if (deleteDialog.kind === "model" && deleteDialog.modelId) {
      removeModel(deleteDialog.modelId);
    } else {
      onRemove();
    }
    setDeleteDialog(null);
  };

  const providerRequiresApiKey = providerRequiresApiKeyInForm;
  const usesOfficialEndpoint = effectiveCatalogEntry
    && effectiveUrl.replace(/\/+$/, "") === effectiveCatalogEntry.defaultUrl.replace(/\/+$/, "");
  const modelListUrl = usesOfficialEndpoint
    ? effectiveCatalogEntry.modelListUrl ?? effectiveUrl
    : effectiveUrl;
  const hasCompleteModelListUrl = (() => {
    try {
      const url = new URL(modelListUrl);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  })();
  const modelListNeedsApiKey = Boolean(
    providerRequiresApiKeyInForm,
  );
  const canFetchModels = Boolean(
    hasCompleteModelListUrl && (!modelListNeedsApiKey || draftProvider.apiKey),
  );
  const fallbackModels: ApiModelListItem[] =
    effectiveCatalogEntry?.models.map(({ id, displayName }) => ({ id, displayName })) ?? [];
  const candidateModels = (apiModels ?? []).filter((model) => {
    if (draftProvider.models && model.id in draftProvider.models) return false;
    return model.id.toLocaleLowerCase().includes(modelSearch.trim().toLocaleLowerCase());
  });

  const refreshModels = async () => {
    if (!canFetchModels) {
      setApiModels(fallbackModels);
      return;
    }
    setApiModelsStatus("loading");
    setApiModelsError("");
    try {
      const models = await fetchProviderModels({
        protocol,
        baseUrl: modelListUrl,
        apiKey: draftProvider.apiKey ?? "",
        providerId: isMaskedKey ? providerId : trimmedProviderId,
      });
      setApiModels(models);
      setApiModelsStatus("idle");
    } catch (error) {
      setApiModels(fallbackModels);
      setApiModelsStatus("error");
      setApiModelsError(error instanceof Error ? error.message : String(error));
    }
  };

  const startEditing = () => {
    setEditing(true);
    void refreshModels();
  };

  const apiKeyInputValue = isMaskedKey ? MASK : (draftProvider.apiKey ?? "");

  return (
    <section className="provider-detail" aria-label={t("pilotDeckConfig.panels.models.providerAria", { name: displayName })}>
      <header className="detail-header">
        <div className="detail-identity">
          <span className="detail-provider-icon">
            <ProviderAvatar providerId={providerIdDraft || providerId} catalogEntry={effectiveCatalogEntry} />
          </span>
          <div>
            <div className="detail-title-line">
              <h2>{displayName}</h2>
              <span className={`status-badge${configured ? "" : " pending"}`}>
                {configured ? <CheckCircleIcon size={14} /> : <PendingIcon size={14} />}
                {configured
                  ? t("pilotDeckConfig.panels.models.configured")
                  : t("pilotDeckConfig.panels.models.pending")}
              </span>
            </div>
          </div>
        </div>
        <div className="detail-actions">
          {editing ? (
            <>
              <button
                className="button secondary compact"
                type="button"
                onClick={cancelEditing}
                disabled={saving}
              >
                {t("settingsPage.actions.cancel")}
              </button>
              <button
                className="button primary compact"
                type="button"
                onClick={() => void saveEditing()}
                disabled={saving}
              >
                <SaveIcon /> {t("actions.saveChanges")}
              </button>
            </>
          ) : (
            <button
              className="button secondary compact edit-provider-button"
              type="button"
              onClick={startEditing}
              disabled={ownBusy}
            >
              <PencilIcon /> {t("settingsPage.actions.edit")}
            </button>
          )}
          <button
            className="button destructive-outline compact"
            type="button"
            onClick={() => void openDeleteDialog("provider")}
            disabled={saving || ownBusy}
          >
            <TrashIcon /> {t("pilotDeckConfig.actions.remove")}
          </button>
        </div>
      </header>

      <div className="detail-scroll">
        <section className="form-section">
          <div className="section-heading">
            <span className="section-icon"><LinkIcon /></span>
            <div><h3>{t("pilotDeckConfig.panels.models.connectionInfo")}</h3></div>
          </div>

          {editing && (
            <label className="field">
              <span>{t("pilotDeckConfig.panels.models.providerId")}</span>
              <input
                value={providerIdDraft}
                onChange={(event) => {
                  setProviderIdDraft(event.target.value);
                  setProviderIdError("");
                }}
                className="mono"
              />
              {providerIdError ? <small className="field-error">{providerIdError}</small> : null}
            </label>
          )}

          {editing && !effectiveCatalogEntry && (
            <div className="connection-grid">
              <label className="field">
                <span>{t("pilotDeckConfig.panels.models.protocol")}</span>
                <select
                  value={protocol}
                  onChange={(event) => update({ protocol: event.target.value as CatalogProviderProtocol })}
                >
                  <option value="openai">{t("pilotDeckConfig.panels.models.protocolOptions.openai")}</option>
                  <option value="openai-responses">{t("pilotDeckConfig.panels.models.protocolOptions.openaiResponses")}</option>
                  <option value="anthropic">{t("pilotDeckConfig.panels.models.protocolOptions.anthropic")}</option>
                  <option value="google">{t("pilotDeckConfig.panels.models.protocolOptions.google")}</option>
                </select>
              </label>
              <label className="field">
                <span>{t("pilotDeckConfig.panels.models.baseUrl")}</span>
                <input
                  value={draftProvider.url ?? ""}
                  placeholder="https://api.example.com/v1"
                  className="mono"
                  onChange={(event) => update({ url: event.target.value })}
                />
              </label>
            </div>
          )}

          <label className="field api-field">
            <span>
              {t("pilotDeckConfig.panels.models.apiKey")}
              {!providerRequiresApiKey ? ` (${t("pilotDeckConfig.panels.models.optional")})` : ""}
            </span>
            <span className="secret-input">
              <KeyIcon />
              <input
                required={providerRequiresApiKey}
                placeholder={t("pilotDeckConfig.panels.models.apiKeyPlaceholder")}
                aria-invalid="false"
                aria-label={t("pilotDeckConfig.panels.models.apiKey")}
                type="password"
                value={apiKeyInputValue}
                disabled={fieldsDisabled}
                onChange={(event) => update({ apiKey: event.target.value })}
              />
            </span>
            {isMaskedKey ? (
              <small className="field-help">
                <InfoIcon /> {t("pilotDeckConfig.panels.models.keySaved")}
              </small>
            ) : null}
          </label>
        </section>

        <section className="form-section models-section">
          <div className="section-heading with-meta">
            <span className="section-icon"><StackIcon /></span>
            <div><h3>{t("pilotDeckConfig.panels.models.enabledModels")}</h3></div>
            <span className="model-count">{enabledModels.length}</span>
          </div>

          <div className="model-list">
            {enabledModels.map((mid) => (
              <div className="model-row" key={mid}>
                <strong className="model-name">{modelLabel(mid)}</strong>
                <label className="model-token-field">
                  <span>{t("pilotDeckConfig.panels.models.maxOutputTokens")}</span>
                  <input
                    aria-label={`${modelLabel(mid)} ${t("pilotDeckConfig.panels.models.maxOutputTokens")}`}
                    type="text"
                    inputMode="numeric"
                    value={tokenValue(mid, "maxOutputTokens")}
                    disabled={fieldsDisabled}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next > 0) {
                        patchModelCapabilities(mid, { maxOutputTokens: next });
                      }
                    }}
                  />
                </label>
                <label className="model-token-field">
                  <span>{t("pilotDeckConfig.panels.models.maxContextTokens")}</span>
                  <input
                    aria-label={`${modelLabel(mid)} ${t("pilotDeckConfig.panels.models.maxContextTokens")}`}
                    type="text"
                    inputMode="numeric"
                    value={tokenValue(mid, "maxContextTokens")}
                    disabled={fieldsDisabled}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (Number.isFinite(next) && next > 0) {
                        patchModelCapabilities(mid, { maxContextTokens: next });
                      }
                    }}
                  />
                </label>
                <button
                  type="button"
                  aria-label={t("pilotDeckConfig.panels.models.removeModelAria", { name: modelLabel(mid) })}
                  disabled={fieldsDisabled || ownBusy}
                  onClick={() => void openDeleteDialog("model", mid)}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        </section>

        {editing && (
          <section className="form-section candidate-models-section">
            <div className="section-heading with-meta">
              <span className="section-icon"><StackIcon /></span>
              <div><h3>{t("pilotDeckConfig.panels.models.candidateModels")}</h3></div>
              <span className="model-count">{candidateModels.length}</span>
              <button
                type="button"
                className="fetch-models-button"
                onClick={() => void refreshModels()}
                disabled={!canFetchModels || apiModelsStatus === "loading"}
              >
                <RefreshIcon className={cn(apiModelsStatus === "loading" && "spin")} />
                {t("pilotDeckConfig.panels.models.fetchApiModels")}
              </button>
            </div>

            <label className="candidate-model-search">
              <SearchIcon />
              <input
                value={modelSearch}
                onChange={(event) => setModelSearch(event.target.value)}
                placeholder={t("pilotDeckConfig.panels.models.searchCandidateModels")}
                aria-label={t("pilotDeckConfig.panels.models.searchCandidateModels")}
              />
            </label>

            {apiModelsStatus === "error" && apiModelsError ? (
              <div className="field-error banner">{apiModelsError}</div>
            ) : null}

            <div className="candidate-model-list">
              <button
                type="button"
                className="candidate-add-model"
                onClick={openCustomModelInput}
              >
                <PlusIcon size={14} />
                {t("pilotDeckConfig.panels.models.addModelId")}
              </button>
              {draftCustomModelId != null ? (
                <input
                  className="candidate-model-input"
                  type="text"
                  value={draftCustomModelId}
                  placeholder={t("pilotDeckConfig.panels.models.customModelIdPlaceholder")}
                  aria-label={t("pilotDeckConfig.panels.models.customModelIdPlaceholder")}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => setDraftCustomModelId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !isImeEnterEvent(event)) {
                      event.preventDefault();
                      commitCustomModel();
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraftCustomModelId(null);
                    }
                  }}
                />
              ) : null}
              {candidateModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className="candidate-model"
                  title={model.id}
                  onClick={() => addModel(model.id)}
                >
                  <span>{model.id}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!editing && (
          <section className="detail-test-section" aria-label={t("pilotDeckConfig.panels.models.testConnection")}>
            <p className="test-cost-note">{t("pilotDeckConfig.panels.models.testCostNote")}</p>
            <div className="test-row">
              {(testStatus === "error" || testStatus === "saveError") && testMessage ? (
                <div className="test-failure-message">
                  <PendingIcon size={16} />
                  <strong>{t(`pilotDeckConfig.panels.models.${testStatus === "saveError" ? "testSaveFailed" : "testFailed"}`)}</strong>
                  <span title={testMessage}>{testMessage}</span>
                </div>
              ) : null}
              {tests.errorCode && <span role="status">{t(`pilotDeckConfig.panels.models.${tests.errorCode === "RATE_LIMITED" ? "testRateLimited" : tests.errorCode === "TEST_BUSY" ? "testBusy" : tests.errorCode === "STATUS_UNAVAILABLE" ? "testStatusUnavailable" : "testRequestFailed"}`)}</span>}
              <button
                className={cn("test-button", testStatus)}
                type="button"
                disabled={testDisabled || !configured}
                onClick={() => void (testStatus === "saveError" && task ? tests.retry(task.id) : tests.start(providerId))}
              >
                {tests.checking ? t("pilotDeckConfig.panels.models.checkingTestStatus")
                  : testStatus === "savingTest" ? t("pilotDeckConfig.panels.models.savingTest")
                  : testStatus === "testing" ? <><RefreshIcon className="spin" /> {t("pilotDeckConfig.panels.models.testing")}</>
                  : testStatus === "cancelling" ? t("pilotDeckConfig.panels.models.cancellingTest")
                  : testStatus === "manual" ? t("pilotDeckConfig.panels.models.awaitingImageConfirmation")
                  : testStatus === "saveError" ? t("pilotDeckConfig.panels.models.retryTestSave")
                  : testStatus === "success" ? <><CheckCircleIcon /> {t("pilotDeckConfig.panels.models.connectionNormal")}</>
                  : testStatus === "error" || testStatus === "cancelled" ? <><RefreshIcon /> {t("pilotDeckConfig.panels.models.retest")}</>
                  : <><PlugIcon /> {t("pilotDeckConfig.panels.models.testConnection")}</>}
              </button>
              {testStatus === "saveError" && (
                <button className="test-button" type="button" disabled={testDisabled || !configured} onClick={() => void tests.start(providerId)}>
                  {t("pilotDeckConfig.panels.models.retest")}
                </button>
              )}
              {task && ["testing", "manual"].includes(testStatus) && (
                <button className="test-button" type="button" disabled={tests.pending} onClick={() => void tests.cancel(task.id)}>
                  {t("pilotDeckConfig.panels.models.cancelTest")}
                </button>
              )}

            </div>
          </section>
        )}
      </div>
      {manualModelIds.length > 0 && (
        <ImageCapabilityModal
          key={task?.id}
          modelIds={manualModelIds}
          onCancel={() => { if (task && !tests.pending) void tests.cancel(task.id); }}
          onConfirm={(values) => { if (task) void tests.confirm(task.id, values); }}
        />
      )}
      {deleteDialog && (
        <DeleteConfirmationModal
          kind={deleteDialog.kind}
          name={deleteDialog.name}
          usages={deleteDialog.usages}
          loading={deleteDialog.loading}
          error={deleteDialog.error}
          replacementOptions={defaultModelOptions.filter(ref => deleteDialog.kind === "provider"
            ? !ref.startsWith(`${providerId}/`)
            : ref !== `${providerId}/${deleteDialog.modelId}`)}
          onReplaceDefault={onReplaceDefaultModel ? async (modelRef) => {
            const target = deleteDialog;
            const result = await onReplaceDefaultModel(modelRef);
            if (!result.ok) throw new Error(result.error || t("pilotDeckConfig.panels.models.deleteDialog.replaceFailed"));
            await openDeleteDialog(target.kind, target.modelId);
          } : undefined}
          onCancel={() => setDeleteDialog(null)}
          onConfirm={confirmDelete}
        />
      )}
    </section>
  );
}
