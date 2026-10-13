// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

/**
 * Parte A del informe de producción — el CI rojo.
 *
 * El job `Tests on windows-2022` del CI legacy del motor de escritorio agotaba
 * su step de 90 minutos en cada push y dejaba el repositorio en rojo por
 * cambios que solo tocaban `web/`. GitHub no valida estas dos cosas al hacer
 * push: que los `paths-ignore` excluyan de verdad un cambio web y que exista un
 * tope de tiempo. Este test las vigila leyendo los workflows (texto, sin
 * dependencias nuevas) para que nadie vuelva a poner el editor web de rehén.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = resolve('..', '.github', 'workflows');
const read = (name: string): string => readFileSync(resolve(WORKFLOWS, name), 'utf8');

describe('ci.yml · un cambio solo de web/ no encola el CI de Rust', () => {
  const ci = read('ci.yml');

  it('ignora web/** y los ficheros de despliegue de la web en push y PR', () => {
    expect(ci).toMatch(/push:[\s\S]*?paths-ignore:[\s\S]*?'web\/\*\*'/);
    expect(ci).toMatch(/pull_request:[\s\S]*?paths-ignore:[\s\S]*?'web\/\*\*'/);
    for (const path of ['web/**', '**.md', 'docs.json', 'vercel.json', 'netlify.toml', '.github/workflows/deploy-gh-pages.yml']) {
      const quoted = `'${path}'`;
      expect(ci.split(quoted).length - 1, path).toBeGreaterThanOrEqual(2);
    }
  });

  it('un cambio de web/ sigue pudiendo lanzarse a mano y desde release.yml', () => {
    expect(ci).toMatch(/workflow_dispatch:/);
    expect(ci).toMatch(/workflow_call:/);
  });

  it('todo job tiene tope de tiempo y el de Windows es experimental', () => {
    // Every job must be able to hang at most the budget it declares.
    const jobs = ci.slice(ci.indexOf('jobs:'));
    const jobStarts = [...jobs.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => match.index!);
    expect(jobStarts.length).toBeGreaterThanOrEqual(2);
    for (const [index, start] of jobStarts.entries()) {
      const end = jobStarts[index + 1] ?? jobs.length;
      const job = jobs.slice(start, end);
      const name = /^ {2}([a-z][\w-]*):$/m.exec(job.slice(0, 40))?.[1] ?? '';
      expect(job, name).toMatch(/timeout-minutes:\s*\d+/);
    }
    // The Windows matrix entry is documented debt, not a blocker.
    expect(ci).toMatch(/windows-2022[\s\S]{0,600}?experimental:\s*true/);
    expect(ci).toMatch(/continue-on-error:\s*\$\{\{\s*matrix\.experimental/);
  });

  it('ningún step de cargo test puede quedarse colgado 90 minutos', () => {
    for (const match of ci.matchAll(/timeout-minutes:\s*(\d+)/g)) {
      expect(Number(match[1])).toBeLessThanOrEqual(120);
    }
  });
});

describe('deploy-gh-pages.yml · es la fuente de verdad de la web', () => {
  const deploy = read('deploy-gh-pages.yml');

  it('ejecuta los tests, el typecheck y el build del editor', () => {
    expect(deploy).toMatch(/npm (ci|install)/);
    expect(deploy).toMatch(/npm test/);
    expect(deploy).toMatch(/npm run typecheck/);
    expect(deploy).toMatch(/npm run build/);
  });

  // Regression guard for the deploy that failed at the test step on every
  // push since PR #7: jsdom 30 needs Node >= 22.22.2, and the workflow pinned
  // Node 20, so vitest died importing it and ~25 test files never ran.
  it('usa la misma versión de Node que el entorno de tests (web/.nvmrc, >= 22.22.2)', () => {
    expect(deploy).toMatch(/node-version-file:\s*web\/\.nvmrc/);
    const nvmrc = readFileSync(resolve('.nvmrc'), 'utf8').trim();
    const [major, minor, patch] = nvmrc.split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(22);
    // jsdom 30's engines field is ^22.22.2 || ^24.15.0 || >=26.
    const atLeast2222 = major === 22 && (minor! > 22 || (minor === 22 && patch! >= 2));
    expect(atLeast2222 || major === 24 || major! >= 26, nvmrc).toBe(true);
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe('>=22.22.2');
  });

  it('instala con npm ci estricto, sin un fallback a npm install que oculte un lockfile roto', () => {
    expect(deploy).toMatch(/run:\s*npm ci/);
    expect(deploy).not.toMatch(/npm ci\s*\|\|/);
  });

  it('typecheck, test y build son steps separados y el build se verifica antes de publicar', () => {
    const order = ['npm run typecheck', 'npm test', 'npm run build', 'web/dist/index.html', 'upload-pages-artifact'];
    const positions = order.map((needle) => deploy.indexOf(needle));
    for (const [index, position] of positions.entries()) expect(position, order[index]).toBeGreaterThan(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('no cancela un despliegue de Pages en curso', () => {
    expect(deploy).toMatch(/group:\s*'?pages'?[\s\S]*?cancel-in-progress:\s*false/);
  });

  it('publica web/dist bajo el sub-path /concat/', () => {
    expect(deploy).toMatch(/path:\s*'web\/dist'/);
    expect(deploy).toMatch(/web\/dist\/\.nojekyll/);
  });

  it('el build usa rutas relativas (base ./) para servir bajo /concat/', () => {
    const vite = readFileSync(resolve('vite.config.ts'), 'utf8');
    expect(vite).toMatch(/base:\s*'\.\/'/);
  });
});
