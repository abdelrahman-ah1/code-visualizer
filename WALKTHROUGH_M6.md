# Milestone 6 walkthrough: file by file
New
- frontend/src/graphlayout.ts: stabilize() keeps a remembered x unless the fresh x is more than 0.5 slot away, and pushes same-row overlaps apart. layeredLayout() does BFS layers, 4 barycenter sweeps, 6 relax passes, components side by side.
- frontend/tests/m6.test.ts: 16 unit tests (graph detection, aliasing, direction, self loops, stability ceilings).
- frontend/tests/m6.spec.ts: 7 browser tests (Python graph, n-ary tree, BST stepping, rotation, shared-list fallback, C++ vector<Node*> graph).
- frontend/tests/programs/m6/*: the example programs. frontend/tests/fixtures/m6/*.m6.json: their recorded traces (named .m6.json so the repo's *.trace.json ignore rule does not hide them).
Changed
- structures.ts: graphSpec() decides which types are graph vertices (a heap-unshared array whose items are same-type records/null/truncated). Shared arrays keep the plain view. buildScene runs tree placement through stabilize(), places the graph block below, one line per vertex pair (two-headed only when reciprocal), x-n labels for multi-edges, self loops. Fixes flat cards overlapping arrays.
- components/Structures.tsx: renderVertex (card, id, tooltip with edges and neighbour list, "N edges not captured"), start markers for two-headed edges, edge test ids.
- style.css: .edge-label.
Unchanged: tracer, trace format, arrow router for non-graph content.
