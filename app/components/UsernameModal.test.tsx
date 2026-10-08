// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../context/I18nContext';
import { UsernameModal } from './UsernameModal';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Au premier lancement ce champ prend le focus sous l'écran de chargement des modèles ; Firefox y montrait sa bulle d'historique de saisie
// (un compte, avec une horloge) par-dessus le chargement. Le champ doit dire au navigateur de ne rien proposer.
describe('the name field of the first launch', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const input = () => container.querySelector<HTMLInputElement>('#username')!;

  it('asks the browser not to suggest, remember or correct anything', () => {
    act(() => root.render(<I18nProvider><UsernameModal isOpen onSubmit={vi.fn(async () => {})} /></I18nProvider>));
    expect(input().getAttribute('autocomplete')).toBe('off');
    expect(input().closest('form')!.getAttribute('autocomplete')).toBe('off');
    expect(input().getAttribute('name')).toBe('studio-display-name'); // not "username": that name is what a browser matches against saved accounts
    expect(input().getAttribute('data-lpignore')).toBe('true'); // password managers
    expect(input().getAttribute('data-1p-ignore')).toBe('true');
    expect(input().getAttribute('spellcheck')).toBe('false');
  });

  it('still submits the typed name', async () => {
    const onSubmit = vi.fn(async () => {});
    act(() => root.render(<I18nProvider><UsernameModal isOpen onSubmit={onSubmit} /></I18nProvider>));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { setter.call(input(), 'Sion971'); input().dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { input().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(onSubmit).toHaveBeenCalledWith('Sion971');
  });

  it('renders nothing when closed', () => {
    act(() => root.render(<I18nProvider><UsernameModal isOpen={false} onSubmit={vi.fn(async () => {})} /></I18nProvider>));
    expect(container.querySelector('#username')).toBeNull();
  });
});
