import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PilotDeckConfig } from '../types';
import ModelsSection from './ModelsSection';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../../../utils/api', () => ({ authenticatedFetch: mocks.fetch }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it.each([false, true])('replaces the default from the deletion dialog while retaining other reference protection: %s', async (hasOtherReference) => {
  const provider = { protocol: 'openai' as const, url: 'https://example.test/v1', apiKey: '********', models: { model: {} } };
  let latest: PilotDeckConfig = { agent: { model: 'old/model' }, model: { providers: { old: provider, replacement: provider } } };
  const saves = vi.fn();
  mocks.fetch.mockImplementation(async (url: string) => ({ ok: true, json: async () => url.includes('model-references') ? { references: [
    ...(latest.agent?.model === 'old/model' ? [{ path: 'agent.model', value: 'old/model', kind: 'agent' }] : []),
    ...(hasOtherReference ? [{ path: 'memory.model', value: 'old/model', kind: 'memory' }] : []),
  ] } : { tasks: [], models: [] } }));
  function Harness() {
    const [config, setConfig] = useState(latest);
    return <ModelsSection config={config} onChange={async next => { latest = next; saves(next); setConfig(next); return { ok: true }; }} />;
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'pilotDeckConfig.actions.remove' }));
  const dialog = within(await screen.findByRole('dialog'));
  const select = await dialog.findByRole('combobox');
  expect(within(select).queryByRole('option', { name: 'old/model' })).toBeNull();
  fireEvent.change(select, { target: { value: 'replacement/model' } });
  fireEvent.click(dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.replaceDefault' }));
  await waitFor(() => expect(latest.agent?.model).toBe('replacement/model'));
  expect(latest.model?.providers?.old).toBeTruthy();
  await waitFor(() => expect(dialog.queryByText('智能体 - 主智能体模型')).toBeNull());
  const remove = dialog.getByRole('button', { name: 'pilotDeckConfig.panels.models.deleteDialog.delete' }) as HTMLButtonElement;
  await waitFor(() => expect(remove.disabled).toBe(hasOtherReference));
  if (!hasOtherReference) {
    fireEvent.click(remove);
    await waitFor(() => expect(latest.model?.providers?.old).toBeUndefined());
    expect(latest.agent?.model).toBe('replacement/model');
  }
});
