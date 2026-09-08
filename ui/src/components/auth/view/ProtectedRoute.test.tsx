// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from './ProtectedRoute';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  auth: {},
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mocks.auth,
}));

vi.mock('../../onboarding/view/Onboarding', () => ({
  default: () => <div>onboarding</div>,
}));

const readyConfiguration = {
  state: 'ready',
  modelRef: 'openai/gpt-5',
  configPath: '/tmp/pilotdeck.yaml',
  revision: 'revision',
};

function authValue(overrides = {}) {
  return {
    user: { username: 'local' },
    isLoading: false,
    needsSetup: false,
    modelConfiguration: readyConfiguration,
    gatewayRuntime: { state: 'ready' },
    refreshOnboardingStatus: vi.fn(),
    retryGateway: vi.fn(),
    ...overrides,
  };
}

afterEach(() => cleanup());

describe('ProtectedRoute runtime states', () => {
  it('shows onboarding while model configuration is missing', () => {
    mocks.auth = authValue({
      modelConfiguration: {
        state: 'needs_configuration',
        reason: 'missing_config',
        configPath: null,
        revision: '',
      },
      gatewayRuntime: { state: 'stopped' },
    });

    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('onboarding')).toBeTruthy();
  });

  it('waits for Gateway after configuration becomes ready', () => {
    mocks.auth = authValue({ gatewayRuntime: { state: 'starting' } });

    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('Loading...')).toBeTruthy();
    expect(screen.queryByText('application')).toBeNull();
  });

  it('keeps an actionable error screen when Gateway fails', () => {
    const retryGateway = vi.fn();
    mocks.auth = authValue({
      gatewayRuntime: { state: 'error', error: 'Gateway crashed' },
      retryGateway,
    });

    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('Gateway crashed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Gateway' }));
    expect(retryGateway).toHaveBeenCalledTimes(1);
  });

  it('allows authenticated users to repair invalid model config from settings', () => {
    mocks.auth = authValue({ modelConfiguration: { state: 'invalid', errors: ['bad provider'] }, gatewayRuntime: { state: 'stopped' } });
    render(<MemoryRouter initialEntries={['/settings/models']}><ProtectedRoute><div>model settings</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('model settings')).toBeTruthy();
    expect(screen.queryByText('Model configuration unavailable')).toBeNull();
  });

  it('links the model error screen to the repair settings', () => {
    mocks.auth = authValue({ modelConfiguration: { state: 'invalid', errors: ['bad provider'] }, gatewayRuntime: { state: 'stopped' } });
    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByRole('link', { name: 'openModelSettings' }).getAttribute('href')).toBe('/settings/models');
  });

  it('enters the application only after both states are ready', () => {
    mocks.auth = authValue();

    render(<MemoryRouter><ProtectedRoute><div>application</div></ProtectedRoute></MemoryRouter>);
    expect(screen.getByText('application')).toBeTruthy();
  });
});
