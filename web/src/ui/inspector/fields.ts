// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Field builders for the Fase 4 inspector sections. Sliders show the value
 * live on `input` and commit once on `change` (pointer release / keyboard),
 * so a drag is a single history entry.
 */

/** A collapsible group (`<details>`), open by default when active. */
export function group(title: string, open: boolean, children: HTMLElement[], className = ''): HTMLElement {
  const box = document.createElement('details');
  box.className = `inspector-group fx-group ${className}`.trim();
  box.open = open;
  const summary = document.createElement('summary');
  summary.className = 'inspector-group-title';
  summary.textContent = title;
  box.appendChild(summary);
  box.append(...children);
  return box;
}

/** A sub-heading inside a group. */
export function subheading(text: string): HTMLElement {
  const h = document.createElement('h4');
  h.className = 'fx-subheading';
  h.textContent = text;
  return h;
}

/**
 * A labelled range slider with a live readout.
 * @param label visible label.
 * @param value current value.
 * @param range min/max/step.
 * @param commit called once per change.
 * @param format readout formatter.
 * @returns the row.
 */
export function slider(
  label: string,
  value: number,
  range: { min: number; max: number; step: number },
  commit: (value: number) => void,
  format: (value: number) => string = (v) => String(Math.round(v * 100) / 100),
): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field-row fx-slider';
  const title = document.createElement('span');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  const readout = document.createElement('output');
  readout.className = 'fx-readout';
  readout.textContent = format(value);
  input.setAttribute('aria-valuetext', readout.textContent);
  input.addEventListener('input', () => {
    readout.textContent = format(Number(input.value));
    input.setAttribute('aria-valuetext', readout.textContent);
  });
  input.addEventListener('change', () => commit(Number(input.value)));
  row.append(title, input, readout);
  return row;
}

/** A labelled checkbox. */
export function check(label: string, checked: boolean, commit: (value: boolean) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field-row';
  const title = document.createElement('span');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => commit(input.checked));
  row.append(title, input);
  return row;
}

/** A labelled select. */
export function select<T extends string>(label: string, value: T, options: readonly { value: T; label: string }[], commit: (value: T) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field-row';
  const title = document.createElement('span');
  title.textContent = label;
  const input = document.createElement('select');
  input.className = 'input';
  input.setAttribute('aria-label', label);
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option.value;
    el.textContent = option.label;
    input.appendChild(el);
  }
  input.value = value;
  input.addEventListener('change', () => {
    const chosen = options.find((option) => option.value === input.value);
    if (chosen) commit(chosen.value);
  });
  row.append(title, input);
  return row;
}

/** A labelled number input. */
export function number(label: string, value: number, range: { min: number; max: number; step: number }, commit: (value: number) => void): HTMLElement {
  const row = document.createElement('label');
  row.className = 'field-row';
  const title = document.createElement('span');
  title.textContent = label;
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'input';
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v)) commit(Math.min(range.max, Math.max(range.min, v)));
  });
  row.append(title, input);
  return row;
}

/** A small button. */
export function button(label: string, onClick: () => void, title = label, className = 'btn btn-ghost btn-small'): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = className;
  el.textContent = label;
  el.title = title;
  el.addEventListener('click', onClick);
  return el;
}

/** A row of buttons. */
export function actions(...buttons: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'fx-actions';
  row.append(...buttons);
  return row;
}
