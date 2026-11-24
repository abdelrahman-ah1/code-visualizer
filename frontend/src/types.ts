export type Value =
  | { kind: 'scalar'; type: string; value: string | number | boolean | null; truncated?: boolean }
  | { kind: 'ref'; id: string }
  | { kind: 'opaque'; type: string }
  | { kind: 'truncated'; type: string };
export interface HeapNode {
  type: string; items?: Value[]; entries?: [Value, Value][];
  fields?: Record<string, Value>; length?: number; truncated?: boolean; opaque?: boolean;
  // M5, C++ only. Optional extras: readers that do not know them ignore them.
  storage?: 'stack' | 'heap' | 'global' | 'unknown'; address?: string; freed?: boolean; element_type?: string;
}
// M5: findings from the compiler, the scanner, the memory checker and the run itself.
export interface Diagnostic {
  source: string; severity: 'error' | 'warning' | 'info'; kind: string; message: string; line?: number; column?: number;
  freed_line?: number; allocated_line?: number;
}
export interface Frame { depth: number; function: string; line: number; locals: Record<string, Value> }
export interface TraceEvent {
  step: number; event: 'call' | 'line' | 'return' | 'exception'; line: number;
  frames: Frame[]; heap: Record<string, HeapNode>; stdout: string; stderr: string;
  truncated: string[]; return_value?: Value; exception_type?: string;
}
export type RunStatus = 'ok' | 'error' | 'timeout' | 'trace_limit' | 'output_limit' | 'unsupported' | 'worker_error';
export interface Trace {
  schema_version: 'codeviz.trace/1.0'; source: string;
  runtime: { implementation: string; version: string };
  limits: { wall_seconds: number; events: number; output_chars: number };
  events: TraceEvent[]; status: RunStatus; complete: boolean;
  stdout?: string; stderr?: string; error?: { type: string; line?: number };
  resource_limits_applied?: boolean;
  diagnostics?: Diagnostic[]; exit_code?: number; compile_ms?: number; trace_ms?: number;
}
