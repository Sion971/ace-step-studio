// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EditableSlider } from './EditableSlider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('EditableSlider disabled', () => {
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

  const show = (disabled?: boolean) =>
    act(() => {
      root.render(
        <EditableSlider label="Scale" value={0.5} min={0} max={1} step={0.05} onChange={() => {}} disabled={disabled} />,
      );
    });
  const clickValue = () =>
    act(() => {
      (Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '0.5') as HTMLElement).click();
    });

  it('disables the range and refuses the typed edit', () => {
    show(true);
    expect((container.querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
    clickValue();
    expect(container.querySelector('input[type="number"]')).toBeNull();
  });

  it('stays editable by default', () => {
    show();
    expect((container.querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(false);
    clickValue();
    expect(container.querySelector('input[type="number"]')).not.toBeNull();
  });
});
