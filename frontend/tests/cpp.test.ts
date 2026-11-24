import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
const load = (n: string) => JSON.parse(readFileSync(new URL(`../public/examples/${n}.trace.json`, import.meta.url), 'utf8'));
const names = ['cpp_01_linked_list_swap', 'cpp_02_arrays_structs', 'cpp_03_recursion', 'cpp_04_binary_tree_insert', 'cpp_05_crash_null_pointer', 'cpp_06_use_after_free', 'cpp_07_memory_leak', 'cpp_08_uncaught_exception', 'cpp_09_string_and_vector'];
it.each(names)('real C++ recording %s passes the reader', (n) => {
  const t = parseTrace(JSON.stringify(load(n)));
  expect(t.events.length).toBeGreaterThan(0);
});
it('crash recording keeps its diagnostics and partial trace', () => {
  const t = parseTrace(JSON.stringify(load('cpp_05_crash_null_pointer')));
  expect(t.status).toBe('error'); expect(t.diagnostics?.length).toBeGreaterThan(0);
});
it('use-after-free recording shows a freed node', () => {
  const t = parseTrace(JSON.stringify(load('cpp_06_use_after_free')));
  const freed = t.events.some((e) => Object.values(e.heap).some((n) => n.freed));
  expect(freed).toBe(true);
});
it('older Python recordings without the new fields still load', () => {
  expect(parseTrace(JSON.stringify(load('05_alias'))).events.length).toBeGreaterThan(0);
});
it('rejects malformed diagnostics', () => {
  const t = load('cpp_05_crash_null_pointer');
  t.diagnostics = [{ source: 'x' }];
  expect(() => parseTrace(JSON.stringify(t))).toThrow();
  t.diagnostics = 'nope';
  expect(() => parseTrace(JSON.stringify(t))).toThrow();
});
it('rejects a bad freed flag and bad exit_code', () => {
  const t = load('cpp_06_use_after_free');
  const bad = JSON.parse(JSON.stringify(t)); bad.exit_code = 'x';
  expect(() => parseTrace(JSON.stringify(bad))).toThrow();
});
